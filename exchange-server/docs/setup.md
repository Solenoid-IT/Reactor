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
- `USER_UID` / `USER_GID` (must match host owner of `exchange-server/cert/`; default `1000:1000`)

Example:

```env
PORT=7070
TLS=false
TLS_MODE=direct
TOKEN=your_shared_token_here
```


## 2) Build the image
Start Exchange first with Docker build:

```bash
docker compose up -d --build
```


## TLS configuration

`TLS` enables secure client transport. `TLS_MODE` controls where TLS is terminated.

- `TLS=false`: Exchange serves `http://` and `ws://`
- `TLS=true` + `TLS_MODE=direct`: Exchange serves `https://` and `wss://` directly on `PORT`
- `TLS=true` + `TLS_MODE=proxy`: Exchange serves internal `http://` and `ws://`; reverse proxy exposes HTTPS/WSS

Startup behavior when TLS files are missing:

- if `TLS=true` + `TLS_MODE=direct` but `cert.pem` / `key.pem` are not found at boot, Exchange logs a warning
- in that case, Exchange continues to run in plain `http://` and `ws://` mode (no TLS) instead of stopping
- when certificate files are created later, Exchange can promote automatically to `https://` and `wss://` without Docker container restart

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

If you want direct TLS, generate certificate files from inside the running container:

```bash
docker compose exec reactor-exchange node daemonctl.js generate-tls-cert
```

For Docker deployments in this repository, `generate-tls-cert` schedules an automatic container restart after certificate creation.
This gives a predictable setup flow: build, generate certificate, automatic restart with TLS files available.

Optional parameters:

```bash
docker compose exec reactor-exchange node daemonctl.js generate-tls-cert --bits 4096 --days 3650
```

Generate a CA-signed certificate (Let's Encrypt via certbot webroot):

```bash
docker compose exec reactor-exchange node daemonctl.js generate-tls-cert --signed --cn exchange.example.com --domain ws.exchange.example.com --webroot /var/www/html --bits 4096
```

Notes for `--signed`:

- `--days` is not accepted for signed certificates.
- certbot and access to `/etc/letsencrypt/live/<domain>` must be available in the execution environment.
- `--webroot` must point to a webroot already serving ACME challenge files for the requested domains.

You can normalize permissions from inside the container too:

```bash
docker compose exec reactor-exchange node daemonctl.js fix-tls-perms
```

For Docker deployments, generating the certificate from inside the container is recommended because files are created with the same runtime user used by the daemon.

Generated files are written on host at:

- `exchange-server/cert/cert.pem`
- `exchange-server/cert/key.pem`

Inside container, the same files are available at:

- `/data/tls/cert.pem`
- `/data/tls/key.pem`

With Docker Compose in this repository, `/data/tls` is bind-mounted from `exchange-server/cert/`.
Ownership is stabilized by running the container with `USER_UID:USER_GID`, so cert replacement from host is straightforward.

Replace certificates from host (no container shell needed):

1. Copy new `cert.pem` and `key.pem` into `exchange-server/cert/`
2. Restart Exchange container:

```bash
docker compose restart reactor-exchange
```

Use cases:

- local testing with self-signed certs
- direct TLS bootstrap without external proxy
- bootstrap certs for a reverse proxy in internal environments

For public production endpoints, use CA-issued certificates (for example Let's Encrypt) on the reverse proxy.



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
