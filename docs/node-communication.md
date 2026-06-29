# Node-to-Node Communication

This document explains how Reactor nodes communicate with each other.

There are two communication primitives:

- `Node.sendMessage(target, content)` for discrete messages
- `Node.stream(target, source, options)` for chunked streaming

There are also two network paths:

- Direct node-to-node (HTTP) in LAN or reachable private networks
- Triangulated node-to-node via Exchange (WebSocket routing)

## 1. `sendMessage()`

Use `sendMessage()` when you need to send a single payload (text, JSON, binary) and process it as one logical message.

`target` supports these forms:

- `host`
- `host:port`
- `host/script_id`
- `host:port/script_id`
- `node_name`
- `node_name/script_id`

When `script_id` is present, Reactor delivers the message only to the project whose root `uuid` file contains that UUID v4.

### Sender

```ts
import { Node } from 'core';

export async function run() {
	await Node.sendMessage('192.168.1.20:7070', {
		type: 'status-update',
		value: 42,
		ts: Date.now(),
	});

	await Node.sendMessage('192.168.1.20:7070/550e8400-e29b-41d4-a716-446655440000', {
		type: 'status-update',
		value: 42,
		ts: Date.now(),
	});

	await Node.sendMessage('target-node', {
		type: 'status-update',
		value: 42,
		ts: Date.now(),
	});

	await Node.sendMessage('target-node/550e8400-e29b-41d4-a716-446655440000', {
		type: 'status-update',
		value: 42,
		ts: Date.now(),
	});
}
```

### Receiver (`@on MESSAGE`)

```ts
// @state ENABLED
// @on MESSAGE(192.168.1.10:7070,node-a)

import type { Context } from 'core';
import { log } from 'core';

export async function run(ctx: Context) {
	await log(`MESSAGE from ${ctx.messageSender || 'unknown'}`);
	await log(`target node=${ctx.messageTargetNode || 'n/a'} script=${ctx.messageTargetScriptId || 'broadcast'}`);

	// Text body
	await log(`content=${ctx.messageContent || ''}`);

	// JSON body (if content-type is json)
	if (ctx.messageJson) {
		await log(`json received`);
	}
}
```

## 2. `stream()`

Use `stream()` when you need chunked transfer (large files, long payloads, progressive delivery).

`Node.stream(target, source, options)` supports the same target forms as `Node.sendMessage(target, content)`:

- `host`
- `host:port`
- `host/script_id`
- `host:port/script_id`
- `node_name`
- `node_name/script_id`

When `script_id` is present, `STREAM` and the final `STREAMEND` are delivered only to the target project.

### Direct streaming (`Node.stream`)

```ts
import { Node } from 'core';

export async function run() {
	const chunks = [
		Buffer.from('hello '),
		Buffer.from('stream '),
		Buffer.from('world'),
	];

	await Node.stream('192.168.1.20:7070', chunks, {
		chunkSize: 64 * 1024,
		contentType: 'application/octet-stream',
		metadata: { fileName: 'demo.bin' },
	});

	await Node.stream('192.168.1.20:7070/550e8400-e29b-41d4-a716-446655440000', chunks, {
		chunkSize: 64 * 1024,
		contentType: 'application/octet-stream',
		metadata: { fileName: 'demo-targeted.bin' },
	});

	await Node.stream('target-node/550e8400-e29b-41d4-a716-446655440000', chunks, {
		chunkSize: 64 * 1024,
		contentType: 'application/octet-stream',
		metadata: { fileName: 'demo-targeted-exchange.bin' },
	});
}
```

### Exchange streaming (`Node.exchange().stream`)

```ts
import { Node } from 'core';

export async function run() {
	const chunks = [Buffer.from('part-1'), Buffer.from('part-2')];

	await Node.exchange().stream('target-node-name', chunks, {
		metadata: { transfer: 'report' },
	});
}
```

### Receiver (`@on STREAM`)

`Node.stream(...)` and `Node.exchange().stream(...)` trigger `STREAM`, not `MESSAGE`.

```ts
// @state ENABLED
// @on STREAM(node-a,192.168.1.10:7070)

import type { Context } from 'core';
import { log } from 'core';

const buffersByStreamId = new Map<string, Buffer[]>();

export async function run(ctx: Context) {
	const stream = ctx.stream;
	if (!stream) return;

	const streamId = stream.getId();
	await log(`target node=${ctx.messageTargetNode || 'n/a'} script=${ctx.messageTargetScriptId || 'broadcast'}`);

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
// @state ENABLED
// @on STREAMEND(node-a,192.168.1.10:7070)

import type { Context } from 'core';
import { log } from 'core';

export async function run(ctx: Context) {
	const end = ctx.streamEnd;
	if (!end) return;

	await log(`target node=${ctx.messageTargetNode || 'n/a'} script=${ctx.messageTargetScriptId || 'broadcast'}`);

	if (!end.isValid()) {
		await log(`STREAMEND invalid id=${end.getId()} error=${end.getError()}`);
		return;
	}

	await log(`STREAMEND id=${end.getId()} path=${end.getPath()} bytes=${end.getBytes()} sha256=${end.getDigestSha256()}`);
}
```

## 3. Trigger Summary

- `Node.sendMessage(...)` -> `@on MESSAGE(...)`
- `Node.stream(...)` -> `@on STREAM(...)`
- `Node.exchange().stream(...)` -> `@on STREAM(...)`
- Stream completion (validated and spooled) -> `@on STREAMEND(...)`

## 4. Which One to Use

- Use `sendMessage()` for events/commands/small payloads.
- Use `stream()` for large payloads, progressive transfer, or file-like data.

## 5. Notes

- In `node` mode, direct communication uses HTTP node-to-node.
- In `node` mode with Exchange enabled, `Node.exchange().*` routes traffic through Exchange.
- Sender filters in directives support names and host:port values for both `MESSAGE` and `STREAM`.
- `STREAMEND` uses the same sender filtering style as `STREAM`.
- Incoming stream chunks are reassembled on disk under `temp_files/streams` to avoid RAM saturation.
