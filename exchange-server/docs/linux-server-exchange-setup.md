# Linux Exchange Setup (Docker-Only)

Bare-metal/systemd instructions were removed to keep Exchange deployment consistent.

Use Docker Compose only:

1. Quick start: see `setup.md`
2. Full Docker guide: see `docker-compose-exchange.md`
3. Runtime monitoring: see `monitor-exchange.md`

## Why this change

- one deployment path across environments
- simpler operations and upgrades
- easier rollback and troubleshooting with container logs
