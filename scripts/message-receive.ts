// @state DISABLED
// @on BOOT



import { Node } from 'core';



export async function run ()
{
    await Node.sendMessage( '127.0.0.1', 'hello' );
}