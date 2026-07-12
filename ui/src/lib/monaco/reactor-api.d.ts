declare module 'core' {
	/** Log severity used by `log(message, type)`. */
	export type LogLevel = 'E' | 'W' | 'I' | 'D';

	/** Outgoing HTTP headers map. */
	export type HeadersMap = Record<string, string>;
	/** Normalized incoming HTTP headers map (lowercase keys + lookup helper). */
	export interface NormalizedHeadersMap extends HeadersMap {
		/** Case-insensitive header lookup. */
		get(name: string): string | undefined;
	}
	/** Incoming HTTP headers map (single, multi, or missing values). */
	export type IncomingHeadersMap = Record<string, string | string[] | undefined>;

	/** HTTP request payload accepted by `HttpClient.sendRequest`. */
	export interface HttpRequestObject {
		/** HTTP method, for example `GET`, `POST`, `PUT`. */
		method: string;
		/** Request body, text or streaming source depending on platform support. */
		body: null | string | AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream;
		/** Outgoing request headers. */
		headers: HeadersMap;
		/** Absolute URL target. */
		url: string;
	}

	/** Base stream handle used by file APIs. */
	export interface StreamHandle {
		/** Internal discriminator used by runtime adapters. */
		__type?: 'Stream' | 'FileHandle' | 'ReadableStream' | 'WritableStream' | 'HttpResponseBody';
		/** Open mode (`r` for read streams, `w` for write streams). */
		mode?: 'r' | 'w';
		/** Source path associated with the handle when it is file-based. */
		__path?: string;
	}

	/** Readable stream handle used by file and HTTP APIs. */
	export interface ReadableStreamHandle extends StreamHandle, AsyncIterable<Uint8Array | Buffer | string> {
		/** Internal discriminator used by runtime adapters. */
		__type?: 'FileHandle' | 'ReadableStream' | 'HttpResponseBody';
		/** Read mode marker. */
		mode?: 'r';
		/** Returns the same readable handle (fluent helper). */
		open?(): ReadableStreamHandle;
		/** ReadableStream-style reader accessor. */
		getReader?(): { read(): Promise<{ value?: Uint8Array | Buffer | string; done: boolean }>; releaseLock?(): void };
	}

	/** Writable stream handle used by file write operations. */
	export interface WritableStreamHandle extends StreamHandle {
		/** Internal discriminator used by runtime adapters. */
		__type?: 'WritableStream';
		/** Write mode marker. */
		mode?: 'w';
		/** Write one chunk to the destination stream. */
		write(chunk: Uint8Array | Buffer | string): Promise<void>;
		/** Close and flush the destination stream. */
		close(): Promise<void>;
		/** WritableStream-style writer accessor. */
		getWriter?(): { write(chunk: Uint8Array | Buffer | string): Promise<void>; close(): Promise<void>; releaseLock?(): void };
	}

	/** Stream-like HTTP response body that can also be converted to text. */
	export interface HttpResponseBody extends ReadableStreamHandle {
		/** Convert full response payload to a string. */
		toString(encoding?: string): string;
	}

	/** HTTP response returned by `HttpClient.sendRequest`. */
	export interface HttpResponse {
		/** Numeric HTTP status code. */
		statusCode: number;
		/** Human-readable status label (for example `OK`, `Not Found`). */
		statusText: string;
		/** Normalized response headers (all lowercase keys). */
		headers: NormalizedHeadersMap;
		/** Response body as a readable stream-like object. */
		body: HttpResponseBody;
	}

	/** Object that can be converted to a path by FileSystem helpers. */
	export interface EntryLike {
		/** Explicit path value if available. */
		path?: string;
		/** Optional metadata accessor used by helper APIs. */
		getMeta?: () => FileMeta | Promise<FileMeta>;
	}

	/** Path input accepted by File and Entry helpers. */
	export type PathLike = string | EntryLike;

	/** HTTP client API exposed to endpoint scripts. */
	export interface HttpClientApi {
		/** Build a request object. */
		Request: new (
			method: string,
			url: string,
			body?: null | string | AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream,
			headers?: HeadersMap,
		) => HttpRequestObject;
		/** Execute an HTTP request. Timeout is expressed in seconds. */
		sendRequest: (request: HttpRequestObject, timeout?: number) => Promise<HttpResponse>;
	}

	/** Converts human-readable values (for example `2 GB`, `30m`) to numbers. */
	export interface UnitConverterApi {
		conv(value: string | number): number;
	}

	/** Unit conversion utilities for bytes and seconds. */
	export interface UnitApi {
		/** Byte-based converter (`B`, `KB`, `MB`, `GB`, ...). */
		Byte: UnitConverterApi;
		/** Second-based converter (`s`, `m`, `h`, `day`, ...). */
		Second: UnitConverterApi;
	}

	/** Time helpers that always return epoch seconds. */
	export interface TimeApi {
		/**
		 * Resolve a relative expression based on now.
		 * Examples: `now`, `now + 2 hour`, `now - 30 second`.
		 */
		at(expression: string): number;
		/** Shortcut for `Time.at('now')`. */
		now(): number;
	}

	/** Metadata for a file path. All time fields are epoch seconds. */
	export interface FileMeta {
		/** File path used for metadata lookup. */
		path: string;
		/** True when the file exists and metadata was resolved. */
		exists: boolean;
		/** File size in bytes, when available. */
		size?: number;
		/** Last modification time in epoch seconds. */
		mTime?: number;
		/** Creation time in epoch seconds, when available. */
		cTime?: number;
		/** Additional platform-specific metadata fields. */
		[key: string]: unknown;
	}

	/** Metadata for a directory path. All time fields are epoch seconds. */
	export interface DirectoryMeta {
		/** Directory path used for metadata lookup. */
		path: string;
		/** True when the directory exists and metadata was resolved. */
		exists: boolean;
		/** Last modification time in epoch seconds. */
		mTime?: number;
		/** Creation time in epoch seconds, when available. */
		cTime?: number;
		/** Additional platform-specific metadata fields. */
		[key: string]: unknown;
	}

	/** File instance API (`new FileSystem.File(path)`). */
	export interface FileApi {
		/** Read full file as UTF-8 text. */
		read(): Promise<string | null>;
		/** Write UTF-8 text. Set `append=true` to append content. */
		write(content: string, append?: boolean): Promise<boolean>;
		/** Delete file if it exists. */
		delete(): Promise<boolean>;
		/** Read file metadata. */
		getMeta(): FileMeta | Promise<FileMeta>;
	}

	/** Async readable file handle produced by `File.open`. */
	export interface FileHandle extends ReadableStreamHandle {
		/** Internal handle discriminator. */
		__type: 'FileHandle' | 'ReadableStream';
		/** Source path associated with the handle. */
		__path: string;
		/** Returns the same readable handle (fluent helper). */
		open(): FileHandle | ReadableStreamHandle;
	}

	/** Readable stream constructor exposed by FileSystem namespace. */
	export interface ReadableStreamConstructorApi {
		/** Build a readable stream wrapper for a file path. */
		new (filePath: PathLike): {
			/** Open underlying stream in read mode. */
			open(options?: { chunkSize?: number; encoding?: string }): FileHandle | Promise<FileHandle>;
		};
	}

	/** Static file helpers (`File` export and `FileSystem.File`). */
	export interface FileStaticApi {
		/** Pipe/copy bytes from input stream/iterable to output stream. */
		copyStream(
			input: AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream,
			output: WritableStreamHandle | WritableStream<Uint8Array> | NodeJS.WritableStream,
		): Promise<boolean>;
		/** Delete file by path. */
		delete(filePath: string): Promise<boolean>;
		/** Open file for read mode (default). */
		open(
			filePath: PathLike,
			options?: { chunkSize?: number; encoding?: string; mode?: 'read' },
		): FileHandle | Promise<FileHandle>;
		/** Open file for write mode. */
		open(
			filePath: PathLike,
			options: { mode: 'write'; append?: boolean },
		): WritableStreamHandle | WritableStream<Uint8Array> | NodeJS.WritableStream;
	}

	/** Constructor + static helpers for files. */
	export interface FileConstructorApi {
		/** Create a file wrapper for a path. */
		new (filePath: PathLike): FileApi;
		/** Pipe/copy bytes from input stream/iterable to output stream. */
		copyStream(
			input: AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream,
			output: WritableStreamHandle | WritableStream<Uint8Array> | NodeJS.WritableStream,
		): Promise<boolean>;
		/** Delete file by path. */
		delete(filePath: string): Promise<boolean>;
		/** Open file for read mode (default). */
		open(
			filePath: PathLike,
			options?: { chunkSize?: number; encoding?: string; mode?: 'read' },
		): FileHandle | Promise<FileHandle>;
		/** Open file for write mode. */
		open(
			filePath: PathLike,
			options: { mode: 'write'; append?: boolean },
		): WritableStreamHandle | WritableStream<Uint8Array> | NodeJS.WritableStream;
	}

	/** Directory instance API (`new FileSystem.Directory(path)`). */
	export interface DirectoryApi {
		/** Normalized directory path. */
		path: string;
		/** Create directory recursively. */
		create(permission?: number): Promise<boolean>;
		/** Delete directory recursively. */
		delete(): Promise<boolean>;
		/** Compute total size of files in directory tree (bytes). */
		calcSize(): Promise<number>;
		/** List directory entries as relative paths. */
		list(recursive?: boolean): Promise<string[]>;
		/** Read directory metadata. */
		getMeta(): DirectoryMeta | Promise<DirectoryMeta>;
	}

	/** Path/entry utility helpers. */
	export interface EntryStaticApi {
		/** True when path-like points to a file. */
		isFile(pathOrEntry: PathLike): boolean;
		/** True when path-like points to a directory. */
		isDirectory(pathOrEntry: PathLike): boolean;
		/** Convert path-like object to normalized string path. */
		toPath(pathOrEntry: PathLike): string;
	}

	/** File system namespace exported by `core`. */
	export interface FileSystemApi {
		/** File constructor + static helpers. */
		File: FileConstructorApi;
		/** Constructor for cross-platform readable streams from file paths. */
		ReadableStream: ReadableStreamConstructorApi;
		/** Directory constructor. */
		Directory: new (path: string) => DirectoryApi;
		/** Path utility helpers. */
		Entry: EntryStaticApi;
	}

	/** Supported crypto metadata for user-key encrypted payloads. */
	export interface UserEncryptionCrypto {
		/** Crypto map type discriminator. */
		type: 'user';
		/** AES-GCM IV encoded in base64. */
		resourceIV: string;
		/** RSA-OAEP encrypted resource key encoded in base64. */
		encResourceKey: string;
	}

	/** Result returned by `Sekrypt.encryptFile`. */
	export interface SekryptFileResult {
		/** Encrypted content stream ready for `HttpClient.Request` body. */
		content: AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream;
		/** Encryption metadata required for decryption. */
		crypto: UserEncryptionCrypto;
	}

	/** Sekrypt helpers exposed to endpoint scripts. */
	export interface SekryptApi {
		/** Encrypt a readable stream using a public RSA key. */
		encryptFile(
			content: AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream,
			publicKey: string,
		): Promise<SekryptFileResult>;
		/** Decrypt an encrypted readable stream using crypto metadata and an RSA private key. */
		decryptFile(
			content: AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream,
			crypto: object,
			privateKey: string,
		): Promise<AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream>;
		/** Encode crypto metadata object as base64-encoded JSON UTF-8 string. */
		encodeCrypto(crypto: object): string;
		/** Decode base64-encoded JSON UTF-8 crypto metadata string. */
		decodeCrypto(crypto: string): any;
	}

	/** Network status snapshot (platform-dependent fields may vary). */
	export interface NetworkStatus {
		/** True when network appears online (platform best-effort). */
		online?: boolean;
		/** True when device reports active connectivity. */
		connected?: boolean;
		/** Additional platform-specific network fields. */
		[key: string]: unknown;
	}

	/** Device network helper API. */
	export interface NetworkApi {
		/** Read current network status. */
		getStatus(): Promise<NetworkStatus>;
	}

	/** Battery helper API. */
	export interface BatteryApi {
		/** True if battery info is available on current platform/device. */
		exists(): Promise<boolean>;
		/** Battery level (0-1) or platform-specific fallback value. */
		getLevel(): Promise<number>;
	}

	/** Power source helper API. */
	export interface PowerApi {
		/** True when device is currently running on battery power. */
		isBattery(): Promise<boolean>;
	}

	export interface PositionResult {
		/** Latitude, or null when not available. */
		lat: number | null;
		/** Longitude, or null when not available. */
		lon: number | null;
		/** True when coordinates are valid and current. */
		available: boolean;
	}

	/** GPS position helper API. */
	export interface PositionApi {
		/** Resolve current coordinates when available. */
		get(): Promise<PositionResult>;
	}

	/** Operating system helper API. */
	export interface OSApi {
		/** CPU architecture identifier. */
		getArch(): string;
		/** True when running on desktop runtime. */
		isDesktop(): boolean;
		/** True when running on mobile runtime. */
		isMobile(): boolean;
		/** Short OS name (`darwin`, `linux`, `android`, ...). */
		getName(): string;
		/** Human-readable OS description. */
		getFullName(): string;
	}

	/** Device namespace exported by `core`. */
	export interface DeviceApi {
		/** Network helper constructor. */
		Network: new () => NetworkApi;
		/** Battery helper constructor. */
		Battery: new () => BatteryApi;
		/** Power helper constructor. */
		Power: new () => PowerApi;
		/** Position helper object. */
		Position: PositionApi;
		/** Operating system helper constructor. */
		OS: new () => OSApi;
		/** Trigger a local device notification. */
		notify(message: string): Promise<boolean>;
	}

	/** Process wrapper (`new System.Process(command)`). */
	export interface ProcessApi {
		/** Spawn process in detached/background mode when supported. */
		spawn(): Promise<boolean>;
	}

	/** System namespace exported by `core`. */
	export interface SystemApi {
		Process: new (command: string) => ProcessApi;
		/** Resolve user home/app home directory for current platform. */
		getHomeDirectory(): Promise<string>;
	}

	/** Options for `Node.sendMessage` advanced overload. */
	export interface NodeSendMessageOptions {
		/** Extra transport headers forwarded with the message. */
		headers?: HeadersMap;
		/** Queue message for retry when immediate delivery fails. */
		enqueueOnFail?: boolean;
	}

	/** Options for binary stream send helpers. */
	export interface NodeStreamOptions {
		/** Per-chunk payload size in bytes. */
		chunkSize?: number;
		/** Queue stream packets on Exchange target-side failures. */
		enqueueOnFail?: boolean;
		/** Disable queue fallback explicitly. */
		noEnqueue?: boolean;
		/** Stream content type metadata. */
		contentType?: string;
		/** User metadata shipped with stream start/end packets. */
		metadata?: Record<string, unknown>;
		/** Optional total size hint in bytes. */
		totalBytes?: number;
		/** Extra transport headers for stream packets. */
		headers?: HeadersMap;
		/** Custom stream identifier (otherwise auto-generated). */
		streamId?: string;
		/** Enable/disable client-side retry/resume loop. Default: true. */
		retry?: boolean;
		/** Max number of retry attempts for failed stream operations. */
		maxRetries?: number;
		/** Delay between retry attempts in milliseconds. */
		retryDelayMs?: number;
		/** Time to wait for Exchange reconnection before next retry. */
		retryReconnectWaitMs?: number;
	}

	/** Accepted source types for Node streaming APIs. */
	export type NodeStreamSource =
		| ReadableStream<Uint8Array>
		| AsyncIterable<Uint8Array | Buffer | string | ArrayBuffer>
		| Iterable<Uint8Array | Buffer | string | ArrayBuffer>
		| Uint8Array
		| Buffer
		| string
		| ArrayBuffer;

	/** Result returned by streaming APIs. */
	export interface NodeStreamResponse {
		/** Original target used for send. */
		target: string;
		/** Logical routing channel chosen by runtime. */
		via: 'direct' | 'exchange';
		/** Delivery transport used in final hop when available. */
		deliveredVia?: 'P2P_DIRECT' | 'P2P_RELAY' | 'EXCHANGE';
		/** Stream id assigned to this transfer. */
		streamId: string;
		/** Number of chunks sent. */
		chunks: number;
		/** Total bytes sent. */
		totalBytes: number;
		/** SHA-256 digest of full stream payload. */
		digestSha256: string;
		/** True when one or more chunk retries/resume attempts were required. */
		resumed?: boolean;
		/** Number of chunk retry/resume attempts performed. */
		resumeCount?: number;
	}

	/** Incoming stream packet helper exposed in STREAM events. */
	export interface StreamPacketApi {
		/** Stream identifier. */
		getId(): string;
		/** Packet phase (`start`, `chunk`, `end`). */
		getPhase(): string;
		/** True when this packet starts a stream. */
		isStart(): boolean;
		/** True when this packet contains payload chunk data. */
		isChunk(): boolean;
		/** True when this packet ends a stream. */
		isEnd(): boolean;
		/** User metadata attached to stream. */
		getMetadata(): Record<string, unknown>;
		/** Content type declared by sender. */
		getContentType(): string;
		/** Zero-based chunk index. */
		getChunkIndex(): number;
		/** Chunk size in bytes. */
		getChunkSize(): number;
		/** Chunk payload encoded as base64 text. */
		getBase64(): string;
		/** Chunk payload decoded as Buffer. */
		readChunkBuffer(): Buffer;
		/** Chunk payload decoded as text with selected encoding. */
		readChunkText(encoding?: BufferEncoding): string;
	}

	/** Incoming stream finalization helper exposed in STREAMEND events. */
	export interface StreamEndApi {
		/** Stream identifier. */
		getId(): string;
		/** Sender routing identity. */
		getSender(): string;
		/** Temporary/assembled payload path. */
		getPath(): string;
		/** Final payload size in bytes. */
		getBytes(): number;
		/** Number of chunks received. */
		getChunks(): number;
		/** SHA-256 digest declared or computed for payload. */
		getDigestSha256(): string;
		/** True when transfer integrity checks passed. */
		isValid(): boolean;
		/** Error string when transfer failed validation. */
		getError(): string;
		/** User metadata attached to stream. */
		getMetadata(): Record<string, unknown>;
	}

	/** Result of `Node.sendMessage`. */
	export interface NodeSendMessageResponse {
		/** Original target passed by caller. */
		target: string;
		/** Resolved endpoint URL when direct HTTP route is used. */
		endpoint?: string;
		/** HTTP status code when available. */
		statusCode?: number;
		/** HTTP status text when available. */
		statusText?: string;
		/** Response headers when available. */
		headers?: HeadersMap;
		/** Response body payload or reference, depending on transport path. */
		body?: string;
		/** Logical routing channel selected by runtime. */
		via?: 'direct' | 'exchange';
		/** Delivery transport used in final hop when available. */
		deliveredVia?: 'P2P_DIRECT' | 'P2P_RELAY' | 'EXCHANGE';
		/** True when message was queued for later retry. */
		queued?: boolean;
		/** Human-readable reason for queue/fallback decisions. */
		reason?: string;
	}

	/** Result of `Node.exchange().sendMessage`. */
	export interface NodeExchangeSendMessageResponse {
		/** Original target passed by caller. */
		target: string;
		/** Routing channel (always exchange). */
		via: 'exchange';
		/** Exchange send API currently returns queued semantic result. */
		queued: true;
	}

	/** Exchange-only node helpers. */
	export interface NodeExchangeApi {
		/** Send message via exchange channel. */
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
		) => Promise<NodeExchangeSendMessageResponse>;
		/** Stream binary data via exchange channel. */
		stream: (
			target: string,
			source: NodeStreamSource,
			options?: Omit<NodeStreamOptions, 'headers'>,
		) => Promise<NodeStreamResponse>;
	}

	/** Node communication helpers. */
	export interface NodeApi {
		/** Resolve current node home directory. */
		getHomeDirectory: () => Promise<string>;

		/** Send endpoint message to a node (boolean overload for legacy enqueue flag). */
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
			enqueueOnFail?: boolean,
		) => Promise<NodeSendMessageResponse>;
		/** Send endpoint message to a node with options object. */
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
			options?: NodeSendMessageOptions,
		) => Promise<NodeSendMessageResponse>;
		/** Stream binary payload to node. */
		stream: (
			target: string,
			source: NodeStreamSource,
			options?: NodeStreamOptions,
		) => Promise<NodeStreamResponse>;
		/** Access exchange-specific helpers. */
		exchange: () => NodeExchangeApi;
	}

	/** Snapshot of low-level runtime namespaces. */
	export interface RuntimeApi {
		/** Raw FileSystem namespace from runtime layer. */
		FileSystem: FileSystemApi;
		/** Raw HttpClient namespace from runtime layer. */
		HttpClient: HttpClientApi;
		/** Unit conversion helpers. */
		Unit: UnitApi;
		/** Device capability helpers. */
		Device: DeviceApi;
		/** System capability helpers. */
		System: SystemApi;
	}

	/** Network interface snapshot used in NET_CHANGE events. */
	export interface NetChangeInterfaceInfo {
		/** Interface name (`en0`, `wlan0`, ...). */
		name: string;
		/** Address family (`IPv4`, `IPv6`). */
		family: string;
		/** Interface IP address. */
		address: string;
		/** Interface netmask. */
		netmask: string;
		/** CIDR representation when available. */
		cidr: string;
		/** MAC address when available. */
		mac: string;
		/** True for loopback/internal interfaces. */
		internal: boolean;
		/** Best-effort transport type classification. */
		transport: 'wifi' | 'ethernet' | 'cellular' | 'loopback' | 'unknown';
	}

	/** Aggregate network snapshot used in NET_CHANGE events. */
	export interface NetChangeSnapshot {
		/** Snapshot timestamp in ISO string format. */
		timestamp: string;
		/** True when runtime considers node online. */
		online: boolean;
		/** Primary interface name, when detected. */
		primaryInterface: string | null;
		/** Primary interface IP address, when detected. */
		primaryAddress: string | null;
		/** Primary subnet, when detected. */
		subnet: string | null;
		/** Gateway address, when detected. */
		gateway: string | null;
		/** Best-effort selected transport label. */
		transport: string;
		/** Signal quality indicator when available. */
		signal: number | null;
		/** Per-interface details. */
		interfaces: NetChangeInterfaceInfo[];
	}

	/** Wrapper containing previous/current net snapshots. */
	export interface NetChangeContext {
		/** Reason for emission (`initial` or `changed`). */
		reason: 'initial' | 'changed';
		/** Previous snapshot, null for first emission. */
		previous: NetChangeSnapshot | null;
		/** Current snapshot payload. */
		current: NetChangeSnapshot;
	}

	/** Supported watch event discriminator strings. */
	export type WatchEventType = 'file:created' | 'file:deleted' | 'file:moved' | 'dir:created' | 'dir:deleted' | 'dir:moved' | 'file:changed';

	/** Generic key/value payload container for event classes. */
	export interface EventData {
		/** Dynamic payload key. */
		[key: string]: unknown;
	}

	/** Sender identity for endpoint events. */
	export class Sender {
		/** Sender endpoint name. */
		readonly endpoint: string;
		/** Sender node name/id. */
		readonly node: string;
		/** Build a sender identity. */
		constructor(endpoint?: string, node?: string);
		/** Render as endpoint@node when both parts are available. */
		toString(): string;
	}

	/** Base event class for all endpoint triggers. */
	export class Event<TType extends string = string, TData extends EventData = EventData> {
		/** Trigger type for this event. */
		readonly type: TType;
		/** Sender endpoint/node identity. */
		readonly sender: Sender;
		/** Event payload data. */
		readonly data: TData;
		/** Event timestamp in ISO format. */
		readonly timestamp: string;
		/** Build a generic event instance. */
		constructor(type: TType, data?: TData, timestamp?: string);
	}

	/** Payload of a WATCH event. */
	export interface WatchEventData extends EventData {
		/** Watched root path that triggered event. */
		watchPath: string;
		/** Relative path from watch root to changed entry. */
		relativePath: string;
		/** Classified watch event type. */
		watchType: WatchEventType | null;
	}

	/** WATCH trigger event. */
	export class WatchEvent extends Event<'WATCH', WatchEventData> {
		/** Build a WATCH event instance. */
		constructor(data?: Partial<WatchEventData>, timestamp?: string);
		/** Watched root path that triggered event. */
		readonly watchPath: string;
		/** Relative path from watch root to changed entry. */
		readonly relativePath: string;
		/** Classified watch event type. */
		readonly watchType: WatchEventType | null;
		/** Deprecated direct data access marker. */
		readonly data: never;
	}

	/** Payload of a MESSAGE event. */
	export interface MessageEventData extends EventData {
		/** Sender routing identity when available. */
		sender: string | null;
		/** Sender endpoint name when available. */
		senderEndpoint: string | null;
		/** Sender node name/id when available. */
		senderNode: string | null;
		/** Sender display name when available. */
		senderName: string | null;
		/** Raw target expression. */
		target: string | null;
		/** Resolved target node name/id. */
		targetNode: string | null;
		/** Resolved target endpoint name. */
		targetEndpoint: string | null;
		/** Resolved target endpoint id. */
		targetEndpointId: string | null;
		/** Message body as text when provided as text. */
		content: string;
		/** Content type value. */
		contentType: string;
		/** Message body as base64 when binary payload is used. */
		bodyBase64: string;
		/** Parsed JSON body when available. */
		json: unknown;
		/** Incoming message headers. */
		headers: IncomingHeadersMap;
	}

	/** MESSAGE trigger event. */
	export class MessageEvent extends Event<'MESSAGE', MessageEventData> {
		/** Build a MESSAGE event instance. */
		constructor(data?: Partial<MessageEventData>, timestamp?: string);
	}

	/** Payload of a STREAM event. */
	export interface StreamEventData extends MessageEventData {
		/** Packet helper for current stream envelope. */
		stream: StreamPacketApi | null;
	}

	/** STREAM trigger event. */
	export class StreamEvent extends Event<'STREAM', StreamEventData> {
		/** Build a STREAM event instance. */
		constructor(data?: Partial<StreamEventData>, timestamp?: string);
	}

	/** Payload of a STREAMEND event. */
	export interface StreamEndEventData extends MessageEventData {
		/** Sender-provided metadata snapshot. */
		metadata: Record<string, unknown>;
		/** Temporary path of assembled stream payload. */
		tmpFilePath: string;
		/** Finalization helper object. */
		streamEnd: StreamEndApi | null;
	}

	/** STREAMEND trigger event. */
	export class StreamEndEvent extends Event<'STREAMEND', StreamEndEventData> {
		/** Build a STREAMEND event instance. */
		constructor(data?: Partial<StreamEndEventData>, timestamp?: string);
		/** Sender-provided metadata snapshot. */
		readonly metadata: Record<string, unknown>;
	}

	/** Payload of a SCHEDULE event. */
	export interface ScheduleEventData extends EventData {
		/** Schedule expression that triggered execution. */
		expression: string | null;
	}

	/** SCHEDULE trigger event. */
	export class ScheduleEvent extends Event<'SCHEDULE', ScheduleEventData> {
		/** Build a SCHEDULE event instance. */
		constructor(data?: Partial<ScheduleEventData>, timestamp?: string);
	}

	/** Payload of an EVENT trigger. */
	export interface RuntimeEventData extends EventData {
		/** Runtime event name. */
		name: string | null;
		/** Network change context for NET_CHANGE-like events. */
		networkChange: NetChangeContext | null;
	}

	/** Runtime EVENT trigger event. */
	export class RuntimeEvent extends Event<'EVENT', RuntimeEventData> {
		/** Build an EVENT trigger instance. */
		constructor(data?: Partial<RuntimeEventData>, timestamp?: string);
		/** Runtime event name. */
		readonly name: string | null;
	}

	/** Payload of a MANUAL_TEST event. */
	export interface ManualEventData extends EventData {
		/** Optional reason attached to manual trigger. */
		reason: string | null;
	}

	/** Manual trigger event used by test/manual runs. */
	export class ManualEvent extends Event<'MANUAL_TEST', ManualEventData> {
		/** Build a MANUAL_TEST event instance. */
		constructor(data?: Partial<ManualEventData>, timestamp?: string);
	}

	/** Union of all event objects available in endpoint runtime. */
	export type ReactorEvent =
		| WatchEvent
		| MessageEvent
		| StreamEvent
		| StreamEndEvent
		| ScheduleEvent
		| RuntimeEvent
		| ManualEvent
		| Event;

	/** Raw runtime namespaces (advanced usage). */
	export const api: RuntimeApi;
	/** Static file helpers (`File.open`, `File.copyStream`). */
	export const File: FileStaticApi;
	/** File system namespace (`File`, `Directory`, `Entry`). */
	export const FileSystem: FileSystemApi;
	/** HTTP client namespace. */
	export const HttpClient: HttpClientApi;
	/** Sekrypt namespace. */
	export const Sekrypt: SekryptApi;
	/** Unit conversion namespace. */
	export const Unit: UnitApi;
	/** Time helpers namespace. */
	export const Time: TimeApi;
	/** Device helper namespace. */
	export const Device: DeviceApi;
	/** System helper namespace. */
	export const System: SystemApi;
	/** Node communication namespace. */
	export const Node: NodeApi;

	/** Environment helper namespace. */
	export interface EnvApi {
		/** Read a value from envs/<NAME> or return the provided default. */
		get(name: string, defaultValue?: string): string;
	}

	/** Environment helper namespace (`Env.get`). */
	export const Env: EnvApi;

	/** Write endpoint log line with optional log level. */
	export function log(message: string, type?: LogLevel): Promise<void> | void;
}
