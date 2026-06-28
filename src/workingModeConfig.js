const fs = require('fs/promises');

const DEFAULT_WORKING_MODE_CONFIG = {
	type: 'node',
	host: '',
	port: 7070,
	tls: false,
	token: '',
};

function normalizeWorkingModeConfig(rawConfig = {}) {
	return {
		type: String(rawConfig.type || rawConfig.exchangeMode || rawConfig.mode || 'node'),
		host: String(rawConfig.host || rawConfig.exchangeHost || ''),
		port: Number(rawConfig.port || rawConfig.exchangePort) > 0 ? Number(rawConfig.port || rawConfig.exchangePort) : 7070,
		tls: Boolean(rawConfig.tls ?? rawConfig.exchangeTls),
		token: String(rawConfig.token || rawConfig.exchangeToken || ''),
	};
}

function normalizeWorkingModeUpdate(rawConfig = {}) {
	const normalized = {};

	if (Object.prototype.hasOwnProperty.call(rawConfig, 'type') || Object.prototype.hasOwnProperty.call(rawConfig, 'exchangeMode') || Object.prototype.hasOwnProperty.call(rawConfig, 'mode')) {
		normalized.type = String(rawConfig.type || rawConfig.exchangeMode || rawConfig.mode || 'node');
	}

	if (Object.prototype.hasOwnProperty.call(rawConfig, 'host') || Object.prototype.hasOwnProperty.call(rawConfig, 'exchangeHost')) {
		normalized.host = String(rawConfig.host || rawConfig.exchangeHost || '');
	}

	if (Object.prototype.hasOwnProperty.call(rawConfig, 'port') || Object.prototype.hasOwnProperty.call(rawConfig, 'exchangePort')) {
		normalized.port = Number(rawConfig.port || rawConfig.exchangePort) > 0 ? Number(rawConfig.port || rawConfig.exchangePort) : 7070;
	}

	if (Object.prototype.hasOwnProperty.call(rawConfig, 'tls') || Object.prototype.hasOwnProperty.call(rawConfig, 'exchangeTls')) {
		normalized.tls = Boolean(rawConfig.tls ?? rawConfig.exchangeTls);
	}

	if (Object.prototype.hasOwnProperty.call(rawConfig, 'token') || Object.prototype.hasOwnProperty.call(rawConfig, 'exchangeToken')) {
		normalized.token = String(rawConfig.token || rawConfig.exchangeToken || '');
	}

	return normalized;
}

async function readWorkingModeConfig(configPath) {
	try {
		const raw = await fs.readFile(configPath, 'utf8');
		const parsed = JSON.parse(raw);
		return {
			...DEFAULT_WORKING_MODE_CONFIG,
			...normalizeWorkingModeConfig(parsed),
		};
	} catch {
		return { ...DEFAULT_WORKING_MODE_CONFIG };
	}
}

async function writeWorkingModeConfig(configPath, nextSettings = {}) {
	const current = await readWorkingModeConfig(configPath);
	const merged = {
		...current,
		...normalizeWorkingModeUpdate(nextSettings),
	};
	await fs.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
	return merged;
}

module.exports = {
	DEFAULT_WORKING_MODE_CONFIG,
	normalizeWorkingModeConfig,
	readWorkingModeConfig,
	writeWorkingModeConfig,
};