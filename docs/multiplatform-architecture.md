# Reactor Multiplatform Architecture

## Vision

Same code everywhere.

Reactor is designed as an agnostic platform runtime where script logic remains portable and platform-specific behavior is isolated behind adapters.

## Runtime Layers

1. Script layer (portable): user TypeScript scripts and trigger metadata (@schedule, @on, @watch).
2. Reactor core layer (portable): parsing, scheduling, trigger dispatch, script lifecycle.
3. Platform adapter layer (platform-specific): filesystem, http, permissions, background execution.
4. Host layer:
   - Desktop: Electron
   - Mobile: Capacitor + native plugin execution (for example QuickJS plugin)
   - Server: Node daemon + HTTP web UI

## Unified UI Strategy

Write UI once and host it in:
- Electron WebView (desktop)
- Capacitor WebView (mobile)
- Daemon HTTP webapp (Linux/server)

The UI communicates with Reactor through platform-specific bridges:
- Electron IPC bridge
- Capacitor plugin bridge
- HTTP/WS API bridge for daemon

## Mobile Script Execution Strategy

Mobile script execution should not rely on WebView eval.
Use a native execution plugin (for example capacitor-quickjs) and keep the same trigger semantics used by desktop/server.

## Permission Strategy

Support both:
- one-time bootstrap request on first install
- on-enable script validation (script-aware permissions)

Use permission inference from metadata (see src/platform/permissionPlanner.js), then expose a global permissions panel in Settings.

## Network Event Strategy

- Desktop and server can derive network events from host runtime facilities.
- Android uses `ConnectivityManager.NetworkCallback` as the primary trigger for `@on NET_CHANGE`.
- Android applies a short debounce before recomputing the network snapshot so transient handoffs do not flood scripts.
- Android keeps a lightweight fallback poll only when the system callback cannot be registered.
- `NET_CHANGE` payload is best-effort across platforms and should be treated as a normalized runtime snapshot, not as a strict OS-level contract.

## Packaging and Build

- dist/desktop: Electron artifacts
- dist/mobile: Capacitor artifacts and web bundle scaffold

`reactor-cli` commands:
- build desktop
- build mobile
- build all
- plugin build <dir>

## Plugin Direction

Plugins should declare:
- supported platforms
- required permissions
- capabilities (filesystem/network/location/background)
- mobile native bindings where needed

This allows scripts to keep a consistent API while runtime selects the proper platform implementation.
