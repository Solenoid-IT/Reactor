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

Notes:
- the Exchange container reads its configuration from the mounted `.env` file.
- the Exchange container bootstraps through a dedicated wrapper, so it stays isolated from the generic node daemon startup.
- Use `docker compose up -d --build` only when application code or Dockerfile changes.

## Optional TURN service

If you need TURN/STUN for WebRTC relay, run coturn independently from its own folder and docs:

- `coturn-server/docker-compose.yml`
- `coturn-server/README.md`

## Configure and verify

Set node name:

```bash
docker compose exec reactor-exchange node daemonctl.js set-name reactor-exchange-1
```