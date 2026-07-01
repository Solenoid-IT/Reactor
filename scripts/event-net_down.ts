// @state DISABLED

// @on NET_DOWN



import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { log } from 'core';

import { Context } from 'core';



export async function run (ctx : Context)
{
  const targetPath = path.join(os.homedir(), 'Desktop', 'net_off');
  await fs.mkdir(targetPath, { recursive: true });
  await log(`created or already exists: ${targetPath} (event=${ctx.event})`);
}