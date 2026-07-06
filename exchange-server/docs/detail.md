# Exchange Operational Details (Docker)

This page collects advanced Docker-only operations for Reactor Exchange.

## Start and restart

From `exchange-server/`:

```bash
docker compose up -d
docker compose restart reactor-exchange
```

Use `--build` only when code or Dockerfile changed.

## Optional heartbeat tuning

Set heartbeat values in `exchange-server/.env`:

```env
REACTOR_EXCHANGE_HEARTBEAT_INTERVAL_MS=10000
REACTOR_EXCHANGE_HEARTBEAT_TIMEOUT_MS=30000
```

Apply changes:

```bash
docker compose up -d --force-recreate reactor-exchange
```

## Discovery endpoint

```bash
TOKEN="<shared-token>"
curl -s \
  -H "Authorization: Bearer ${TOKEN}" \
  http://127.0.0.1:7070/nodes
```

Notes:
- endpoint path: `/nodes`
- returns `401` when token is missing or invalid

## Runtime and connections

```bash
docker compose exec reactor-exchange node daemonctl.js status
docker compose logs -f reactor-exchange
docker compose exec reactor-exchange cat /var/lib/reactor/exchange-active-connections.json
```
