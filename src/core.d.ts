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
		write(content: string, append?: boolean): Promise<boolean>;
		delete(): Promise<boolean>;
		getMeta(): Promise<FileMeta>;
	}

	export interface FileStaticApi {
		copyStream(
			input: AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream,
			output: WritableStream<Uint8Array> | NodeJS.WritableStream,
		): Promise<boolean>;
		open(
			filePath: string,
			options?: { chunkSize?: number; encoding?: string; mode?: 'read' },
		): AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array>;
		open(
			filePath: string,
			options: { mode: 'write'; append?: boolean },
		): WritableStream<Uint8Array> | NodeJS.WritableStream;
	}

	export interface FileConstructorApi {
		new (filePath: string): FileApi;
		copyStream(
			input: AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array> | NodeJS.ReadableStream,
			output: WritableStream<Uint8Array> | NodeJS.WritableStream,
		): Promise<boolean>;
		open(
			filePath: string,
			options?: { chunkSize?: number; encoding?: string; mode?: 'read' },
		): AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array>;
		open(
			filePath: string,
			options: { mode: 'write'; append?: boolean },
		): WritableStream<Uint8Array> | NodeJS.WritableStream;
	}

	export interface DirectoryApi {
		create(permission?: number): Promise<boolean>;
		delete(): Promise<boolean>;
		list(recursive?: boolean): Promise<string[]>;
		getMeta(): Promise<DirectoryMeta>;
	}

	export interface FileSystemApi {
		File: FileConstructorApi;
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
		getHomeDirectory(): Promise<string>;
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
		getHomeDirectory: () => Promise<string>;

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

	export type WatchEventType = 'file:created' | 'file:deleted' | 'file:moved' | 'dir:created' | 'dir:deleted' | 'dir:moved' | 'file:changed';

	export interface EventData {
		[key: string]: unknown;
	}

	export class Event<TType extends string = string, TData extends EventData = EventData> {
		readonly type: TType;
		readonly data: TData;
		readonly timestamp: string;
		constructor(type: TType, data?: TData, timestamp?: string);
	}

	export interface WatchEventData extends EventData {
		watchPath: string;
		relativePath: string;
		watchType: WatchEventType | null;
	}

	export class WatchEvent extends Event<'WATCH', WatchEventData> {
		constructor(data?: Partial<WatchEventData>, timestamp?: string);
		readonly watchPath: string;
		readonly relativePath: string;
		readonly watchType: WatchEventType | null;
		readonly data: never;
	}

	export interface MessageEventData extends EventData {
		sender: string | null;
		senderName: string | null;
		target: string | null;
		targetNode: string | null;
		targetEndpoint: string | null;
		targetEndpointId: string | null;
		content: string;
		contentType: string;
		bodyBase64: string;
		json: unknown;
		headers: IncomingHeadersMap;
	}

	export class MessageEvent extends Event<'MESSAGE', MessageEventData> {
		constructor(data?: Partial<MessageEventData>, timestamp?: string);
	}

	export interface StreamEventData extends MessageEventData {
		stream: StreamPacketApi | null;
	}

	export class StreamEvent extends Event<'STREAM', StreamEventData> {
		constructor(data?: Partial<StreamEventData>, timestamp?: string);
	}

	export interface StreamEndEventData extends MessageEventData {
		metadata: Record<string, unknown>;
		tmpPath: string;
		streamEnd: StreamEndApi | null;
	}

	export class StreamEndEvent extends Event<'STREAMEND', StreamEndEventData> {
		constructor(data?: Partial<StreamEndEventData>, timestamp?: string);
		readonly metadata: Record<string, unknown>;
		readonly tmpPath: string;
	}

	export interface ScheduleEventData extends EventData {
		expression: string | null;
	}

	export class ScheduleEvent extends Event<'SCHEDULE', ScheduleEventData> {
		constructor(data?: Partial<ScheduleEventData>, timestamp?: string);
	}

	export interface RuntimeEventData extends EventData {
		name: string | null;
		networkChange: NetChangeContext | null;
	}

	export class RuntimeEvent extends Event<'EVENT', RuntimeEventData> {
		constructor(data?: Partial<RuntimeEventData>, timestamp?: string);
		readonly name: string | null;
	}

	export interface ManualEventData extends EventData {
		reason: string | null;
	}

	export class ManualEvent extends Event<'MANUAL_TEST', ManualEventData> {
		constructor(data?: Partial<ManualEventData>, timestamp?: string);
	}

	export type ReactorEvent =
		| WatchEvent
		| MessageEvent
		| StreamEvent
		| StreamEndEvent
		| ScheduleEvent
		| RuntimeEvent
		| ManualEvent
		| Event;

	export const api: RuntimeApi;
	export const File: FileStaticApi;
	export const FileSystem: FileSystemApi;
	export const HttpClient: HttpClientApi;
	export const Device: DeviceApi;
	export const System: SystemApi;
	export const Node: NodeApi;

	export function log(message: string, type?: LogLevel): Promise<void> | void;
}
