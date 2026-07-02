# Node-to-Node Communication

This document explains how Reactor nodes communicate with each other.

There are two communication primitives:

- `Node.sendMessage(target, content, enqueueOnFail = false)` for discrete messages
- `Node.stream(target, source, options)` for chunked streaming

There are also two network paths:

- Direct node-to-node (HTTP) in LAN or reachable private networks
- Triangulated node-to-node via Exchange (WebSocket routing)
- WebRTC DataChannel peer path (direct or TURN relay)

## Delivery Strategy (`node` mode)

For logical node targets (`endpoint@node_name`), Reactor uses this strategy:

1. Try peer-to-peer delivery first (`P2P_DIRECT`).
2. If direct ICE is not possible, keep the peer-to-peer path through TURN relay (`P2P_RELAY`).
3. If P2P is unavailable or not connected, fallback to Exchange routing (`EXCHANGE`).

The same strategy applies to `Node.stream(...)` (start/chunk/end frames).

### Delivery Levels

- `P2P_DIRECT`: DataChannel over direct ICE candidate pair. Lowest latency path.
- `P2P_RELAY`: DataChannel over TURN relay candidate pair. Still peer-to-peer semantics, but relayed.
- `EXCHANGE`: message/stream routed by Exchange transport when DataChannel is unavailable.

Fallback order is fixed in node mode: `P2P_DIRECT -> P2P_RELAY -> EXCHANGE`.

## Remote Endpoint Discovery (Network View)

When you open Network View and click a remote node (not the current node), Reactor loads that node endpoint list with the same transport strategy on both desktop and mobile:

1. Try `requestRemoteEndpointsP2P(target)` over WebRTC DataChannel.
2. If P2P is unavailable, times out, or fails, fallback to Exchange discovery (`/nodes`).

Result metadata includes `source`:

- `p2p-datachannel` when fetched through DataChannel
- `exchange-discovery` when fetched through Exchange fallback

When fallback is used, the response can also include `p2pError` with the original P2P failure reason.

### Delivery Metadata

Successful results now include `deliveredVia`:

- `P2P_DIRECT`
- `P2P_RELAY`
- `EXCHANGE`

## 1. `sendMessage()`

Use `sendMessage()` when you need to send a single payload (text, JSON, binary) and process it as one logical message.

`target` uses this format:

- `{endpoint}@{node}`

Supported endpoint selectors:

- `endpoint_name` (for example `send_message`)
- `id:uuid_v4` (for example `id:550e8400-e29b-41d4-a716-446655440000`)

Supported node selectors:

- `node_name` (for example `R2`)
- `net:host:port` (for example `net:1.2.3.4:5678`)
- `net:fqdn:port` (for example `net:www.example.com:5000`)

When `@{node}` is omitted, Reactor dispatches to the selected endpoint on the current node.

### Quick Target Matrix

- `send_message` -> local endpoint `send_message` on current node.
- `send_message@R2` -> endpoint `send_message` on node `R2`.
- `send_message@net:1.2.3.4:5678` -> endpoint `send_message` on direct network node `1.2.3.4:5678`.
- `send_message@net:www.example.com:5000` -> endpoint `send_message` on direct network node `www.example.com:5000`.
- `id:550e8400-e29b-41d4-a716-446655440000@R2` -> UUID-targeted endpoint on node `R2`.

`enqueueOnFail` controls fallback queue behavior:

- `false` (default): fail immediately when delivery is not possible
- `true`: enqueue payload and retry later when connectivity is restored

### Sender

```ts
import { Node } from 'core';

export async function run() {
	const directResult = await Node.sendMessage('send_message@net:192.168.1.20:7070', {
		type: 'status-update',
		value: 42,
		ts: Date.now(),
	}, false);

	await log(`deliveredVia=${directResult.deliveredVia || 'n/a'}`);

	await Node.sendMessage('id:550e8400-e29b-41d4-a716-446655440000@R2', {
		type: 'status-update',
		value: 42,
		ts: Date.now(),
	});

	await Node.sendMessage('my_custom_endpoint@R3', {
		type: 'status-update',
		value: 42,
		ts: Date.now(),
	}, true);

	await Node.sendMessage('send_message', {
		type: 'status-update',
		value: 42,
		ts: Date.now(),
	});
}
```

Example result (shape):

```json
{
	"target": "send_message@R2",
  "deliveredVia": "P2P_DIRECT"
}
```

### Receiver (`@on MESSAGE`)

Sender filters use OR semantics. Example: `@on MESSAGE [R2,net:1.2.3.4:5678]` means "accept messages from R2 OR from net:1.2.3.4:5678".

```ts
// @enabled TRUE

// @on MESSAGE [R2,net:192.168.1.10:7070,net:www.example.com]

import { Event, MessageEvent, log } from 'core';

export async function run (event: Event)
{
	if (!(event instanceof MessageEvent)) return;

	await log(`MESSAGE from ${event.data.sender || 'unknown'}`);
	await log(`target node=${event.data.targetNode || 'n/a'} endpoint=${event.data.targetEndpoint || 'broadcast'} endpointId=${event.data.targetEndpointId || 'n/a'}`);

	// Text body
	await log(`content=${event.data.content || ''}`);

	// JSON body (if content-type is json)
	if (event.data.json)
	{
		await log(`json received`);
	}
}
```

## 2. `stream()`

Use `stream()` when you need chunked transfer (large files, long payloads, progressive delivery).

`Node.stream(target, source, options)` uses the same `{endpoint}@{node}` target format as `Node.sendMessage(...)`.

When the endpoint selector is `id:uuid_v4`, `STREAM` and `STREAMEND` are delivered only to the target project UUID.

### Direct streaming (`Node.stream`)

```ts
import { Node } from 'core';

export async function run() {
	const chunks = [
		Buffer.from('hello '),
		Buffer.from('stream '),
		Buffer.from('world'),
	];

	const streamResult = await Node.stream('send_message@net:192.168.1.20:7070', chunks, {
		chunkSize: 64 * 1024,
		contentType: 'application/octet-stream',
		metadata: { fileName: 'demo.bin' },
	});

	await log(`stream deliveredVia=${streamResult.deliveredVia || 'n/a'}`);

	await Node.stream('id:550e8400-e29b-41d4-a716-446655440000@R2', chunks, {
		chunkSize: 64 * 1024,
		contentType: 'application/octet-stream',
		metadata: { fileName: 'demo-targeted.bin' },
	});

	await Node.stream('my_custom_endpoint@R3', chunks, {
		chunkSize: 64 * 1024,
		contentType: 'application/octet-stream',
		metadata: { fileName: 'demo-targeted-exchange.bin' },
	});
}
```

Example stream result (shape):

```json
{
	"target": "send_message@R2",
	"streamId": "...",
	"chunks": 3,
	"totalBytes": 12345,
	"digestSha256": "...",
	"deliveredVia": "P2P_RELAY"
}
```

### Exchange streaming (`Node.exchange().stream`)

```ts
import { Node } from 'core';

export async function run() {
	const chunks = [Buffer.from('part-1'), Buffer.from('part-2')];

	// Exchange stream uses logical node routing; target format stays endpoint@node.
	await Node.exchange().stream('send_message@target-node-name', chunks, {
		metadata: { transfer: 'report' },
	});
}
```

### Receiver (`@on STREAM`)

`Node.stream(...)` and `Node.exchange().stream(...)` trigger `STREAM`, not `MESSAGE`.

```ts
// @enabled TRUE

// @on STREAM [R2,net:192.168.1.10:7070]

import { Event, StreamEvent, log } from 'core';

const buffersByStreamId = new Map<string, Buffer[]>();

export async function run(event: Event) {
	if (!(event instanceof StreamEvent)) return;

	const stream = event.data.stream;
	if (!stream) return;

	const streamId = stream.getId();
	await log(`target node=${event.data.targetNode || 'n/a'} endpoint=${event.data.targetEndpoint || 'broadcast'} endpointId=${event.data.targetEndpointId || 'n/a'}`);

	if (stream.isStart()) {
		buffersByStreamId.set(streamId, []);
		await log(`STREAM start id=${streamId}`);
		return;
	}

	if (stream.isChunk()) {
		const list = buffersByStreamId.get(streamId) || [];
		list.push(stream.readChunkBuffer());
		buffersByStreamId.set(streamId, list);
		return;
	}

	if (stream.isEnd()) {
		const list = buffersByStreamId.get(streamId) || [];
		const full = Buffer.concat(list);
		await log(`STREAM end id=${streamId} bytes=${full.length}`);
		buffersByStreamId.delete(streamId);
	}
}
```

### Receiver finalization (`@on STREAMEND`)

For low-RAM transfers, let runtime spool chunks to disk and finalize on `STREAMEND`.

```ts
// @enabled TRUE

// @on STREAMEND [R2,net:192.168.1.10:7070]

import { Event, StreamEndEvent, log } from 'core';

export async function run (event: Event)
{
	if (!(event instanceof StreamEndEvent)) return;

	const end = event.data.streamEnd;
	if (!end) return;

	await log(`target node=${event.data.targetNode || 'n/a'} endpoint=${event.data.targetEndpoint || 'broadcast'} endpointId=${event.data.targetEndpointId || 'n/a'}`);

	if (!end.isValid()) {
		await log(`STREAMEND invalid id=${end.getId()} error=${end.getError()}`);
		return;
	}

	await log(`STREAMEND id=${end.getId()} path=${end.getPath()} bytes=${end.getBytes()} sha256=${end.getDigestSha256()}`);
}
```

## 3. Trigger Summary

- `Node.sendMessage(...)` -> `@on MESSAGE` or `@on MESSAGE [sender_a,sender_b]`
- `Node.stream(...)` -> `@on STREAM` or `@on STREAM [sender_a,sender_b]`
- `Node.exchange().stream(...)` -> `@on STREAM` or `@on STREAM [sender_a,sender_b]`
- Stream completion (validated and spooled) -> `@on STREAMEND` or `@on STREAMEND [sender_a,sender_b]`

## 4. Which One to Use

- Use `sendMessage()` for events/commands/small payloads.
- Use `stream()` for large payloads, progressive transfer, or file-like data.

## 5. Notes

- In `node` mode, direct communication uses HTTP node-to-node.
- In `node` mode with Exchange enabled, `Node.exchange().*` routes traffic through Exchange.
- Sender filters in directives support names and `net:host`/`net:host:port` values for `MESSAGE`, `STREAM`, and `STREAMEND`.
- `STREAMEND` uses the same sender filtering style as `STREAM`.
- Incoming stream chunks are reassembled on disk under `temp_files/streams` to avoid RAM saturation.
