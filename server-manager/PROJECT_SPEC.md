# Server Manager Specification

## Purpose and Boundary

Build a Docker-deployable management service with a TypeScript API, React WebUI, and MySQL persistence. It is the control plane for Pterodactyl lifecycle, proxy registration/heartbeats, target/domain/entry-profile configuration, durable disconnected tickets, audit events, and automatic idle shutdown.

The user's intended production deployment uses an existing independent MySQL service. SQLite is not the production default. The manager must not read or write Pterodactyl's internal database.

## Functional Scope

### Pterodactyl integration

- Configure panel base URL and Client API credentials securely.
- Validate credentials and server access from the WebUI using a server-side test action.
- For each managed server, store the Pterodactyl server identifier, backend host/port, display name, software/loader/version metadata, domain aliases, forwarding profile, and entry profile.
- Read `GET /api/client/servers/{identifier}/resources`; retain raw `current_state`, `is_suspended`, resource timestamp/age, and any error.
- Send `POST /api/client/servers/{identifier}/power` with `start` or graceful `stop` only. `restart` can be an explicit operator action. Never use `kill` for idle shutdown.
- Treat a power-action response as accepted request only. Poll and persist observed state transitions.
- Handle `offline`, `starting`, `running`, `stopping`, suspended, blocked installation/maintenance, API error, and unknown state explicitly.
- Deduplicate concurrent start requests per target with an atomic operation/lock. A new demand during idle-stop countdown cancels it; demand during `stopping` is recorded and starts once Pterodactyl reports `offline`.
- Default readiness timeout 300 seconds; default idle timeout 900 seconds after a trusted zero-player observation. Both are configurable per target and globally.

### Proxy registration and runtime state

- Issue a distinct manager API token for each proxy instance. Store only a token hash for verification; allow one-time display/rotation.
- Receive heartbeats and per-target presence snapshots. Store last-seen timestamp and count; do not accept a stale/invalid timestamp as fresh.
- Default heartbeat cadence is 15 seconds and freshness window 45 seconds (both configurable).
- If heartbeats are missing/stale, block automatic idle stop and show an alert. Do not infer zero players from absence of data.
- Provide a scoped config response for the authenticated proxy. It contains only enabled targets, route aliases, entry profiles, safe queue timings, and lifecycle summaries.

### Queue ticket persistence

- Persist offline tickets keyed by target and player UUID, with a unique active-ticket constraint so reconnects update rather than duplicate.
- Keep online queue and offline waitlist counts/positions distinct. The plugin owns live Velocity session dispatch; manager stores the durable ticket/order and audit trail.
- Online players may overtake an offline waitlist head, since an offline player cannot be transferred. This never interrupts a transfer countdown already underway.
- On reconnect, accept a promotion event and retain ticket history; on successful transfer, mark completed; on expiry, mark expired rather than deleting audit evidence immediately.
- Minimize personal data: UUID and last-known player name may be stored for ticket recovery; no IP address or full mod inventory.
- Ticket retention duration is configurable; proposed initial default is 30 minutes for active offline tickets, with older completed/expired records retained for a shorter audit window or normal retention policy.

## Lifecycle State Machine

Persist both Pterodactyl raw observation and normalized manager state:

```text
OFFLINE -> START_REQUESTED -> STARTING -> RUNNING_UNREADY -> READY
                                                |                |
                                                |                +-> IDLE_COUNTDOWN -> STOP_REQUESTED -> STOPPING -> OFFLINE
                                                +-> FAILED
Any state -> SUSPENDED / BLOCKED / API_ERROR / UNKNOWN as applicable
```

State rules:

- `START_REQUESTED`: wake accepted locally and waiting for API result; same target requests share one operation.
- `STARTING`: raw Pterodactyl state is `starting`.
- `RUNNING_UNREADY`: raw state is `running`, but game readiness has not been verified after a cold start.
- `READY`: manager has a recent successful game status probe or a trusted already-occupied presence observation.
- `IDLE_COUNTDOWN`: target remains running and ready, trusted player count is zero, and there is no queue or transfer demand.
- `STOP_REQUESTED`/`STOPPING`: graceful stop was sent/observed. Do not dispatch new joins.
- `FAILED`: startup/readiness timeout or unrecoverable action error; retain diagnostic and tickets until operator/user retry policy.
- `API_ERROR` and `UNKNOWN`: include age of last known state. Never treat them as offline or zero players.
- `SUSPENDED`/`BLOCKED`: surface actual panel condition and refrain from retry loops.

If new demand arrives during `IDLE_COUNTDOWN`, cancel the countdown and keep the target ready. If new demand arrives during `STOPPING`, wait for confirmed `offline` and issue one start if the server reached offline; do not race start/stop requests.

## Proposed MySQL Data Model

Use migrations and foreign keys. Normalize operational entities; keep only flexible, versioned metadata in JSON. Suggested initial tables:

- `admin_users`: id, username/email, password hash, role, enabled, created/last-login timestamps.
- `panel_connections`: id, display name, base URL, encrypted API credential, credential hint, enabled, tested-at. Encryption key comes from Docker secret/environment and is not stored in MySQL.
- `proxy_instances`: id, name, token hash, token hint, enabled, last_seen_at, plugin_version, API version.
- `entry_profiles`: id, name, holding server reference or proxy-side holding mode, Minecraft version, loader, profile metadata, enabled.
- `target_servers`: id, panel connection id, Pterodactyl identifier, slug, display name, backend host/port, software, loader, Minecraft version, forwarding mode, entry profile id, startup timeout, idle timeout, enabled, current raw/normalized state, readiness, heartbeat count/age, zero_since, last error, timestamps.
- `domain_routes`: id, normalized hostname, target id, route enabled, unique hostname.
- `presence_snapshots`: id, proxy id, target id, observed_at, player_count, freshness/quality. Retain a bounded history or aggregate periodically.
- `queue_tickets`: id, target id, player UUID, last player name, class (`online`/`offline`), state, enqueue sequence, created/updated/expiry timestamps, last status snapshot. Unique active `(target_id, player_uuid)` enforced with a generated active key or transactionally maintained active flag.
- `queue_events`: id, ticket id, event type, source, payload JSON with no secrets, created_at.
- `lifecycle_operations`: id, target id, operation (`start`/`stop`), idempotency key, requested_by, outcome, started/finished timestamps, error.
- `audit_log`: actor, action, object type/id, safe summary JSON, remote metadata where appropriate, timestamp.

Use InnoDB, UTC timestamps, parameterized queries, explicit transactions for queue ticket uniqueness and per-target lifecycle locks. Database credentials should be supplied through Docker secrets/environment. The manager should support TLS to the remote MySQL endpoint and connection pool health checks.

### MySQL vs PostgreSQL decision

MySQL is selected because the user already expects an independent SQL service and this workload is conventional relational configuration, operational state, queue tickets, and audit rows. It needs transactions and uniqueness, which MySQL provides. PostgreSQL's JSON querying and advanced database features do not justify adding a new service requirement for this use case. Keep the schema portable where practical, but do not promise SQLite production parity.

## HTTP API

Use `/api/v1`. Separate authenticated admin routes from proxy machine routes.

### Proxy routes

Implement the shared initial contract in `ARCHITECTURE.md`: config/ETag, heartbeat, wake, lifecycle, queue ticket create/update, ticket event, and queue summary. Machine authentication is per-proxy, with authorization restricted to targets linked to that proxy.

Wake endpoint requirements:

- `offline` -> atomically create/start operation and issue Pterodactyl start.
- `starting` or `RUNNING_UNREADY` -> return current operation, no duplicate start.
- `ready` -> return ready without power call.
- `stopping` -> return `STOPPING` and queue demand; do not race a start until observed offline.
- suspended/blocked/API error -> return a structured reason and no repeated power call.
- Support idempotency key and return operation ID.

### Admin routes

Provide APIs for:

- Login/logout/session refresh and current user.
- Dashboard summary and recent lifecycle/audit events.
- CRUD for panel connections, proxies, targets, domains, and entry profiles.
- Pterodactyl connection test, server selection/import, and target readiness test.
- Manual start/stop/restart with confirmable audit record and permissions.
- Queue inspection and safe ticket cancel/expire actions.
- Settings for global defaults, timeout policy, heartbeat freshness, message locales, and notification policy.

Validate request and response schemas. Return stable error codes, not raw Pterodactyl response bodies or credentials.

## WebUI Requirements

The interface is operational, not marketing-oriented. The first screen is the dashboard.

### Main views

- **Dashboard:** running/starting/stopping/offline/failed counts, stale proxy heartbeat warning, servers approaching idle stop, recent actions.
- **Servers:** dense table with target, domains, software/version, Pterodactyl state, readiness, player count, heartbeat age, idle timer, queue counts, and power actions.
- **Server detail:** lifecycle timeline, configuration, forwarding/entry profile, domains, queue/tickets, safe logs, Pterodactyl resource summary.
- **Routes and profiles:** hostname-to-target map and compatible waiting profile settings.
- **Activity:** searchable lifecycle/audit events and failure details.
- **Settings:** panel connection, proxy token rotation, global defaults, account/security, theme.

### Liquid-glass visual direction

- Apple-inspired liquid glass is a defining visual requirement, not a decorative afterthought.
- Provide both light and dark themes, each built from translucent layered surfaces, strong backdrop blur, subtle specular borders/highlights, restrained depth, and fluid but quiet transitions.
- Use a neutral base with carefully chosen accent colors for lifecycle semantics. Do not let blur erase text/table contrast.
- Keep data tables and forms dense, stable, and scannable. Glass surfaces frame tools and repeated items; do not turn every page section into a floating card.
- Use consistent status colors plus text/icon labels; color alone is insufficient.
- Respect reduced-motion and accessibility contrast settings. Provide a solid-surface fallback if backdrop filters are unavailable.
- Use icon buttons for row actions with accessible names/tooltips; confirmations for stop/restart, not kill.
- Keep light and dark themes equally finished. Theme choice persists per user/browser.

## Docker Deployment

- Supply a multi-stage Dockerfile and Compose example for the manager and optional reverse proxy; MySQL can be external and should remain external by default.
- Persistent application data should be limited to logs/cache if needed; business state is in MySQL.
- Configuration through environment/secrets: public base URL, bind port, MySQL DSN/TLS, session secret, credential-encryption key, initial admin bootstrap, proxy auth settings, log level.
- Never bake credentials into image layers, Compose examples, or source control.
- Add health/readiness endpoints. Readiness checks MySQL connectivity and migrations; liveness must not expose internals.
- Run migrations as a controlled startup/release step, not concurrently in every API replica.
- Handle graceful shutdown so active polling/actions are recorded and no duplicate startup operation is created on restart.
- Backups are the operator's responsibility for the external SQL service; document schema migration and restore compatibility.

## Suggested Service Modules

- `pterodactyl/`: typed Client API client, resource/power calls, server pagination/import.
- `lifecycle/`: state normalization, per-target operation lock, start/readiness/idle-stop coordinator.
- `proxy-api/`: scoped machine auth, config distribution, heartbeat, ticket events.
- `queue/`: durable offline ticket service and position/count queries.
- `targets/`, `routes/`, `profiles/`: domain services and validation.
- `auth/`, `admin-api/`: user sessions, roles, audit.
- `jobs/`: lifecycle polling, heartbeat freshness, idle evaluation, retention.
- `db/`: migrations, repositories, transactions.
- `web/`: React/Vite operational dashboard and responsive management screens.

## Tests and Acceptance

- Unit tests for Pterodactyl state mapping, idempotent wake policy, transition races, stale heartbeat handling, idle timer reset, and online/offline queue ticket behavior.
- Contract tests for the shared plugin API DTOs and stable error codes.
- Integration tests with a fake Pterodactyl API covering `204`, `starting -> running -> offline`, `running` without game readiness, `stopping`, 401/403, timeout, and unknown state.
- MySQL integration tests for lifecycle lock/idempotency and unique active ticket under concurrent reconnect requests.
- API security tests for proxy target scoping, invalid token, credential masking, role checks, CSRF/session behavior, and SSRF-safe URL validation.
- UI checks for both themes, narrow screens, long hostnames, raw states/errors, empty/loading/stale states, and accessible action names.
- End-to-end acceptance follows `ARCHITECTURE.md` acceptance criteria.

## Build and Directory Rules

All API, WebUI, Docker, migrations, and manager tests stay beneath `server-manager/`. Keep the backend and frontend independently testable within this directory. MySQL is the production persistence target. Do not add SQLite as a silent fallback that can lead to split production data.
