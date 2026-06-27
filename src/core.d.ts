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
	}

	export interface ProcessApi {
		spawn(): Promise<boolean>;
	}

	export interface SystemApi {
		Process: new (command: string) => ProcessApi;
	}

	export interface NodeSendMessageOptions {
		headers?: HeadersMap;
	}

	export interface NodeSendMessageResponse {
		target: string;
		endpoint: string;
		status: number;
		headers: HeadersMap;
		body: string;
	}

	export interface NodeApi {
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
			options?: NodeSendMessageOptions,
		) => Promise<NodeSendMessageResponse>;
	}

	export interface RuntimeApi {
		FileSystem: FileSystemApi;
		HttpClient: HttpClientApi;
		Device: DeviceApi;
		System: SystemApi;
	}

	export interface Context {
		trigger?: string;
		event?: string | null;
		expression?: string | null;
		messageSender?: string | null;
		messageSenderName?: string | null;
		messageContent?: string;
		messageContentType?: string;
		messageBodyBase64?: string;
		messageJson?: unknown;
		messageHeaders?: IncomingHeadersMap;
		watchPath?: string;
		watchType?: 'file:created' | 'file:deleted' | 'file:moved' | 'dir:created' | 'dir:deleted' | 'dir:moved' | 'file:changed';
		routeMethod?: string;
		routePath?: string;
		routeQuery?: string;
		routeBody?: string;
		routeHeaders?: IncomingHeadersMap;
		request?: {
			method: string;
			path: string;
			query: string;
			queryParams: Record<string, string>;
			headers: IncomingHeadersMap;
			body: string;
			bodyJson: unknown;
		};
	}

	export const api: RuntimeApi;
	export const FileSystem: FileSystemApi;
	export const HttpClient: HttpClientApi;
	export const Device: DeviceApi;
	export const System: SystemApi;
	export const Node: NodeApi;

	export function log(message: string, type?: LogLevel): Promise<void> | void;
}
