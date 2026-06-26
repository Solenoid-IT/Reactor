export interface Context
{
	trigger?: string;
	event?: string | null;
	expression?: string | null;
	messageSender?: string | null;
	messageSenderName?: string | null;
	messageContent?: string;
	messageContentType?: string;
	messageBodyBase64?: string;
	messageJson?: unknown;
	messageHeaders?: Record<string, string | string[] | undefined>;
	watchPath?: string;
	watchType?: 'file:created' | 'file:deleted' | 'file:moved' | 'dir:created' | 'dir:deleted' | 'dir:moved' | 'file:changed';
	routeMethod?: string;
	routePath?: string;
	routeQuery?: string;
	routeBody?: string;
	routeHeaders?: Record<string, string | string[] | undefined>;
	request?: {
		method: string;
		path: string;
		query: string;
		queryParams: Record<string, string>;
		headers: Record<string, string | string[] | undefined>;
		body: string;
		bodyJson: unknown;
	};
	api?: any;
	FileSystem?: any;
	HttpClient?: {
		Request: new (
			request:
				| { method?: string; body?: unknown; headers?: Record<string, string>; url?: string }
				| string,
			body?: unknown,
			headers?: Record<string, string>,
			url?: string,
		) => {
			method: string;
			body: unknown;
			headers: Record<string, string>;
			url: string;
		};
		sendRequest: (
			request: {
				method: string;
				body: unknown;
				headers: Record<string, string>;
				url: string;
			},
			timeout?: number,
		) => Promise<{
			status: number;
			headers: Record<string, string>;
			body: string;
		}>;
	};
	Device?: any;
	System?: any;
	Node?: {
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
			options?: { headers?: Record<string, string> },
		) => Promise<{
			target: string;
			endpoint: string;
			status: number;
			headers: Record<string, string>;
			body: string;
		}>;
	};
	log: (message: string, type?: 'E' | 'W' | 'I' | 'D') => Promise<void> | void;
}