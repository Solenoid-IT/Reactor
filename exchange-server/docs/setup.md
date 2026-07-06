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
- `TLS` (`false` for plain HTTP/WS, `true` when clients must connect through HTTPS/WSS)

Example:

```env
PORT=7070
TLS=false
TOKEN=your_shared_token_here
```

## TLS configuration

`TLS` in `.env` is a client-facing mode flag for Reactor nodes.

- `TLS=false`: nodes connect to Exchange with `http://` and `ws://`
- `TLS=true`: nodes connect to Exchange with `https://` and `wss://`

Recommended production setup:

1. Keep Exchange container on internal plain HTTP (`reactor-exchange:7070`)
2. Put a reverse proxy in front (Nginx/Caddy/Traefik) for TLS termination
3. Configure certificates on the proxy
4. Expose only proxy `443`
5. Set `TLS=true` in `exchange-server/.env` and use the public host in Reactor node config

Note: the current Exchange daemon process itself does not directly terminate TLS. HTTPS/WSS should be terminated by the reverse proxy.

## Generate TLS certificate

You can generate a self-signed TLS certificate with `daemonctl.js`.

From `exchange-server/`:

```bash
docker compose exec reactor-exchange node daemonctl.js generate-tls-cert
```

Optional parameters:

```bash
docker compose exec reactor-exchange node daemonctl.js generate-tls-cert --bits 4096 --days 3650
```

Generated files are stored in the Exchange data volume:

- `/data/tls/cert.pem`
- `/data/tls/key.pem`

Use cases:

- local testing with self-signed certs
- bootstrap certs for a reverse proxy in internal environments

For public production endpoints, use CA-issued certificates (for example Let's Encrypt) on the reverse proxy.

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
