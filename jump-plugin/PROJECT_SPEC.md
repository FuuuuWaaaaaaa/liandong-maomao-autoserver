# Jump Plugin Specification

## Purpose and Boundary

Implement a Java plugin for the Velocity proxy. This component owns the player-facing join flow, hostname routing, online transfer queue, session-safe connection attempts, and presence reporting. It calls the manager API for configuration, lifecycle, wake operations, and durable tickets.

It does not own Pterodactyl credentials, call Pterodactyl directly, connect directly to MySQL, or make arbitrary power decisions. The manager is the control plane.

## Required Behaviors

### Hostname routing

- Resolve the original login hostname against exact, case-insensitive configured domain aliases.
- Support multiple aliases per target. Treat wildcard routing as opt-in and lower priority than exact mappings.
- Account for DNS SRV and Velocity forced-host behavior; keep a diagnostic command that reports the hostname Velocity received and the mapped target.
- Unknown hostname follows the configured default entry route or a clear disconnect; never guess a target by substring.
- A mapped target is not necessarily the initial backend. The initial destination is its compatible entry profile or the configured lobby.

### Startup orchestration

- On an offline target request, enqueue the connected session, move it to a compatible holding backend, then issue one idempotent manager wake request.
- Multiple players requesting the same target share a single startup lifecycle.
- Poll/read the manager lifecycle without blocking Velocity's event loop.
- Wait for both Pterodactyl `running` and the manager/plugin readiness signal. Cold start uses a protocol-level Minecraft status probe where possible.
- If a fresh proxy heartbeat says target `running` with one or more players already connected, it is established and can be used immediately.
- On 5-minute readiness timeout, failed power action, suspension, or external stop, report a target-specific reason and preserve/disposition each ticket according to the shared spec.

### Queue and transfer

- Maintain an online dispatcher per target. Initial release supports one active transfer per target.
- A queue entry is bound to a Velocity player UUID and connection/session generation; a stale callback from a previous reconnect cannot transfer a new session accidentally.
- Before each move from holding to target, send a 5-second countdown notice (chat plus action bar/title where supported). Message includes target name and does not depend on the backend server being reachable.
- Revalidate player is still connected, target still `READY`, and queue entry is still eligible when the timer expires.
- Use `RegisteredServer` and Velocity's `createConnectionRequest(player).connect()` APIs. Observe the completion result and relevant connection/kick events.
- Mark complete only after the connection event names the expected target and the player remains connected for the configured stability window (proposed 2 seconds).
- Only then release the queue lock and begin the next player's notice period.
- On failure, attempt fallback to the original compatible holding server. Report a clear reason and move to offline ticket if there is no reachable holding connection. Continue later entries after bounded cleanup.
- Cancel pending timers on disconnect, proxy shutdown, target state changes, or replacement session.

### Offline tickets and join-screen fallback

- When a player cannot enter any compatible holding profile, send a persisted ticket event to the manager before disconnecting.
- Disconnect reason should be concise and localized, such as:

  ```text
  Target: Create World
  Status: Starting (2:14 / 5:00)
  Offline waitlist: #1 of 3
  Online players waiting: 2
  Reconnect to refresh status and continue.
  ```

- The text is a snapshot, timestamped by the manager/proxy. Do not claim to update after disconnect.
- On reconnect, look up an existing ticket by UUID and target; refresh it instead of duplicating it. If the player enters a compatible holding profile, promote it to a connected online request.
- Online requests are dispatchable before offline tickets. An offline ticket at the head does not reserve the active transfer lock. Do not preempt an active 5-second countdown.
- Expose ticket TTL; proposed initial default is 30 minutes, adjustable in manager settings.

### Presence heartbeat

- Derive per-target player counts from Velocity's registered backend player collections, not from Pterodactyl CPU/RAM stats.
- Send proxy heartbeat every 15 seconds by default. Include only proxy ID, target ID, count, observed-at time, plugin version, and supported API version.
- Send zero counts only for a healthy observation; if plugin cannot query a backend/server registry, mark the observation unknown rather than zero.
- Plugin restart should send an initial heartbeat after config/state reconciliation.
- Retry transient API failures with bounded exponential backoff and jitter; never block game events while retrying.
- Report counts only for managed target backends; define whether lobby is managed separately.

## Proposed Plugin Configuration

The manager is authoritative for routable domains and target settings. Local configuration contains the manager connection and safe local fallbacks:

```yaml
manager:
  base-url: "https://manager.example.net"
  proxy-id: "proxy-main"
  token: "${JUMP_MANAGER_TOKEN}"
  connect-timeout-ms: 3000
  request-timeout-ms: 5000
  config-refresh-seconds: 30
  heartbeat-seconds: 15
queue:
  transfer-notice-seconds: 5
  transfer-stability-seconds: 2
  max-concurrent-transfers-per-target: 1
  offline-ticket-ttl-seconds: 1800
messages:
  locale: "zh_CN"
diagnostics:
  log-host-routing: true
```

The manager API token must be a dedicated proxy credential, not a Pterodactyl key. Support secret-file or environment substitution instead of requiring a plaintext token committed with the plugin config.

## Suggested Components

- `JumpPlugin`: Velocity lifecycle, dependency injection, command registration.
- `ManagerApiClient`: HTTPS, authentication, versioned DTOs, retries, ETag config fetch.
- `RouteResolver`: hostname normalization/alias lookup and entry profile selection.
- `TargetLifecycleCache`: manager lifecycle cache and readiness view.
- `TargetQueueCoordinator`: per-target online queue and transfer lock.
- `TransferWorkflow`: notice, revalidation, connection request, success/stability/fallback.
- `TicketService`: idempotent offline ticket promotion and event reporting.
- `PresenceReporter`: heartbeat aggregation and retry.
- `Messages`: Adventure components/MiniMessage formatting and locale fallback.
- `JumpAdminCommand`: permission-gated route, lifecycle, queue, and test-connection diagnostics.

Prefer Velocity's supported APIs and scheduler. Do not run blocking HTTP or socket checks on the proxy main/event thread. Treat Minecraft client version/protocol as a hint only; it does not reliably identify loader or modpack compatibility.

## Commands and Permissions

Suggested operator commands:

- `/jump status <target>`: raw/normalized lifecycle, ready probe, heartbeat age.
- `/jump queue <target>`: online queue and offline waitlist counts/positions.
- `/jump route <hostname>`: received hostname and route/entry profile.
- `/jump refresh`: request config refresh.
- `/jump test <target>`: manager connectivity and backend reachability diagnostics without moving players.

Use a dedicated permission such as `jump.admin`. Commands must not disclose credentials. Player-facing commands are optional and must not bypass queue/power policy.

## Tests and Acceptance

- Unit tests for hostname canonicalization, alias resolution, lifecycle mapping, queue arbitration, ticket idempotency, and session generation checks.
- Simulated event tests for the 5-second notice, cancellation, successful connection event, stability window, and next-player dispatch.
- Integration tests against a fake manager API covering start deduplication, timeout, stale heartbeat, and reconnect ticket promotion.
- Smoke-test one Paper backend, one Fabric backend, one NeoForge or modern Forge backend, and one Spigot legacy-forwarding backend.
- Verify a heavy modpack entry profile against its actual client pack; protocol compatibility alone is not acceptance.
- Verify that all plugin network calls are async and plugin shutdown cancels executors/timers cleanly.

## Build and Directory Rules

Keep all plugin sources, build scripts, tests, and deployment notes beneath `jump-plugin/`. Recommended initial build system is Gradle with Java; select the current supported Velocity API/runtime Java pair at implementation time and record it in the tested matrix. Do not duplicate the manager's domain logic here; share the written API contract from `ARCHITECTURE.md`.
