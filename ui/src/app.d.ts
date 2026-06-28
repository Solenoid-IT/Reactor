declare global {
	interface Window {
		reactor?: {
			getScriptsInfo?: () => Promise<any>;
			getUiSettings?: () => Promise<any>;
			openScriptsFolder?: () => Promise<any>;
			openScriptFile?: (filePath: string) => Promise<any>;
			readScriptContent?: (filePath: string) => Promise<any>;
			saveScriptContent?: (filePath: string, content: string) => Promise<any>;
			resolveEventLogPath?: (filePath?: string) => Promise<any>;
			pickDefaultProgram?: () => Promise<any>;
			runScriptNow?: (filePath: string) => Promise<any>;
			createScriptFile?: (templateKey: string, scriptName?: string) => Promise<any>;
			renameScriptFile?: (filePath: string, nextName: string) => Promise<any>;
			confirmDeleteScript?: (scriptName: string) => Promise<any>;
			deleteScriptFile?: (filePath: string) => Promise<any>;
			toggleScriptDirective?: (filePath: string, directive: string) => Promise<any>;
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
		};
	}
}

export {};
