export interface Context
{
	trigger?: string;
	event?: string | null;
	expression?: string | null;
	watchPath?: string;
	watchType?: 'file:created' | 'file:deleted' | 'file:moved' | 'dir:created' | 'dir:deleted' | 'dir:moved' | 'file:changed';
	log: (message: string, type?: 'E' | 'W' | 'I' | 'D') => Promise<void> | void;
}