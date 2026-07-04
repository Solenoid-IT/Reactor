import * as Buffer from '@/modules/Buffer.js';



const AES_ALGO            = 'AES-GCM';
const AES_KEY_LENGTH      = 256;
const AES_IV_LENGTH       = 12;
const AES_AUTH_TAG_LENGTH = 128;

const AES_PARAMS =
{
    'name':   AES_ALGO,
    'length': AES_KEY_LENGTH
}
;



const RSA_LENGTH = 4096;

const RSA_PARAMS =
{
    'name': 'RSA-OAEP',
    'hash': 'SHA-256'
}
;



// Returns [Promise:ArrayBuffer]
export const convertKey = async function (key)
{
    // (Getting the value)
    const binaryContent = window.atob( key.trim().split( "\n" ).slice( 1, -1 ).join( '' ).trim() );
    


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



// Returns [Promise:ArrayBuffer|false]
export const encryptRSA = async function (content, publicKey)
{
    try
    {
        // Returning the value
        return await crypto.subtle.encrypt
        (
            {
                'name': 'RSA-OAEP',
                'hash': 'SHA-256'
            },
            publicKey,
            content
        )
        ;
    }
    catch (e)
    {
        // Returning the value
        return false;
    }
}

// Returns [Promise:ArrayBuffer|false]
export const decryptRSA = async function (content, privateKey)
{
    try
    {
        // Returning the value
        return await crypto.subtle.decrypt
        (
            {
                'name': 'RSA-OAEP',
                'hash': 'SHA-256'
            },
            privateKey,
            content
        )
        ;
    }
    catch (e)
    {
        // Returning the value
        return false;
    }
}



// Returns [Promise:object]
export const generateKeyPair = async function ()
{
    // (Generating key pair)
    const keyPair = await window.crypto.subtle.generateKey
    (
        {
            'name':           'RSA-OAEP',
            'hash':           'SHA-256',
            'modulusLength':  RSA_LENGTH,
            'publicExponent': new Uint8Array( [ 0x01, 0x00, 0x01 ] ), // 65537 (standard)
        },
        true,
        [ 'encrypt', 'decrypt' ]
    )
    ;



    // (Getting the value)
    const object =
    {
        'privateKey': "-----BEGIN PRIVATE KEY-----\n" + Buffer.toBase64( await window.crypto.subtle.exportKey( 'pkcs8', keyPair.privateKey ) ).match(/.{1,64}/g).join( "\n" ) + "\n-----END PRIVATE KEY-----\n",
        'publicKey':  "-----BEGIN PUBLIC KEY-----\n" + Buffer.toBase64( await window.crypto.subtle.exportKey( 'spki', keyPair.publicKey ) ).match(/.{1,64}/g).join( "\n" ) + "\n-----END PUBLIC KEY-----\n"
    }
    ;



    // Returning the value
    return object;
}



// Returns [Promise:ArrayBuffer|false]
export const generateKey = async function ()
{
    try
    {
        // (Getting the value)
        const cryptoKey = await window.crypto.subtle.generateKey
        (
            AES_PARAMS,
            true,
            [ 'encrypt', 'decrypt' ]
        )
        ;



        // (Getting the value)
        const rawKey = await window.crypto.subtle.exportKey( 'raw', cryptoKey );



        // Returning the value
        return rawKey;
    }
    catch (e)
    {
        // Returning the value
        return false;
    }
}

// Returns [Promise:ArrayBuffer]
export const generateIV = async function ()
{
    // Returning the value
    return window.crypto.getRandomValues( new Uint8Array( AES_IV_LENGTH ) ).buffer;
}



// Returns [Promise:ArrayBuffer]
export const generateNonce = async function (length)
{
    // Returning the value
    return window.crypto.getRandomValues( new Uint8Array( length ) ).buffer;
}




// Returns [Promise:ArrayBuffer|false]
export const encrypt = async function (content, key, iv)
{
    try
    {
        // (Getting the value)
        const cryptoKey = await window.crypto.subtle.importKey
        (
            'raw',
            key,
            AES_PARAMS,
            false,
            [ 'encrypt' ]
        )
        ;



        // (Getting the value)
        const encContent = await window.crypto.subtle.encrypt
        (
            {
                'name':      AES_ALGO,
                'length':    AES_KEY_LENGTH,

                'iv':        iv,

                'tagLength': AES_AUTH_TAG_LENGTH
            },
            cryptoKey,
            content
        )
        ;



        // Returning the value
        return encContent;
    }
    catch (e)
    {
        // Returning the value
        return false;
    }
}

// Returns [Promise:ArrayBuffer|false]
export const decrypt = async function (content, key, iv)
{
    try
    {
        // (Getting the value)
        const cryptoKey = await window.crypto.subtle.importKey
        (
            'raw',
            key,
            AES_PARAMS,
            false,
            [ 'decrypt' ]
        )
        ;



        // (Getting the value)
        const rawContent = await window.crypto.subtle.decrypt
        (
            {
                'name':      AES_ALGO,
                'length':    AES_KEY_LENGTH,

                'iv':        iv,

                'tagLength': AES_AUTH_TAG_LENGTH
            },
            cryptoKey,
            content
        )
        ;



        // Returning the value
        return rawContent;
    }
    catch (e)
    {
        // Returning the value
        return false;
    }
}



// Returns [Promise:<ArrayBuffer>|false]
export const encryptKey = async function (key, publicKey)
{
    // (Getting the value)
    const cryptoKey = await window.crypto.subtle.importKey
    (
        'spki',
        await convertKey( publicKey ),
        RSA_PARAMS,
        false,
        [ 'encrypt' ]
    )
    ;



    // (Getting the value)
    const encKey = await window.crypto.subtle.encrypt
    (
        RSA_PARAMS,
        cryptoKey,
        key
    )
    ;



    // Returning the value
    return encKey;
}

// Returns [Promise:ArrayBuffer|false]
export const decryptKey = async function (encKey, privateKey)
{
    try
    {
        // (Getting the value)
        const cryptoKey = await window.crypto.subtle.importKey
        (
            'pkcs8',
            await convertKey( privateKey ),
            RSA_PARAMS,
            false,
            [ 'decrypt' ]
        )
        ;



        // (Getting the value)
        const key = await window.crypto.subtle.decrypt
        (
            RSA_PARAMS,
            cryptoKey,
            encKey
        )
        ;



        // Returning the value
        return key;
    }
    catch (e)
    {
        // Returning the value
        return false;
    }
}



export class UserKey
{
    #resourceKey = null;



    constructor (resourceKey, encResourceKey, resourceIV)
    {
        // (Getting the value)
        this.#resourceKey = resourceKey;



        // (Getting the values)
        this.resourceIV     = resourceIV;
        this.encResourceKey = encResourceKey;
    }



    // Returns [self]
    static async generate (publicKey)
    {
        // (Getting the value)
        const resourceKey = await generateKey();



        // (Getting the value)
        const resourceIV = await generateIV();



        // (Getting the value)
        const encResourceKey = await encryptKey( resourceKey, publicKey );



        // Returning the value
        return new UserKey( resourceKey, encResourceKey, resourceIV );
    }


    
    // Returns [Promise:ArrayBuffer|false]
    async encrypt (content)
    {
        // Returning the value
        return await encrypt( content, this.#resourceKey, this.resourceIV );
    }



    // Returns [object]
    toCrypto ()
    {
        // (Getting the value)
        const object =
        {
            'type':           'user',

            'resourceIV':     Buffer.toBase64( this.resourceIV ),
            'encResourceKey': Buffer.toBase64( this.encResourceKey )
        }
        ;
    


        // Returning the value
        return object;
    }
}



export class AccessKey
{
    #resourceKey = null;



    constructor (crypto, personalKey)
    {
        // (Getting the values)
        this.crypto      = crypto;
        this.personalKey = personalKey;
    }



    // Returns [Promise:self]
    async import ()
    {
        // (Getting the value)
        this.resourceIV = Buffer.fromBase64( this.crypto['resourceIV'] );



        switch ( this.crypto['type'] )
        {
            case 'user':
                // (Getting the value)
                this.#resourceKey = await decryptKey( Buffer.fromBase64( this.crypto['encResourceKey'] ), this.personalKey );
            break;

            case 'group':
                // (Getting the values)
                const groupKey        = await decryptKey( Buffer.fromBase64( this.crypto['encGroupKey'] ), this.personalKey );
                const resourceGroupIV = Buffer.fromBase64( this.crypto['resourceGroupIV'] );



                // (Getting the value)
                this.#resourceKey = await decrypt( Buffer.fromBase64( this.crypto['encResourceGroupKey'] ), groupKey, resourceGroupIV );
            break;
        }



        // Returning the value
        return this;
    }



    // Returns [Promise:ArrayBuffer|false]
    async encrypt (content)
    {
        // Returning the value
        return await encrypt( content, this.#resourceKey, this.resourceIV );
    }

    // Returns [Promise:ArrayBuffer|false]
    async decrypt (content)
    {
        // Returning the value
        return await decrypt( content, this.#resourceKey, this.resourceIV );
    }



    // Returns [Promise:ArrayBuffer|false]
    async buildUserKey (publicKey)
    {
        // Returning the value
        return await encryptKey( this.#resourceKey, publicKey );
    }

    // Returns [Promise:ArrayBuffer|false]
    async buildGroupKey (groupKey, resourceGroupIV)
    {
        // Returning the value
        return await encrypt( this.#resourceKey, groupKey, resourceGroupIV );
    }
}



export class PublicKey
{
    #value = null;



    constructor (value)
    {
        // (Getting the value)
        this.#value = value;
    }



    // Returns [ArrayBuffer|false]
    async encrypt (content)
    {
        // Returning the value
        return await encryptKey( content, this.#value );
    }



    // Returns [string]
    toString ()
    {
        // Returning the value
        return this.#value;
    }
}

export class PrivateKey
{
    #value = null;



    constructor (value)
    {
        // (Getting the value)
        this.#value = value;
    }



    // Returns [ArrayBuffer|false]
    async decrypt (content)
    {
        // Returning the value
        return await decryptKey( content, this.#value );
    }



    // Returns [string]
    toString ()
    {
        // Returning the value
        return this.#value;
    }
}



export class KeyPair
{
    #value = null;



    constructor (value)
    {
        // (Getting the value)
        this.#value = value;
    }



    // Returns [Promise:self]
    static async generate ()
    {
        // Returning the value
        return new KeyPair( await generateKeyPair() );
    }



    // Returns [PublicKey]
    getPublicKey ()
    {
        // Returning the value
        return new PublicKey( this.#value.publicKey );
    }

    // Returns [PrivateKey]
    getPrivateKey ()
    {
        // Returning the value
        return new PrivateKey( this.#value.privateKey );
    }
}