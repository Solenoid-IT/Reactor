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

export async function getScriptsInfo() {
	const bridge = getBridge();
	if (bridge && bridge.getScriptsInfo) {
		return bridge.getScriptsInfo();
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.getScriptsInfo) {
		return mobile.getScriptsInfo();
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

	return { defaultProgramPath: '', httpServerPort: 7070 };
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
	if (!bridge || !bridge.runScriptNow) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.runScriptNow(filePath);
}

export async function createScriptFile(templateKey) {
	const bridge = getBridge();
	if (bridge && bridge.createScriptFile) {
		return bridge.createScriptFile(templateKey);
	}

	const mobile = getMobilePlugin();
	if (mobile && mobile.createScriptFile) {
		return mobile.createScriptFile({ templateKey });
	}

	return { ok: false, error: 'bridge unavailable' };
}

export async function renameScriptFile(filePath, nextName) {
	const bridge = getBridge();
	if (!bridge || !bridge.renameScriptFile) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.renameScriptFile(filePath, nextName);
}

export async function confirmDeleteScript(scriptName) {
	const bridge = getBridge();
	if (!bridge || !bridge.confirmDeleteScript) {
		return { ok: false, confirmed: false };
	}
	return bridge.confirmDeleteScript(scriptName);
}

export async function deleteScriptFile(filePath) {
	const bridge = getBridge();
	if (!bridge || !bridge.deleteScriptFile) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.deleteScriptFile(filePath);
}

export async function toggleScriptDirective(filePath, directive) {
	const bridge = getBridge();
	if (!bridge || !bridge.toggleScriptDirective) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.toggleScriptDirective(filePath, directive);
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

	return { ok: false, error: 'bridge unavailable' };
}

export async function setHttpServerPort(port) {
	const bridge = getBridge();
	if (!bridge || !bridge.setHttpServerPort) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.setHttpServerPort(port);
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

	return { ok: false, error: 'bridge unavailable' };
}

export async function openServerStatus() {
	const bridge = getBridge();
	if (!bridge || !bridge.openServerStatus) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.openServerStatus();
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
