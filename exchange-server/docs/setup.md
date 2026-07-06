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
- `TLS_MODE` (`direct` for native TLS in Exchange, `proxy` for TLS offload on reverse proxy)

Example:

```env
PORT=7070
TLS=false
TLS_MODE=direct
TOKEN=your_shared_token_here
```

## TLS configuration

`TLS` enables secure client transport. `TLS_MODE` controls where TLS is terminated.

- `TLS=false`: Exchange serves `http://` and `ws://`
- `TLS=true` + `TLS_MODE=direct`: Exchange serves `https://` and `wss://` directly on `PORT`
- `TLS=true` + `TLS_MODE=proxy`: Exchange serves internal `http://` and `ws://`; reverse proxy exposes HTTPS/WSS

### Direct TLS mode (no proxy)

1. Set `TLS=true`
2. Set `TLS_MODE=direct`
3. Ensure certificate files exist (`cert.pem`, `key.pem`)
4. Start Exchange and connect clients with `https://` / `wss://`

### Proxy TLS mode (optional)

1. Keep Exchange container on internal plain HTTP (`reactor-exchange:7070`)
2. Put a reverse proxy in front (Nginx/Caddy/Traefik) for TLS termination
3. Configure certificates on the proxy
4. Expose only proxy `443`
5. Set `TLS=true` and `TLS_MODE=proxy` in `exchange-server/.env`
6. Use the public host in Reactor node config

## Generate TLS certificate

You can generate a self-signed TLS certificate with `daemonctl.js`.

From `exchange-server/`:

```bash
node daemonctl.js generate-tls-cert
```

This command is intended to be run before starting Docker.

Optional parameters:

```bash
node daemonctl.js generate-tls-cert --bits 4096 --days 3650
```

Alternative (if the container is already running):

```bash
docker compose exec reactor-exchange node daemonctl.js generate-tls-cert
```

Generated files are written on host at:

- `exchange-server/cert/cert.pem`
- `exchange-server/cert/key.pem`

Inside container, the same files are available at:

- `/data/tls/cert.pem`
- `/data/tls/key.pem`

With Docker Compose in this repository, `/data/tls` is bind-mounted from `exchange-server/cert/`.
So you can also provide your own certificate files directly from host by placing them there before starting the container.

Use cases:

- local testing with self-signed certs
- direct TLS bootstrap without external proxy
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

If `TLS=true` and `TLS_MODE=direct`:

```bash
curl -sk https://127.0.0.1:7070/health
curl -sk -H "Authorization: Bearer your_shared_token_here" https://127.0.0.1:7070/nodes
```

If `TLS=false` or `TLS_MODE=proxy`:

```bash
curl -s http://127.0.0.1:7070/health
curl -s -H "Authorization: Bearer your_shared_token_here" http://127.0.0.1:7070/nodes
```

If `/nodes` returns `401`, verify that the token in the request matches `TOKEN` in `exchange-server/.env`.
