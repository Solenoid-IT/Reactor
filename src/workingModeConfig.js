const fs = require('fs/promises');

const DEFAULT_WORKING_MODE_CONFIG = {
	type: 'node',
	host: '',
	port: 7070,
	tls: false,
	token: '',
	discovery: false,
	stun: {
		host: '',
		port: 3478,
		tls: false,
	},
	turn: {
		host: '',
		port: 3478,
		tls: false,
	},
};

function normalizeRelayEndpoint(rawConfig = {}, key, fallbackPort = 3478) {
	const nested = rawConfig[key] && typeof rawConfig[key] === 'object' ? rawConfig[key] : {};
	const host = String(
		nested.host
		?? nested.server
		?? rawConfig[`${key}Host`]
		?? rawConfig[`${key}Server`]
		?? '',
	);
	const rawPort = nested.port ?? rawConfig[`${key}Port`];
	const port = Number(rawPort) > 0 ? Number(rawPort) : fallbackPort;
	const tls = Boolean(nested.tls ?? rawConfig[`${key}Tls`]);

	return {
		host,
		port,
		tls,
	};
}

function hasRelayEndpointUpdate(rawConfig = {}, key) {
	if (
		Object.prototype.hasOwnProperty.call(rawConfig, `${key}Host`)
		|| Object.prototype.hasOwnProperty.call(rawConfig, `${key}Server`)
		|| Object.prototype.hasOwnProperty.call(rawConfig, `${key}Port`)
		|| Object.prototype.hasOwnProperty.call(rawConfig, `${key}Tls`)
	) {
		return true;
	}

	if (!Object.prototype.hasOwnProperty.call(rawConfig, key)) {
		return false;
	}

	const nested = rawConfig[key];
	if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
		return true;
	}

	return (
		Object.prototype.hasOwnProperty.call(nested, 'host')
		|| Object.prototype.hasOwnProperty.call(nested, 'server')
		|| Object.prototype.hasOwnProperty.call(nested, 'port')
		|| Object.prototype.hasOwnProperty.call(nested, 'tls')
	);
}

function normalizeMode(rawMode) {
	const mode = String(rawMode || '').trim().toLowerCase();
	if (mode === 'exchange') {
		return 'exchange';
	}
	if (mode === 'node') {
		return 'node';
	}
	return 'node';
}

function normalizeWorkingModeConfig(rawConfig = {}) {
	return {
		type: normalizeMode(rawConfig.type || rawConfig.exchangeMode || rawConfig.mode || 'node'),
		host: String(rawConfig.host || rawConfig.exchangeHost || ''),
		port: Number(rawConfig.port || rawConfig.exchangePort) > 0 ? Number(rawConfig.port || rawConfig.exchangePort) : 7070,
		tls: Boolean(rawConfig.tls ?? rawConfig.exchangeTls),
		token: String(rawConfig.token || rawConfig.exchangeToken || ''),
		discovery: Boolean(
			rawConfig.discovery
			?? rawConfig.exchangeDiscovery
			?? rawConfig.discoveryEnabled
			?? rawConfig.exposeDiscoveryEndpoint
			?? rawConfig.exchangeDiscoveryEndpoint
			?? rawConfig.discoveryEndpoint,
		),
		stun: normalizeRelayEndpoint(rawConfig, 'stun', 3478),
		turn: normalizeRelayEndpoint(rawConfig, 'turn', 3478),
	};
}

function normalizeWorkingModeUpdate(rawConfig = {}) {
	const normalized = {};

	if (Object.prototype.hasOwnProperty.call(rawConfig, 'type') || Object.prototype.hasOwnProperty.call(rawConfig, 'exchangeMode') || Object.prototype.hasOwnProperty.call(rawConfig, 'mode')) {
		normalized.type = normalizeMode(rawConfig.type || rawConfig.exchangeMode || rawConfig.mode || 'node');
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

	if (
		Object.prototype.hasOwnProperty.call(rawConfig, 'discovery')
		|| Object.prototype.hasOwnProperty.call(rawConfig, 'exchangeDiscovery')
		|| Object.prototype.hasOwnProperty.call(rawConfig, 'discoveryEnabled')
		|| Object.prototype.hasOwnProperty.call(rawConfig, 'exposeDiscoveryEndpoint')
		|| Object.prototype.hasOwnProperty.call(rawConfig, 'exchangeDiscoveryEndpoint')
		|| Object.prototype.hasOwnProperty.call(rawConfig, 'discoveryEndpoint')
	) {
		normalized.discovery = Boolean(
			rawConfig.discovery
			?? rawConfig.exchangeDiscovery
			?? rawConfig.discoveryEnabled
			?? rawConfig.exposeDiscoveryEndpoint
			?? rawConfig.exchangeDiscoveryEndpoint
			?? rawConfig.discoveryEndpoint,
		);
	}

	if (hasRelayEndpointUpdate(rawConfig, 'stun')) {
		normalized.stun = normalizeRelayEndpoint(rawConfig, 'stun', 3478);
	}

	if (hasRelayEndpointUpdate(rawConfig, 'turn')) {
		normalized.turn = normalizeRelayEndpoint(rawConfig, 'turn', 3478);
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