declare global {
	interface Window {
		reactor?: {
			getEndpointsInfo?: () => Promise<any>;
			getUiSettings?: () => Promise<any>;
			stopBackgroundProcess?: () => Promise<any>;
			openEndpointsFolder?: () => Promise<any>;
			openEndpointFile?: (filePath: string) => Promise<any>;
			readEndpointContent?: (filePath: string) => Promise<any>;
			saveEndpointContent?: (filePath: string, content: string) => Promise<any>;
			resolveEndpointLogPath?: (filePath?: string) => Promise<any>;
			pickDefaultProgram?: () => Promise<any>;
			runEndpointNow?: (filePath: string) => Promise<any>;
			createEndpointFile?: (templateKey: string, scriptName?: string) => Promise<any>;
			renameEndpointFile?: (filePath: string, nextName: string) => Promise<any>;
			confirmDeleteEndpoint?: (scriptName: string) => Promise<any>;
			deleteEndpointFile?: (filePath: string) => Promise<any>;
			toggleEndpointDirective?: (filePath: string, directive: string) => Promise<any>;
			openEventLog?: (filePath: string) => Promise<any>;
			clearEventLog?: (filePath: string) => Promise<any>;
			getHttpServerConfig?: () => Promise<any>;
			setHttpServerPort?: (port: number) => Promise<any>;
			openServerStatus?: () => Promise<any>;
			getReactorName?: () => Promise<any>;
			setReactorName?: (name: string) => Promise<any>;
			getWorkflow?: () => Promise<any>;
			saveWorkflow?: (workflow: any) => Promise<any>;
			getMessageQueueStatus?: () => Promise<any>;
			setMessageQueueTtlDays?: (ttlDays: number) => Promise<any>;
			flushMessageQueue?: () => Promise<any>;
			clearMessageQueue?: () => Promise<any>;
			exportBackup?: () => Promise<any>;
			importBackup?: () => Promise<any>;
			requestRemoteEndpointsP2P?: (target: string, timeoutMs: number) => Promise<any>;
		};
	}
}

export {};
