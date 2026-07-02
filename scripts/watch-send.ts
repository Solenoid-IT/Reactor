// @enabled TRUE
// @mutex TRUE

// @on WATCH "{HOME_DIR}/Download" [file:created]



import { Event, WatchEvent, FileSystem, Node } from 'core';

export async function run (event : Event)
{
    if ( !( event instanceof WatchEvent ) ) return;



	const stream = await FileSystem.File.open( event.path );

    const homeDir = await Node.getHomeDirectory();

    const options =
    {
        'metadata':
        {
            'relativePath': event.path.substring( homeDir.length + 1 ),
        }
    }
    ;

    await Node.stream( 'file_receiver@R1', stream, options );
}