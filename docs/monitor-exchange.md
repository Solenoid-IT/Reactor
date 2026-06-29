# Simple Exchange Setup

Quick setup to run Reactor as Exchange and monitor connected nodes.

## Start daemon as Exchange

```bash
REACTOR_DATA_DIR=/var/lib/reactor \
REACTOR_WORKING_MODE=exchange \
node daemon.js
```

## Optional heartbeat tuning (HA)

Use environment variables to tune WebSocket heartbeat:

```bash
REACTOR_EXCHANGE_HEARTBEAT_INTERVAL_MS=15000
REACTOR_EXCHANGE_HEARTBEAT_TIMEOUT_MS=45000
```

Example:

```bash
REACTOR_DATA_DIR=/var/lib/reactor \
REACTOR_WORKING_MODE=exchange \
REACTOR_EXCHANGE_HEARTBEAT_INTERVAL_MS=10000 \
REACTOR_EXCHANGE_HEARTBEAT_TIMEOUT_MS=30000 \
node daemon.js
```

## Generate and read token

```bash
REACTOR_DATA_DIR=/var/lib/reactor node daemonctl.js generate-exchange-token
REACTOR_DATA_DIR=/var/lib/reactor node daemonctl.js get-exchange-token
```

## Optional discovery endpoint (HTTP)

Expose an HTTP endpoint that lists currently connected Exchange nodes (name, ip, port, connectedAt, lastSeenAt, userAgent):

```bash
REACTOR_DATA_DIR=/var/lib/reactor node daemonctl.js set-discovery on
```

Disable it:

```bash
REACTOR_DATA_DIR=/var/lib/reactor node daemonctl.js set-discovery off
```

When enabled, query it with the same Bearer token used by nodes to register against Exchange:

```bash
TOKEN="$(REACTOR_DATA_DIR=/var/lib/reactor node daemonctl.js get-exchange-token | awk -F'  ' '/Token:/ {print $2}')"
curl -s \
	-H "Authorization: Bearer ${TOKEN}" \
	http://127.0.0.1:7070/nodes | jq .
```

Notes:
- endpoint path: `/nodes`
- available only in `exchange` mode
- returns `401` when token is missing/invalid
- returns `404` when discovery is disabled

## Monitor connected nodes

1. Runtime status and heartbeat metrics:

```bash
REACTOR_DATA_DIR=/var/lib/reactor node daemonctl.js get-exchange
```

The output now includes:
- heartbeat interval/timeout
- server heartbeat counters (pings/pongs/terminated)
- connected client details (name/address/connected time)
- connection log file path (`ConnLog`)
- active connections JSON snapshot path (`ConnJSN`)

2. Dedicated connection events log:

```bash
tail -f /var/lib/reactor/exchange-connections.log
```

Logged events include:
- `CONNECTION_OPEN`
- `CLIENT_REGISTERED`
- `CLIENT_DISCONNECTED`
- `CLIENT_TERMINATED_HEARTBEAT`
- `AUTH_REJECTED_UPGRADE`
- `AUTH_REJECTED_REGISTER`

3. Active connections JSON snapshot:

```bash
cat /var/lib/reactor/exchange-active-connections.json
```

This file contains an array of currently connected nodes, for example:

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

