const { app } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { DEFAULT_WORKING_MODE_CONFIG, readWorkingModeConfig, writeWorkingModeConfig } = require('../workingModeConfig');

const UI_SETTINGS_FILE = 'ui-settings.json';
const WORKING_MODE_FILE = 'working-mode.json';

function getUiSettingsPath() {
	return path.join(app.getPath('userData'), UI_SETTINGS_FILE);
}

function getWorkingModeSettingsPath() {
	return path.join(app.getPath('userData'), WORKING_MODE_FILE);
}

async function readUiSettings() {
	const workingModeSettings = await readWorkingModeConfig(getWorkingModeSettingsPath());
	try {
		const raw = await fs.readFile(getUiSettingsPath(), 'utf8');
		const parsed = JSON.parse(raw);
		const normalizedWorkingMode = {
			exchangeMode: workingModeSettings.type,
			exchangeHost: workingModeSettings.host,
			exchangePort: workingModeSettings.port,
			exchangeTls: workingModeSettings.tls,
			exchangeToken: workingModeSettings.token,
			exchangeDiscovery: Boolean(workingModeSettings.discovery),
			stun: {
				host: String(workingModeSettings.stun?.host || ''),
				port: Number(workingModeSettings.stun?.port) > 0 ? Number(workingModeSettings.stun.port) : 3478,
				tls: Boolean(workingModeSettings.stun?.tls),
			},
			turn: {
				host: String(workingModeSettings.turn?.host || ''),
				port: Number(workingModeSettings.turn?.port) > 0 ? Number(workingModeSettings.turn.port) : 3478,
				tls: Boolean(workingModeSettings.turn?.tls),
			},
		};
		return {
			defaultProgramPath: parsed.defaultProgramPath || '',
			httpServerPort: Number(parsed.httpServerPort) || 7070,
			...normalizedWorkingMode,
		};
	} catch (error) {
		return {
			defaultProgramPath: '',
			httpServerPort: 7070,
			exchangeMode: DEFAULT_WORKING_MODE_CONFIG.type,
			exchangeHost: DEFAULT_WORKING_MODE_CONFIG.host,
			exchangePort: DEFAULT_WORKING_MODE_CONFIG.port,
			exchangeTls: DEFAULT_WORKING_MODE_CONFIG.tls,
			exchangeToken: DEFAULT_WORKING_MODE_CONFIG.token,
			exchangeDiscovery: Boolean(DEFAULT_WORKING_MODE_CONFIG.discovery),
			stun: {
				host: String(DEFAULT_WORKING_MODE_CONFIG.stun?.host || ''),
				port: Number(DEFAULT_WORKING_MODE_CONFIG.stun?.port) > 0 ? Number(DEFAULT_WORKING_MODE_CONFIG.stun.port) : 3478,
				tls: Boolean(DEFAULT_WORKING_MODE_CONFIG.stun?.tls),
			},
			turn: {
				host: String(DEFAULT_WORKING_MODE_CONFIG.turn?.host || ''),
				port: Number(DEFAULT_WORKING_MODE_CONFIG.turn?.port) > 0 ? Number(DEFAULT_WORKING_MODE_CONFIG.turn.port) : 3478,
				tls: Boolean(DEFAULT_WORKING_MODE_CONFIG.turn?.tls),
			},
		};
	}
}

async function writeUiSettings(nextSettings) {
	const current = await readUiSettings();
	const workingModeUpdates = {};
	for (const key of ['exchangeMode', 'exchangeHost', 'exchangePort', 'exchangeTls', 'exchangeToken', 'exchangeDiscovery', 'stun', 'turn']) {
		if (Object.prototype.hasOwnProperty.call(nextSettings, key)) {
			workingModeUpdates[key] = nextSettings[key];
		}
	}

	if (Object.keys(workingModeUpdates).length > 0) {
		await writeWorkingModeConfig(getWorkingModeSettingsPath(), workingModeUpdates);
	}

	const merged = {
		...current,
		...nextSettings,
	};
	const uiSettingsOnly = {
		defaultProgramPath: merged.defaultProgramPath || '',
		httpServerPort: Number(merged.httpServerPort) || 7070,
	};
	await fs.writeFile(getUiSettingsPath(), `${JSON.stringify(uiSettingsOnly, null, 2)}\n`, 'utf8');
}

module.exports = {
	readUiSettings,
	writeUiSettings,
};
