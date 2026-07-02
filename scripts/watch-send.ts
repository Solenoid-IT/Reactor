// @enabled TRUE
// @mutex TRUE

// @on WATCH "{HOME_DIR}/Download" [file:created]



import { Event, WatchEvent, FileSystem, Node, Device, log } from 'core';

export async function run (event : Event)
{
    if ( !( event instanceof WatchEvent ) ) return;

    const relativePath = String( event.relativePath || '' ).replace( /\\/g, '/' );
    if ( !relativePath ) return;

    const filePath = relativePath.startsWith( '/' )
        ? relativePath
        : `${event.watchPath}/${relativePath}`;

    const notifyResult = await Device.notify( `New file detected: ${relativePath}` );
    await log( `notify result=${notifyResult ? 'ok' : 'failed'} file=${filePath}` );

	const stream = await FileSystem.File.open( filePath );

    const options =
    {
        'metadata':
        {
            'relativePath': relativePath.startsWith( '/' )
                ? relativePath.slice( 1 )
                : relativePath,
        }
    }
    ;

    await Node.stream( 'file_receiver@R1', stream, options );
}