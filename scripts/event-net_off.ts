// @state DISABLED
// @on NET_OFF



import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import type { Context } from '../src/context.js';



export async function run(ctx : Context)
{
  const targetPath = path.join(os.homedir(), 'Desktop', 'net_off');
  await fs.mkdir(targetPath, { recursive: true });
  ctx.log(`created or already exists: ${targetPath} (event=${ctx.event})`);
}