export interface Context
{
	trigger?: string;
	event?: string | null;
	expression?: string | null;
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
	HttpClient?: any;
	Device?: any;
	System?: any;
	log: (message: string, type?: 'E' | 'W' | 'I' | 'D') => Promise<void> | void;
}