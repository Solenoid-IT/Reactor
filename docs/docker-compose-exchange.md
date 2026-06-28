# Reactor Exchange with Docker Compose

This guide provides the fastest way to run Reactor on Linux with Docker Compose.
You can run:
- only Exchange server
- only Client node
- both Exchange and Client in the same compose stack

## Files included

- `Dockerfile.daemon`
- `docker-compose.exchange.yml`
- `.env.example`

The services run `daemon.js` in headless mode and use `REACTOR_WORKING_MODE`.

## Requirements

- Docker Engine
- Docker Compose plugin (`docker compose`)

## Prepare environment file

Create your local `.env` file from template:

```bash
cp .env.example .env
```

Edit `.env` for your setup:
- `REACTOR_EXCHANGE_PORT`
- `REACTOR_EXCHANGE_TOKEN` (optional; can be generated later)
- `REACTOR_CLIENT_PORT`
- `REACTOR_EXCHANGE_HOST`
- `REACTOR_EXCHANGE_TLS`

## Start profiles

Start only Exchange profile:

```bash
docker compose -f docker-compose.exchange.yml --profile exchange up -d --build
```

Start only Client profile:

```bash
docker compose -f docker-compose.exchange.yml --profile client up -d --build
```

Start both profiles:

From project root:

```bash
docker compose -f docker-compose.exchange.yml --profile exchange --profile client up -d --build
```

Check status:

```bash
docker compose -f docker-compose.exchange.yml ps
docker compose -f docker-compose.exchange.yml logs -f
```

## Configure name, token, and verify

Set node name:

```bash
docker compose -f docker-compose.exchange.yml exec reactor-exchange node daemonctl.js set-name reactor-exchange-1
```

Generate token:

```bash
docker compose -f docker-compose.exchange.yml exec reactor-exchange node daemonctl.js generate-exchange-token
```

Read token and keep it for client nodes:

```bash
docker compose -f docker-compose.exchange.yml exec reactor-exchange node daemonctl.js get-exchange-token
```

Verify Exchange config:

```bash
docker compose -f docker-compose.exchange.yml exec reactor-exchange node daemonctl.js get-exchange
```

If you run the client profile too, verify client config:

```bash
docker compose -f docker-compose.exchange.yml exec reactor-client node daemonctl.js get-exchange
```

## Data persistence

Runtime data is stored in dedicated Docker volumes mounted at `/data`:
- `reactor-exchange-data`
- `reactor-client-data`

Important persisted files:
- `/data/working-mode.json`
- `/data/name`
- `/data/projects/`
- `/data/activity.log`
- `/data/tls/cert.pem`
- `/data/tls/key.pem`

## TLS / WSS (optional)

To enable WSS, place TLS files in `/data/tls` inside the container.

Generate self-signed cert directly in container:

```bash
docker compose -f docker-compose.exchange.yml exec reactor-exchange sh -lc 'mkdir -p /data/tls && openssl req -x509 -newkey rsa:2048 -keyout /data/tls/key.pem -out /data/tls/cert.pem -days 3650 -nodes -subj "/CN=reactor-exchange-1"'
```

Enable TLS in Exchange config:

```bash
docker compose -f docker-compose.exchange.yml exec reactor-exchange node daemonctl.js set-exchange exchange 7070 --tls
```

Restart service:

```bash
docker compose -f docker-compose.exchange.yml restart
```

## Configure a node client to connect

On a Reactor node (outside this container):

```bash
node daemonctl.js set-name node-1
node daemonctl.js set-exchange node EXCHANGE_HOST_OR_IP 7070 --token YOUR_SHARED_TOKEN
```

With TLS:

```bash
node daemonctl.js set-exchange node EXCHANGE_HOST_OR_IP 7070 --tls --token YOUR_SHARED_TOKEN
```

## Stop / remove

Stop:

```bash
docker compose -f docker-compose.exchange.yml down
```

Stop and remove persisted data volume:

```bash
docker compose -f docker-compose.exchange.yml down -v
```
