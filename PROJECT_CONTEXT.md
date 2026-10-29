# Project Context - Read First

> Durable handoff marker: if chat memory is missing, compressed, or ambiguous, reread this file and then `ARCHITECTURE.md`, `jump-plugin/PROJECT_SPEC.md`, and `server-manager/PROJECT_SPEC.md` before doing project work. `AGENTS.md` repeats this requirement for future coding sessions.

## Goal

Build two isolated applications under this workspace:

1. `jump-plugin/`: a Java plugin for a Velocity proxy. It routes players by the hostname they joined, holds them while their target is off, asks the manager to wake it, reports player presence, and serializes transfers.
2. `server-manager/`: a Docker-deployable TypeScript API plus React WebUI, backed by the user's independent MySQL service. It manages Pterodactyl state and power actions, proxy heartbeats, durable waiting tickets, and idle shutdown.

The specifications were created before implementation. The repository now contains the TypeScript manager, React WebUI, MySQL migration/Docker packaging, and Java Velocity plugin described below; keep this document aligned with the written contracts as behavior evolves.

## Confirmed Decisions

- Use Velocity as the jump proxy.
- The network contains Vanilla, Forge, NeoForge, Fabric, Paper, and Spigot backends. “水龙头” means Spigot.
- Backend game ports are not externally reachable; players must enter through the proxy. Firewall rules still restrict backend ports to the proxy.
- Use Pterodactyl's API for lifecycle and power control. Keep Pterodactyl credentials in the manager service, never in the Velocity plugin.
- Pterodactyl's `current_state` is richer than a boolean. Handle at least `offline`, `starting`, `running`, and `stopping`; also handle API errors, unknown states, suspension, installation/maintenance restrictions, and process state separately from game readiness.
- Cold start timeout: 5 minutes. After Pterodactyl says `running`, continue checking game-server readiness; only then begin queue transfers.
- Before each queued transfer, notify that player 5 seconds ahead. Do not begin the next player's transfer until the previous player is confirmed connected to the destination and has remained connected for a short stability window.
- Stop a running target after 15 minutes with zero players, using proxy-reported presence heartbeats. Fail closed on stale/missing heartbeat or while queue demand/transfers exist.
- Heavy modded clients must not be rejected just because the shared lobby has a vanilla mod list. A single Paper/Spigot lobby cannot guarantee this for every Forge/NeoForge pack. Use a matching modded holding profile where needed; if the client still cannot join, persist a waiting ticket and disconnect with a readable Minecraft join-screen status snapshot.
- A disconnected/offline ticket cannot receive live updates and cannot be transferred. When the client reconnects, refresh its state and ticket. Online queue entries are dispatchable and may overtake the offline waitlist head; an already-started 5-second countdown is not preempted.
- WebUI visual style is a core requirement: Apple-inspired liquid glass, with both light and dark themes. Keep status/error text readable over translucent surfaces.
- Use MySQL, not SQLite, for the intended deployment. The user expects to use an existing independent SQL service. PostgreSQL is not required for this data model.
- Default technical direction: TypeScript service, React WebUI, Docker deployment, MySQL persistence. Plugin implementation language: Java against Velocity API.
- The user has authorized implementation, functional completion, Docker/GitHub publication, and Chinese operational documentation. Keep the two applications isolated and preserve the contracts in `ARCHITECTURE.md`.

## Queue Rule To Preserve

Keep two concepts distinct:

- **Online queue:** connected players currently held on a compatible lobby/holding backend. These can be notified and transferred.
- **Offline waitlist:** durable tickets for clients who had to return to the Minecraft join screen because no compatible holding server accepted them.

The offline head does not reserve an active transfer slot. Online requests may overtake it and complete first. If an offline-ticket owner reconnects, convert/promote that ticket into the online queue according to the configured priority policy. Do not interrupt a transfer countdown already in progress. See the shared architecture specification for exact event ordering and persistence requirements.

## Read Next

1. `ARCHITECTURE.md`
2. `jump-plugin/PROJECT_SPEC.md`
3. `server-manager/PROJECT_SPEC.md`

Research links and compatibility qualifications are documented in `ARCHITECTURE.md`; verify version-sensitive library and loader support again when implementation begins.
