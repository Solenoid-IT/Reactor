// @state DISABLED
// @on BOOT



import { Context, Node } from 'core';



export async function run (ctx : Context)
{
    await Node.sendMessage( '127.0.0.1', 'hello' );
}