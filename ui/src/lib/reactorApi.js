import { getBridge, getMobilePlugin, invokeNative } from './reactorBridge';

async function callNative(methodName, options = {}) {
	const nativeResult = await invokeNative('ReactorMobile', methodName, options);
	return nativeResult || null;
}

export async function getEndpointsInfo() {
	const bridge = getBridge();
	if (bridge && bridge.getEndpointsInfo) {
		return bridge.getEndpointsInfo();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getEndpointsInfo) {
		return mobile.getEndpointsInfo();
	}

	const nativeResult = await callNative('getEndpointsInfo');
	if (nativeResult) {
		return nativeResult;
	}

	return { path: '', endpoints: [] };
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

	const nativeResult = await callNative('getUiSettings');
	if (nativeResult) {
		return nativeResult;
	}

	return { defaultProgramPath: '', httpServerPort: 7070 };
}

export async function getPermissionsConfig() {
	const bridge = getBridge();
	if (bridge && bridge.getPermissionsConfig) {
		return bridge.getPermissionsConfig();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getPermissionsConfig) {
		return mobile.getPermissionsConfig();
	}

	const nativeResult = await callNative('getPermissionsConfig');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable', platform: '', permissions: {} };
}

export async function savePermissionsConfig(permissions) {
	const bridge = getBridge();
	if (bridge && bridge.savePermissionsConfig) {
		return bridge.savePermissionsConfig(permissions);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.savePermissionsConfig) {
		return mobile.savePermissionsConfig({ permissions });
	}

	const nativeResult = await callNative('savePermissionsConfig', { permissions });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function requestSystemPermissions(permissions = []) {
	const bridge = getBridge();
	if (bridge && bridge.requestSystemPermissions) {
		return bridge.requestSystemPermissions(permissions);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.requestSystemPermissions) {
		return mobile.requestSystemPermissions({ permissions });
	}

	const nativeResult = await callNative('requestSystemPermissions', { permissions });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable', granted: [], denied: [] };
}

export async function openSystemPermissionSettings(permissions = []) {
	const normalizedPermissions = Array.isArray(permissions)
		? Array.from(new Set(permissions.map((permissionName) => String(permissionName || '').trim()).filter(Boolean)))
		: [];

	const bridge = getBridge();
	if (bridge && bridge.openSystemPermissionSettings) {
		return bridge.openSystemPermissionSettings(normalizedPermissions);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.openSystemPermissionSettings) {
		return mobile.openSystemPermissionSettings({ permissions: normalizedPermissions });
	}

	const nativeResult = await callNative('openSystemPermissionSettings', { permissions: normalizedPermissions });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable', opened: false };
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

	const nativeResult = await callNative('stopBackgroundProcess');
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

	const nativeResult = await callNative('copyTextToClipboard', { text: safeText });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function openEndpointsFolder() {
	const bridge = getBridge();
	if (bridge && bridge.openEndpointsFolder) {
		return bridge.openEndpointsFolder();
	}
}

export async function openEndpointFile(filePath) {
	const bridge = getBridge();
	if (!bridge || !bridge.openEndpointFile) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.openEndpointFile(filePath);
}

export async function readEndpointContent(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.readEndpointContent) {
		return bridge.readEndpointContent(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.readEndpointContent) {
		return mobile.readEndpointContent({ filePath });
	}

	const nativeResult = await callNative('readEndpointContent', { filePath });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function saveEndpointContent(filePath, content) {
	const bridge = getBridge();
	if (bridge && bridge.saveEndpointContent) {
		return bridge.saveEndpointContent(filePath, content);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.saveEndpointContent) {
		return mobile.saveEndpointContent({ filePath, content });
	}

	const nativeResult = await callNative('saveEndpointContent', { filePath, content });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function resolveEndpointLogPath(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.resolveEndpointLogPath) {
		return bridge.resolveEndpointLogPath(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.resolveEndpointLogPath) {
		return mobile.resolveEndpointLogPath({ filePath });
	}

	const nativeResult = await callNative('resolveEndpointLogPath', { filePath });
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

export async function runEndpointNow(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.runEndpointNow) {
		return bridge.runEndpointNow(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.runEndpointNow) {
		return mobile.runEndpointNow({ filePath });
	}

	const nativeResult = await callNative('runEndpointNow', { filePath });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function createEndpointFile(templateKey, endpointName = '') {
	const bridge = getBridge();
	if (bridge && bridge.createEndpointFile) {
		return bridge.createEndpointFile(templateKey, endpointName);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.createEndpointFile) {
		return mobile.createEndpointFile({ templateKey, endpointName });
	}

	const nativeResult = await callNative('createEndpointFile', { templateKey, endpointName });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function reorderEndpoints(paths = []) {
	const safePaths = Array.isArray(paths)
		? paths.map((item) => String(item || '').trim()).filter(Boolean)
		: [];

	const bridge = getBridge();
	if (bridge && bridge.reorderEndpoints) {
		return bridge.reorderEndpoints(safePaths);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.reorderEndpoints) {
		return mobile.reorderEndpoints({ paths: safePaths });
	}

	const nativeResult = await callNative('reorderEndpoints', { paths: safePaths });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function renameEndpointFile(filePath, nextName) {
	const bridge = getBridge();
	if (bridge && bridge.renameEndpointFile) {
		return bridge.renameEndpointFile(filePath, nextName);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.renameEndpointFile) {
		return mobile.renameEndpointFile({ filePath, nextName });
	}

	const nativeResult = await callNative('renameEndpointFile', { filePath, nextName });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function confirmDeleteEndpoint(endpointName) {
	const bridge = getBridge();
	if (bridge && bridge.confirmDeleteEndpoint) {
		return bridge.confirmDeleteEndpoint(endpointName);
	}

	if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
		const confirmed = window.confirm(`Are you sure to delete endpoint '${endpointName.replace( /\.[\w]+$/, '' ) || 'this endpoint'}'?`);
		return { ok: true, confirmed };
	}

	return { ok: true, confirmed: false };
}

export async function deleteEndpointFile(filePath) {
	const bridge = getBridge();
	if (bridge && bridge.deleteEndpointFile) {
		return bridge.deleteEndpointFile(filePath);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.deleteEndpointFile) {
		return mobile.deleteEndpointFile({ filePath });
	}

	const nativeResult = await callNative('deleteEndpointFile', { filePath });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function toggleEndpointDirective(filePath, directive) {
	const bridge = getBridge();
	if (bridge && bridge.toggleEndpointDirective) {
		return bridge.toggleEndpointDirective(filePath, directive);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.toggleEndpointDirective) {
		return mobile.toggleEndpointDirective({ filePath, directive });
	}

	const nativeResult = await callNative('toggleEndpointDirective', { filePath, directive });
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

	const nativeResult = await callNative('openEventLog', { filePath });
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

	const nativeResult = await callNative('clearEventLog', { filePath });
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

	const nativeResult = await callNative('getHttpServerConfig');
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

	const nativeResult = await callNative('setHttpServerPort', { port });
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

	const nativeResult = await callNative('getReactorName');
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

	const nativeResult = await callNative('setReactorName', { name });
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

	const nativeResult = await callNative('openServerStatus');
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

	const nativeResult = await callNative('getExchangeConfig');
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

	const nativeResult = await callNative('setExchangeConfig', { mode, host, port, tls, token, discovery, stun, turn });
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

	const nativeResult = await callNative('saveRelayConfig', { kind, config });
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

	const nativeResult = await callNative('getP2PStatus');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable', p2p: { enabled: false, sessions: [], remotePeers: [] } };
}

export function subscribeP2PStatus(handler) {
	const mobile = getMobilePlugin();
	if (!mobile || typeof mobile.addListener !== 'function' || typeof handler !== 'function') {
		return () => {};
	}

	let subscription = null;
	try {
		subscription = mobile.addListener('p2pStatus', (payload) => {
			handler(payload || null);
		});
	} catch {
		return () => {};
	}

	return () => {
		try {
			if (subscription && typeof subscription.then === 'function') {
				subscription.then((resolved) => {
					if (resolved && typeof resolved.remove === 'function') {
						resolved.remove();
					}
				}).catch(() => {});
				return;
			}

			if (subscription && typeof subscription.remove === 'function') {
				subscription.remove();
			}
		} catch {
			// ignore
		}
	};
}

export function subscribeExchangeStatus(handler) {
	const mobile = getMobilePlugin();
	if (!mobile || typeof mobile.addListener !== 'function' || typeof handler !== 'function') {
		return () => {};
	}

	let subscription = null;
	try {
		subscription = mobile.addListener('exchangeStatus', (payload) => {
			handler(payload || null);
		});
	} catch {
		return () => {};
	}

	return () => {
		try {
			if (subscription && typeof subscription.then === 'function') {
				subscription.then((resolved) => {
					if (resolved && typeof resolved.remove === 'function') {
						resolved.remove();
					}
				}).catch(() => {});
				return;
			}

			if (subscription && typeof subscription.remove === 'function') {
				subscription.remove();
			}
		} catch {
			// ignore
		}
	};
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

	const nativeResult = await callNative('sendP2PSignal', { target, signalType, payload, sessionId });
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

	const nativeResult = await callNative('closeP2PSession', { target, sessionId, payload });
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

	const nativeResult = await callNative('startP2PSession', { target, initiator });
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

	const nativeResult = await callNative('sendP2PData', { target, text });
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function requestRemoteEndpointsP2P(target, timeoutMs = 8000) {
	const bridge = getBridge();
	if (bridge && bridge.requestRemoteEndpointsP2P) {
		return bridge.requestRemoteEndpointsP2P(target, timeoutMs);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.requestRemoteEndpointsP2P) {
		return mobile.requestRemoteEndpointsP2P({ target, timeoutMs });
	}

	const nativeResult = await callNative('requestRemoteEndpointsP2P', { target, timeoutMs });
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

	const nativeResult = await callNative('getExchangeLinkedNodes');
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

	const nativeResult = await callNative('getExchangeToken');
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

	const nativeResult = await callNative('generateExchangeToken');
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

	const nativeResult = await callNative('exportBackup');
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

	const nativeResult = await callNative('importBackup');
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

	const nativeResult = await callNative('getMessageQueueStatus');
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

	const nativeResult = await callNative('setMessageQueueTtlDays', { ttlDays });
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

	const nativeResult = await callNative('flushMessageQueue');
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

	const nativeResult = await callNative('clearMessageQueue');
	if (nativeResult) {
		return nativeResult;
	}

	return { ok: false, error: 'bridge unavailable' };
}
