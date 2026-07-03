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

// Response body is written to a local file path.
const bodyStream = await FileSystem.File.open(response.body);
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
