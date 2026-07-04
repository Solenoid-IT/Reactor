import * as Encryption from '@/modules/Encryption.js';
import * as IDB from '@/modules/IDB.js';
import * as File from '@/modules/File.js';
import * as Buffer from '@/modules/Buffer.js';
import JSZip from 'jszip';

import { envs } from '@/envs.js';

import { Client } from '@/modules/Client.ts';



export async function generateKeyPair ()
{
    // Returning the value
    return await Encryption.generateKeyPair();
}

export async function storePrivateKey (userId : number, privateKey : string)
{
    // Returning the value
    return await ( new IDB.Connection( envs.IDB_DATABASE, 'personal_key' ) ).set( userId, privateKey );
}

export async function storePublicKey (publicKey : string, requestToken : string)
{
    // Returning the value
    return await new Client( '/api/user' ).run( 'User.set_e2ee_public_key', publicKey, new Headers( { 'Request-Token': requestToken } ) );
}



export async function encryptFile (file : File, publicKey : string)
{
    // (Getting the value)
    const userKey = await Encryption.UserKey.generate( publicKey );



    // (Getting the value)
    const cipherContent = await userKey.encrypt( await File.read( file ) );

    if ( !cipherContent )
    {// (Unable to encrypt file)
        // Throwing the exception
        throw new Error( 'Unable to encrypt file' );
    }



    // (Getting the value)
    const data =
    (
        {
            'content': new Blob( [ cipherContent ], { 'type': file.type } ),
            'crypto':  userKey.toCrypto()
        }
    )
    ;



    // Returning the value
    return data;
}

export async function decryptFile (content: any, crypto : object, privateKey : string)
{
    // (Getting the value)
    const accessKey = await new Encryption.AccessKey( crypto, privateKey ).import();



    // (Getting the value)
    const plainContent = await accessKey.decrypt( content );



    // Returning the value
    return plainContent;
}



export async function encryptText (text : string, publicKey : string)
{
    // (Getting the value)
    const userKey = await Encryption.UserKey.generate( publicKey );



    // (Getting the value)
    const cipherText = await userKey.encrypt( text );

    if ( !cipherText )
    {// (Unable to encrypt text)
        // Throwing the exception
        throw new Error( 'Unable to encrypt text' );
    }



    // (Getting the value)
    const data =
    (
        {
            'content': cipherText,
            'crypto':  userKey.toCrypto()
        }
    )
    ;



    // Returning the value
    return data;
}

export async function decryptText (text : string, crypto : object, privateKey : string)
{
    // (Getting the value)
    const accessKey = await new Encryption.AccessKey( crypto, privateKey ).import();



    // (Getting the value)
    const plainText = await accessKey.decrypt( text );

    if ( !plainText )
    {// (Unable to decrypt text)
        // Throwing the exception
        throw new Error( 'Unable to decrypt text' );
    }



    // Returning the value
    return plainText;
}



export function encodeCrypto (crypto : object)
{
    // (Getting the value)
    const json = JSON.stringify( crypto );



    // (Getting the value)
    const bytes = new TextEncoder().encode( json );



    // (Setting the value)
    let binary = '';

    for ( const byte of bytes )
    {// Processing each entry
        // (Appending the value)
        binary += String.fromCharCode( byte );
    }



    // Returning the value
    return btoa( binary );
}

export function decodeCrypto (crypto : string)
{
    // Returning the value
    return JSON.parse( atob( crypto ) );
}



export async function listPublicKeys (userIds : number[])
{
    // (Getting the values)
    const { code, body } = await new Client( '/api/user' ).run( 'User.list_e2ee_public_keys', userIds );

    if ( code !== 200 ) return null;



    // Returning the value
    return body;
}

export async function findUserGroupKey (groupId : number)
{
    // (Getting the values)
    const { code, body } = await new Client( '/api/user' ).run( 'Group.find_e2ee_key', groupId );
    
    if ( code !== 200 ) return null;



    // Returning the value
    return body;
}



export async function generateUserKey (targetUserId : number, srcUserCrypto : object, srcUserPrivateKey : string)
{
    // (Getting the value)
    const targetUserPublicKeys = await listPublicKeys( [ targetUserId ] );



    // (Getting the value)
    const targetUserPublicKey = targetUserPublicKeys[ targetUserId ];

    if ( !targetUserPublicKey )
    {// (Public key not found)
        // Alerting the value
        alert( 'Public key of target user not found' );



        // Throwing the exception
        throw new Error( 'Public key of target user not found' );
    }



    // (Getting the value)
    const entryAccessKey = await new Encryption.AccessKey( srcUserCrypto, srcUserPrivateKey ).import();



    // (Getting the value)
    const encResourceKey = await entryAccessKey.buildUserKey( targetUserPublicKey );



    // Returning the value
    return Buffer.toBase64( encResourceKey );
}

export async function generateUserGroupKey (targetGroupId : number, srcUserCrypto : object, srcUserPrivateKey : string)
{
    // (Getting the value)
    const userGroupKey = await findUserGroupKey( targetGroupId );

    if ( !userGroupKey )
    {// (Key not found)
        // Alerting the value
        alert( 'User key of target group not found' );



        // Throwing the exception
        throw new Error( 'User key of target group not found' );
    }



    // (Getting the value)
    const entryAccessKey = await new Encryption.AccessKey( srcUserCrypto, srcUserPrivateKey ).import();



    // (Getting the value)
    const groupKey = await Encryption.decryptKey( Buffer.fromBase64( userGroupKey ), srcUserPrivateKey );

    if ( !groupKey )
    {// (Unable to decrypt group key)
        // Throwing the exception
        throw new Error( 'Unable to decrypt target group key' );
    }



    // (Getting the value)
    const resourceGroupIV = await Encryption.generateIV();



    // (Getting the value)
    const encResourceGroupKey = await entryAccessKey.buildGroupKey( groupKey, resourceGroupIV );

    if ( !encResourceGroupKey )
    {// (Unable to build group key)
        // Throwing the exception
        throw new Error( 'Unable to build encrypted resource group key' );
    }



    // (Getting the value)
    const object =
    {
        'encResourceGroupKey': Buffer.toBase64( encResourceGroupKey ),
        'resourceGroupIV':     Buffer.toBase64( resourceGroupIV )
    }
    ;



    // Returning the value
    return object;
}



export async function generateResourceKey ()
{
    // Returning the value
    return await Encryption.generateKey();
}

export async function encryptResourceKey (resourceKey : ArrayBuffer, publicKey : string)
{
    // Returning the value
    return Buffer.toBase64( await Encryption.encryptKey( resourceKey, publicKey ) );
}

export async function decryptResourceKey (encResourceKey : string, privateKey : string)
{
    // Returning the value
    return await Encryption.decryptKey( Buffer.fromBase64( encResourceKey ), privateKey );
}



export async function decryptZipFile (zipFile : Blob, cryptoMap : Record<string, any>, privateKey : string)
{
    // (Getting the values)
    const zipIn  = await JSZip.loadAsync( zipFile );
    const zipOut = new JSZip();



    for ( const [ path, entry ] of Object.entries( zipIn.files ) )
    {// Processing each entry
        if ( entry.dir )
        {// (Entry is a directory)
            // (Adding the directory)
            zipOut.folder( path );

            // Continuing the iteration
            continue;
        }



        // (Getting the value)
        const normalizedPath = '/' + path.replace( /^\/+/, '' );



        // (Getting the values)
        const splitPath  = normalizedPath.split( '/' ).filter( Boolean );
        const trimmedPath = splitPath.length > 1 ? '/' + splitPath.slice( 1 ).join( '/' ) : normalizedPath;



        // (Getting the value)
        const crypto = cryptoMap?.[ normalizedPath ] ?? cryptoMap?.[ trimmedPath ];



        // (Getting the value)
        let outputContent : ArrayBuffer|false = await entry.async( 'arraybuffer' );

        if ( crypto )
        {// (Crypto found)
            // (Decrypting the file)
            outputContent = await decryptFile( outputContent, crypto, privateKey );

            if ( !outputContent )
            {// (Unable to decrypt file)
                // Throwing the exception
                throw new Error( `Unable to decrypt zip entry :: ${ path }` );
            }
        }



        if ( !outputContent )
        {// (Output content not found)
            // Throwing the exception
            throw new Error( `Invalid zip entry content :: ${ path }` );
        }



        // (Adding the file)
        zipOut.file( path, outputContent );
    }



    // Returning the value
    return await zipOut.generateAsync( { 'type': 'blob' } );
}