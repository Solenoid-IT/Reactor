# Core API Examples

This page provides practical endpoint snippets for the `core` module.

## Time

```ts
import { Time, Unit } from 'core';

const now = Time.now();
const inTwoHours = Time.at('now + 2 hour');
const thirtyMinutesAgo = Time.at('now - 30 minute');
const ttl = Unit.Second.conv('2h 30m');
```

## ENV: app-defined variables

```ts
import { Env } from 'core';

const apiBaseUrl = Env.get('API_BASE_URL', 'https://example.com');
const featureFlag = Env.get('FEATURE_FLAG', '0') === '1';
```

## FileSystem: scan old files

```ts
import { FileSystem, Time, Unit } from 'core';

const directory = new FileSystem.Directory('/tmp/inbox');
const minAge = Unit.Second.conv('30d 2h 3m 5s');

const files = await directory.list(true);
for (const relativePath of files)
{
  const entryPath = directory.path + '/' + relativePath;
  if (!FileSystem.Entry.isFile(entryPath)) continue;

  const meta = await new FileSystem.File(entryPath).getMeta();
  if (!Number.isFinite(meta.mTime)) continue;

  if (Time.now() - meta.mTime <= minAge) continue;

  // process old file here
}
```

## FileSystem: cross-platform readable stream

```ts
import { FileSystem } from 'core';

const stream = await new FileSystem.ReadableStream('/tmp/inbox/report.bin').open();
```

## FileSystem: mode-based stream open

```ts
import { FileSystem } from 'core';

const readable = await FileSystem.File.open('/tmp/inbox/report.bin');
const writable = await FileSystem.File.open('/tmp/out/report.bin', { mode: 'write' });

await FileSystem.File.copyStream(readable, writable);
```

## HttpClient: upload file stream

```ts
import { FileSystem, HttpClient } from 'core';

const stream = await FileSystem.File.open('/tmp/inbox/report.bin');

const response = await HttpClient.sendRequest(
  new HttpClient.Request(
    'POST',
    'https://example.com/upload',
    stream,
    {
      'Content-Type': 'application/octet-stream',
      'X-Custom-Header': 'abcde',
    },
  ),
);

if (response.statusCode >= 400)
{
  throw new Error('Upload failed: ' + response.statusCode + ' ' + response.statusText);
}

// Response body is a readable stream-like object.
const responseText = response.body.toString();

// Response headers are normalized to lowercase and support case-insensitive lookup.
const contentType = response.headers.get('Content-Type');
```

## Sekrypt: encrypt stream before upload

```ts
import { FileSystem, Sekrypt, HttpClient } from 'core';

const stream = await FileSystem.File.open('/tmp/inbox/report.bin');
const targetPublicKey = '-----BEGIN PUBLIC KEY-----...-----END PUBLIC KEY-----';
const encrypted = await Sekrypt.encryptFile(stream, targetPublicKey);

const response = await HttpClient.sendRequest(
  new HttpClient.Request(
    'POST',
    'https://example.com/upload',
    encrypted.content,
    {
      'Content-Type': 'application/octet-stream',
      'X-Reactor-Crypto': JSON.stringify(encrypted.crypto),
    },
  ),
);

if (response.statusCode >= 400)
{
  throw new Error('Encrypted upload failed: ' + response.statusCode + ' ' + response.statusText);
}
```

## Sekrypt: compute tenant hash

```ts
import { FileSystem, Sekrypt } from 'core';

const tenantUuid = '8f2fe11b-01cf-4f6f-9662-2dd95f6fc2c7';
const stream = await FileSystem.File.open('/tmp/inbox/report.bin');

const hash = await Sekrypt.tenantHash(tenantUuid, stream);
```

## System: portable base path

```ts
import { System, FileSystem } from 'core';

const home = await System.getHomeDirectory();
const base = home.replace(/\/+$/, '') + '/reactor/data/outbox';

const directory = new FileSystem.Directory(base);
await directory.create();
```

## Node: send endpoint message

```ts
import { Node } from 'core';

await Node.sendMessage(
  'processReport@my-node',
  { reportId: 'RPT-001', priority: 'high' },
  { enqueueOnFail: true },
);
```
