# Reactor Exchange Monitor

This guide explains how to monitor Exchange when running with Docker Compose.

## Runtime status

Use `daemonctl.js status` inside the Exchange container:

```bash
docker compose exec reactor-exchange node daemonctl.js status
```

The output includes:
- heartbeat interval/timeout
- server heartbeat counters (pings/pongs/terminated)
- connected client details (name/address/connected time)
- connection log file path (`ConnLog`)
- active connections JSON snapshot path (`ConnJSN`)

## Connection events log

Use container logs for continuous monitoring:

```bash
docker compose logs -f reactor-exchange
```

Logged events include:
- `CONNECTION_OPEN`
- `CLIENT_REGISTERED`
- `CLIENT_DISCONNECTED`
- `CLIENT_TERMINATED_HEARTBEAT`
- `AUTH_REJECTED_UPGRADE`
- `AUTH_REJECTED_REGISTER`

## Active connections snapshot

Read the snapshot from inside the container:

```bash
docker compose exec reactor-exchange cat /var/lib/reactor/exchange-active-connections.json
```

Example structure:

```json
[
	{
		"name": "node-1",
		"registrationAt": "2026-06-28T20:00:00.000Z",
		"lastSeenAt": "2026-06-28T20:02:00.000Z",
		"ip": "10.0.0.21",
		"port": 51234,
		"userAgent": "Reactor/1.0"
	}
]
```
