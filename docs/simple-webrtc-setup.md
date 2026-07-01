# WebRTC Setup (STUN/TURN) with Docker Compose

This guide explains how to configure a WebRTC relay server (STUN/TURN) using `coturn` in the current Reactor Docker Compose stack.

Goal:
- keep current Exchange logic unchanged (control-plane)
- add TURN/STUN support for peer-to-peer connectivity reliability
- use TURN relay only when direct peer connectivity is not possible

## Architecture Overview

Recommended model:
- Exchange: signaling, authentication, peer presence
- WebRTC data channel: direct peer-to-peer data path
- TURN/STUN (coturn): NAT traversal and fallback relay for difficult networks

## Prerequisites

- Docker Engine
- Docker Compose plugin (`docker compose`)
- Public server reachable from peers
- Open firewall ports for TURN/STUN

## 1) Configure Environment Variables

From project root:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```dotenv
# TURN/STUN server (coturn)
COTURN_REALM=reactor.example.com
COTURN_USER=reactor
COTURN_PASSWORD=replace-with-strong-password

# Public IP or DNS reachable by clients
# For production this should be set
COTURN_EXTERNAL_IP=YOUR_PUBLIC_IP_OR_DNS

COTURN_PORT=3478
COTURN_TLS_PORT=5349
COTURN_TLS_CERT_PATH=/var/lib/coturn/certs/cert.pem
COTURN_TLS_KEY_PATH=/var/lib/coturn/certs/key.pem
COTURN_MIN_RELAY_PORT=49160
COTURN_MAX_RELAY_PORT=49200
```

Notes:
- `COTURN_EXTERNAL_IP` is strongly recommended in production.
- Use a strong password for `COTURN_PASSWORD`.
- Keep relay port range reasonably small for easier firewall management.

### Generate TURN TLS certificate inside container (one command)

Run this command from project root:

```bash
docker compose --profile turn run --rm --entrypoint sh coturn -lc 'mkdir -p /var/lib/coturn/certs && openssl req -x509 -newkey rsa:4096 -keyout /var/lib/coturn/certs/key.pem -out /var/lib/coturn/certs/cert.pem -days 3650 -nodes -subj "/CN=turn.local"'
```

Then start (or restart) coturn:

```bash
docker compose --profile turn up -d
```

If you changed `.env` values and need to apply them to the TURN container, recreate it:

```bash
docker compose --profile turn up -d --force-recreate coturn
```

Notes:
- Certificate and key are persisted in Docker volume `reactor-coturn-data`.
- For production use a real certificate and set CN/SAN to your public TURN hostname.

## 2) Start Services

Start the default stack (Exchange + TURN/coturn):

```bash
docker compose up -d --build
```

Optional: start the client container too:

```bash
docker compose --profile client up -d --build
```

Check service status:

```bash
docker compose ps
```

Read coturn logs:

```bash
docker compose logs -f coturn
```

## 3) Firewall / Network Rules

Allow inbound to the host:

- UDP `3478` (STUN/TURN)
- TCP `3478` (TURN over TCP)
- TCP `5349` (TURN over TLS)
- UDP relay range `49160-49200` (or your configured range)

If you use cloud security groups, open the same ports there.

## 4) TURN URL Configuration in Clients

Use these ICE server entries in your WebRTC implementation:

- `stun:YOUR_HOST:3478`
- `turn:YOUR_HOST:3478?transport=udp`
- `turn:YOUR_HOST:3478?transport=tcp`
- `turns:YOUR_HOST:5349?transport=tcp` (if TLS configured)

Credentials:
- username: `COTURN_USER`
- credential: `COTURN_PASSWORD`

## 5) Production Hardening (Recommended)

- Prefer DNS hostname in `COTURN_REALM` and client URLs.
- Use strong secrets (`COTURN_PASSWORD`).
- Enable TLS for TURN (`5349`) with valid certificates.
- Restrict relay port range and monitor usage.
- Rotate TURN credentials periodically.

## 6) Verify Connectivity

Basic checks:

```bash
docker compose --profile turn config
```

```bash
docker compose logs -f coturn
```

When peers connect, check logs for allocations/relay usage.

Expected behavior:
- direct P2P when possible
- TURN relay only when direct path fails

## 7) Troubleshooting

If peers cannot connect:

1. Verify `COTURN_EXTERNAL_IP` is correct.
2. Verify host firewall and cloud security groups allow required ports.
3. Verify client ICE config includes both STUN and TURN entries.
4. Verify TURN credentials match `.env` values.
5. Verify NAT-heavy mobile networks may require TURN relay more often.

If TURN allocates but traffic is unstable:

1. Increase relay UDP range if heavily loaded.
2. Ensure no upstream firewall/NAT timeout is killing UDP flows.
3. Prefer TURN over TLS (`5349`) in restrictive enterprise networks.

## 8) Operations

Stop TURN only:

```bash
docker compose --profile turn down
```

Stop whole stack:

```bash
docker compose down
```

Preserve runtime data by default (named volume `reactor-coturn-data`).

To remove all persisted data volumes:

```bash
docker compose down -v
```
