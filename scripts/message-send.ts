// @state DISABLED
// @on MESSAGE [net:127.0.0.1]



import { Context, log } from 'core';



export async function run (ctx : Context)
{
    const sender  = ctx.messageSenderName || ctx.messageSender;
    const message = ctx.messageContent;

    await log(`Message received from ${sender} :: ${message}`);
}