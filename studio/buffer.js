// Returns [string]
export const toBase64 = function (buffer)
{
    /*// (Setting the value)
    let binary = '';



    // (Getting the value)
    const bytes = new Uint8Array( buffer );



    for ( let i = 0; i < bytes.byteLength; i++ )
    {// Iterating each index
        // (Appending the value)
        binary += String.fromCharCode( bytes[i] );
    }



    // Returning the value
    return btoa( binary ); */



    // Returning the value
    return btoa( String.fromCharCode( ... ( buffer instanceof Uint8Array ? buffer : new Uint8Array( buffer ) ) ) );
}

// Returns [ArrayBuffer]
export const fromBase64 = function (content)
{
    // (Getting the value)
    const binaryContent = window.atob( content );



    // (Getting the value)
    const bytes = new Uint8Array( binaryContent.length );

    for ( let i = 0; i < binaryContent.length; i++ )
    {// Iterating each index
        // (Getting the value)
        bytes[i] = binaryContent.charCodeAt( i );
    }



    // Returning the value
    return bytes.buffer;
}



// Returns [string]
export const toText = function (buffer)
{
    // Returning the value
    return new TextDecoder().decode( buffer );
}

// Returns [ArrayBuffer]
export const fromText = function (text)
{
    // Returning the value
    return new TextEncoder().encode( text ).buffer;
}



// Returns [Object|false]
export const parseJBIN = function (buffer)
{
    // (Getting the value)
    const bytes = new Uint8Array( buffer );



    // (Setting the value)
    const separator = [ 10, 10 ];// '\n\n'

    for ( let i = 0; i < bytes.length - 1; i++ )
    {// Iterating each index
        if ( bytes[i] === separator[0] && bytes[i + 1] === separator[1] )
        {// Match OK
            // (Getting the values)
            const jsonBytes   = bytes.slice( 0, i );
            const binaryBytes = bytes.slice( i + 2 );



            // (Getting the value)
            const jsonText = new TextDecoder().decode( jsonBytes );



            // (Getting the value)
            const object =
            {
                'json':   JSON.parse( jsonText ),
                'binary': binaryBytes.buffer,
            }
            ;



            // Returning the value
            return object;
        }
    }



    // Returning the value
    return false;
}

// Returns [ArrayBuffer]
export const buildJBIN = function (json, binary)
{
    // (Getting the value)
    const textBufferView = new TextEncoder().encode( JSON.stringify( json ) + "\n\n" ); 
    


    // (Getting the value)
    const binaryBufferView = new Uint8Array( binary );



    // (Getting the value)
    const totalLength = textBufferView.length + binaryBufferView.length;
    


    // (Geting the value)
    const mergedArrayBuffer = new ArrayBuffer( totalLength );
    


    // (Getting the value)
    const finalView = new Uint8Array( mergedArrayBuffer );



    // (Setting the content)
    finalView.set( textBufferView, 0 );
    finalView.set( binaryBufferView, textBufferView.length );



    // Returning the value
    return mergedArrayBuffer;
}