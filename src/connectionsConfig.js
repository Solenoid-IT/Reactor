const fs = require('fs/promises');

const DEFAULT_CONNECTIONS_CONFIG = {
	exchange: {
		host: '',
		port: 7070,
		tls: false,
		token: '',
		discovery: false,
	},
	stun: {
		host: '',
		port: 3478,
		tls: false,
		username: '',
		password: '',
	},
	turn: {
		host: '',
		port: 3478,
		tls: false,
		username: '',
		password: '',
	},
};

function normalizeRelayEndpoint(rawValue = {}, fallbackPort = 3478) {
	const nested = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
	const host = String(nested.host ?? nested.server ?? '');
	const rawPort = nested.port;
	const port = Number(rawPort) > 0 ? Number(rawPort) : fallbackPort;
	const tls = Boolean(nested.tls);
	const username = String(nested.username ?? nested.user ?? '');
	const password = String(nested.password ?? '');

	return {
		host,
		port,
		tls,
		username,
		password,
	};
}

function normalizeExchangeConfig(rawValue = {}) {
	const nested = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
	return {
		host: String(nested.host ?? ''),
		port: Number(nested.port) > 0 ? Number(nested.port) : 7070,
		tls: Boolean(nested.tls),
		token: String(nested.token ?? ''),
		discovery: Boolean(nested.discovery),
	};
}

function normalizeConnectionsConfig(rawConfig = {}) {
	const source = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
	return {
		exchange: normalizeExchangeConfig(source.exchange),
		stun: normalizeRelayEndpoint(source.stun, 3478),
		turn: normalizeRelayEndpoint(source.turn, 3478),
	};
}

function normalizeConnectionsUpdate(rawConfig = {}) {
	const source = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
	const normalized = {};

	if (Object.prototype.hasOwnProperty.call(source, 'exchange')) {
		normalized.exchange = normalizeExchangeConfig(source.exchange);
	}

	if (Object.prototype.hasOwnProperty.call(source, 'stun')) {
		normalized.stun = normalizeRelayEndpoint(source.stun, 3478);
	}

	if (Object.prototype.hasOwnProperty.call(source, 'turn')) {
		normalized.turn = normalizeRelayEndpoint(source.turn, 3478);
	}

	return normalized;
}

async function readConnectionsConfig(configPath) {
	try {
		const raw = await fs.readFile(configPath, 'utf8');
		const parsed = JSON.parse(raw);
		return {
			...DEFAULT_CONNECTIONS_CONFIG,
			...normalizeConnectionsConfig(parsed),
		};
	} catch {
		return {
			...DEFAULT_CONNECTIONS_CONFIG,
		};
	}
}

async function writeConnectionsConfig(configPath, nextSettings = {}) {
	const current = await readConnectionsConfig(configPath);
	const merged = {
		...current,
		...normalizeConnectionsUpdate(nextSettings),
	};
	await fs.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
	return merged;
}

module.exports = {
	DEFAULT_CONNECTIONS_CONFIG,
	normalizeConnectionsConfig,
	readConnectionsConfig,
	writeConnectionsConfig,
};