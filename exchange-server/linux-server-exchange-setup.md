# Reactor on Linux Server as Exchange

This guide explains how to install Reactor on an Ubuntu or Debian-like server, run it as a headless daemon, configure it as an Exchange server, and generate the shared authentication token used by Reactor nodes.

If you prefer containerized deployment, use the Docker Compose guide:
- `docker-compose-exchange.md`

## What Exchange mode does

When Reactor runs in `exchange` mode it acts as a WebSocket router for other Reactor nodes.

Important behavior:
- The Exchange WebSocket server is attached to the same HTTP server used by the daemon.
- HTTP and WS/WSS use the same port.
- If a token is configured, client nodes must authenticate with `Authorization: Bearer <token>` during the WebSocket upgrade.

## Requirements

Install these packages first:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs npm git openssl
```

Verify the installation:

```bash
node -v
npm -v
openssl version
```

Recommended minimums:
- Node.js 20+
- npm
- openssl

## Recommended filesystem layout

Recommended paths:
- Application code: `/opt/reactor`
- Runtime data: `/var/lib/reactor`
- Runtime user: `reactor`

The runtime data directory will contain:
- `working-mode.json` for Exchange configuration
- `name` for the Reactor node name
- `endpoints/` for endpoints
- `activity.log` for daemon activity
- `tls/` for TLS certificates
- `reactor-daemon.sock` for local daemon control

## Install Reactor

Create a dedicated runtime user and the required directories:

```bash
sudo useradd --system --home /var/lib/reactor --create-home --shell /usr/sbin/nologin reactor
sudo mkdir -p /opt/reactor
sudo mkdir -p /var/lib/reactor
sudo chown -R reactor:reactor /var/lib/reactor
```

Copy or clone the project into `/opt/reactor` and install dependencies:

```bash
cd /opt/reactor
sudo npm install
```

If you want the static web UI bundle available on the server too, build it once:

```bash
sudo npm run ui:install
sudo npm run ui:build
```

This step is optional for pure headless Exchange usage.

## Install the systemd service

A service template is already included in `reactor.service`.

Copy it into systemd:

```bash
sudo cp /opt/reactor/reactor.service /etc/systemd/system/reactor.service
```

The defaults in the template are:
- `User=reactor`
- `Group=reactor`
- `WorkingDirectory=/opt/reactor`
- `ExecStart=/usr/bin/node /opt/reactor/daemon.js`
- `Environment=REACTOR_DATA_DIR=/var/lib/reactor`

Reload and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now reactor
sudo systemctl status reactor
```

Follow logs:

```bash
sudo journalctl -u reactor -f
```

## Important note about environment variables

The daemon supports Exchange configuration from environment variables, but they have higher priority than the configuration saved at runtime.

That means:
- if you set `REACTOR_WORKING_MODE`, `REACTOR_EXCHANGE_HOST`, `REACTOR_EXCHANGE_PORT`, `REACTOR_EXCHANGE_TLS`, or `REACTOR_EXCHANGE_TOKEN` inside the service file
- then later changes done with `daemonctl.js` may appear ignored after a restart

Recommended approach:
- keep `REACTOR_DATA_DIR` in the systemd unit
- configure Exchange mode, port, TLS, and token through `daemonctl.js`

Use environment variables in the unit only if you want a fully static, locked configuration.

## Configure Reactor as Exchange

All commands below assume:
- code is in `/opt/reactor`
- runtime data is in `/var/lib/reactor`
- the daemon is already running

### 1. Set the Reactor name

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-name reactor-exchange-1
```

### 2. Set the HTTP port

The Exchange server uses the same port as the daemon HTTP server. Example with port `7070`:

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-port 7070
```

### 3. Generate the shared Exchange token

This creates and stores the token in `working-mode.json`.

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js generate-exchange-token
```

You can also read it back later:

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js get-exchange-token
```

### 4. Enable Exchange mode

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-exchange exchange 7070
```

### 5. Verify the Exchange configuration

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js get-exchange
```

Expected output should show at least:
- `Mode: exchange`
- `Port: 7070`
- `Active: yes`
- `Token: configured`

## Open the firewall

If you use `ufw`, open the chosen port:

```bash
sudo ufw allow 7070/tcp
sudo ufw status
```

If you choose another port, open that port instead.

## Optional: enable TLS for HTTPS and WSS

If TLS files are present, Reactor automatically upgrades:
- HTTP to HTTPS
- WS to WSS

Expected certificate paths:
- `/var/lib/reactor/tls/cert.pem`
- `/var/lib/reactor/tls/key.pem`

Create a self-signed certificate:

```bash
sudo mkdir -p /var/lib/reactor/tls
sudo openssl req -x509 -newkey rsa:2048 -keyout /var/lib/reactor/tls/key.pem -out /var/lib/reactor/tls/cert.pem -days 3650 -nodes -subj "/CN=reactor-exchange-1"
sudo chown -R reactor:reactor /var/lib/reactor/tls
sudo chmod 600 /var/lib/reactor/tls/key.pem
sudo chmod 644 /var/lib/reactor/tls/cert.pem
sudo systemctl restart reactor
```

Then enable TLS in the Exchange configuration:

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-exchange exchange 7070 --tls
```

Verify again:

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js get-exchange
```

## Configure a Linux node to use this Exchange

On another Linux machine running Reactor, configure the node to connect to this Exchange server.

Set a name first:

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-name node-1
```

Configure the node in client mode without TLS:

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-exchange node exchange.example.com 7070 --token YOUR_SHARED_TOKEN
```

Or with TLS enabled:

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-exchange node exchange.example.com 7070 --tls --token YOUR_SHARED_TOKEN
```

Check the node configuration:

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js get-exchange
```

## Persisted files to know

With `REACTOR_DATA_DIR=/var/lib/reactor`, the important files are:

- `/var/lib/reactor/working-mode.json`
- `/var/lib/reactor/name`
- `/var/lib/reactor/endpoints/`
- `/var/lib/reactor/activity.log`
- `/var/lib/reactor/tls/cert.pem`
- `/var/lib/reactor/tls/key.pem`
- `/var/lib/reactor/reactor-daemon.sock`

## Troubleshooting

### daemonctl cannot connect to daemon socket

Use the same `REACTOR_DATA_DIR` for both the service and the CLI commands:

```bash
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js status
```

### Exchange settings are not changing after restart

Check whether the systemd unit contains fixed Exchange environment variables. If they are present, they override the saved configuration.

Inspect the service:

```bash
sudo systemctl cat reactor
```

### Service does not start

Check logs:

```bash
sudo journalctl -u reactor -n 200 --no-pager
```

### WSS clients do not connect

Check:
- `cert.pem` and `key.pem` exist in `/var/lib/reactor/tls`
- file ownership is `reactor:reactor`
- Exchange config was updated with `--tls`
- firewall allows the configured port

## Quick setup summary

Standard Ubuntu Exchange setup on port `7070`:

```bash
sudo useradd --system --home /var/lib/reactor --create-home --shell /usr/sbin/nologin reactor
sudo mkdir -p /opt/reactor /var/lib/reactor
sudo chown -R reactor:reactor /var/lib/reactor
cd /opt/reactor
sudo npm install
sudo cp /opt/reactor/reactor.service /etc/systemd/system/reactor.service
sudo systemctl daemon-reload
sudo systemctl enable --now reactor
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-name reactor-exchange-1
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-port 7070
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js generate-exchange-token
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js set-exchange exchange 7070
sudo -u reactor env REACTOR_DATA_DIR=/var/lib/reactor node /opt/reactor/daemonctl.js get-exchange
sudo ufw allow 7070/tcp
```
