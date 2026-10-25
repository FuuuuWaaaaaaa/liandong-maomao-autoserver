# Shared Architecture and Behavioral Contract

## 1. Product Shape

The network has one public entry point and two application components:

```text
Minecraft client
    |
    | target hostname (for example modded.example.net)
    v
Velocity proxy + jump plugin
    |  \
    |   \ outbound authenticated control API, heartbeat, queue/ticket events
    |    v
    |  Server manager (TypeScript API + MySQL + WebUI, deployed with Docker)
    |    |
    |    +---- Pterodactyl Client API: resource state and power actions
    |
    +---- holding profile / lobby backend
    +---- target game backend after it is ready
```

Keep the applications in `jump-plugin/` and `server-manager/`. The proxy handles player sessions and game protocol routing. The manager owns Pterodactyl credentials, durable configuration, lifecycle decisions, audit history, and disconnected waiting tickets. The Pterodactyl panel database is not an integration point; call the supported API.

## 2. Core Flows

### 2.1 Direct join to an already-running target

1. Read and normalize the hostname from the original Minecraft connection. Resolve it using an exact configured domain alias.
2. Ask the manager's cached lifecycle state, refreshed from Pterodactyl.
3. If the target is running and fresh proxy presence reports players already inside, treat it as established and connect the player directly. Do not impose the cold-start probe path.
4. If it is running but has no known players (for example, a freshly started server), verify Minecraft readiness before sending the first queued player.
5. A request that must wait is first sent to its configured compatible holding profile. Each actual transfer from a holding profile to the target gets its own 5-second notice.

The exact hostname can be affected by DNS SRV resolution and Velocity's forced-host matching. Configure all hostnames that clients may actually present, and test with the production DNS record. Do not assume the name typed by the user is always the name visible to the proxy.

### 2.2 Cold wake and transfer

1. A player requests a target that is `offline`. Put the connected player in the target's online queue, then move them to the target's compatible holding profile.
2. The plugin sends one idempotent wake request for the target. Concurrent requests share that wake; they do not produce repeated start actions.
3. The manager sends Pterodactyl `start` and polls `GET /api/client/servers/{identifier}/resources` (or equivalent configured Client API endpoint). A successful power-action response is an acknowledgement, not proof that Minecraft is ready.
4. Model Pterodactyl process state separately from game readiness. `starting` means booting; `running` means the container/process is running. Once running, probe the Minecraft status protocol at a bounded interval. A successful protocol response marks the target ready. For already-running targets with a fresh player count greater than zero, the fresh presence signal can short-circuit the cold-start readiness probe as described above.
5. When `READY`, select the next connected online request. Send a player-visible 5-second notice, then connect them using Velocity's supported server connection API.
6. Confirm success using Velocity's backend connection event for that player and target. Require a small stability window (default proposal: 2 seconds) before releasing the per-target transfer lock and selecting the next player.
7. If the connection fails, report the reason, return the player to their holding backend if possible, or disconnect with a clear snapshot if holding is unavailable. Continue the queue after a bounded failure path; never leave the target queue locked forever.

Proposed readiness probe interval is 3 to 5 seconds while starting, with backoff or a slower interval when stable. The 5-minute startup timeout is measured from the first accepted wake request until game readiness, not merely until Pterodactyl reports `running`.

### 2.3 Holding server failure and offline waitlist

A client can fail to enter a holding server because its Forge/NeoForge/Fabric client requires a matching modded server profile. If no compatible holding profile accepts it:

1. Persist or refresh a per-player/per-target offline ticket before disconnecting.
2. Return a readable disconnect reason in the Minecraft multiplayer/join screen, including target name, current lifecycle (`starting`, `ready`, `failed`, etc.), its current offline ticket position/count, and the fact that reconnecting refreshes status.
3. This screen is a snapshot, not a live display. Once disconnected, the plugin cannot push new status. Do not claim otherwise.
4. When the same player reconnects through a mapped hostname, refresh the ticket and current lifecycle. If a compatible holding route is available, they become connected and dispatchable. Do not duplicate their ticket.
5. Expire old offline tickets after a configurable retention period. Proposed initial default: 30 minutes; this is an implementation default to expose in configuration, not a locked user requirement.

### 2.4 Two-queue arbitration

Maintain a per-target **online queue** and **offline waitlist**. Online entries represent connected Velocity sessions that can be transferred. Offline entries are durable identity tickets and are not transferable until reconnect.

- Serialize transfer work per target. Only one player per target may be in the notice/connect/stability sequence at a time.
- Online queue entries are eligible first, including when an offline ticket is currently at the offline head. This implements the user's requested online insertion/overtake behavior.
- Never interrupt the active 5-second notice countdown or a backend connection already in flight. Overtaking is applied only when choosing the next transfer.
- Keep arrival sequence within each class. A reconnected offline ticket is promoted to an online request; default proposal is to join the online queue according to its current promotion time, while preserving its original ticket metadata for audit/UI.
- Display online position and offline position separately. A disconnected ticket's displayed position can change while the client is away; the disconnect screen is only the value at disconnect time.
- A ticket for a player who disconnects while online moves to offline waitlist. It must not block eligible online players.
- Queue state changes need to be idempotent by ticket/player/target and robust to duplicate HTTP requests, reconnects, plugin restarts, and manager restarts.

No strict starvation guarantee has been selected. If fairness becomes necessary, add an explicit max-overtake or aging policy. Do not silently change the agreed priority behavior.

### 2.5 Presence and automatic stop

The jump plugin is the source of player presence because players must use the proxy and backend ports are private. At a configurable interval (proposed 15 seconds), send for each managed target:

- target ID, proxy ID, observation time, connected player count, and plugin/protocol version;
- no player IP addresses and no mod inventory;
- optionally hashed/opaque session identifiers only when needed for ticket reconciliation; avoid sending UUID lists for routine heartbeat.

Presence is fresh for a configurable interval (proposed 45 seconds). The manager may accumulate idle time only when all are true:

- Pterodactyl `current_state` is `running`;
- presence heartbeat is fresh and reports zero players;
- no connected transfer is in progress and no online queue demand exists;
- target is not suspended, installing, or otherwise blocked.

After 15 uninterrupted idle minutes, send a graceful Pterodactyl `stop` signal. Never use `kill` as the normal idle action. A nonzero player count, queue demand, transfer, stale heartbeat, API error, or unknown status resets/pauses the idle timer. The safe default for stale heartbeat is to pause auto-stop, not infer zero.

## 3. Pterodactyl State Model

Do not flatten the API to `online: boolean`. Preserve raw API values and expose a normalized lifecycle.

| Pterodactyl/API observation | Manager lifecycle | Meaning/action |
|---|---|---|
| `current_state=offline` | `OFFLINE` | Eligible for an idempotent start request. |
| `current_state=starting` | `STARTING` | Wait and poll; keep players in holding/offline ticket state. |
| `current_state=running`, Minecraft not ready | `RUNNING_UNREADY` | Continue readiness checks; do not call this ready. |
| `current_state=running`, readiness established | `READY` or `IDLE_COUNTDOWN` | Route connected queue or track safe idle time. |
| `current_state=stopping` | `STOPPING` | Do not dispatch new players; cancel idle stop if supported and a new demand arrives, otherwise wait for offline and restart once safe. |
| `is_suspended=true` | `SUSPENDED` | Do not repeatedly send power actions; report panel suspension. |
| installation/transfer/maintenance condition | `BLOCKED` | Do not start/stop; show exact known reason. |
| request timeout, 401/403/404/5xx, malformed response | `API_ERROR` or `UNKNOWN` | Preserve last known value with its age; never treat as offline or zero-player. |
| boot/readiness timeout or failed start | `FAILED` | Stop automatic retries; keep tickets, show actionable error, allow operator retry. |

The resource endpoint documents `current_state` and resource stats; it is distinct from the server's setup/installation status. Power API `204` means the requested signal was accepted for dispatch, not that the lifecycle transition completed. Poll state after start/stop.

## 4. Compatibility Contract

Velocity is the agreed proxy. The jump plugin must compile against Velocity and Adventure APIs and avoid Bukkit, NMS, or backend implementation classes. It should not require recompilation for each backend Minecraft patch. Protocol translation plugins such as ViaVersion/ViaBackwards can help with client/server protocol differences; they do not make mismatched mod loaders or required mod lists compatible.

Use a per-backend forwarding profile:

| Backend | Suggested forwarding / notes |
|---|---|
| Paper 1.13.2+ | Velocity modern forwarding, secret shared with backend, private port. |
| Fabric | FabricProxy-Lite for modern forwarding; CrossStitch may improve modded custom argument compatibility. Test per pack. |
| NeoForge | Version-appropriate Proxy Compatible Forge / NeoForged forwarding implementation; check project compatibility matrix for exact game and loader build. |
| Forge above 1.20.2 | Velocity 3.3+ has documented support for newer Forge; still install/configure forwarding support as required by the exact version. |
| Forge 1.13 through 1.20.1 | Special compatibility path such as Ambassador or version-specific Proxy Compatible Forge. Handshake and server switching need pack tests. |
| Spigot | Legacy BungeeCord forwarding only. Restrict backend port to proxy at network/firewall layer because legacy forwarding is weaker. |
| Mojang Vanilla | Limited forwarding support; prefer Fabric + FabricProxy-Lite if vanilla gameplay is desired. Otherwise evaluate legacy-compatible VanillaCord. |

### Heavy modded holding clients

A generic Paper/Spigot lobby cannot promise acceptance of every Forge/NeoForge pack. Some clients only have client-side mods and can enter a vanilla-like lobby; other clients require server-side channels/loader negotiation and are rejected before the plugin can run an in-game message.

Each target therefore points to an `entry profile`: a compatible waiting backend or proxy-side holding mode tested with that target's client pack. A matching holding backend may share the correct game version/loader and required handshake mods. If no profile is compatible, use the disconnect-screen ticket flow. Treat modpack compatibility as an explicit tested capability, never infer it from `ViaVersion` being installed.

Moving between some legacy Forge servers can require client reset/handshake work and may not be seamless. The first implementation should support the selected modern versions and record a tested compatibility matrix; do not advertise every loader/version combination until tested.

## 5. Shared API Contract (Initial Proposal)

All endpoints are HTTPS, versioned, scoped to an authenticated proxy instance, rate-limited, and idempotent where requests can be repeated. These paths are a proposed contract for implementation, not an existing API.

| Method/path | Purpose |
|---|---|
| `GET /api/v1/proxy/config` | Return enabled domain aliases, target IDs, entry profiles, queue timing, and cached lifecycle; support ETag/If-None-Match. |
| `POST /api/v1/proxy/heartbeat` | Submit proxy liveness and per-target player-count observations. |
| `POST /api/v1/proxy/targets/{targetId}/wake` | Idempotently request start; return current lifecycle and operation ID. |
| `GET /api/v1/proxy/targets/{targetId}/lifecycle` | Read normalized/raw lifecycle, readiness, heartbeat age, and last error. |
| `POST /api/v1/proxy/targets/{targetId}/tickets` | Create/update connected/offline wait ticket; idempotency key includes target and player UUID. |
| `POST /api/v1/proxy/targets/{targetId}/tickets/{ticketId}/events` | Report promoted, transferred, failed, or expired ticket event. |
| `GET /api/v1/proxy/targets/{targetId}/queue` | Return separate online/offline counts and positions where authorized. |

Keep the plugin API minimal: it must not receive the Pterodactyl API token or have an endpoint that can choose arbitrary panel server IDs. The manager verifies that requested IDs are configured for the authenticated proxy.

## 6. Security and Failure Rules

- Pterodactyl secrets live only in manager runtime secrets or are encrypted at rest with an environment-provided master key. The UI must never return a stored token in read APIs; show only a masked hint and support replacement.
- Use a least-privilege Pterodactyl Client API account/key with access only to managed servers. Avoid root-wide Application API tokens unless no narrower API capability can meet the requirement.
- Use distinct, random Velocity forwarding secrets. Do not reuse the manager API credential.
- Backend firewall allows only proxy-to-backend traffic. Panel API access should be restricted to manager host/network where practical.
- Require TLS for manager API and secure admin authentication for the WebUI. Hash passwords with a modern password hash; protect cookie sessions with HttpOnly, Secure, SameSite, CSRF controls, and rate limits.
- Validate all domain names, ports, Pterodactyl identifiers, and callback payloads. Avoid arbitrary URL fetches from user-configurable target addresses where SSRF could reach internal services.
- Audit power actions, configuration edits, ticket state transitions, auth failures, and manual operator actions. Never log secrets or player IPs.
- On API uncertainty, fail closed for auto-stop and do not falsely report ready. For player flow, return a clear status and keep/recover ticket state.

## 7. Initial Acceptance Criteria

1. Two applications build/deploy independently from their own subdirectories.
2. Exact hostname routes to its configured target, with alias/SRV behavior documented and tested.
3. Concurrent requests for one offline server cause exactly one effective start operation.
4. `starting` is never treated as ready; `running` is followed by game readiness check.
5. Startup readiness fails by 5 minutes with a visible error and preserved tickets.
6. Each queued transfer gets a 5-second notice; a second player is not dispatched before the first connection is confirmed and stable.
7. An online player can overtake an offline waitlist head; an active countdown is not interrupted.
8. Lobby incompatibility produces a persistent ticket and a join-screen message with a status/queue snapshot.
9. Stale presence prevents auto-stop. Fresh zero presence, no queue demand, and `running` for 15 minutes causes one graceful stop.
10. WebUI offers light and dark liquid-glass themes with readable state badges, tables, forms, and dialogs.
11. Pterodactyl credentials never appear in plugin configuration, browser responses, or logs.

## 8. Primary Research Links

Verify version-sensitive compatibility when implementation starts. Sources consulted for this specification:

- [Velocity server compatibility](https://docs.papermc.io/velocity/server-compatibility/)
- [Velocity security](https://docs.papermc.io/velocity/security/)
- [Velocity FAQ](https://docs.papermc.io/velocity/faq/)
- [FabricProxy-Lite](https://github.com/OKTW-Network/FabricProxy-Lite)
- [Proxy Compatible Forge](https://github.com/adde0109/Proxy-Compatible-Forge)
- [Pterodactyl resource API](https://docs.pterodactyl.io/v2/api/client-api/clientGetServerResources)
- [Pterodactyl power action API](https://docs.pterodactyl.io/v2/api/client-api/clientSendPowerAction)
- [ViaVersion setup](https://viaversion.com/setup?lang=en)
- [NeoForge mod mismatch example](https://github.com/neoforged/NeoForge/issues/3481)
