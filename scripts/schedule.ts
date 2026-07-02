// @state ENABLED
// @mutex ON

// @on SCHEDULE "EVERY 30 SECOND"



import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { log } from 'core';

import { Event, ScheduleEvent } from 'core';



export async function run (event : Event)
{
  if (!(event instanceof ScheduleEvent)) {
    return;
  }

  const desktopPath = path.join(os.homedir(), 'Desktop');
  const targetPath = path.join(desktopPath, 'reactor_schedule_test');

  await fs.mkdir(targetPath, { recursive: true });
  await log(`scheduled execution (${event.data.expression || 'n/a'}): created or already exists: ${targetPath}`);
}