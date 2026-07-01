// @state DISABLED
// @on BOOT



import { Node } from 'core';



export async function run ()
{
    // No @node means local endpoint dispatch on the current node.
    await Node.sendMessage( 'message-send', 'hello' );
}