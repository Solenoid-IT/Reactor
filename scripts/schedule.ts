// @state ENABLED
// @mutex ON

// @on SCHEDULE "EVERY 30 SECOND"



import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { log } from 'core';

import { Context } from 'core';



export async function run (ctx : Context)
{
  const desktopPath = path.join(os.homedir(), 'Desktop');
  const targetPath = path.join(desktopPath, 'reactor_schedule_test');

  await fs.mkdir(targetPath, { recursive: true });
  await log(`scheduled execution (${ctx.expression || 'n/a'}): created or already exists: ${targetPath}`);
}