declare module 'core' {
	export type LogLevel = 'E' | 'W' | 'I' | 'D';

	export type HeadersMap = Record<string, string>;
	export type IncomingHeadersMap = Record<string, string | string[] | undefined>;

	export interface HttpRequestInput {
		method?: string;
		body?: unknown;
		headers?: HeadersMap;
		url?: string;
	}

	export interface HttpRequestObject {
		method: string;
		body: unknown;
		headers: HeadersMap;
		url: string;
	}

	export interface HttpResponse {
		status: number;
		headers: HeadersMap;
		body: string;
	}

	export interface HttpClientApi {
		Request: new (
			request: HttpRequestInput | string,
			body?: unknown,
			headers?: HeadersMap,
			url?: string,
		) => HttpRequestObject;
		sendRequest: (request: HttpRequestObject, timeout?: number) => Promise<HttpResponse>;
	}

	export interface FileMeta {
		path: string;
		exists: boolean;
		size?: number;
		mtimeMs?: number;
		ctimeMs?: number;
		[key: string]: unknown;
	}

	export interface DirectoryMeta {
		path: string;
		exists: boolean;
		mtimeMs?: number;
		ctimeMs?: number;
		[key: string]: unknown;
	}

	export interface FileApi {
		read(): Promise<string | null>;
		readStream(options?: { chunkSize?: number; encoding?: string }): AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array>;
		write(content: string, append?: boolean): Promise<boolean>;
		delete(): Promise<boolean>;
		getMeta(): Promise<FileMeta>;
	}

	export interface FileStaticApi {
		readStream(
			filePath: string,
			options?: { chunkSize?: number; encoding?: string },
		): AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array>;
	}

	export interface DirectoryApi {
		create(permission?: number): Promise<boolean>;
		delete(): Promise<boolean>;
		list(recursive?: boolean): Promise<string[]>;
		getMeta(): Promise<DirectoryMeta>;
	}

	export interface FileSystemApi {
		File: new (filePath: string) => FileApi;
		Directory: new (dirPath: string) => DirectoryApi;
	}

	export interface NetworkStatus {
		online?: boolean;
		connected?: boolean;
		[key: string]: unknown;
	}

	export interface NetworkApi {
		getStatus(): Promise<NetworkStatus>;
	}

	export interface BatteryApi {
		exists(): Promise<boolean>;
		getLevel(): Promise<number>;
	}

	export interface PowerApi {
		isBattery(): Promise<boolean>;
	}

	export interface PositionResult {
		lat: number | null;
		lon: number | null;
		available: boolean;
	}

	export interface PositionApi {
		get(): Promise<PositionResult>;
	}

	export interface OSApi {
		getArch(): string;
		isDesktop(): boolean;
		isMobile(): boolean;
		getName(): string;
		getFullName(): string;
	}

	export interface DeviceApi {
		Network: new () => NetworkApi;
		Battery: new () => BatteryApi;
		Power: new () => PowerApi;
		Position: PositionApi;
		OS: new () => OSApi;
		notify(message: string): Promise<boolean>;
	}

	export interface ProcessApi {
		spawn(): Promise<boolean>;
	}

	export interface SystemApi {
		Process: new (command: string) => ProcessApi;
	}

	export interface NodeSendMessageOptions {
		headers?: HeadersMap;
		enqueueOnFail?: boolean;
	}

	export interface NodeStreamOptions {
		chunkSize?: number;
		contentType?: string;
		metadata?: Record<string, unknown>;
		totalBytes?: number;
		headers?: HeadersMap;
		streamId?: string;
	}

	export type NodeStreamSource =
		| ReadableStream<Uint8Array>
		| AsyncIterable<Uint8Array | Buffer | string | ArrayBuffer>
		| Iterable<Uint8Array | Buffer | string | ArrayBuffer>
		| Uint8Array
		| Buffer
		| string
		| ArrayBuffer;

	export interface NodeStreamResponse {
		target: string;
		via: 'direct' | 'exchange';
		deliveredVia?: 'P2P_DIRECT' | 'P2P_RELAY' | 'EXCHANGE';
		streamId: string;
		chunks: number;
		totalBytes: number;
		digestSha256: string;
	}

	export interface StreamPacketApi {
		getId(): string;
		getPhase(): string;
		isStart(): boolean;
		isChunk(): boolean;
		isEnd(): boolean;
		getMetadata(): Record<string, unknown>;
		getContentType(): string;
		getChunkIndex(): number;
		getChunkSize(): number;
		getBase64(): string;
		readChunkBuffer(): Buffer;
		readChunkText(encoding?: BufferEncoding): string;
	}

	export interface StreamEndApi {
		getId(): string;
		getSender(): string;
		getPath(): string;
		getBytes(): number;
		getChunks(): number;
		getDigestSha256(): string;
		isValid(): boolean;
		getError(): string;
		getMetadata(): Record<string, unknown>;
	}

	export interface NodeSendMessageResponse {
		target: string;
		endpoint?: string;
		status?: number;
		headers?: HeadersMap;
		body?: string;
		via?: 'direct' | 'exchange';
		deliveredVia?: 'P2P_DIRECT' | 'P2P_RELAY' | 'EXCHANGE';
		queued?: boolean;
		reason?: string;
	}

	export interface NodeExchangeSendMessageResponse {
		target: string;
		via: 'exchange';
		queued: true;
	}

	export interface NodeExchangeApi {
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
		) => Promise<NodeExchangeSendMessageResponse>;
		stream: (
			target: string,
			source: NodeStreamSource,
			options?: Omit<NodeStreamOptions, 'headers'>,
		) => Promise<NodeStreamResponse>;
	}

	export interface NodeApi {
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
			enqueueOnFail?: boolean,
		) => Promise<NodeSendMessageResponse>;
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
			options?: NodeSendMessageOptions,
		) => Promise<NodeSendMessageResponse>;
		stream: (
			target: string,
			source: NodeStreamSource,
			options?: NodeStreamOptions,
		) => Promise<NodeStreamResponse>;
		exchange: () => NodeExchangeApi;
	}

	export interface RuntimeApi {
		FileSystem: FileSystemApi;
		HttpClient: HttpClientApi;
		Device: DeviceApi;
		System: SystemApi;
	}

	export interface NetChangeInterfaceInfo {
		name: string;
		family: string;
		address: string;
		netmask: string;
		cidr: string;
		mac: string;
		internal: boolean;
		transport: 'wifi' | 'ethernet' | 'cellular' | 'loopback' | 'unknown';
	}

	export interface NetChangeSnapshot {
		timestamp: string;
		online: boolean;
		primaryInterface: string | null;
		primaryAddress: string | null;
		subnet: string | null;
		gateway: string | null;
		transport: string;
		signal: number | null;
		interfaces: NetChangeInterfaceInfo[];
	}

	export interface NetChangeContext {
		reason: 'initial' | 'changed';
		previous: NetChangeSnapshot | null;
		current: NetChangeSnapshot;
	}

	export interface Context {
		trigger?: string;
		event?: string | null;
		expression?: string | null;
		messageSender?: string | null;
		messageSenderName?: string | null;
		messageTarget?: string | null;
		messageTargetNode?: string | null;
		messageTargetEndpoint?: string | null;
		messageTargetEndpointId?: string | null;
		messageContent?: string;
		messageContentType?: string;
		messageBodyBase64?: string;
		messageJson?: unknown;
		stream?: StreamPacketApi | null;
		streamEnd?: StreamEndApi | null;
		networkChange?: NetChangeContext | null;
		messageHeaders?: IncomingHeadersMap;
		watchPath?: string;
		watchType?: 'file:created' | 'file:deleted' | 'file:moved' | 'dir:created' | 'dir:deleted' | 'dir:moved' | 'file:changed';
	}

	export const api: RuntimeApi;
	export const File: FileStaticApi;
	export const FileSystem: FileSystemApi;
	export const HttpClient: HttpClientApi;
	export const Device: DeviceApi;
	export const System: SystemApi;
	export const Node: NodeApi;

	export function log(message: string, type?: LogLevel): Promise<void> | void;
}
