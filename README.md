# Reactor

<p align="center">
  <img src="https://www.solenoid.it/cdn/logo/Reactor.jpg" alt="Reactor Logo" height="400" />
</p>

Reactor is an agnostic platform runtime for endpoint execution (manager and runner).

Slogan: Same code everywhere.

Core value:
- one language (TypeScript) for endpoint automation across desktop, mobile, and server
- one trigger model (@on TYPE PARAMS) across all platforms

Endpoints are loaded from an external, user-specific folder and can be triggered by:
- schedules using @on SCHEDULE "..."
- runtime events using @on EVENT_NAME
- file system changes using @on WATCH "..."
- node-to-node messages using @on MESSAGE [sender_a,sender_b]

Each endpoint also supports:
- @enabled for enable/disable
- @mutex for concurrency control

## Requirements

Before running Reactor, make sure your system has:
- Node.js 20 or newer
- npm (usually included with Node.js)

Development note:
- Node.js is required for development workflows (install, run, test, and build commands)
- Reactor can produce build artifacts for each target platform (desktop and mobile)

You can verify your installed versions with:

```bash
node -v
npm -v
```

## Quick Start

For local development:

```bash
npm install
npm start
```

To start with visible UI:

```bash
npm run start:debug-ui
```

## SvelteKit UI (Component-based Frontend)

Reactor now supports a SvelteKit frontend under `ui/`, so the interface can be split into reusable components.

Install UI dependencies:

```bash
npm run ui:install
```

Run SvelteKit dev server:

```bash
npm run ui:dev
```

In another terminal, start Electron with SvelteKit dev URL:

```bash
npm run start:ui
```

Build static SvelteKit UI (used by Electron in production builds):

```bash
npm run ui:build
```

If `ui/build/index.html` exists, Electron loads it automatically. If not, Reactor shows a minimal error page asking to run `npm run ui:build`.

To run in headless mode (daemon):

```bash
npm run start:daemon
```

## Runtime Modes

Reactor supports both:
- Desktop mode (Electron GUI/background)
- Headless mode (Node daemon)

Target architecture also includes:
- Mobile mode (Capacitor host + QuickJS execution plugin)
- Unified web UI in Electron WebView, Capacitor WebView, and daemon HTTP webapp

You can use either mode depending on deployment.

## Headless Mode (Daemon)

Start daemon:

```bash
npm run start:daemon
```

Daemon CLI commands:

```bash
npm run daemon:list
npm run daemon:status
npm run daemon:run -- "endpoint-name"
npm run daemon:stop
node daemonctl.js test "endpoint-name"
node daemonctl.js delete "endpoint-name"
node daemonctl.js set-name "my-reactor"
node daemonctl.js set-port 7071
node daemonctl.js set-exchange exchange 7070 --token "<token>" --discovery
node daemonctl.js set-discovery on
```

Examples:

```bash
npm run daemon:run -- watcher
npm run daemon:run -- watch.ts
```

### Daemon Environment Variables

- REACTOR_DATA_DIR: base data directory for daemon runtime
- REACTOR_ENDPOINTS_DIR: endpoints directory override
- REACTOR_EVENT_LOG_PATH: global activity log override
- REACTOR_DAEMON_SOCKET: daemon control socket override

Default daemon data directory:
- macOS: ~/Library/Application Support/Reactor
- Windows: %AppData%/Reactor
- Linux: ~/.config/Reactor

Linux server example:

```bash
REACTOR_DATA_DIR=/opt/reactor-data npm run start:daemon
```

Important: if you use daemonctl with a custom data directory, use the same REACTOR_DATA_DIR (or same REACTOR_DAEMON_SOCKET) in both daemon and client.

## systemd (Ubuntu Server)

A service template is included: reactor.service.

For a complete Linux server installation and Exchange configuration guide, see:
- `docs/linux-server-exchange-setup.md`

For Docker Compose setup as Exchange server, see:
- `docs/docker-compose-exchange.md`

For WebRTC STUN/TURN server setup (coturn), see:
- `docs/setup-webrtc.md`

Recommended setup:

1. Copy project to /opt/reactor
2. Create a dedicated user (example: reactor)
3. Create data directory /var/lib/reactor
4. Copy service file:

```bash
sudo cp /opt/reactor/reactor.service /etc/systemd/system/reactor.service
```

5. Reload systemd:

```bash
sudo systemctl daemon-reload
```

6. Enable and start:

```bash
sudo systemctl enable --now reactor
```

7. Follow logs:

```bash
sudo journalctl -u reactor -f
```

If you change paths or user, update WorkingDirectory, ExecStart, User, Group, and REACTOR_DATA_DIR in reactor.service.

## External Endpoints Folder (Post-build Behavior)

Endpoints are loaded only from an external user-specific folder.

Endpoints directory by OS:
- macOS: ~/Library/Application Support/Reactor/endpoints
- Windows: %AppData%\Reactor\endpoints
- Linux: ~/.config/Reactor/endpoints

Production update workflow:

1. Create external endpoints folder on target machine
2. Add .ts files to that folder
3. Restart Reactor

No app rebuild is required for endpoint-only updates.

## Project Structure

- boot.js: Electron main process and GUI mode bootstrap
- daemon.js: headless daemon bootstrap
- daemonctl.js: CLI client for daemon control
- src/: runtime, parser, metadata, and UI modules
- endpoints/: demo endpoints (not loaded automatically at runtime)
- activity.log: persistent execution log (JSONL)

## Directive Reference

Canonical header order:

1. @enabled
2. @mutex
3. @on

Note: you do not need all directives. When UI rewrites headers (enabled/mutex toggles), it preserves this order.

### @enabled

Values:
- @enabled TRUE
- @enabled FALSE

Rules:
- default is FALSE
- FALSE endpoints are loaded but not registered for schedule/event/watch execution

### @mutex

Values:
- @mutex TRUE
- @mutex FALSE

Rules:
- default is FALSE
- TRUE prevents concurrent runs of the same endpoint

### @on

Canonical syntax:
- @on TYPE PARAMS

Examples:
- @on MESSAGE
- @on MESSAGE [sender_1,sender_2]
- @on STREAM
- @on STREAM [sender_3]
- @on STREAMEND
- @on STREAMEND [sender_4]
- @on SCHEDULE "EVERY 7 HOUR"
- @on WATCH "/my/custom/path" [dir:created,file:created]
- @on BOOT
- @on NET_CHANGE
- @on NET_DOWN
- @on NET_UP
- @on WIFI_ON
- @on WIFI_OFF

SCHEDULE expression formats:
- EVERY N SECOND
- EVERY N SECONDS
- EVERY N MINUTE
- EVERY N MINUTES
- EVERY N HOUR
- EVERY N HOURS

Supported event types:
- BOOT
- WIFI_ON
- WIFI_OFF
- NET_UP
- NET_DOWN
- NET_CHANGE
- MESSAGE
- STREAM
- STREAMEND
- SCHEDULE
- WATCH

MESSAGE sender filter rules:
- @on MESSAGE receives messages from all senders
- @on MESSAGE [R1] receives only from sender R1
- @on MESSAGE [R1,R2] receives only from listed senders
- sender can be reactor name or host[:port]
- host without port uses default 7070

MESSAGE target rules:
- `Node.sendMessage(target, content, enqueueOnFail = false)` accepts `target=node_name` or `target=node_name/endpoint_id`
- `node_name` delivers to MESSAGE listeners on that node as before
- `node_name/endpoint_id` delivers only to the endpoint project whose root contains file `uuid` with that UUID v4 value
- New endpoint projects automatically create a root file named `uuid`

Message transport notes:
- import { Node } from 'core' then call Node.sendMessage(target, content, enqueueOnFail)
- request header Reactor-Name contains current node name
- request headers may also include Reactor-Target-Node and Reactor-Target-Endpoint-Id when the message is endpoint-targeted
- content supports string, JSON object, and binary payloads
- when `enqueueOnFail` is TRUE, failed deliveries are queued and retried later; when FALSE, the call fails immediately

Boot/network behavior:
- On bootstrap, a coherent initial connectivity pair is emitted immediately
- Online: WIFI_ON and NET_UP
- Offline: WIFI_OFF and NET_DOWN

NET_CHANGE behavior:
- `@on NET_CHANGE` receives a JSON payload with `reason`, `previous`, and `current`
- Android uses `ConnectivityManager.NetworkCallback` as the primary trigger
- Android applies a debounce window of about 2.5 seconds before evaluating the new network snapshot
- Android falls back to a lightweight periodic poll only when the system callback is unavailable
- Snapshot fields are best-effort and may include `online`, `primaryInterface`, `primaryAddress`, `subnet`, `gateway`, `transport`, `signal`, and `interfaces`

WATCH syntax:
- @on WATCH "/my/folder"
- @on WATCH "/my/folder" [file:created, file:moved, dir:deleted]

Rules:
- Without listener pseudo-array, all listeners are enabled
- With listener pseudo-array, only listed listeners are enabled
- Absolute and relative paths are supported (relative paths resolve from endpoint folder)

Available listeners:
- file:created
- file:deleted
- file:moved
- file:changed
- dir:created
- dir:deleted
- dir:moved

Complete header example:

```ts
// @enabled TRUE
// @mutex TRUE
// @on BOOT
// @on SCHEDULE "EVERY 30 SECOND"
// @on WATCH "/tmp/inbox" [file:created, file:moved]
```

HTTP server notes:
- Reactor starts an internal HTTP server for health and message dispatch
- `POST /message` is used by `@on MESSAGE` and `@on MESSAGE [sender_a,sender_b]`
- Default port: 7070
- Port can be configured at runtime (UI bridge) or with environment variable REACTOR_HTTP_PORT

## Endpoint Contract

Each endpoint must export run or default function.

Minimal example:

```ts
// @enabled TRUE
// @mutex FALSE
// @on SCHEDULE "EVERY 30 SECOND"

import { log } from 'core';
import type { Context } from 'core';

export async function run(ctx: Context) {
  await log("scheduled execution", "I");
}
```

Available ctx fields:
- trigger: EVENT, SCHEDULE, WATCH, or MESSAGE
- event: event name when trigger is EVENT
- expression: schedule expression when trigger is SCHEDULE
- messageSender: normalized sender identifier for MESSAGE trigger
- messageSenderName: sender name from Reactor-Name header (if present)
- messageTarget: target node name for MESSAGE trigger when available
- messageTargetNode: same as messageTarget, explicit node field
- messageTargetEndpointId: target endpoint project UUID when the sender addressed a specific endpoint
- messageContent: UTF-8 message body text
- messageContentType: incoming content-type
- messageBodyBase64: raw body payload encoded as base64
- messageJson: parsed JSON body when content-type is application/json
- messageHeaders: incoming request headers for MESSAGE trigger
- watchPath: path that generated WATCH event
- watchType: watch event type

Runtime APIs must be imported from `core`:
- `import type { Context } from 'core'`
- `import { log } from 'core'`
- `import { Node } from 'core'` then `Node.sendMessage(...)`
- `import { HttpClient, FileSystem, Device, System, api } from 'core'`

WATCH example with listener filter:

```ts
// @enabled TRUE
// @mutex TRUE
// @on WATCH "/my/folder" [file:created, file:moved, dir:deleted]

import { log } from 'core';
import type { Context } from 'core';

export async function run(ctx: Context) {
  if (ctx.trigger === 'WATCH') {
    await log('watch event: ' + ctx.watchPath + ' (' + ctx.watchType + ')', 'I');
  }
}
```

## Activity Logs

Reactor writes two log levels:

- Global activity.log: START entries for runs triggered by @on, and manual test/CLI execution
- Endpoint activity.log: START entries next to each endpoint package.json

UI log mapping:
- Top LOG menu uses global activity log
- Item LOG menu uses per-endpoint activity log

## Build and Distribution

Reactor supports platform-specific builds from a single codebase:
- desktop targets: macOS, Windows, Linux
- mobile target: Capacitor-based build pipeline

Packaging endpoints:

```bash
npm run icon:mac
npm run pack
npm run build
npm run build:mac
npm run build:win
npm run build:linux
npm run build:desktop
npm run build:mobile
npm run build:all
```

CLI:

```bash
npm run cli -- build desktop
npm run cli -- build mobile
npm run cli -- build all
```

### Mobile npm shortcuts (Android)

Common mobile workflow commands:

```bash
npm run mobile:sync
npm run mobile:build
npm run mobile:open
```

What they do:
- `npm run mobile:sync`: builds UI and runs `npx cap sync android`.
- `npm run mobile:build`: runs `mobile:sync` and builds debug APK with Gradle.
- `npm run mobile:open`: opens the Android project in Android Studio.

Android project path:
- `capacitor/android`

Debug APK output path:
- `capacitor/android/app/build/outputs/apk/debug/app-debug.apk`

If Gradle fails due to Java version, use Java 11+ (recommended Java 17).
On macOS with Android Studio installed:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" npm run mobile:build
```

### macOS Build Notes

- Reactor uses `assets/logo.icns` as app icon for macOS builds.
- If you update `assets/logo.png`, regenerate the icon with:

```bash
npm run icon:mac
```

- Then build for macOS:

```bash
npm run build:mac
```

Build output is generated in:
- dist/desktop -> Electron artifacts
- dist/mobile -> Capacitor/mobile scaffold and artifacts

### Startup Behavior (macOS)

- Reactor registers itself at login and starts hidden in background.
- On macOS packaged builds, Reactor also installs a LaunchAgent for reliable autostart at user login (no manual app opening required).
- If started by login items, the window stays hidden.
- If opened manually from Finder/Applications, the UI opens normally.
- Closing the window does not stop Reactor: it stays running in background to keep runtime and Exchange connection active.
- Quitting the app is also intercepted in persistent mode, so runtime stays active in background.
- You can force behavior during tests:
  - Show window: `REACTOR_SHOW_WINDOW=1 npm start`
  - Hide window: `REACTOR_SHOW_WINDOW=0 npm start`
  - Disable desktop persistence (allow normal quit): `REACTOR_PERSIST_BACKGROUND=0 npm start`

Build outputs:
- macOS: dmg, zip
- Windows: nsis
- Linux: AppImage

## Mobile Runtime Notes (Capacitor + QuickJS)

Mobile support is designed with two separate layers:
- UI layer: shared web UI rendered in Capacitor WebView
- Endpoint execution layer: native mobile execution via a Capacitor plugin (for example capacitor-quickjs), not via browser eval/webview execution

This keeps endpoint behavior aligned with desktop/server while reducing environment drift.

## Permissions Strategy (Mobile)

Reactor should support both strategies:
- one-time permission bootstrap at first launch
- per-endpoint permission check when enabling endpoints (based on @on directives and plugin requirements)

A dedicated Settings section should expose global permissions state (for example storage and location).

Important: automatic endpoint runs must never block waiting for runtime permission dialogs.

## Plugins and Packages

Reactor supports external packages on desktop/server using npm install.

For mobile, package support should be delivered through Reactor plugins:
- plugin manifests declare native/mobile capabilities and permissions
- plugin build output can be consumed by reactor-cli for desktop and mobile targets
- runtime uses platform adapters (filesystem/http/permissions) to keep endpoint logic portable

## Multiplatform Goal

The strongest Reactor benefit is the convenience of a single, multiplatform endpoint manager in one language, with endpoint execution triggered by many runtime events.

Cross-platform recommendation: build each target on its native OS (or with a CI matrix).

## Included Demo Endpoints

Demo endpoints are available under endpoints.

Important: files in endpoints are examples only and are not automatically loaded by runtime.
To execute them, copy them to your external endpoints folder.

## Current Limits
- @on SCHEDULE parser supports SECOND, MINUTE, HOUR only
- No sandboxing for user endpoint execution
- Network monitor uses periodic DNS lookup

## Legal

Copyright (c) 2026 Solenoid-IT. All rights reserved.

Reactor (TM) is a trademark of Solenoid-IT.

Licensed under Apache License 2.0. See LICENSE and NOTICE for details.
