// @state ENABLED
// @mutex ON
// @watch /Abs/Path/of/Desktop
// @watch /Abs/Path/of/Downloads [file:created]



import type { Context } from '../src/context.js';



export async function run(ctx : Context)
{
	const timestamp = new Date().toISOString();
	const msg = `[${timestamp}] Watch event on ${ctx.watchPath}: ${ctx.watchType}`;
	await ctx.log(msg, 'I');
}