// @enabled TRUE
// @mutex TRUE

// @on STREAMEND [R2]



import { Event, StreamEndEvent, FileSystem, Node } from 'core';



export async function run (event : Event)
{
	if ( !( event instanceof StreamEndEvent ) ) return;

	if ( !event.tmpPath ) return;


    const inputStream = await FileSystem.File.open( event.tmpPath );



    const homeDir = await Node.getHomeDirectory();
    const relativePath = String( event.metadata?.relativePath || '' ).replace( /\\/g, '/' );
    const safeRelativePath = relativePath.startsWith( '/' )
        ? relativePath.slice( 1 )
        : relativePath;
    const fallbackName = event.tmpPath.split( '/' ).pop() || 'incoming.bin';
    const targetFilePath = `${homeDir}/Desktop/reactor-tests/${safeRelativePath || fallbackName}`;
    const outputStream = await FileSystem.File.open( targetFilePath, { 'mode': 'write' } );



    await FileSystem.File.copyStream( inputStream, outputStream );
}
