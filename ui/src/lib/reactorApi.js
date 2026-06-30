function getBridge() {
	if (typeof window === 'undefined') {
		return null;
	}
	return window.reactor || null;
}

function getMobilePlugin() {
	if (typeof window === 'undefined') {
		return null;
	}
	const plugins = window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins : null;
	return plugins && plugins.ReactorMobile ? plugins.ReactorMobile : null;
}

function getCapacitorRuntime() {
	if (typeof window === 'undefined') {
		return null;
	}
	return window.Capacitor || null;
}

async function invokeNative(pluginName, methodName, options = {}) {
	const capacitor = getCapacitorRuntime();
	if (!capacitor || typeof capacitor.nativePromise !== 'function') {
		return null;
	}

	try {
		const raw = await capacitor.nativePromise(pluginName, methodName, options);
		if (!raw || typeof raw !== 'object') {
			return raw;
		}

		if (Object.prototype.hasOwnProperty.call(raw, 'ok') || Object.prototype.hasOwnProperty.call(raw, 'scripts') || Object.prototype.hasOwnProperty.call(raw, 'path')) {
			return raw;
		}

		if (raw.value && typeof raw.value === 'object') {
			return raw.value;
		}

		if (raw.data && typeof raw.data === 'object') {
			return raw.data;
		}

		if (raw.result && typeof raw.result === 'object') {
			return raw.result;
		}

		return raw;
	} catch (error) {
		return { ok: false, error: error?.message || 'native bridge unavailable' };
	}
}

export async function getScriptsInfo() {
	const bridge = getBridge();
	if (bridge && bridge.getScriptsInfo) {
		return bridge.getScriptsInfo();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getScriptsInfo) {
		return mobile.getScriptsInfo();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'getScriptsInfo');
	if (nativeResult) {
		return nativeResult;
	}

	return { path: '', scripts: [] };
}

export async function getUiSettings() {
	const bridge = getBridge();
	if (bridge && bridge.getUiSettings) {
		return bridge.getUiSettings();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getUiSettings) {
		return mobile.getUiSettings();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'getUiSettings');
	if (nativeResult) {
		return nativeResult;
	}

	return { defaultProgramPath: '', httpServerPort: 7070 };
}

export async function stopBackgroundProcess() {
	const bridge = getBridge();
	if (bridge && bridge.stopBackgroundProcess) {
		return bridge.stopBackgroundProcess();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.stopBackgroundProcess) {
		return mobile.stopBackgroundProcess();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'stopBackgroundProcess');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function copyTextToClipboard(text) {
	const safeText = String(text ?? '');
	const mobile = getMobilePlugin();
	if (mobile && mobile.copyTextToClipboard) {
		return mobile.copyTextToClipboard({ text: safeText });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'copyTextToClipboard', { text: safeText });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function openScriptsFolder() {
	const bridge = getBridge();
	if (bridge && bridge.openScriptsFolder) {
		return bridge.openScriptsFolder();
	}
}

export async function openScriptFile(filePath) {
	const bridge = getBridge();
	if (!bridge || !bridge.openScriptFile) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.openScriptFile(filePath);
}

export async function readScriptContent(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.readScriptContent) {
		return bridge.readScriptContent(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.readScriptContent) {
		return mobile.readScriptContent({ filePath });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'readScriptContent', { filePath });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function saveScriptContent(filePath, content) {
	const bridge = getBridge();
	if (bridge && bridge.saveScriptContent) {
		return bridge.saveScriptContent(filePath, content);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.saveScriptContent) {
		return mobile.saveScriptContent({ filePath, content });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'saveScriptContent', { filePath, content });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function resolveEventLogPath(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.resolveEventLogPath) {
		return bridge.resolveEventLogPath(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.resolveEventLogPath) {
		return mobile.resolveEventLogPath({ filePath });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'resolveEventLogPath', { filePath });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function pickDefaultProgram() {
	const bridge = getBridge();
	if (!bridge || !bridge.pickDefaultProgram) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.pickDefaultProgram();
}

export async function runScriptNow(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.runScriptNow) {
		return bridge.runScriptNow(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.runScriptNow) {
		return mobile.runScriptNow({ filePath });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'runScriptNow', { filePath });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function createScriptFile(templateKey, scriptName = '') {
	const bridge = getBridge();
	if (bridge && bridge.createScriptFile) {
		return bridge.createScriptFile(templateKey, scriptName);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.createScriptFile) {
		return mobile.createScriptFile({ templateKey, scriptName });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'createScriptFile', { templateKey, scriptName });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function renameScriptFile(filePath, nextName) {
	const bridge = getBridge();
	if (bridge && bridge.renameScriptFile) {
		return bridge.renameScriptFile(filePath, nextName);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.renameScriptFile) {
		return mobile.renameScriptFile({ filePath, nextName });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'renameScriptFile', { filePath, nextName });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function confirmDeleteScript(scriptName) {
	const bridge = getBridge();
	if (bridge && bridge.confirmDeleteScript) {
		return bridge.confirmDeleteScript(scriptName);
	}

	if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
		const confirmed = window.confirm(`Are you sure to delete script '${scriptName.replace( /\.[\w]+$/, '' ) || 'this script'}'?`);
		return { ok: true, confirmed };
	}

	return { ok: true, confirmed: false };
}

export async function deleteScriptFile(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.deleteScriptFile) {
		return bridge.deleteScriptFile(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.deleteScriptFile) {
		return mobile.deleteScriptFile({ filePath });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'deleteScriptFile', { filePath });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function toggleScriptDirective(filePath, directive) {
	const bridge = getBridge();
	if (bridge && bridge.toggleScriptDirective) {
		return bridge.toggleScriptDirective(filePath, directive);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.toggleScriptDirective) {
		return mobile.toggleScriptDirective({ filePath, directive });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'toggleScriptDirective', { filePath, directive });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function openEventLog(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.openEventLog) {
		return bridge.openEventLog(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.openEventLog) {
		return mobile.openEventLog({ filePath });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'openEventLog', { filePath });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function clearEventLog(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.clearEventLog) {
		return bridge.clearEventLog(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.clearEventLog) {
		return mobile.clearEventLog({ filePath });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'clearEventLog', { filePath });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function getHttpServerConfig() {
	const bridge = getBridge();
	if (bridge && bridge.getHttpServerConfig) {
		return bridge.getHttpServerConfig();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getHttpServerConfig) {
		return mobile.getHttpServerConfig();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'getHttpServerConfig');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function setHttpServerPort(port) {
	const bridge = getBridge();
	if (bridge && bridge.setHttpServerPort) {
		return bridge.setHttpServerPort(port);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.setHttpServerPort) {
		return mobile.setHttpServerPort({ port });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'setHttpServerPort', { port });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function getReactorName() {
	const bridge = getBridge();
	if (bridge && bridge.getReactorName) {
		return bridge.getReactorName();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getReactorName) {
		return mobile.getReactorName();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'getReactorName');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function setReactorName(name) {
	const bridge = getBridge();
	if (bridge && bridge.setReactorName) {
		return bridge.setReactorName(name);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.setReactorName) {
		return mobile.setReactorName({ name });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'setReactorName', { name });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function openServerStatus() {
	const bridge = getBridge();
	if (bridge && bridge.openServerStatus) {
		return bridge.openServerStatus();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.openServerStatus) {
		return mobile.openServerStatus();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'openServerStatus');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function getWorkflow() {
	const bridge = getBridge();
	if (!bridge || !bridge.getWorkflow) {
		return { ok: false, error: 'bridge unavailable', workflow: { version: 1, nodes: [], links: [] } };
	}
	return bridge.getWorkflow();
}

export async function saveWorkflow(workflow) {
	const bridge = getBridge();
	if (!bridge || !bridge.saveWorkflow) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.saveWorkflow(workflow);
}

export async function getExchangeConfig() {
	const bridge = getBridge();
	if (bridge && bridge.getExchangeConfig) {
		return bridge.getExchangeConfig();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getExchangeConfig) {
		return mobile.getExchangeConfig();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'getExchangeConfig');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function setExchangeConfig(mode, host, port, tls = false, token = '', discovery = false, stun = {}, turn = {}) {
	const bridge = getBridge();
	if (bridge && bridge.setExchangeConfig) {
		return bridge.setExchangeConfig(mode, host, port, tls, token, discovery, stun, turn);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.setExchangeConfig) {
		return mobile.setExchangeConfig({ mode, host, port, tls, token, discovery, stun, turn });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'setExchangeConfig', { mode, host, port, tls, token, discovery, stun, turn });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function saveRelayConfig(kind, config = {}) {
	const bridge = getBridge();
	if (bridge && bridge.saveRelayConfig) {
		return bridge.saveRelayConfig(kind, config);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.saveRelayConfig) {
		return mobile.saveRelayConfig({ kind, config });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'saveRelayConfig', { kind, config });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function getP2PStatus() {
	const bridge = getBridge();
	if (bridge && bridge.getP2PStatus) {
		return bridge.getP2PStatus();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getP2PStatus) {
		return mobile.getP2PStatus();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'getP2PStatus');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable', p2p: { enabled: false, sessions: [], remotePeers: [] } };
}

export async function sendP2PSignal(target, signalType, payload = null, sessionId = null) {
	const bridge = getBridge();
	if (bridge && bridge.sendP2PSignal) {
		return bridge.sendP2PSignal(target, signalType, payload, sessionId);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.sendP2PSignal) {
		return mobile.sendP2PSignal({ target, signalType, payload, sessionId });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'sendP2PSignal', { target, signalType, payload, sessionId });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function closeP2PSession(target, sessionId = null, payload = null) {
	const bridge = getBridge();
	if (bridge && bridge.closeP2PSession) {
		return bridge.closeP2PSession(target, sessionId, payload);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.closeP2PSession) {
		return mobile.closeP2PSession({ target, sessionId, payload });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'closeP2PSession', { target, sessionId, payload });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function startP2PSession(target, initiator = true) {
	const bridge = getBridge();
	if (bridge && bridge.startP2PSession) {
		return bridge.startP2PSession(target, initiator);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.startP2PSession) {
		return mobile.startP2PSession({ target, initiator });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'startP2PSession', { target, initiator });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function sendP2PData(target, text = '') {
	const bridge = getBridge();
	if (bridge && bridge.sendP2PData) {
		return bridge.sendP2PData(target, text);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.sendP2PData) {
		return mobile.sendP2PData({ target, text });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'sendP2PData', { target, text });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function requestRemoteScriptsP2P(target, timeoutMs = 8000) {
	const bridge = getBridge();
	if (bridge && bridge.requestRemoteScriptsP2P) {
		return bridge.requestRemoteScriptsP2P(target, timeoutMs);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.requestRemoteScriptsP2P) {
		return mobile.requestRemoteScriptsP2P({ target, timeoutMs });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'requestRemoteScriptsP2P', { target, timeoutMs });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function getExchangeLinkedNodes() {
	const bridge = getBridge();
	if (bridge && bridge.getExchangeLinkedNodes) {
		return bridge.getExchangeLinkedNodes();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getExchangeLinkedNodes) {
		return mobile.getExchangeLinkedNodes();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'getExchangeLinkedNodes');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable', nodes: [], total: 0 };
}

export async function getExchangeToken() {
	const bridge = getBridge();
	if (bridge && bridge.getExchangeToken) {
		return bridge.getExchangeToken();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getExchangeToken) {
		return mobile.getExchangeToken();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'getExchangeToken');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function generateExchangeToken() {
	const bridge = getBridge();
	if (bridge && bridge.generateExchangeToken) {
		return bridge.generateExchangeToken();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.generateExchangeToken) {
		return mobile.generateExchangeToken();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'generateExchangeToken');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function getTlsConfig() {
	const bridge = getBridge();
	if (bridge && bridge.getTlsConfig) {
		return bridge.getTlsConfig();
	}
	return { ok: false, error: 'bridge unavailable' };
}

export async function generateTlsCert() {
	const bridge = getBridge();
	if (bridge && bridge.generateTlsCert) {
		return bridge.generateTlsCert();
	}
	return { ok: false, error: 'bridge unavailable' };
}

export async function deleteTlsCert() {
	const bridge = getBridge();
	if (bridge && bridge.deleteTlsCert) {
		return bridge.deleteTlsCert();
	}
	return { ok: false, error: 'bridge unavailable' };
}

export async function exportBackup() {
	const bridge = getBridge();
	if (bridge && bridge.exportBackup) {
		return bridge.exportBackup();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.exportBackup) {
		return mobile.exportBackup();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'exportBackup');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function importBackup() {
	const bridge = getBridge();
	if (bridge && bridge.importBackup) {
		return bridge.importBackup();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.importBackup) {
		return mobile.importBackup();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'importBackup');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function getMessageQueueStatus() {
	const bridge = getBridge();
	if (bridge && bridge.getMessageQueueStatus) {
		return bridge.getMessageQueueStatus();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getMessageQueueStatus) {
		return mobile.getMessageQueueStatus();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'getMessageQueueStatus');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function setMessageQueueTtlDays(ttlDays) {
	const bridge = getBridge();
	if (bridge && bridge.setMessageQueueTtlDays) {
		return bridge.setMessageQueueTtlDays(ttlDays);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.setMessageQueueTtlDays) {
		return mobile.setMessageQueueTtlDays({ ttlDays });
	}

	const nativeResult = await invokeNative('ReactorMobile', 'setMessageQueueTtlDays', { ttlDays });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function flushMessageQueue() {
	const bridge = getBridge();
	if (bridge && bridge.flushMessageQueue) {
		return bridge.flushMessageQueue();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.flushMessageQueue) {
		return mobile.flushMessageQueue();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'flushMessageQueue');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function clearMessageQueue() {
	const bridge = getBridge();
	if (bridge && bridge.clearMessageQueue) {
		return bridge.clearMessageQueue();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.clearMessageQueue) {
		return mobile.clearMessageQueue();
	}

	const nativeResult = await invokeNative('ReactorMobile', 'clearMessageQueue');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}
