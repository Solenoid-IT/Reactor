// @state ENABLED
// @mutex ON

// @on WATCH "/Abs/Path/of/Desktop"
// @on WATCH "/Abs/Path/of/Downloads" [file:created]



import { Context, log } from 'core';



export async function run(ctx : Context)
{
	const timestamp = new Date().toISOString();
	const msg = `[${timestamp}] Watch event on ${ctx.watchPath}: ${ctx.watchType}`;
	await log(msg, 'I');
}