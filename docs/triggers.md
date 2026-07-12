# Reactor Triggers

Reactor endpoints are TypeScript files with one or more trigger directives in the header. Every trigger calls the exported `run(event)` function with an event object from `core`.

```ts
// @enabled TRUE
// @mutex FALSE
// @on MESSAGE [controller]
// @on STREAMEND [camera-node]

import { Event, MessageEvent, StreamEndEvent, log } from 'core';

export async function run(event: Event) {
	if (event instanceof MessageEvent) {
		await log(`message=${event.data.content}`);
		return;
	}

	if (event instanceof StreamEndEvent) {
		await log(`stream file=${event.data.tmpFilePath}`);
		return;
	}
}
```

`instanceof` checks are supported on desktop and Android. This is the recommended way to branch inside multi-trigger endpoints.

## Common Directives

| Directive | Description |
| --- | --- |
| `// @enabled TRUE` | Enables the endpoint. Use `FALSE` to keep the endpoint loaded but inactive. |
| `// @mutex TRUE` | Prevents concurrent runs of the same endpoint. If one run is active, the next matching trigger is skipped. |
| `// @debug TRUE` | Enables debug behavior where supported by the runtime. |
| `// @on ...` | Registers one trigger. An endpoint can declare multiple `@on` lines. |

## Supported Events

| Trigger directive | Event class | `event.type` | When it runs |
| --- | --- | --- | --- |
| `@on SCHEDULE "*/5 * * * *"` | `ScheduleEvent` | `SCHEDULE` | A schedule expression matches. |
| `@on WATCH "/path/to/dir"` | `WatchEvent` | `WATCH` | A watched file or directory changes. |
| `@on EVENT_NAME` | `RuntimeEvent` | `EVENT` | A named runtime event is emitted. For example, `@on NET_CHANGE`. |
| `@on MESSAGE` | `MessageEvent` | `MESSAGE` | A node-to-node message is received. |
| `@on MESSAGE [sender_a,sender_b]` | `MessageEvent` | `MESSAGE` | A message is received from one of the listed senders. |
| `@on STREAM` | `StreamEvent` | `STREAM` | A stream packet is received. |
| `@on STREAM [sender_a,sender_b]` | `StreamEvent` | `STREAM` | A stream packet is received from one of the listed senders. |
| `@on STREAMEND` | `StreamEndEvent` | `STREAMEND` | A streamed payload has been assembled and finalized on disk. |
| `@on STREAMEND [sender_a,sender_b]` | `StreamEndEvent` | `STREAMEND` | A streamed payload from one of the listed senders has been finalized. |
| Manual run or endpoint test | `ManualEvent` | `MANUAL_TEST` | The endpoint is run manually or through a test command. |

All event classes extend `Event`, so `event instanceof Event` is true for all supported trigger events.

## Multi-Trigger Filtering

Use `instanceof` when the same endpoint handles different trigger classes.

```ts
// @enabled TRUE
// @on SCHEDULE "*/10 * * * *"
// @on MESSAGE [controller]
// @on STREAMEND [camera-node]

import { Event, ScheduleEvent, MessageEvent, StreamEndEvent } from 'core';

export async function run(event: Event) {
	if (event instanceof ScheduleEvent) {
		return runScheduledJob(event);
	}

	if (event instanceof MessageEvent) {
		return handleMessage(event);
	}

	if (event instanceof StreamEndEvent) {
		return handleCompletedStream(event);
	}
}
```

This pattern works across desktop and Android. Android also brands Reactor event objects internally so `instanceof` remains stable even when QuickJS receives an event object through a bridge path where prototype identity may otherwise be fragile.

## Event Payloads

### `Event`

Base event for every trigger.

```ts
import { Event } from 'core';
```

| Field | Type | Description |
| --- | --- | --- |
| `event.type` | `string` | Event discriminator. |
| `event.sender` | `Sender` | Sender endpoint/node identity. `event.sender.endpoint` and `event.sender.node` are readonly strings; `event.sender.toString()` renders `endpoint@node` when both parts are available. |
| `event.data` | `object` | Trigger-specific payload. |
| `event.timestamp` | `string` | ISO timestamp. |
| `event.originalEvent` | `Event \| null` | Event instance that caused this event to cross an endpoint boundary, when available. |

### `ScheduleEvent`

Created by `@on SCHEDULE "..."`.

| Field | Type | Description |
| --- | --- | --- |
| `event.data.expression` | `string \| null` | Schedule expression that triggered the run. |

### `WatchEvent`

Created by `@on WATCH ...`.

| Field | Type | Description |
| --- | --- | --- |
| `event.watchPath` | `string` | Watched root path. |
| `event.relativePath` | `string` | Changed entry relative to the watched root. |
| `event.watchType` | `string \| null` | Change kind, such as `file:created`, `file:changed`, or `dir:deleted`. |

Watch directives can include listener filters and recursive mode:

```ts
// @on WATCH "/Users/me/inbox" [file:created,file:changed]
// @on WATCH "/Users/me/projects" [file:created] R
```

Supported watch listener values are:

- `file:created`
- `file:deleted`
- `file:moved`
- `file:changed`
- `dir:created`
- `dir:deleted`
- `dir:moved`

### `RuntimeEvent`

Created by named runtime events such as `@on NET_CHANGE`.

| Field | Type | Description |
| --- | --- | --- |
| `event.name` | `string \| null` | Runtime event name. |
| `event.data.networkChange` | `object \| null` | Network-change context for `NET_CHANGE`. |

### `MessageEvent`

Created by `@on MESSAGE`.

| Field | Type | Description |
| --- | --- | --- |
| `event.data.sender` | `string \| null` | Sender routing identity when available. |
| `event.data.senderName` | `string \| null` | Sender display name when available. |
| `event.data.target` | `string \| null` | Raw target expression. |
| `event.data.targetNode` | `string \| null` | Resolved target node name or id. |
| `event.data.targetEndpoint` | `string \| null` | Resolved target endpoint name. |
| `event.data.targetEndpointId` | `string \| null` | Resolved target endpoint id. |
| `event.data.content` | `string` | Text body. |
| `event.data.contentType` | `string` | Content type. |
| `event.data.bodyBase64` | `string` | Base64 body for binary payloads. |
| `event.data.json` | `unknown` | Parsed JSON body when available. |
| `event.data.headers` | `object` | Incoming message headers. |

Sender filters use OR semantics:

```ts
// @on MESSAGE [R2,net:192.168.1.10:9063,net:www.example.com]
```

### `StreamEvent`

Created by `@on STREAM` for stream packets.

| Field | Type | Description |
| --- | --- | --- |
| `event.data.stream` | `StreamPacketApi \| null` | Packet helper for the current stream envelope. |

`StreamEvent` includes the same routing and content fields as `MessageEvent`, plus `event.data.stream`.

### `StreamEndEvent`

Created by `@on STREAMEND` after the runtime has assembled a streamed payload on disk.

| Field | Type | Description |
| --- | --- | --- |
| `event.metadata` | `Record<string, unknown>` | Sender-provided metadata. |
| `event.data.tmpFilePath` | `string` | Temporary path of the assembled payload. |
| `event.data.streamEnd` | `StreamEndApi \| null` | Finalization helper object. |

Typical stream finalization pattern:

```ts
import { Event, StreamEndEvent, FileSystem } from 'core';

export async function run(event: Event) {
	if (!(event instanceof StreamEndEvent)) return;

	const output = await FileSystem.File.open('/tmp/output.bin', { mode: 'write' });
	const input = await FileSystem.File.open(event.data.tmpFilePath);
	await FileSystem.File.copyStream(input, output);
}
```

### `ManualEvent`

Created by manual/test execution paths.

| Field | Type | Description |
| --- | --- | --- |
| `event.data.reason` | `string \| null` | Manual trigger reason when available. |

## Sender Filters

`MESSAGE`, `STREAM`, and `STREAMEND` can restrict accepted senders.

```ts
// @on MESSAGE [node-name]
// @on STREAM [node-name,net:192.168.1.20:9063]
// @on STREAMEND [net:camera.local]
```

Supported sender forms include:

- Node names, such as `controller` or `R2`.
- `net:host`, using the default Reactor port.
- `net:host:port`, using an explicit port.

Filters are OR-based. If the sender list is omitted, the endpoint accepts that trigger from any sender.

## Notes

- `Node.sendMessage(...)` triggers `MESSAGE`.
- `Node.stream(...)` and `Node.exchange().stream(...)` trigger `STREAM` packets and then `STREAMEND` after finalization.
- For large file-like payloads, prefer `STREAMEND` so the runtime can spool the payload to disk before your endpoint opens it.
- `StreamEvent` is packet-oriented. `StreamEndEvent` is file-oriented.
- Legacy sender syntax such as `@on MESSAGE(sender)` may still parse, but new endpoints should use bracket filters: `@on MESSAGE [sender]`.
