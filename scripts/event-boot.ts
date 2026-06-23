// @state DISABLED
// @on BOOT



import fs from 'fs/promises';
import path from 'path';

import type { Context } from '../src/context.js';



export async function run (ctx : Context)
{
  const endpoint = process.env.REACTOR_HTTP_TEST_URL || 'https://httpbin.org/post';
  const defaultFilePath = path.join(__dirname, 'upload-test.txt');
  const filePath = process.env.REACTOR_HTTP_TEST_FILE || defaultFilePath;

  const payload = await fs.readFile(filePath);
  const fileName = path.basename(filePath);

  ctx.log(`sending file ${fileName} (${payload.length} bytes) to ${endpoint}`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': fileName,
    },
    body: payload,
  });

  const responseText = await response.text();
  const preview = responseText.slice(0, 300).replace(/\s+/g, ' ').trim();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${preview}`);
  }

  ctx.log(`api call success status=${response.status} preview=${preview}`);
}