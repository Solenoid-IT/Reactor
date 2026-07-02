// @state DISABLED

// @on NET_DOWN



import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { log } from 'core';

import { Event, RuntimeEvent } from 'core';



export async function run (event : Event)
{
  if (!(event instanceof RuntimeEvent) || event.data.name !== 'NET_DOWN') {
    return;
  }

  const targetPath = path.join(os.homedir(), 'Desktop', 'net_off');
  await fs.mkdir(targetPath, { recursive: true });
  await log(`created or already exists: ${targetPath} (event=${event.data.name})`);
}