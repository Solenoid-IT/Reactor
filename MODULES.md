# Module Architecture

Refactor of boot.js based on the **Single Responsibility Principle (SRP)**.

## Structure

```
Reactor/
├── boot.js                    # Entry point Electron
├── daemon.js                  # Entry point headless/server (Linux, macOS, Win)
├── daemonctl.js               # CLI per controllare il daemon
├── preload.js                 # IPC bridge renderer ↔ main process
├── reactor.service            # Systemd unit file per Linux
├── src/
│   ├── scheduleParser.js      # Parsing espressioni @schedule
│   ├── metadata.js            # Parsing metadati script (@state, @on, @schedule, …)
│   ├── scriptLoader.js        # Transpilazione TypeScript → CommonJS
│   ├── networkMonitor.js      # Monitoraggio connettività
│   ├── runtime.js             # Classe principale ReactorRuntime
│   ├── exchangeManager.js     # WebSocket Exchange server/client (Node.js)
│   └── platform/
│       ├── contracts.js                 # Interfacce cross-platform
│       ├── nodePlatformServices.js      # Implementazioni Node/Electron
│       ├── capacitorPlatformServices.js # Implementazioni Capacitor/mobile
│       ├── runtimeApiContracts.js       # Contratti FileSystem/HttpClient/Device/System
│       ├── nodeRuntimeApi.js            # Runtime API mapping Node
│       └── androidRuntimeApi.js         # Runtime API mapping Android
└── [other files]
```

## Modules


### `boot.js` (Entry Point)
- ✅ App lifecycle orchestration
- ✅ Directory resolution (external/bundled)
- ✅ Background mode setup
- ✅ IPC handler setup

### `scheduleParser.js`
- Parses expressions: `EVERY N SECOND|MINUTE|HOUR`
- Returns: interval in milliseconds or null

### `metadata.js`
- Extracts metadata from TypeScript comments
- Supports: `@state`, `@schedule`, `@on` (including `@on MESSAGE(...)`), `@watch`, `@mutex`

### Available Script Directives

#### `@state ENABLED|DISABLED`
Controls script execution. Default: `DISABLED`
```typescript
// @state ENABLED
```

#### `@schedule EXPRESSION`
Periodic execution. Supports: `EVERY N SECOND|MINUTE|HOUR`
```typescript
// @schedule EVERY 30 SECOND
```

#### `@on EVENT_NAME[,EVENT2,...]`
Event-driven execution. Built-in events: BOOT, WIFI_ON/OFF, NET_UP/DOWN
```typescript
// @on BOOT, NET_UP, CUSTOM_EVENT
```

Node message trigger:
```typescript
// @on MESSAGE
// @on MESSAGE(sender_1)
// @on MESSAGE(10.20.43.20:7070,sender_2)
```
`import { Node } from 'core'` and `Node.sendMessage(target, content)` dispatch POST `/message` and trigger matching MESSAGE listeners.

Node stream trigger:
```typescript
// @on STREAM
// @on STREAM(sender_1)
// @on STREAM(10.20.43.20:7070,sender_2)
```
`Node.stream(...)` and `Node.exchange().stream(...)` trigger matching STREAM listeners.
Inside `run(ctx)` you can read stream packets with `ctx.stream` methods:
- `ctx.stream.isStart()` / `isChunk()` / `isEnd()`
- `ctx.stream.getId()`, `getChunkIndex()`, `getChunkSize()`, `getMetadata()`
- `ctx.stream.readChunkBuffer()` or `ctx.stream.readChunkText()`

Stream finalization trigger:
```typescript
// @on STREAMEND
// @on STREAMEND(sender_1)
// @on STREAMEND(10.20.43.20:7070,sender_2)
```
Runtime reassembles stream chunks on disk and triggers `STREAMEND` when transfer is finalized.
Inside `run(ctx)` use `ctx.streamEnd` methods:
- `ctx.streamEnd.getId()`, `getPath()`, `getBytes()`, `getChunks()`
- `ctx.streamEnd.getDigestSha256()`, `isValid()`, `getError()`, `getMetadata()`

#### `@watch /path/to/folder` (multiple supported)
File system monitoring. Paths can be absolute or relative to the script directory.
Triggers `run()` on file/directory changes with `ctx.watchPath` and `ctx.watchType`.
```typescript
// @watch ~/Desktop/monitor
// @watch ./relative/path
```

**watchType values:**
- `file:created` | `file:deleted` | `file:moved` | `file:changed`
- `dir:created` | `dir:deleted` | `dir:moved`

#### `@mutex ON|OFF`
Prevents concurrent executions. Default: `OFF`
```typescript
// @mutex ON
```

**Context example:**
```typescript
import { log } from 'core';
import type { Context } from 'core';

export async function run(ctx: Context) {
	if (ctx.trigger === 'WATCH') {
    await log(`File event: ${ctx.watchPath} (${ctx.watchType})`, 'I');
	}
}
```

### `scriptLoader.js`
- Transpiles TypeScript → CommonJS
- Creates an isolated module via Function constructor
- Loads exports

### `networkMonitor.js`
- `NetworkMonitor` class handles polling
- DNS lookup every 5 seconds
- Emits events: WIFI_ON/OFF, NET_UP/DOWN
- Methods: `start()` / `stop()`

### `runtime.js`
- Main `ReactorRuntime` class
- Responsibilities:
  - Script discovery
  - Schedule setup
  - Event emission
  - HTTP server health/message handling (`POST /message`)
  - Script execution
  - Event logging
  - Exchange integration (delegate to `ExchangeManager`)
- Supports platform service injection (filesystem/http/permissions)
- Exposes mapped runtime APIs (FileSystem, HttpClient, Device, System) in script context
- Uses all the other modules

**Exchange-related methods:**
- `getExchangeConfig()` → returns current exchange config + status
- `setExchangeConfig(mode, host, port)` → applies new exchange config at runtime

**`Node.sendMessage` routing logic:**
1. Tenta HTTP POST diretto a `http://<target>/message` (LAN)
2. Se il target non è raggiungibile AND mode è `client` → invia via WebSocket all'Exchange

**Streaming API (chunked):**
- `Node.stream(target, source, options)` → stream diretto HTTP verso un altro nodo
- `Node.exchange().stream(target, source, options)` → stream triangolato via Exchange (WS)
- Entrambe inviano eventi JSON `start` / `chunk` / `end` con envelope:
  - `__reactorStream: true`
  - `streamId`, `phase`, `contentType`, `index`, `encoding`, `data`, `chunks`, `totalBytes`, `digestSha256`
- `source` può essere: `ReadableStream`, `AsyncIterable`, `Iterable`, `Buffer`, `Uint8Array`, `ArrayBuffer`, `string`
- `options`: `chunkSize` (default 64KB), `contentType`, `metadata`, `totalBytes`, `streamId`
- Il receiver esegue spool su disco in `temp_files/streams` (stato RAM minimo) e valida `totalBytes`/`digestSha256` prima di emettere `STREAMEND`

### `exchangeManager.js`

Gestisce il sistema WebSocket Exchange su **Node.js / Electron / daemon Linux**.  
Dipendenza: pacchetto npm `ws`.

---

## Exchange — Architettura completa

### Concetto

Ogni nodo Reactor può essere in modalità `node` o `exchange`.

**Node**
- Ha un **HTTP server** (default port 7070) che riceve messaggi diretti da altri nodi in LAN
- Ha un **WebSocket client** che si connette a un Exchange remoto per messaggi extra-LAN
- Modalità: riceve e invia messaggi

**Exchange**
- Ha un **WebSocket server** sulla stessa porta HTTP (default 7070) che funge da router
- I nodi si connettono, si registrano per nome e ricevono i messaggi diretti a loro
- Modalità: inoltra messaggi da sorgente a destinazione

```
Nodo A (Node)              Nodo EXCHANGE            Nodo B (Node)
      │                         │                         │
      │◀──── HTTP diretta ──────▶│◀────── HTTP diretta ───▶│
      │     (se in LAN)         │     (se in LAN)        │
      │                         │                         │
      │── wss://exchange:7070 ──▶│ WebSocket server       │
      │   { register: 'a' }     │                        │
      │                         │◀─ wss://exchange:7070 ──│
      │                         │   { register: 'b' }    │
      │                         │                         │
      │── { to:'b', msg:'hi' }──▶│                         │
      │                         │── { from:'a', msg:'hi'}──▶│
```

### Protocollo WebSocket (JSON)

| Direzione | Tipo | Payload |
|-----------|------|---------|
| node → exchange | `register` | `{ type, name }` |
| exchange → node | `registered` | `{ type, name }` |
| node → exchange | `message` | `{ type, to, content, contentType }` |
| exchange → node | `message` | `{ type, from, content, contentType }` |

### Configurazione

| Campo | Descrizione | Default |
|-------|-------------|---------|
| `exchangeMode` | `node` \| `exchange` | `node` |
| `exchangeHost` | Host dell'exchange remoto (solo modalità node) | `''` |
| `exchangePort` | Porta HTTP dell'exchange (default 7070) | `7070` |
| `exchangeTls` | Usa WSS anzichè WS | `false` |

### Persistenza per piattaforma

| Piattaforma | File |
|-------------|------|
| Electron (macOS/Win/Linux desktop) | `ui-settings.json` in userData |
| Daemon headless (Linux server) | `$REACTOR_DATA_DIR/exchange-config.json` |
| Android | SharedPreferences (`exchangeMode`, `exchangeHost`, `exchangePort`, `exchangeTls`) |

### Variabili d'ambiente (priorità massima su tutte le piattaforme Node.js)

```bash
REACTOR_WORKING_MODE=exchange           # oppure: node
REACTOR_EXCHANGE_HOST=192.168.1.10     # solo per modalità node
REACTOR_EXCHANGE_PORT=7070             # porta HTTP dell'exchange
REACTOR_EXCHANGE_TLS=true              # usa WSS
```

### Android

Su Android l'`ExchangeManager` Node.js non è disponibile. Il supporto Exchange è implementato direttamente in Java:
- **EXCHANGE**: `ReactorHttpService.handleClient()` rileva l'header `Upgrade: websocket` e gestisce la sessione WS in-process (handshake RFC 6455 manuale, SHA-1 + Base64).
- **CLIENT**: OkHttp 4.12.0 WebSocket client con reconnect automatico ogni 5s.
- Configurazione: `ReactorMobilePlugin.setExchangeConfig()` / `getExchangeConfig()`

### Reconnect

Client mode reconnect automatico: 5 secondi dopo ogni disconnessione (su tutte le piattaforme).

---

## Daemon headless (`daemon.js`)

Permette di eseguire Reactor su un **server Linux** (o qualsiasi macchina headless) senza UI.

### Avvio

```bash
# Avvio diretto
node daemon.js

# Con data dir personalizzata
REACTOR_DATA_DIR=/var/lib/reactor node daemon.js

# Come EXCHANGE server
REACTOR_WORKING_MODE=exchange REACTOR_DATA_DIR=/var/lib/reactor node daemon.js

# Come CLIENT
REACTOR_WORKING_MODE=node REACTOR_EXCHANGE_HOST=10.0.0.1 node daemon.js
```

### Variabili d'ambiente del daemon

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `REACTOR_DATA_DIR` | `~/.config/Reactor` | Cartella dati principale |
| `REACTOR_SCRIPTS_DIR` | `$DATA_DIR/projects` | Cartella script |
| `REACTOR_EVENT_LOG_PATH` | `$DATA_DIR/activity.log` | Log attività globale |
| `REACTOR_HTTP_PORT` | `7070` | Porta HTTP server |
| `REACTOR_WORKING_MODE` | `node` | Modalità di lavoro (`node` oppure `exchange`) |
| `REACTOR_EXCHANGE_HOST` | `''` | Host exchange (client) |
| `REACTOR_EXCHANGE_PORT` | `7070` | Porta exchange (client) |

### Comandi `daemonctl.js`

```bash
node daemonctl.js list                          # Elenca script caricati
node daemonctl.js status                        # PID, uptime, script count
node daemonctl.js run <script-name>             # Esegue uno script
node daemonctl.js set-name <name>              # Imposta nome reactor
node daemonctl.js set-port <port>              # Cambia porta HTTP
node daemonctl.js get-exchange                 # Mostra config exchange corrente
node daemonctl.js set-exchange exchange [port] # Imposta modalità EXCHANGE
node daemonctl.js set-exchange client <host[:port]>  # Imposta modalità CLIENT
node daemonctl.js set-exchange disabled        # Disabilita exchange
node daemonctl.js stop                         # Arresta il daemon
```

### Installazione come servizio systemd (Ubuntu/Debian)

```bash
# 1. Copia il progetto
sudo cp -r . /opt/reactor
sudo npm install --prefix /opt/reactor --omit=dev

# 2. Crea utente dedicato
sudo useradd --system --no-create-home --shell /usr/sbin/nologin reactor
sudo mkdir -p /var/lib/reactor
sudo chown reactor:reactor /var/lib/reactor

# 3. Installa il servizio
sudo cp /opt/reactor/reactor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable reactor
sudo systemctl start reactor

# 4. Verifica
sudo systemctl status reactor
journalctl -u reactor -f

# 5. Configurazione exchange (opzione A: variabili nel .service)
sudo systemctl edit reactor
# → aggiungi:
#   [Service]
#   Environment=REACTOR_WORKING_MODE=exchange

# 5. Configurazione exchange (opzione B: daemonctl a runtime)
node /opt/reactor/daemonctl.js set-exchange exchange
node /opt/reactor/daemonctl.js set-exchange client 10.0.0.1:7070
```

### File generati dal daemon

```
$REACTOR_DATA_DIR/
├── projects/           # Script e progetti
├── activity.log        # Log attività globale
├── name                # Nome del nodo reactor
├── exchange-config.json # Config exchange (se impostata via daemonctl)
└── reactor-daemon.sock # Unix socket di controllo
```

### `platform/contracts.js`
- Defines platform-agnostic interfaces:
  - `FileWriter`
  - `HttpClient`
  - `PermissionManager`

### `platform/nodePlatformServices.js`
- Node/Electron runtime implementations
- Used as default in current desktop/daemon runtime

### `platform/capacitorPlatformServices.js`
- Capacitor runtime implementations for mobile
- Designed to integrate with Capacitor plugins and native permission flows

## IPC Handlers (Electron)

Defined in `src/electron/ipcHandlers.js`, exposed via `preload.js`:

| IPC channel | Direction | Description |
|-------------|-----------|-------------|
| `get-ui-settings` | renderer→main | Read persisted UI settings |
| `get-http-server-config` | renderer→main | HTTP server status + port |
| `set-http-server-port` | renderer→main | Change HTTP server port |
| `get-http-server-logs` | renderer→main | Recent HTTP server log entries |
| `get-reactor-name` | renderer→main | Read reactor identity name |
| `set-reactor-name` | renderer→main | Write reactor identity name |
| `get-exchange-config` | renderer→main | Exchange mode/host/port/status |
| `set-exchange-config` | renderer→main | Apply new exchange configuration |
| `get-scripts-info` | renderer→main | Script list + metadata |
| `open-scripts-folder` | renderer→main | Open scripts dir in Finder/Explorer |
| `open-script-file` | renderer→main | Open script with default/configured editor |
| `read-script-content` | renderer→main | Read script file text |
| `save-script-content` | renderer→main | Write script file text |
| `run-script-now` | renderer→main | Manual trigger of a script |
| `create-script-file` | renderer→main | Create script from template |
| `rename-script-file` | renderer→main | Rename script file |
| `delete-script-file` | renderer→main | Delete script file |
| `toggle-script-directive` | renderer→main | Toggle `@state` or `@mutex` |
| `open-event-log` | renderer→main | Resolve activity.log path |
| `clear-event-log` | renderer→main | Truncate activity.log |
| `get-workflow` | renderer→main | Read workflow.json |
| `save-workflow` | renderer→main | Write workflow.json |
| `open-server-status` | renderer→main | Open HTTP server status in browser |
| `pick-default-program` | renderer→main | Open file picker for default editor |

## Benefits

✅ **Testability**: Each module is isolated
✅ **Maintainability**: Single clear responsibility per module
✅ **Reusability**: Modules can be used standalone
✅ **Clarity**: boot.js is highly readable (35 lines)
✅ **Scalability**: Easy to add new features
