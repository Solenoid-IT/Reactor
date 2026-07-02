// @state DISABLED
// @on MESSAGE [net:127.0.0.1]



import { Event, MessageEvent, log } from 'core';



export async function run (event : Event)
{
    if (!(event instanceof MessageEvent)) {
        return;
    }

    const sender  = event.data.senderName || event.data.sender;
    const message = event.data.content;

    await log(`Message received from ${sender} :: ${message}`);
}