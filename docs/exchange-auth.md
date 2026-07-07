# Exchange Authentication Modes

Reactor nodes can authenticate with an Exchange server in two ways: **Token** mode and **User/Password** mode.
Both modes are fully supported on desktop (Mac, Linux) and Android.

---

## Mode 1 — Token (Bearer)

A single shared secret is distributed to every node that should connect to the Exchange.

```
Authorization: Bearer <token>
```

**Behavior:**
- A node authenticated with a token can discover and communicate with **all other nodes** connected to the same Exchange, regardless of which user or network they belong to.
- Suitable for trusted environments where all nodes are under the same administrative control.

**When to use it:**
- Small or closed deployments where all nodes are trusted.
- Single-tenant setups.
- Backward-compatible with older Exchange configurations.

**How to configure (UI):**
1. In Settings → Connections → EXCHANGE, enable "Use EXCHANGE".
2. Set Host, Port, TLS.
3. Select **Token** in the Auth selector.
4. Paste the shared token.

---

## Mode 2 — User / Password (Basic)

Each node authenticates with an individual username and password.

```
Authorization: Basic <base64(user:password)>
```

Plus JSON body `{ "user": "...", "password": "..." }` on `POST /register`.

**Behavior:**
- A node authenticated as a user can discover and communicate **only with nodes that share at least one network** with that user (as configured in the Exchange auth database).
- Different users are isolated from each other unless they share a common network entry.
- Suitable for multi-tenant deployments where access partitioning is required.

**When to use it:**
- Multi-tenant or multi-organization setups.
- When different groups of nodes must be kept isolated.
- When you want per-user access control managed on the Exchange side (via the Exchange Admin UI).

**How to configure (UI):**
1. In Settings → Connections → EXCHANGE, enable "Use EXCHANGE".
2. Set Host, Port, TLS.
3. Select **User / Password** in the Auth selector.
4. Enter the username and password assigned in the Exchange auth database.

---

## Selection Logic

The client uses the mode based on what is configured:

| Token set | User set | Auth sent |
|---|---|---|
| ✅ yes | — | `Bearer <token>` |
| ❌ no | ✅ yes | `Basic <base64(user:password)>` |
| ❌ no | ❌ no | no `Authorization` header (Exchange must have no TOKEN configured) |

Token takes priority over user/password when both are set.

---

## Exchange Server Side

The Exchange server (`reactor-exchange`) validates credentials on `POST /register` before issuing a `sessionId`. The WebSocket connection (`/ws?sessionId=...`) itself does not carry credentials — authentication is bound to the session established at registration time.

To add users and networks on the Exchange side, use the Exchange Admin UI (runs on localhost by default).

See [reactor-exchange/docs/setup.md](../../reactor-exchange/docs/setup.md) and [reactor-exchange/docs/exchange.md](../../reactor-exchange/docs/exchange.md) for Exchange server configuration.

---

## Config Persistence and Cross-Platform Import/Export

All connection parameters (host, port, TLS, token, user, password, STUN, TURN) are saved in `connections.json`.

The file uses a **nested format** on desktop and a **flat format** on Android, but both sides read both formats transparently — no data is lost when exporting from one platform and importing on the other.

### Export from Mac, import on Android (and vice versa)

1. On the source device: Settings → Backup → Export Backup (enable "Include connections").
2. Transfer the `.zip` file to the target device.
3. On the target device: Settings → Backup → Import Backup.
4. All Exchange, STUN, and TURN parameters are restored automatically. No manual re-entry needed.

### What is preserved

| Parameter | Desktop | Android |
|---|---|---|
| Exchange host | ✅ | ✅ |
| Exchange port | ✅ | ✅ |
| TLS | ✅ | ✅ |
| Token | ✅ | ✅ |
| User | ✅ | ✅ |
| Password | ✅ | ✅ |
| STUN host / port | ✅ | ✅ |
| TURN host / port / credentials | ✅ | ✅ |
