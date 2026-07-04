<svelte:head>
    <title>File Explorer</title>
</svelte:head>

<script>

    import * as File from '@/modules/File.js';
    import * as URL from '@/modules/URL.js';
    import * as Time from '@/modules/Time.js';

    import { Client } from '@/modules/Client.ts';
    import { Entity } from '@/modules/Entity.ts';

    import { user }    from '@/stores/user.js';
    import { appData } from '@/stores/appData.js';
    import { personalKey } from '@/stores/personalKey.js';

    import * as E2EEService from '@/services/E2EE.ts';

    import FileExplorer from '@/views/components/FileExplorer.svelte';
    import Modal        from '@/views/components/Modal.svelte';
    import Form         from '@/views/components/Form.svelte';
    import ShareModal   from '@/views/components/ShareModal.svelte';

    import { onMount, tick } from 'svelte';



    const client = new Client();
    const isNative = !import.meta.env.DEV;

    Entity.requestToken = $user['request_token'];



    const RESOURCE_ID = 1;



    let currentPath = '/';
    let files       = [];
    let loading     = false;

    let pageLengthOptions = [ 5, 10, 25, 50, 100, 200, 500 ];
    let pageLength        = 25;
    let pagePosition      = 0;
    let totalLength       = 0;

    let cursor            = { 'lastId': 0, 'lastSortValue': null };
    let nextCursor        = null;
    let pageHistory       = [ cursor ];

    let newFolderModal;
    let newFolderForm;
    let newFolderName = '';

    let moveEntryModal;
    let moveEntry = null;
    let moveBrowserParent = null;
    let moveBrowserPath = '/';
    let moveBrowserStack = [];
    let moveBrowserParents = [];
    let moveBrowserFolders = [];
    let moveBrowserLoading = false;

    let shareModal;

    let parent;
    let folderStack = [];
    let stats = { 'used_size': 0, 'total_size': 0, 'types': {} };
    let currentFolderInfo = null;
    let currentSearchQuery = '';

    let uploadQueue = [];
    let uploadSequence = 0;

    const MAX_PARALLEL_UPLOADS = 4;



    // Returns [void]
    function resetPaginator ()
    {
        pagePosition = 0;

        cursor =
        {
            'lastId':        0,
            'lastSortValue': null
        }
        ;

        nextCursor  = null;
        pageHistory = [ cursor ];
    }



    // Returns [string]
    function formatBytes (bytes)
    {
        if ( !bytes || bytes === 0 ) return '0 B';
        if ( bytes < 1024 )         return bytes + ' B';
        if ( bytes < 1048576 )      return ( bytes / 1024 ).toFixed( 1 ) + ' KB';
        if ( bytes < 1073741824 )   return ( bytes / 1048576 ).toFixed( 1 ) + ' MB';

        // Returning the value
        return ( bytes / 1073741824 ).toFixed( 2 ) + ' GB';
    }



    // Returns [string]
    function encodeJsonToBase64 (value)
    {
        // (Getting the value)
        const json = JSON.stringify( value );

        // (Getting the value)
        const bytes = new TextEncoder().encode( json );

        // (Setting the value)
        let binary = '';

        for ( const byte of bytes )
        {
            // (Appending the value)
            binary += String.fromCharCode( byte );
        }

        // Returning the value
        return btoa( binary );
    }



    // Returns [Promise:void]
    async function listEntries (options = {})
    {
        loading = true;

        try
        {
            // (Getting the values)
            const query = options['query'] !== undefined ? options['query'] : currentSearchQuery;

            // (Getting the value)
            const input =
            {
                'paginator':
                {
                    'length': options['length'] || pageLength,
                    'cursor': options['cursor'] || cursor,
                },

                'parent': parent,
                'query': query,
            }
            ;
            


            // (Getting the values)
            const { code, body } = await client.run( 'Resources/File.list_entries', input );

            if ( code !== 200 ) return;



            // (Getting the value)
            const paginator = Array.isArray( body )
                ?
                {
                    'elements': body,
                    'length':   body.length,
                    'cursor':   null,
                }
                :
                {
                    'elements': body?.['elements'] || [],
                    'length':   body?.['length'] || 0,
                    'cursor':   body?.['cursor'] || null,
                }
            ;



            // (Setting the value)
            $appData['paginator'] =
            {
                'length': paginator['length'],
                'cursor': paginator['cursor'],
            }
            ;



            // (Setting the values)
            totalLength = paginator['length'] || 0;
            nextCursor  = paginator['cursor'] || null;



            files = paginator['elements'].map( function ( item )
            {
                return {
                    id:       item['id'],
                    parent:   item['parent'] ?? null,
                    name:     item['name'],
                    type:     item['folder'] ? 'folder' : item['type'],
                    mime:     item['mime'] || null,
                    size:     item['size'] || 0,
                    modified: Time.toLocal( item['datetime']['update'] ?? item['datetime']['insert'] ),
                    shareRule: item['share_rule'] ?? 2,
                    path:     item['path'] || null,
                };
            } )
            ;
        }
        finally
        {
            loading = false;
        }
    }



    // Returns [Promise:void]
    async function onNavigate ( event )
    {
        // (Getting the values)
        const { path, parent: newParent, depth = null } = event.detail;



        // (Updating the folder stack)
        if ( depth === 0 )
        {
            folderStack = [];
            parent = null;
        }
        else
        {
            if ( newParent !== null && newParent !== undefined )
            {
                if ( depth === null )
                {
                    folderStack = [ ...folderStack, newParent ];
                }
                else
                {
                    folderStack = [ ...folderStack.slice( 0, Math.max( 0, depth - 1 ) ), newParent ];
                }
            }

            parent = newParent;
        }



        // (Getting the value)
        currentPath = path;



        // (Resetting paginator)
        resetPaginator();



        // (Listing entries)
        await listEntries();
    }



    // Returns [Promise:void]
    async function onPrevPageClick ()
    {
        if ( pagePosition === 0 ) return;



        // (Decrementing the value)
        pagePosition -= pageLength;



        // (Getting the previous cursor)
        cursor = pageHistory[ pageHistory.length - 2 ] || { 'lastId': 0, 'lastSortValue': null };

        // (Popping the value)
        pageHistory.pop();



        await listEntries
        (
            {
                'length': pageLength,
                'cursor': cursor,
                'query':  currentSearchQuery,
            }
        )
        ;
    }

    // Returns [Promise:void]
    async function onNextPageClick ()
    {
        if ( pagePosition + pageLength >= totalLength ) return;

        if ( !nextCursor ) return;



        // (Incrementing the value)
        pagePosition += pageLength;



        // (Setting the value)
        cursor = nextCursor;

        // (Appending the value)
        pageHistory.push( cursor );



        await listEntries
        (
            {
                'length': pageLength,
                'cursor': cursor,
                'query':  currentSearchQuery,
            }
        )
        ;
    }

    // Returns [Promise:void]
    async function onPageLengthChange (value)
    {
        // (Getting the value)
        pageLength = parseInt( value );

        if ( Number.isNaN( pageLength ) || pageLength <= 0 )
        {// (Value is not valid)
            // (Setting the value)
            pageLength = 25;
        }



        // (Resetting the paginator)
        resetPaginator();

        await listEntries( { 'query': currentSearchQuery } );
    }



    // Returns [Promise:void]
    async function onUpload ( event )
    {
        if ( $user['tenant']['e2ee'] )
        {// (E2EE is enabled on workspace)
            if ( !$user['e2ee']['public_key'] )
            {// (User doesn't have a public key)
                // Alerting the message
                alert( `You don't have a public key. This workspace requires E2EE.` );

                // Returning the value
                return;
            }
        }



        const { path, files: fileList } = event.detail;

        // (Resetting the upload queue)
        uploadQueue = [];

        // (Setting the values)
        const failedFiles = [];

        try
        {
            await uploadFilesWithConcurrency( path, fileList, MAX_PARALLEL_UPLOADS, failedFiles );
        }
        finally
        {
            await listEntries();

            if ( failedFiles.length > 0 )
            {
                alert( `Upload falliti: ${ failedFiles.join( ', ' ) }` );
            }
        }
    }



    // Returns [Promise:void]
    async function uploadFilesWithConcurrency (path, fileList, maxParallel, failedFiles)
    {
        // (Normalizing the value)
        const workersLength = Math.max( 1, Math.min( maxParallel, fileList.length ) );



        // (Setting the value)
        let nextIndex = 0;



        // (Setting the value)
        const workers = Array.from( { length: workersLength }, async function ()
        {
            while ( true )
            {
                // (Getting the value)
                const currentIndex = nextIndex;

                // (Incrementing the value)
                nextIndex += 1;

                if ( currentIndex >= fileList.length ) break;



                // (Getting the value)
                const file = fileList[ currentIndex ];

                try
                {
                    await uploadFileWithProgress( path, file );
                }
                catch ( error )
                {
                    // (Appending the value)
                    failedFiles.push( file.name );
                }
            }
        } );



        // (Waiting for workers)
        await Promise.all( workers );
    }



    // Returns [Promise:void]
    function uploadFileWithProgress (path, file)
    {
        // (Getting the value)
        const uploadId = ++uploadSequence;



        // (Appending the value)
        uploadQueue =
        [
            ...uploadQueue,
            {
                id:       uploadId,
                name:     file.name,
                size:     file.size,
                progress: 0,
                status:   'uploading',
                error:    null,
            }
        ]
        ;



        // Returning the value
        return new Promise
        (
            async function (resolve, reject)
            {
                // (Getting the value)
                let uploadBody = file;

                // (Setting the value)
                let uploadCrypto = null;

                if ( $user['tenant']['e2ee'] )
                {// Value is true
                    // (Getting the value)
                    const data = await E2EEService.encryptFile( file, $user['e2ee']['public_key'] );



                    // (Getting the values)
                    uploadBody   = data.content;
                    uploadCrypto = data.crypto;
                }



                // (Creating the request)
                const xhr = new XMLHttpRequest();



                // (Opening the request)
                xhr.open( isNative ? 'RUN' : 'POST', '/api/user?p=Resources/File.put_file' );

                if ( !isNative )
                {
                    xhr.setRequestHeader( 'X-HTTP-Method-Override', 'RUN' );
                }



                // (Getting the values)
                const bodySize = file.size;
                const bodyType = uploadBody?.type || file.type || 'application/octet-stream';



                // (Setting the headers)
                xhr.setRequestHeader( 'Request-Token', Entity.requestToken );
                xhr.setRequestHeader( 'X-File-Name', file.name );
                xhr.setRequestHeader( 'X-File-Size', String( bodySize ) );
                xhr.setRequestHeader( 'X-File-Type', bodyType );
                xhr.setRequestHeader( 'X-File-Path', path );

                if ( parent !== null && parent !== undefined )
                {// Value found
                    // (Setting the header)
                    xhr.setRequestHeader( 'X-Parent-Id', String( parent ) );
                }

                if ( uploadCrypto )
                {// Value found
                    // (Setting the header)
                    xhr.setRequestHeader( 'X-File-Crypto', E2EEService.encodeCrypto( uploadCrypto ) );
                }



                // (Setting the header)
                xhr.setRequestHeader( 'Content-Type', bodyType );



                // (Tracking the upload progress)
                xhr.upload.onprogress = function (event)
                {
                    if ( !event.lengthComputable ) return;



                    // (Updating the value)
                    uploadQueue = uploadQueue.map
                    (
                        function (item)
                        {
                            if ( item.id !== uploadId ) return item;

                            return {
                                ...item,
                                progress: Math.round( ( event.loaded / event.total ) * 100 ),
                            };
                        }
                    )
                    ;
                };



                // (Handling success)
                xhr.onload = function ()
                {
                    if ( xhr.status >= 200 && xhr.status < 300 )
                    {
                        // (Updating the value)
                        uploadQueue = uploadQueue.map
                        (
                            function (item)
                            {
                                if ( item.id !== uploadId ) return item;

                                return {
                                    ...item,
                                    progress: 100,
                                    status:   'done',
                                };
                            }
                        )
                        ;

                        // Returning the value
                        resolve();
                        return;
                    }



                    // (Updating the value)
                    uploadQueue = uploadQueue.map
                    (
                        function (item)
                        {
                            if ( item.id !== uploadId ) return item;

                            return {
                                ...item,
                                status: 'error',
                                error:  xhr.responseText || `HTTP ${ xhr.status }`,
                            };
                        }
                    )
                    ;

                    // Throwing the exception
                    reject( new Error( xhr.responseText || `HTTP ${ xhr.status }` ) );
                };



                // (Handling errors)
                xhr.onerror = function ()
                {
                    // (Updating the value)
                    uploadQueue = uploadQueue.map
                    (
                        function (item)
                        {
                            if ( item.id !== uploadId ) return item;

                            return {
                                ...item,
                                status: 'error',
                                error:  'Network error',
                            };
                        }
                    )
                    ;

                    // Throwing the exception
                    reject( new Error( 'Network error' ) );
                };



                // (Sending the body)
                xhr.send( uploadBody );
            }
        )
        ;
    }



    // Returns [Promise:void]
    async function onDownloadFile (event)
    {
        // (Getting the value)
        const { file } = event.detail;

        if ( !file ) return;

        try
        {
            // (Downloading the file)
            await downloadFile( file );
        }
        catch (error)
        {
            alert( `Download failed :: ${ file.name }` );
        }
    }



    // Returns [Promise:void]
    function downloadFile (file)
    {
        // Returning the value
        return new Promise
        (
            function (resolve, reject)
            {
                // (Creating the request)
                const xhr = new XMLHttpRequest();



                // (Opening the request)
                xhr.open( isNative ? 'RUN' : 'POST', '/api/user?p=Resources/File.download_file' );

                if ( !isNative )
                {
                    xhr.setRequestHeader( 'X-HTTP-Method-Override', 'RUN' );
                }



                // (Setting the headers)
                xhr.setRequestHeader( 'Request-Token', Entity.requestToken );
                xhr.setRequestHeader( 'Content-Type', 'text/plain' );



                // (Setting the response type)
                xhr.responseType = 'arraybuffer';



                // (Handling success)
                xhr.onload = async function ()
                {
                    if ( xhr.status >= 200 && xhr.status < 300 )
                    {// (Data ready)
                        if ( $user['tenant']['e2ee'] )
                        {// (E2EE is enabled on workspace)
                            if ( !$personalKey )
                            {// (User doesn't have a private key)
                                // Alerting the message
                                alert( `You don't have a private key. This workspace requires E2EE.` );

                                // Returning the value
                                return;
                            }



                            // (Getting the value)
                            const crypto = E2EEService.decodeCrypto( xhr.getResponseHeader( 'X-File-Crypto' ) );



                            // (Decrypting the file)
                            const plainContent = await E2EEService.decryptFile( xhr.response, crypto, $personalKey );

                            // (Downloading the file)
                            File.downloadFromBlob
                            (
                                xhr.getResponseHeader( 'Content-Disposition' ).split( '; ' )[1].split( '=' )[1].replace( /\"/g, '' ),
                                new Blob( [ plainContent ], { 'type': xhr.getResponseHeader( 'Content-Type' ) } )
                            )
                            ;



                            // Returning the value
                            return;
                        }



                        // (Downloading file)
                        File.download( file.name, file.mime || 'application/octet-stream', xhr.response );



                        // (Calling the function)
                        resolve();



                        // Returning the value
                        return;
                    }



                    // Throwing the exception
                    reject( new Error( `HTTP ${ xhr.status }` ) );
                };



                // (Handling errors)
                xhr.onerror = function ()
                {
                    // Throwing the exception
                    reject( new Error( 'Network error' ) );
                };



                // (Sending the body)
                xhr.send( String( file.id ) );
            }
        )
        ;
    }



    // Returns [Promise:void]
    async function onDownloadFolder ( event )
    {
        // (Getting the value)
        const { file } = event.detail;

        loading = true;

        try
        {
            // (Setting the value)
            const headers =
            {
                'Request-Token': Entity.requestToken,
                'Content-Type':  'text/plain',
            }
            ;

            if ( !isNative )
            {
                headers['X-HTTP-Method-Override'] = 'RUN';
            }



            const response = await fetch
            (
                '/api/user?p=Resources/File.download_folder',
                {
                    method:  isNative ? 'RUN' : 'POST',
                    headers,
                    body:    file ? file.id : '',
                }
            )
            ;

            if ( !response.ok ) { alert( 'Errore durante il download della cartella' ); return; }

            // (Getting the value)
            const contentDisposition = response.headers.get( 'Content-Disposition' ) || '';

            // (Setting the value)
            let filename = '';



            // (Getting the value)
            const filenameStarMatch = contentDisposition.match( /filename\*=UTF-8''([^;]+)/i );

            if ( filenameStarMatch && filenameStarMatch[1] )
            {// Match found
                try
                {
                    // (Decoding the value)
                    filename = decodeURIComponent( filenameStarMatch[1] );
                }
                catch ( error )
                {
                    // (Setting the value)
                    filename = filenameStarMatch[1];
                }
            }
            else
            {
                // (Getting the value)
                const filenameMatch = contentDisposition.match( /filename="?([^";]+)"?/i );

                if ( filenameMatch && filenameMatch[1] )
                {// Match found
                    // (Setting the value)
                    filename = filenameMatch[1];
                }
            }



            if ( !filename )
            {// Value not found
                // (Setting the value)
                filename = path === '/' ? 'root.zip' : path.split( '/' ).pop() + '.zip';
            }



            // (Getting the value)
            let blob = await response.blob();



            if ( $user['tenant']['e2ee'] )
            {// (E2EE is enabled on workspace)
                if ( !$personalKey )
                {// (User doesn't have a private key)
                    // Alerting the message
                    alert( `You don't have a private key. This workspace requires E2EE.` );

                    // Returning the value
                    return;
                }



                // (Getting the values)
                const { code: cryptoCode, body: cryptoMap } = await client.run( 'Resources/File.list_crypto', file?.id ? file.id : undefined );

                if ( cryptoCode !== 200 )
                {// (Request failed)
                    // Throwing the exception
                    throw new Error( 'Unable to fetch folder cryptos' );
                }



                // (Getting the value)
                blob = await E2EEService.decryptZipFile( blob, cryptoMap, $personalKey );
            }



            // (Downloading file)
            File.downloadFromBlob( filename, blob );
        }
        finally
        {
            loading = false;
        }
    }



    // Returns [Promise:void]
    async function onFolderInfo (event)
    {
        // (Getting the value)
        const { file, reference } = event.detail;



        // (Getting the value)
        const input =
        {
            'reference': reference || 'user',
            'folder_id': file?.id,
        }
        ;



        // (Saving the current folder for later reference changes)
        currentFolderInfo = { file, reference };



        // (Getting the values)
        const { code, body } = await client.run( 'Resources/File.get_folder_info', input );

        if ( code !== 200 ) return;



        // (Setting the value)
        stats = body || { 'used_size': 0, 'total_size': 0, 'types': {} };
    }



    // Returns [Promise:void]
    async function onFolderInfoReferenceChange (event)
    {
        if ( !currentFolderInfo ) return;

        // (Getting the value)
        const { reference } = event.detail;



        // (Getting the value)
        const input =
        {
            'reference': reference || 'user',
            'folder_id': currentFolderInfo.file?.id,
        }
        ;



        // (Getting the values)
        const { code, body } = await client.run( 'Resources/File.get_folder_info', input );

        if ( code !== 200 ) return;



        // (Setting the value)
        stats = body || { 'used_size': 0, 'total_size': 0, 'types': {} };
    }



    let searchTimeout;

    // Returns [Promise:void]
    async function onSearch (event)
    {
        // (Clearing timeout)
        clearTimeout( searchTimeout );



        // (Setting timeout)
        searchTimeout = setTimeout
        (
            async function ()
            {
                // (Getting the value)
                const { query } = event.detail;
                currentSearchQuery = query || '';

                if ( query )
                {// (Searching)
                    // (Resetting paginator)
                    resetPaginator();

                    // (Listing entries with search)
                    await listEntries( { 'query': currentSearchQuery } );
                }
                else
                {// (Clearing search)
                    // (Resetting paginator)
                    resetPaginator();

                    // (Listing entries)
                    await listEntries();
                }
            },
            300
        )
        ;
    }



    // Returns [Promise:void]
    async function onDelete (event)
    {
        // (Getting the value)
        const { entries } = event.detail;



        // (Getting the values)
        const fileIds   = entries.filter( ( entry ) => entry.type === 'file' ).map( ( entry ) => entry.id );
        const folderIds = entries.filter( ( entry ) => entry.type === 'folder' ).map( ( entry ) => entry.id );



        if ( !confirm( 'Are you sure to remove selected entries ?' ) ) return;



        if ( fileIds.length > 0 )
        {// (There are files to delete)
            // (Deleting files)
            await client.run( 'Resources/File.remove_file', fileIds, new Headers( { 'Request-Token': Entity.requestToken } ) );
        }

        if ( folderIds.length > 0 )
        {// (There are folders to delete)
            // (Deleting folders)
            await client.run( 'Resources/File.remove_folder', folderIds, new Headers( { 'Request-Token': Entity.requestToken } ) );
        }



        // (Listing entries)
        await listEntries();
    }



    // Returns [Promise:void]
    async function onRename (event)
    {
        // (Getting the values)
        const { id, name } = event.detail;



        // (Getting the value)
        const input =
        {
            'id':   id,
            'name': name,
        }
        ;



        // (Getting the value)
        const { code } = await client.run( 'Resources/File.rename_entry', input, new Headers( { 'Request-Token': Entity.requestToken } ) );

        if ( code !== 200 ) return;



        // (Listing entries)
        await listEntries();
    }



    // Returns [array:string]
    function getCurrentPathParts ()
    {
        return ( currentPath || '/' ).split( '/' ).filter( Boolean );
    }



    // Returns [string]
    function buildMovePathFromStack (stack)
    {
        if ( stack.length === 0 ) return '/';

        // Returning the value
        return '/' + stack.map( (item) => item.name ).join( '/' );
    }



    // Returns [Promise:void]
    async function listMoveFolders (targetParent = null)
    {
        moveBrowserLoading = true;

        try
        {
            // (Getting the value)
            const input =
            {
                'paginator':
                {
                    'length': 500,
                    'cursor': { 'lastId': 0, 'lastSortValue': null },
                },

                'parent': targetParent,
            }
            ;



            // (Getting the values)
            const { code, body } = await client.run( 'Resources/File.list_entries', input );

            if ( code !== 200 )
            {
                moveBrowserFolders = [];
                return;
            }



            // (Getting the value)
            const paginator = Array.isArray( body )
                ? { 'elements': body }
                : { 'elements': body?.['elements'] || [] }
            ;



            // (Setting the value)
            moveBrowserFolders = paginator['elements']
                .filter( (entry) => entry['folder'] )
                .map( function (entry)
                {
                    return {
                        'id':     entry['id'],
                        'name':   entry['name'],
                        'parent': entry['parent'] ?? null,
                    };
                } )
            ;
        }
        finally
        {
            moveBrowserLoading = false;
        }
    }



    // Returns [Promise:void]
    async function initMoveBrowserFromCurrentPath ()
    {
        // (Getting the value)
        const pathParts = getCurrentPathParts();



        // (Setting the values)
        moveBrowserStack = folderStack.map( function (id, index)
        {
            return {
                'id':   id,
                'name': pathParts[ index ] || String( id ),
            };
        } );

        // (Building the parent breadcrumb)
        moveBrowserParents = [ null, ...folderStack.slice( 0, -1 ) ];

        moveBrowserParent = parent ?? null;
        moveBrowserPath = buildMovePathFromStack( moveBrowserStack );



        // (Listing folders)
        await listMoveFolders( moveBrowserParent );
    }



    // Returns [Promise:void]
    async function onMove (event)
    {
        // (Getting the value)
        const { entry } = event.detail;

        if ( !entry ) return;



        // (Setting the values)
        moveEntry = entry;



        // (Initializing browser)
        await initMoveBrowserFromCurrentPath();



        // (Showing the modal)
        moveEntryModal.show();
    }



    // Returns [Promise:void]
    async function onMoveNavigateRoot ()
    {
        moveBrowserStack = [];
        moveBrowserParents = [];
        moveBrowserParent = null;
        moveBrowserPath = '/';

        await listMoveFolders( moveBrowserParent );
    }



    // Returns [Promise:void]
    async function onMoveNavigateCrumb (index)
    {
        if ( index < 0 )
        {
            await onMoveNavigateRoot();
            return;
        }



        moveBrowserStack = moveBrowserStack.slice( 0, index + 1 );
        moveBrowserParents = moveBrowserParents.slice( 0, index + 1 );
        moveBrowserParent = moveBrowserParents[ index ] ?? null;
        moveBrowserPath = buildMovePathFromStack( moveBrowserStack );

        await listMoveFolders( moveBrowserParent );
    }



    // Returns [Promise:void]
    async function onMoveOpenFolder (folder)
    {
        if ( !folder || folder.id === moveEntry?.id ) return;



        moveBrowserStack = [ ...moveBrowserStack, { 'id': folder.id, 'name': folder.name } ];
        moveBrowserParents = [ ...moveBrowserParents, folder.parent ?? null ];
        moveBrowserParent = folder.id;
        moveBrowserPath = buildMovePathFromStack( moveBrowserStack );

        await listMoveFolders( moveBrowserParent );
    }



    // Returns [Promise:void]
    async function confirmMove ()
    {
        if ( !moveEntry ) return;



        // (Normalizing the value)
        const targetParent = moveBrowserParent;

        if ( targetParent === ( moveEntry.parent ?? null ) )
        {
            moveEntryModal.hide();
            return;
        }



        // (Getting the values)
        const { code } = await client.run
        (
            'Resources/File.move_entry',
            {
                'id':     moveEntry.id,
                'parent': targetParent,
            },
            new Headers( { 'Request-Token': Entity.requestToken } )
        )
        ;

        if ( code !== 200 ) return;



        // (Resetting the state)
        moveEntryModal.hide();
        moveEntry = null;
    moveBrowserFolders = [];
    moveBrowserStack = [];
        moveBrowserParents = [];
        // (Listing entries)
        await listEntries();
    }



    // Returns [Promise:void]
    async function onShare (event)
    {
        // (Getting the value)
        const { entry } = event.detail;

        if ( !entry ) return;



        // (Opening the modal)
        await shareModal.open( RESOURCE_ID, entry.id, entry.shareRule ?? 2 );
    }



    // Returns [void]
    function onOpen ( event )
    {
        const { file } = event.detail;

        // Preview or handle file opening
        window.open( `/api/user?action=Resources/File/preview&id=${ file.id }`, '_blank' );
    }



    // Returns [Promise:void]
    async function onNewFolder ( event )
    {
        // (Getting the value)
        const { parent: newParent } = event.detail;



        // (Getting the value)
        parent = newParent;



        // (Setting the value)
        newFolderName = '';



        // (Showing the modal)
        newFolderModal.show();
    }



    // Returns [Promise:bool]
    async function createFolder ()
    {
        // (Validating the form)
        const result = newFolderForm.validate();

        if ( !result.valid ) return false;



        // (Getting the value)
        const input = result.fetch();



        // (Getting the value)
        const { code } = await client.run
        (
            'Resources/File.create_folder',
            {
                'name':   input['name'],
                'parent': parent,
            },
            new Headers( { 'Request-Token': Entity.requestToken } )
        )
        ;

        if ( code !== 200 ) return false;



        // (Hiding the modal)
        newFolderModal.hide();



        // (Listing entries)
        await listEntries();



        // Returning the value
        return true;
    }



    onMount
    (
        async function ()
        {
            // (Resetting paginator)
            resetPaginator();



            // (Getting the value)
            parent = URL.getParam( 'p', 'int' );



            // (Listing entries)
            await listEntries();
        }
    )
    ;

</script>



<div class="container-fluid px-4 py-3" style="height: 100%; display: flex; flex-direction: column;">

    <!-- Header -->
    <div class="d-flex align-items-center mb-3">
        <h4 class="mb-0 mr-3" style="color: var(--simba-dark-text); font-weight: 600;">
            <i class="fa-solid fa-folder-open mr-2" style="color: var(--simba-primary);"></i>
            File Explorer
        </h4>
    </div>

    <!-- File Explorer Component -->
    {#if uploadQueue.length > 0}
        <div class="card mb-3" style="border: 1px solid rgba(0,0,0,.08);">
            <div class="card-body py-3">
                <div class="d-flex align-items-center justify-content-between mb-3">
                    <div>
                        <strong>Uploading files ...</strong>
                        <div class="text-muted small">{ uploadQueue.filter( ( item ) => item.status === 'done' ).length } / { uploadQueue.length } completed</div>
                    </div>
                </div>

                <div class="d-flex flex-column" style="gap: .75rem;">
                    {#each uploadQueue as item ( item.id )}
                        <div>
                            <div class="d-flex justify-content-between align-items-center mb-1">
                                <div class="small" style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%;">{ item.name }</div>
                                <div class="small text-muted">{ formatBytes( item.size ) } · { item.progress }%</div>
                            </div>

                            <div class="progress" style="height: 8px;">
                                <div
                                    class="progress-bar { item.status === 'done' ? 'bg-success' : item.status === 'error' ? 'bg-danger' : 'bg-primary progress-bar-striped progress-bar-animated' }"
                                    role="progressbar"
                                    style="width: { item.progress }%;"
                                    aria-valuenow={ item.progress }
                                    aria-valuemin="0"
                                    aria-valuemax="100"
                                ></div>
                            </div>

                            {#if item.status === 'error'}
                                <div class="small text-danger mt-1">{ item.error || 'Upload failed' }</div>
                            {/if}
                        </div>
                    {/each}
                </div>
            </div>
        </div>
    {/if}

    <div style="flex: 1; min-height: 0;">
        <FileExplorer
            path={ currentPath }
            { parent }
            bind:files={ files }
            { loading }
            { stats }
            paginator={ true }
            { pageLengthOptions }
            { pageLength }
            { pagePosition }
            { totalLength }
            on:navigate={ onNavigate }
            on:page-prev={ onPrevPageClick }
            on:page-next={ onNextPageClick }
            on:page-length-change={ (event) => onPageLengthChange( event.detail.value ) }
            on:search={ onSearch }
            on:upload={ onUpload }
            on:download-file={ onDownloadFile }
            on:download-folder={ onDownloadFolder }
            on:delete={ onDelete }
            on:rename={ onRename }
            on:move={ onMove }
            on:share={ onShare }
            on:open={ onOpen }
            on:new-folder={ onNewFolder }
            on:folder-info={ onFolderInfo }
            on:folder-info-reference-change={ onFolderInfoReferenceChange }
        />
    </div>

</div>



<!-- New Folder Modal -->
<Modal title="New Folder" bind:api={ newFolderModal } width="400px">
    <Form bind:api={ newFolderForm } on:submit={ createFolder }>
        <div class="row">
            <div class="col">
                <label class="d-block m-0">
                    Name (*)
                    <input
                        type="text"
                        class="form-control input form-input mt-1"
                        name="name"
                        placeholder="ex. Documents"
                        data-required
                        bind:value={ newFolderName }
                    >
                </label>
            </div>
        </div>
        <div class="row mt-4">
            <div class="col text-center">
                <button type="submit" class="btn btn-primary">
                    Create
                </button>
            </div>
        </div>
    </Form>
</Modal>



<Modal title="Move Entry" bind:api={ moveEntryModal } width="460px">
    <div class="row">
        <div class="col">
            <div class="small text-muted mb-2">Entry</div>
            <div class="mb-3" style="font-weight: 600; word-break: break-all;">{ moveEntry?.name || '-' }</div>

            <div class="small text-muted mb-2">Destination</div>
            <div class="mb-2" style="display: flex; flex-wrap: wrap; gap: 6px;">
                <button type="button" class="btn btn-sm fe-btn-secondary" on:click={ onMoveNavigateRoot }>/</button>
                {#each moveBrowserStack as crumb, index}
                    <button type="button" class="btn btn-sm fe-btn-secondary" on:click={ () => onMoveNavigateCrumb( index ) }>{ crumb.name }</button>
                {/each}
            </div>

            <div class="small mb-2" style="word-break: break-all; color: var( --simba-dark-text-muted );">
                Current destination: { moveBrowserPath }
            </div>

            <div style="border: 1px solid var( --simba-dark-border ); border-radius: 6px; min-height: 180px; max-height: 220px; overflow-y: auto; padding: 8px;">
                {#if moveBrowserLoading}
                    <div class="small text-muted py-2">Loading folders ...</div>
                {:else if moveBrowserFolders.length === 0}
                    <div class="small text-muted py-2">No folders in this location</div>
                {:else}
                    <div class="d-flex flex-column" style="gap: 6px;">
                        {#each moveBrowserFolders as folder}
                            <button
                                type="button"
                                class="btn btn-sm text-left"
                                style="background: var( --simba-dark-soft ); border: 1px solid var( --simba-dark-border ); color: var( --simba-dark-text );"
                                disabled={ folder.id === moveEntry?.id }
                                on:click={ () => onMoveOpenFolder( folder ) }
                            >
                                <i class="fa-solid fa-folder mr-2" style="color: var( --simba-primary );"></i>
                                { folder.name }
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>
    </div>

    <div class="row mt-4">
        <div class="col text-center">
            <button
                type="button"
                class="btn btn-primary"
                disabled={ moveBrowserParent === moveEntry?.id }
                on:click={ confirmMove }
            >
                Move
            </button>
        </div>
    </div>
</Modal>



<ShareModal bind:api={ shareModal }/>