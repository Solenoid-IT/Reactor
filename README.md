# Reactor

<p align="center">
  <img src="https://www.solenoid.it/cdn/logo/Reactor.jpg" alt="Reactor Logo" height="400" />
</p>

Reactor is an Electron-based automation runtime for TypeScript scripts.

Scripts are loaded from an external, user-specific folder and can be triggered by:
- schedules using @schedule
- runtime events using @on
- file system changes using @watch

Each script also supports:
- @state for enable/disable
- @mutex for concurrency control

## Requirements

Before running Reactor, make sure your system has:
- Node.js 20 or newer
- npm (usually included with Node.js)

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

To run in headless mode (daemon):

```bash
npm run start:daemon
```

## Runtime Modes

Reactor supports both:
- Desktop mode (Electron GUI/background)
- Headless mode (Node daemon)

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
npm run daemon:run -- "script-name"
npm run daemon:stop
```

Examples:

```bash
npm run daemon:run -- watcher
npm run daemon:run -- watch.ts
```

### Daemon Environment Variables

- REACTOR_DATA_DIR: base data directory for daemon runtime
- REACTOR_SCRIPTS_DIR: scripts directory override
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

## External Scripts Folder (Post-build Behavior)

Scripts are loaded only from an external user-specific folder.

Scripts directory by OS:
- macOS: ~/Library/Application Support/Reactor/projects
- Windows: %AppData%\Reactor\projects
- Linux: ~/.config/Reactor/projects

Production update workflow:

1. Create external scripts folder on target machine
2. Add .ts files to that folder
3. Restart Reactor

No app rebuild is required for script-only updates.

## Project Structure

- boot.js: Electron main process and GUI mode bootstrap
- daemon.js: headless daemon bootstrap
- daemonctl.js: CLI client for daemon control
- src/: runtime, parser, metadata, and UI modules
- scripts/: demo scripts (not loaded automatically at runtime)
- activity.log: persistent execution log (JSONL)

## Directive Reference

Canonical header order:

1. @state
2. @mutex
3. @on
4. @schedule
5. @watch

Note: you do not need all directives. When UI rewrites headers (ENABLED/MUTEX toggles), it preserves this order.

### @state

Values:
- @state ENABLED
- @state DISABLED

Rules:
- default is DISABLED
- DISABLED scripts are loaded but not registered for schedule/event/watch execution

### @mutex

Values:
- @mutex ON
- @mutex OFF

Rules:
- default is OFF
- ON prevents concurrent runs of the same script

### @schedule

Supported formats:
- EVERY N SECOND
- EVERY N SECONDS
- EVERY N MINUTE
- EVERY N MINUTES
- EVERY N HOUR
- EVERY N HOURS

Example:

```ts
// @schedule EVERY 30 SECOND
```

### @on

Supported formats:
- @on EVENT_A, EVENT_B, EVENT_C
- @on EVENT_A EVENT_B EVENT_C

Supported events:
- BOOT
- WIFI_ON
- WIFI_OFF
- NET_ON
- NET_OFF

Boot/network behavior:
- On bootstrap, a coherent initial connectivity pair is emitted immediately
- Online: WIFI_ON and NET_ON
- Offline: WIFI_OFF and NET_OFF

### @watch

Supported syntax:
- @watch /my/folder
- @watch /my/folder [file:created, file:moved, dir:deleted]

Rules:
- Without listener pseudo-array, all listeners are enabled
- With listener pseudo-array, only listed listeners are enabled
- Absolute and relative paths are supported (relative paths resolve from script folder)

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
// @state ENABLED
// @mutex ON
// @on BOOT
// @schedule EVERY 30 SECOND
// @watch /tmp/inbox [file:created, file:moved]
```

## Script Contract

Each script must export run or default function.

Minimal example:

```ts
// @state ENABLED
// @mutex OFF
// @schedule EVERY 30 SECOND

export async function run(ctx) {
  await ctx.log("scheduled execution", "I");
}
```

Available ctx fields:
- trigger: EVENT, SCHEDULE, or WATCH
- event: event name when trigger is EVENT
- expression: schedule expression when trigger is SCHEDULE
- watchPath: path that generated WATCH event
- watchType: watch event type
- log(message, type): script-prefixed logging helper, where type is E, W, I, or D

WATCH example with listener filter:

```ts
// @state ENABLED
// @mutex ON
// @watch /my/folder [file:created, file:moved, dir:deleted]

export async function run(ctx) {
  if (ctx.trigger === 'WATCH') {
    await ctx.log('watch event: ' + ctx.watchPath + ' (' + ctx.watchType + ')', 'I');
  }
}
```

## Activity Logs

Reactor writes two log levels:

- Global activity.log: START entries for runs triggered by @schedule, @on, @watch, and manual test/CLI execution
- Project activity.log: START and END entries next to each project package.json, including output and error details

UI log mapping:
- Top LOG menu uses global activity log
- Item LOG menu uses per-project activity log

## Build and Distribution

Packaging scripts:

```bash
npm run icon:mac
npm run pack
npm run build
npm run build:mac
npm run build:win
npm run build:linux
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

Build output is generated in `dist/` (DMG + ZIP).

### Startup Behavior (macOS)

- Reactor registers itself at login and starts hidden in background.
- If started by login items, the window stays hidden.
- If opened manually from Finder/Applications, the UI opens normally.
- You can force behavior during tests:
  - Show window: `REACTOR_SHOW_WINDOW=1 npm start`
  - Hide window: `REACTOR_SHOW_WINDOW=0 npm start`

Build outputs:
- macOS: dmg, zip
- Windows: nsis
- Linux: AppImage

Cross-platform recommendation: build each target on its native OS (or with a CI matrix).

## Included Demo Scripts

Demo scripts are available under scripts.

Important: files in scripts are examples only and are not automatically loaded by runtime.
To execute them, copy them to your external scripts folder.

## Current Limits
- @schedule parser supports SECOND, MINUTE, HOUR only
- No sandboxing for user script execution
- Network monitor uses periodic DNS lookup

## Legal

Copyright (c) 2026 Solenoid-IT. All rights reserved.

Reactor (TM) is a trademark of Solenoid-IT.

Licensed under Apache License 2.0. See LICENSE and NOTICE for details.
