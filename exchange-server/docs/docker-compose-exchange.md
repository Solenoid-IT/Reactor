# Reactor Exchange with Docker Compose

This guide provides the fastest way to run Reactor on Linux with Docker Compose.
The Exchange stack is standalone and does not mount or depend on coturn files.

## Files included

- `Dockerfile.daemon`
- `docker-compose.yml`
- `.env.example`

The Exchange service runs `daemon.js`, which boots the local Exchange runtime and reads Exchange settings from the mounted `.env` file.

## Requirements

- Docker Engine
- Docker Compose plugin (`docker compose`)

## Prepare environment file

Create your local `.env` file from template:

```bash
cp .env.example .env
```

Edit `.env` for your setup:
- `PORT`
- `TLS`
- `TLS_MODE` (`direct` or `proxy`)
- `USER_UID` and `USER_GID` (must match host owner of `exchange-server/cert`, usually `1000:1000`)
- `TOKEN` (optional; can be generated later)

## Start services

From the `exchange-server` directory:

Start the Exchange stack (reactor-exchange):

```bash
docker compose up -d
```

The container entrypoint is the local Exchange wrapper, so the service does not depend on the root daemon files.

Check status:

```bash
docker compose ps
docker compose logs -f
```

Generate direct TLS certificate (optional):

```bash
docker compose exec reactor-exchange node daemonctl.js generate-tls-cert
```

Generate CA-signed TLS certificate (Let's Encrypt via certbot webroot):

```bash
docker compose exec reactor-exchange node daemonctl.js generate-tls-cert --signed --cn exchange.example.com --domain ws.exchange.example.com --webroot /var/www/html --bits 4096
```

`--signed` requires certbot and access to `/etc/letsencrypt/live/<domain>` in the runtime environment.

In this setup, certificate generation runs inside the container and schedules an automatic container restart.
No manual permission fix is required when `USER_UID`/`USER_GID` match the host ownership of `exchange-server/cert`.
The TLS directory is bind-mounted as `exchange-server/cert -> /data/tls`, so certificates can also be replaced directly from host.

Notes:
- the Exchange container reads its configuration from the mounted `.env` file.
- the Exchange container bootstraps through a dedicated wrapper, so it stays isolated from the generic node daemon startup.
- Use `docker compose up -d --build` only when application code or Dockerfile changes.

## Optional TURN service

If you need TURN/STUN for WebRTC relay, run coturn independently from its own folder and docs:

- `coturn-server/docker-compose.yml`
- `coturn-server/README.md`

## Configure and verify

Check daemon status:

```bash
docker compose exec reactor-exchange node daemonctl.js status
```

Direct TLS mode (`TLS=true`, `TLS_MODE=direct`):

```bash
curl -sk https://127.0.0.1:${PORT:-7070}/health
```

Proxy mode or plain HTTP (`TLS_MODE=proxy` or `TLS=false`):

```bash
curl -s http://127.0.0.1:${PORT:-7070}/health
```