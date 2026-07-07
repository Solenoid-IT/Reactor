const { app } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { DEFAULT_CONNECTIONS_CONFIG, readConnectionsConfig, writeConnectionsConfig } = require('../connectionsConfig');
const { DEFAULT_LOCAL_SERVER_PORT } = require('../runtime/coreUtils');

const UI_SETTINGS_FILE = 'ui-settings.json';
const CONNECTIONS_FILE = 'connections.json';

function getUiSettingsPath() {
	return path.join(app.getPath('userData'), UI_SETTINGS_FILE);
}

function getConnectionsSettingsPath() {
	return path.join(app.getPath('userData'), CONNECTIONS_FILE);
}

async function readUiSettings() {
	const connectionsSettings = await readConnectionsConfig(getConnectionsSettingsPath());
	try {
		const raw = await fs.readFile(getUiSettingsPath(), 'utf8');
		const parsed = JSON.parse(raw);
		const normalizedWorkingMode = {
			exchangeMode: 'node',
			exchangeHost: connectionsSettings.exchange?.host || '',
			exchangePort: Number(connectionsSettings.exchange?.port) > 0 ? Number(connectionsSettings.exchange.port) : 7070,
			exchangeTls: Boolean(connectionsSettings.exchange?.tls),
			exchangeToken: String(connectionsSettings.exchange?.token || ''),
			exchangeUser: String(connectionsSettings.exchange?.user || ''),
			exchangePassword: String(connectionsSettings.exchange?.password || ''),
			exchangeDiscovery: Boolean(connectionsSettings.exchange?.discovery),
			stun: {
				host: String(connectionsSettings.stun?.host || ''),
				port: Number(connectionsSettings.stun?.port) > 0 ? Number(connectionsSettings.stun.port) : 3478,
				tls: Boolean(connectionsSettings.stun?.tls),
				username: String(connectionsSettings.stun?.username || ''),
				password: String(connectionsSettings.stun?.password || ''),
			},
			turn: {
				host: String(connectionsSettings.turn?.host || ''),
				port: Number(connectionsSettings.turn?.port) > 0 ? Number(connectionsSettings.turn.port) : 3478,
				tls: Boolean(connectionsSettings.turn?.tls),
				username: String(connectionsSettings.turn?.username || ''),
				password: String(connectionsSettings.turn?.password || ''),
			},
		};
		return {
			defaultProgramPath: parsed.defaultProgramPath || '',
			httpServerPort: Number(parsed.httpServerPort) || DEFAULT_LOCAL_SERVER_PORT,
			...normalizedWorkingMode,
		};
	} catch (error) {
		return {
			defaultProgramPath: '',
			httpServerPort: DEFAULT_LOCAL_SERVER_PORT,
			exchangeMode: 'node',
			exchangeHost: DEFAULT_CONNECTIONS_CONFIG.exchange.host,
			exchangePort: DEFAULT_CONNECTIONS_CONFIG.exchange.port,
			exchangeTls: DEFAULT_CONNECTIONS_CONFIG.exchange.tls,
			exchangeToken: DEFAULT_CONNECTIONS_CONFIG.exchange.token,
			exchangeUser: String(DEFAULT_CONNECTIONS_CONFIG.exchange.user || ''),
			exchangePassword: String(DEFAULT_CONNECTIONS_CONFIG.exchange.password || ''),
			exchangeDiscovery: Boolean(DEFAULT_CONNECTIONS_CONFIG.exchange.discovery),
			stun: {
				host: String(DEFAULT_CONNECTIONS_CONFIG.stun?.host || ''),
				port: Number(DEFAULT_CONNECTIONS_CONFIG.stun?.port) > 0 ? Number(DEFAULT_CONNECTIONS_CONFIG.stun.port) : 3478,
				tls: Boolean(DEFAULT_CONNECTIONS_CONFIG.stun?.tls),
				username: String(DEFAULT_CONNECTIONS_CONFIG.stun?.username || ''),
				password: String(DEFAULT_CONNECTIONS_CONFIG.stun?.password || ''),
			},
			turn: {
				host: String(DEFAULT_CONNECTIONS_CONFIG.turn?.host || ''),
				port: Number(DEFAULT_CONNECTIONS_CONFIG.turn?.port) > 0 ? Number(DEFAULT_CONNECTIONS_CONFIG.turn.port) : 3478,
				tls: Boolean(DEFAULT_CONNECTIONS_CONFIG.turn?.tls),
				username: String(DEFAULT_CONNECTIONS_CONFIG.turn?.username || ''),
				password: String(DEFAULT_CONNECTIONS_CONFIG.turn?.password || ''),
			},
		};
	}
}

async function writeUiSettings(nextSettings) {
	const current = await readUiSettings();
	const hasConnectionUpdates = [
		'exchangeHost',
		'exchangePort',
		'exchangeTls',
		'exchangeToken',
		'exchangeUser',
		'exchangePassword',
		'exchangeDiscovery',
		'stun',
		'turn',
	].some((key) => Object.prototype.hasOwnProperty.call(nextSettings, key));

	if (hasConnectionUpdates) {
		await writeConnectionsConfig(getConnectionsSettingsPath(), {
			exchange: {
				host: Object.prototype.hasOwnProperty.call(nextSettings, 'exchangeHost') ? nextSettings.exchangeHost : current.exchangeHost,
				port: Object.prototype.hasOwnProperty.call(nextSettings, 'exchangePort') ? nextSettings.exchangePort : current.exchangePort,
				tls: Object.prototype.hasOwnProperty.call(nextSettings, 'exchangeTls') ? nextSettings.exchangeTls : current.exchangeTls,
				token: Object.prototype.hasOwnProperty.call(nextSettings, 'exchangeToken') ? nextSettings.exchangeToken : current.exchangeToken,
				user: Object.prototype.hasOwnProperty.call(nextSettings, 'exchangeUser') ? nextSettings.exchangeUser : current.exchangeUser,
				password: Object.prototype.hasOwnProperty.call(nextSettings, 'exchangePassword') ? nextSettings.exchangePassword : current.exchangePassword,
				discovery: Object.prototype.hasOwnProperty.call(nextSettings, 'exchangeDiscovery') ? nextSettings.exchangeDiscovery : current.exchangeDiscovery,
			},
			stun: Object.prototype.hasOwnProperty.call(nextSettings, 'stun') ? nextSettings.stun : current.stun,
			turn: Object.prototype.hasOwnProperty.call(nextSettings, 'turn') ? nextSettings.turn : current.turn,
		});
	}

	const merged = {
		...current,
		...nextSettings,
	};
	const uiSettingsOnly = {
		defaultProgramPath: merged.defaultProgramPath || '',
		httpServerPort: Number(merged.httpServerPort) || DEFAULT_LOCAL_SERVER_PORT,
	};
	await fs.writeFile(getUiSettingsPath(), `${JSON.stringify(uiSettingsOnly, null, 2)}\n`, 'utf8');
}

module.exports = {
	readUiSettings,
	writeUiSettings,
};
