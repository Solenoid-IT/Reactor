function getBridge() {
	if (typeof window === 'undefined') {
		return null;
	}
	return window.reactor || null;
}

export async function getScriptsInfo() {
	const bridge = getBridge();
	if (!bridge || !bridge.getScriptsInfo) {
		return { path: '', scripts: [] };
	}
	return bridge.getScriptsInfo();
}

export async function getUiSettings() {
	const bridge = getBridge();
	if (!bridge || !bridge.getUiSettings) {
		return { defaultProgramPath: '', httpServerPort: 7070 };
	}
	return bridge.getUiSettings();
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
	if (!bridge || !bridge.createScriptFile) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.createScriptFile(templateKey);
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
	if (!bridge || !bridge.openEventLog) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.openEventLog(filePath);
}

export async function clearEventLog(filePath) {
	const bridge = getBridge();
	if (!bridge || !bridge.clearEventLog) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.clearEventLog(filePath);
}

export async function getHttpServerConfig() {
	const bridge = getBridge();
	if (!bridge || !bridge.getHttpServerConfig) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.getHttpServerConfig();
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
	if (!bridge || !bridge.getReactorName) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.getReactorName();
}

export async function setReactorName(name) {
	const bridge = getBridge();
	if (!bridge || !bridge.setReactorName) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.setReactorName(name);
}

export async function openServerStatus() {
	const bridge = getBridge();
	if (!bridge || !bridge.openServerStatus) {
		return { ok: false, error: 'bridge unavailable' };
	}
	return bridge.openServerStatus();
}
