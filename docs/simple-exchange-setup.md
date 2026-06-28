# Reactor Exchange (Docker) - minimal setup

This guide includes only the minimum required steps to:
- run Reactor as exchange on a Linux server with Docker
- generate the exchange token via CLI
- enable TLS (HTTPS/WSS)

## 1) Prerequisites

- Docker and Docker Compose installed
- Reactor repository already present on the server

## 2) Configure .env

In the project root, create or update .env:

```env
REACTOR_WORKING_MODE=exchange
REACTOR_NAME=exchange-server
REACTOR_EXCHANGE_PORT=7070
REACTOR_EXCHANGE_TOKEN=
```

## 3) Start the exchange container

From the project root:

```bash
docker compose --profile exchange up -d --build
```

Check status:

```bash
docker compose ps
```

## 4) Generate token via CLI

Generate the token inside the running container:

```bash
docker compose exec reactor-exchange node daemonctl.js generate-exchange-token
```

Show the current token:

```bash
docker compose exec reactor-exchange node daemonctl.js get-exchange-token
```

Use this token on clients that need to connect to the exchange.

## 5) TLS (HTTPS/WSS)

Generate a self-signed cert.pem/key.pem directly via CLI:

```bash
docker compose exec reactor-exchange node daemonctl.js generate-tls-cert --bits 4096 --days 3650
```

This creates:
- /data/tls/cert.pem
- /data/tls/key.pem

After restart, Exchange listens on the same port with TLS enabled:
- HTTPS on 7070
- WSS on 7070

Client example variables:

```env
REACTOR_EXCHANGE_HOST=<your-server-ip-or-dns>
REACTOR_EXCHANGE_PORT=7070
REACTOR_EXCHANGE_TLS=true
REACTOR_EXCHANGE_TOKEN=<token>
```
