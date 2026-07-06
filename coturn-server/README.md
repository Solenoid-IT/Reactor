## Configure

Edit `turnserver.conf`:

- `realm`
- `user=<username>:<password>`
- `listening-port`
- `tls-listening-port`
- `cert` / `pkey`
- `min-port` / `max-port`
- optional `external-ip`

Generate a self-signed certificate into `cert/`:

```bash
cd coturn-server
node coturnctl.js generate-tls-cert --cn turn.local
```

Normalize permissions for existing certificate files:

```bash
node coturnctl.js fix-tls-perms
```

## Start

```bash
cd coturn-server
docker compose up -d
```

## Apply config changes

After editing `turnserver.conf`:

```bash
docker compose up -d --force-recreate coturn
```

## Logs

```bash
docker compose logs -f coturn
```

## Stop

```bash
docker compose down
```
