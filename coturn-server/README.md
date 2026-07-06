## Configure

Edit `turnserver.conf`:

- `realm`
- `user=<username>:<password>`
- `listening-port`
- `tls-listening-port`
- `cert` / `pkey`
- `min-port` / `max-port`
- optional `external-ip`

Create a local `.env` from `.env.example` and set `USER_UID` and `USER_GID` to match the owner of `cert/` on the host. The container runs with those IDs so TLS files can be created without permission issues.

Generate a self-signed certificate into `cert/` from inside the running container:

```bash
cd coturn-server
docker compose up -d
docker compose exec coturn sh -lc "openssl req -x509 -newkey rsa:2048 -keyout /var/lib/coturn/certs/key.pem -out /var/lib/coturn/certs/cert.pem -days 3650 -nodes -subj '/CN=turn.local' && chmod 700 /var/lib/coturn/certs && chmod 644 /var/lib/coturn/certs/cert.pem && chmod 600 /var/lib/coturn/certs/key.pem"
```

When you run `node coturnctl.js generate-tls-cert` inside the container, the container restarts automatically so the new certificate is picked up.

If you replace `cert.pem` or `key.pem` from the host, restart the container manually:

```bash
docker compose restart coturn
```

If you still get TLS permission errors, regenerate the files from inside the container as shown above.

## Start

```bash
cd coturn-server
docker compose up -d
```

## Apply config changes

After editing `turnserver.conf`, restart the container:

```bash
docker compose restart coturn
```

## Logs

```bash
docker compose logs -f coturn
```

## Stop

```bash
docker compose down
```
