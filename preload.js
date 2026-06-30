const { contextBridge, ipcRenderer } = require('electron');

function createStatusListener(channel, callback) {
	if (typeof callback !== 'function') {
		return () => {};
	}

	const handler = (_, payload) => callback(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('reactor', {
	openScriptsFolder: () => ipcRenderer.invoke('open-scripts-folder'),
	openScriptFile: (filePath) => ipcRenderer.invoke('open-script-file', filePath),
	readScriptContent: (filePath) => ipcRenderer.invoke('read-script-content', filePath),
	saveScriptContent: (filePath, content) => ipcRenderer.invoke('save-script-content', filePath, content),
	resolveEventLogPath: (filePath) => ipcRenderer.invoke('resolve-event-log-path', filePath),
	runScriptNow: (filePath) => ipcRenderer.invoke('run-script-now', filePath),
	createScriptFile: (templateKey, scriptName) => ipcRenderer.invoke('create-script-file', templateKey, scriptName),
	deleteScriptFile: (filePath) => ipcRenderer.invoke('delete-script-file', filePath),
	renameScriptFile: (filePath, nextName) => ipcRenderer.invoke('rename-script-file', filePath, nextName),
	confirmDeleteScript: (scriptName) => ipcRenderer.invoke('confirm-delete-script', scriptName),
	toggleScriptDirective: (filePath, directive) => ipcRenderer.invoke('toggle-script-directive', filePath, directive),
	getScriptsInfo: () => ipcRenderer.invoke('get-scripts-info'),
	getUiSettings: () => ipcRenderer.invoke('get-ui-settings'),
	stopBackgroundProcess: () => ipcRenderer.invoke('stop-background-process'),
	pickDefaultProgram: () => ipcRenderer.invoke('pick-default-program'),
	openEventLog: (filePath) => ipcRenderer.invoke('open-event-log', filePath),
	clearEventLog: (filePath) => ipcRenderer.invoke('clear-event-log', filePath),
	getHttpServerConfig: () => ipcRenderer.invoke('get-http-server-config'),
	setHttpServerPort: (port) => ipcRenderer.invoke('set-http-server-port', port),
	getHttpServerLogs: (limit) => ipcRenderer.invoke('get-http-server-logs', limit),
	openServerStatus: () => ipcRenderer.invoke('open-server-status'),
	getReactorName: () => ipcRenderer.invoke('get-reactor-name'),
	setReactorName: (name) => ipcRenderer.invoke('set-reactor-name', name),
	getWorkflow: () => ipcRenderer.invoke('get-workflow'),
	saveWorkflow: (workflow) => ipcRenderer.invoke('save-workflow', workflow),
	getExchangeConfig: () => ipcRenderer.invoke('get-exchange-config'),
	setExchangeConfig: (mode, host, port, tls, token, discovery, stun, turn) => ipcRenderer.invoke('set-exchange-config', { mode, host, port, tls, token, discovery, stun, turn }),
	saveRelayConfig: (kind, config) => ipcRenderer.invoke('save-relay-config', { kind, config }),
	getP2PStatus: () => ipcRenderer.invoke('get-p2p-status'),
	sendP2PSignal: (target, signalType, payload, sessionId) => ipcRenderer.invoke('send-p2p-signal', { target, signalType, payload, sessionId }),
	requestRemoteScriptsP2P: (target, timeoutMs) => ipcRenderer.invoke('request-remote-scripts-p2p', { target, timeoutMs }),
	closeP2PSession: (target, sessionId, payload) => ipcRenderer.invoke('close-p2p-session', { target, sessionId, payload }),
	getExchangeLinkedNodes: () => ipcRenderer.invoke('get-exchange-linked-nodes'),
	getExchangeToken: () => ipcRenderer.invoke('get-exchange-token'),
	generateExchangeToken: () => ipcRenderer.invoke('generate-exchange-token'),
	getTlsConfig: () => ipcRenderer.invoke('get-tls-config'),
	generateTlsCert: () => ipcRenderer.invoke('generate-tls-cert'),
	deleteTlsCert: () => ipcRenderer.invoke('delete-tls-cert'),
	getMessageQueueStatus: () => ipcRenderer.invoke('get-message-queue-status'),
	setMessageQueueTtlDays: (ttlDays) => ipcRenderer.invoke('set-message-queue-ttl-days', ttlDays),
	flushMessageQueue: () => ipcRenderer.invoke('flush-message-queue'),
	clearMessageQueue: () => ipcRenderer.invoke('clear-message-queue'),
	exportBackup: () => ipcRenderer.invoke('export-backup'),
	importBackup: () => ipcRenderer.invoke('import-backup'),
	onRuntimeStatus: (callback) => createStatusListener('reactor-runtime-status', callback),
});
