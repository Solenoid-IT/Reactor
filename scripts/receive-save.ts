// @enabled TRUE
// @mutex TRUE

// @on STREAMEND [R2]



import { Event, StreamEndEvent, FileSystem, Node } from 'core';



export async function run (event : Event)
{
	if ( !( event instanceof StreamEndEvent ) ) return;



    const inputStream = await FileSystem.File.open( event.tmpPath );



    const homeDir = await Node.getHomeDirectory();
    const targetFilePath = `${homeDir}/Desktop/reactor-tests/${event.metadata.relativePath}`;
    const outputStream = await FileSystem.File.open( targetFilePath, { 'mode': 'write' } );



    await FileSystem.File.copyStream( inputStream, outputStream );
}
