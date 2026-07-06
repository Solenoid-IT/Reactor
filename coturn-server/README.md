## Configure

Edit `turnserver.conf`:

- `realm`
- `user=<username>:<password>`
- `listening-port`
- `tls-listening-port`
- `cert` / `pkey`
- `min-port` / `max-port`
- optional `external-ip`

Generate a self-signed certificate into `cert/` from inside the running container (recommended to avoid host/container permission mismatches):

```bash
cd coturn-server
docker compose up -d
docker compose exec coturn sh -lc "openssl req -x509 -newkey rsa:2048 -keyout /var/lib/coturn/certs/key.pem -out /var/lib/coturn/certs/cert.pem -days 3650 -nodes -subj '/CN=turn.local' && chmod 700 /var/lib/coturn/certs && chmod 644 /var/lib/coturn/certs/cert.pem && chmod 600 /var/lib/coturn/certs/key.pem"
```

Apply/reload TLS files in coturn:

```bash
docker compose up -d --force-recreate coturn
```

If you already generated certs from host and still get TLS permission errors, regenerate them using `docker compose exec` as shown above.

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
