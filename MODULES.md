# Module Architecture

Refactor of boot.js based on the **Single Responsibility Principle (SRP)**.

## Structure

```
Reactor/
├── boot.js                    # Entry point (35 lines)
├── preload.js                 # IPC bridge
├── src/
│   ├── scheduleParser.js      # @schedule expression parsing
│   ├── metadata.js            # Script metadata parsing (@state, @on, @schedule)
│   ├── scriptLoader.js        # TypeScript transpilation
│   ├── networkMonitor.js      # Connectivity monitoring
│   ├── runtime.js             # Main ReactorRuntime class
│   ├── ui.js                  # UI, IPC handlers, HTML
│   └── platform/
│       ├── contracts.js                 # Cross-platform service contracts
│       ├── nodePlatformServices.js      # Node/Electron implementations
│       ├── capacitorPlatformServices.js # Capacitor/mobile implementations
│       ├── runtimeApiContracts.js       # FileSystem/HttpClient/Device/System contracts
│       ├── nodeRuntimeApi.js            # Node runtime API mapping
│       └── androidRuntimeApi.js         # Android/Capacitor runtime API mapping
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
`Node.sendMessage(target, content)` dispatches POST `/message` and triggers matching MESSAGE listeners.

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

#### `@route METHOD /path`
Triggers script execution when Reactor internal HTTP server receives a matching HTTP request.

Example:
```typescript
// @route POST /run-script-x
```

**Context example:**
```typescript
export async function run(ctx: Context) {
	if (ctx.trigger === 'WATCH') {
		await ctx.log(`File event: ${ctx.watchPath} (${ctx.watchType})`, 'I');
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
  - HTTP route server and @route dispatch
  - Script execution
  - Event logging
- Supports platform service injection (filesystem/http/permissions)
- Exposes mapped runtime APIs (FileSystem, HttpClient, Device, System) in script context
- Uses all the other modules

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

### `ui.js`
- Builds HTML UI
- Creates main window
- Sets up IPC handlers
- Contains no runtime logic

## Benefits

✅ **Testability**: Each module is isolated
✅ **Maintainability**: Single clear responsibility per module
✅ **Reusability**: Modules can be used standalone
✅ **Clarity**: boot.js is highly readable (35 lines)
✅ **Scalability**: Easy to add new features
