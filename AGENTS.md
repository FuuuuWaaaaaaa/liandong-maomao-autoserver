# Repository Working Notes

Before planning or changing this project, read `PROJECT_CONTEXT.md` first, then read the specification for the component being changed:

- `ARCHITECTURE.md` for shared behavior and cross-project contracts.
- `jump-plugin/PROJECT_SPEC.md` for the Velocity proxy plugin.
- `server-manager/PROJECT_SPEC.md` for the API, MySQL service, and WebUI.

These files are the durable project memory. If conversation context is incomplete, has been compacted, or seems to conflict with an earlier decision, reread those files before proceeding. Treat explicit newer user messages as the latest source of truth and update the documents when decisions change.

The two applications must remain isolated in the `jump-plugin/` and `server-manager/` subdirectories. Shared contracts belong in `ARCHITECTURE.md`; do not put Pterodactyl credentials in the proxy plugin.
