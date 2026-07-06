# Minimal Docker Setup (Exchange Server)

Use these steps to configure and start Reactor Exchange with Docker Compose.

## 1) Prepare `.env`

From `exchange-server/`:

```bash
cp .env.example .env
```

Set at least:

- `PORT` (default `7070`)
- `TOKEN` (shared secret used by Reactor nodes)

Example:

```env
PORT=7070
TOKEN=your_shared_token_here
```

## 2) Start the container

From `exchange-server/`:

```bash
docker compose up -d --build
```

## 3) Check status

```bash
docker compose ps
docker compose logs -f reactor-exchange
docker compose exec reactor-exchange node daemonctl.js status
```

## 4) Quick API check

```bash
curl -s http://127.0.0.1:7070/health
curl -s -H "Authorization: Bearer your_shared_token_here" http://127.0.0.1:7070/nodes
```

If `/nodes` returns `401`, verify that the token in the request matches `TOKEN` in `exchange-server/.env`.
