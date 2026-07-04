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
	openEndpointsFolder: () => ipcRenderer.invoke('open-endpoints-folder'),
	openEndpointFile: (filePath) => ipcRenderer.invoke('open-endpoint-file', filePath),
	readEndpointContent: (filePath) => ipcRenderer.invoke('read-endpoint-content', filePath),
	saveEndpointContent: (filePath, content) => ipcRenderer.invoke('save-endpoint-content', filePath, content),
	resolveEndpointLogPath: (filePath) => ipcRenderer.invoke('resolve-endpoint-log-path', filePath),
	runEndpointNow: (filePath) => ipcRenderer.invoke('run-endpoint-now', filePath),
	createEndpointFile: (templateKey, scriptName) => ipcRenderer.invoke('create-endpoint-file', templateKey, scriptName),
	deleteEndpointFile: (filePath) => ipcRenderer.invoke('delete-endpoint-file', filePath),
	renameEndpointFile: (filePath, nextName) => ipcRenderer.invoke('rename-endpoint-file', filePath, nextName),
	reorderEndpoints: (paths) => ipcRenderer.invoke('reorder-endpoints', paths),
	confirmDeleteEndpoint: (scriptName) => ipcRenderer.invoke('confirm-delete-endpoint', scriptName),
	toggleEndpointDirective: (filePath, directive) => ipcRenderer.invoke('toggle-endpoint-directive', filePath, directive),
	getEndpointsInfo: () => ipcRenderer.invoke('get-endpoints-info'),
	getUiSettings: () => ipcRenderer.invoke('get-ui-settings'),
	getPermissionsConfig: () => ipcRenderer.invoke('get-permissions-config'),
	savePermissionsConfig: (permissions) => ipcRenderer.invoke('save-permissions-config', permissions),
	getEnvConfig: () => ipcRenderer.invoke('get-env-config'),
	saveEnvConfig: (env) => ipcRenderer.invoke('save-env-config', env),
	requestSystemPermissions: (permissions) => ipcRenderer.invoke('request-system-permissions', permissions),
	openSystemPermissionSettings: (permissions) => ipcRenderer.invoke('open-system-permission-settings', permissions),
	copyTextToClipboard: (text) => ipcRenderer.invoke('copy-text-to-clipboard', text),
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
	requestRemoteEndpointsP2P: (target, timeoutMs) => ipcRenderer.invoke('request-remote-endpoints-p2p', { target, timeoutMs }),
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
