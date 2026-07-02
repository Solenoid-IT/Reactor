// @state ENABLED
// @mutex ON

// @on WATCH "/Abs/Path/of/Desktop"
// @on WATCH "/Abs/Path/of/Downloads" [file:created]



import { Event, WatchEvent, log } from 'core';



export async function run(event : Event)
{
	if (!(event instanceof WatchEvent)) {
		return;
	}

	const timestamp = new Date().toISOString();
	const msg = `[${timestamp}] Watch event on ${event.path}: ${event.watchType}`;
	await log(msg, 'I');
}