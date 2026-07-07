const fs = require('fs/promises');
const fsNative = require('fs');
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { readConnectionsConfig, writeConnectionsConfig } = require('./connectionsConfig');
const { parseScheduleExpression } = require('./scheduleParser');
const { parseEndpointMetadata } = require('./metadata');
const { loadEndpointModule } = require('./scriptLoader');
const { readEnvConfig, writeEnvConfig } = require('./envStore');
const { NetworkMonitor } = require('./networkMonitor');
const { createNodePlatformServices } = require('./platform/nodePlatformServices');
const { createNodeRuntimeApi } = require('./platform/nodeRuntimeApi');
const { ExchangeManager } = require('./exchangeManager');
const { TlsManager } = require('./tlsManager');
const { P2PDataChannelManager } = require('./p2pDataChannelManager');
const { DEFAULT_LOCAL_SERVER_PORT } = require('./runtime/coreUtils');

const ALL_WATCH_LISTENERS = new Set([
	'file:created',
	'file:deleted',
	'file:moved',
	'file:changed',
	'dir:created',
	'dir:deleted',
	'dir:moved',
]);

const DEFAULT_MESSAGE_QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MESSAGE_QUEUE_RETRY_MS = 30 * 1000;
const DEFAULT_STREAM_MAX_ACTIVE = 24;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_CLEANUP_INTERVAL_MS = 30 * 1000;
const DEFAULT_WATCH_CREATED_POLL_MS = 1000;
const DEFAULT_WATCH_CREATED_QUIET_MS = 10 * 1000;
const DEFAULT_WATCH_CREATED_LARGE_QUIET_MS = 30 * 1000;
const DEFAULT_WATCH_CREATED_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_WATCH_CREATED_LARGE_FILE_BYTES = 1024 * 1024 * 1024;
const PROJECT_UUID_FILE = 'uuid';
const STUN_MAGIC_COOKIE = 0x2112A442;
const STUN_HEADER_LENGTH = 20;
const STUN_ATTR_USERNAME = 0x0006;
const STUN_ATTR_MESSAGE_INTEGRITY = 0x0008;
const STUN_ATTR_ERROR_CODE = 0x0009;
const STUN_ATTR_REALM = 0x0014;
const STUN_ATTR_NONCE = 0x0015;
const TURN_ATTR_REQUESTED_TRANSPORT = 0x0019;
const TURN_ALLOCATE_REQUEST = 0x0003;
const TURN_ALLOCATE_SUCCESS_RESPONSE = 0x0103;
const TURN_RELAY_TEST_TIMEOUT_MS = Number(process.env.REACTOR_TURN_TEST_TIMEOUT_MS) > 0
	? Number(process.env.REACTOR_TURN_TEST_TIMEOUT_MS)
	: 12000;
const P2P_REMOTE_ENDPOINTS_TIMEOUT_MS = Number(process.env.REACTOR_P2P_ENDPOINTS_TIMEOUT_MS) > 0
	? Number(process.env.REACTOR_P2P_ENDPOINTS_TIMEOUT_MS)
	: 12000;

function formatTlsCertificateError(rawError, fallback = 'TLS certificate validation failed') {
	const message = String(rawError || '').trim();
	const lowered = message.toLowerCase();
	if (!lowered) {
		return fallback;
	}

	const certificateIssue =
		lowered.includes('self signed')
		|| lowered.includes('unable to verify')
		|| lowered.includes('unable to get local issuer certificate')
		|| lowered.includes('certificate has expired')
		|| lowered.includes('hostname/ip does not match certificate')
		|| lowered.includes('altname')
		|| lowered.includes('x509')
		|| lowered.includes('cert_');

	if (certificateIssue) {
		return `TLS certificate validation failed: ${message}`;
	}

	return message;
}

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.max(0, Number(ms) || 0));
	});
}

function collectKnownEntries(rootPath, map) {
	let entries = [];
	try {
		entries = fsNative.readdirSync(rootPath, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const fullPath = path.join(rootPath, entry.name);
		if (entry.isDirectory()) {
			map.set(fullPath, 'dir');
			collectKnownEntries(fullPath, map);
		} else if (entry.isFile()) {
			map.set(fullPath, 'file');
		}
	}
}

function normalizeWatchEventPath(rawPath) {
	const normalized = String(rawPath || '').replace(/\\/g, '/');
	if (!normalized) {
		return '';
	}

	if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
		return normalized;
	}

	return normalized.replace(/\/+$/g, '');
}

function computeWatchRelativePath(entryPath, watchPath) {
	const normalizedEntryPath = normalizeWatchEventPath(entryPath);
	const normalizedWatchPath = normalizeWatchEventPath(watchPath);

	if (!normalizedEntryPath) {
		return '';
	}

	if (!normalizedWatchPath) {
		return normalizedEntryPath;
	}

	if (normalizedEntryPath === normalizedWatchPath) {
		return '';
	}

	const prefix = `${normalizedWatchPath}/`;
	if (normalizedEntryPath.startsWith(prefix)) {
		return normalizedEntryPath.slice(prefix.length);
	}

	return normalizedEntryPath;
}

function isUuidV4(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function isLikelyNetworkIdentity(value) {
	const safe = String(value || '').trim().toLowerCase();
	if (!safe) {
		return false;
	}

	if (safe.includes(':')) {
		return true;
	}

	if (/^\d+\.\d+\.\d+\.\d+$/.test(safe)) {
		return true;
	}

	if (safe.includes('.') || safe.endsWith('.local')) {
		return true;
	}

	return false;
}

function parseEndpointSelector(rawSelector) {
	const trimmed = String(rawSelector || '').trim();
	if (!trimmed) {
		return null;
	}

	const lowered = trimmed.toLowerCase();
	if (lowered.startsWith('id:')) {
		const endpointId = lowered.slice(3).trim();
		if (!isUuidV4(endpointId)) {
			return null;
		}

		return {
			type: 'id',
			value: endpointId,
			headerValue: `id:${endpointId}`,
		};
	}

	return {
		type: 'name',
		value: lowered,
		headerValue: lowered,
	};
}

function parseNetNodeTarget(rawNode, defaultPort = DEFAULT_LOCAL_SERVER_PORT) {
	const safeNode = String(rawNode || '').trim().toLowerCase();
	if (!safeNode) {
		return null;
	}

	if (/^https?:\/\//i.test(safeNode)) {
		try {
			const parsed = new URL(safeNode);
			const host = String(parsed.hostname || '').trim().toLowerCase();
			const resolvedPort = parsed.port ? Number(parsed.port) : defaultPort;
			if (!host || !Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
				return null;
			}

			return {
				host,
				port: resolvedPort,
				hostPort: `${host}:${resolvedPort}`,
			};
		} catch {
			return null;
		}
	}

	const hostPort = normalizeHostPort(safeNode, defaultPort);
	if (!hostPort) {
		return null;
	}

	const [host, portString] = hostPort.split(':');
	const port = Number(portString || defaultPort);
	if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
		return null;
	}

	return {
		host,
		port,
		hostPort,
	};
}

function parseNodeDispatchTarget(rawTarget, defaultDirectPort = DEFAULT_LOCAL_SERVER_PORT) {
	const trimmed = String(rawTarget || '').trim();
	if (!trimmed) {
		return null;
	}

	const atIndex = trimmed.lastIndexOf('@');
	if (atIndex === -1) {
		const endpointSelector = parseEndpointSelector(trimmed);
		if (!endpointSelector) {
			return null;
		}

		return {
			rawTarget: trimmed,
			endpointSelector,
			routeKind: 'local',
			nodeName: null,
			directAddress: null,
		};
	}

	const endpointRaw = trimmed.slice(0, atIndex).trim();
	const nodeRaw = trimmed.slice(atIndex + 1).trim();
	if (!endpointRaw || !nodeRaw) {
		return null;
	}

	const endpointSelector = parseEndpointSelector(endpointRaw);
	if (!endpointSelector) {
		return null;
	}

	if (nodeRaw.toLowerCase().startsWith('net:')) {
		const parsedNet = parseNetNodeTarget(nodeRaw.slice(4), defaultDirectPort);
		if (!parsedNet) {
			return null;
		}

		return {
			rawTarget: trimmed,
			endpointSelector,
			routeKind: 'direct',
			nodeName: null,
			directAddress: parsedNet.hostPort,
			nodeSelector: `net:${parsedNet.hostPort}`,
		};
	}

	const nodeName = String(nodeRaw || '').trim().toLowerCase();
	if (!nodeName) {
		return null;
	}

	return {
		rawTarget: trimmed,
		endpointSelector,
		routeKind: 'logical',
		nodeName,
		directAddress: null,
		nodeSelector: nodeName,
	};
}

function detectWatchType(eventType, fullPath, knownEntries) {
	let currentKind = null;
	try {
		const stats = fsNative.statSync(fullPath);
		currentKind = stats.isDirectory() ? 'dir' : 'file';
	} catch {
		currentKind = null;
	}

	const previousKind = knownEntries.get(fullPath) || null;

	if (currentKind) {
		knownEntries.set(fullPath, currentKind);
	} else {
		knownEntries.delete(fullPath);
	}

	if (eventType === 'change') {
		if (currentKind === 'file') {
			return 'file:changed';
		}
		return null;
	}

	if (eventType !== 'rename') {
		return null;
	}

	if (!currentKind) {
		if (previousKind === 'dir') {
			return 'dir:deleted';
		}
		return 'file:deleted';
	}

	if (previousKind === currentKind) {
		return currentKind === 'dir' ? 'dir:moved' : 'file:moved';
	}

	return currentKind === 'dir' ? 'dir:created' : 'file:created';
}

function getDelayToNextMidnightBoundary(intervalMs, nowMs = Date.now()) {
	const now = new Date(nowMs);
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);

	const elapsedSinceMidnightMs = nowMs - midnight.getTime();
	const remainder = elapsedSinceMidnightMs % intervalMs;

	if (remainder === 0) {
		return intervalMs;
	}

	return intervalMs - remainder;
}

function normalizeHostPort(value, defaultPort = DEFAULT_LOCAL_SERVER_PORT) {
	const raw = String(value || '').trim().toLowerCase();
	if (!raw) {
		return null;
	}

	if (/^https?:\/\//i.test(raw)) {
		try {
			const parsed = new URL(raw);
			const host = String(parsed.hostname || '').toLowerCase();
			const port = parsed.port ? Number(parsed.port) : defaultPort;
			if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
				return null;
			}
			return `${host}:${port}`;
		} catch {
			return null;
		}
	}

	const hostPortMatch = raw.match(/^([^:]+):(\d{1,5})$/);
	if (hostPortMatch) {
		const host = hostPortMatch[1].trim();
		const port = Number(hostPortMatch[2]);
		if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
			return null;
		}
		return `${host}:${port}`;
	}

	if (raw.includes(':')) {
		return null;
	}

	return `${raw}:${defaultPort}`;
}

function extractRemoteHost(remoteAddress) {
	const raw = String(remoteAddress || '').trim();
	if (!raw) {
		return null;
	}

	if (raw.startsWith('::ffff:')) {
		return raw.slice('::ffff:'.length).toLowerCase();
	}

	if (raw === '::1') {
		return '127.0.0.1';
	}

	return raw.toLowerCase();
}

function pickPrimaryLocalHost() {
	const interfaces = os.networkInterfaces();
	for (const group of Object.values(interfaces)) {
		for (const candidate of group || []) {
			if (!candidate || candidate.internal) {
				continue;
			}
			if (candidate.family === 'IPv4' && candidate.address) {
				return String(candidate.address).toLowerCase();
			}
		}
	}
	return '127.0.0.1';
}

function parseBooleanOption(rawValue, fallback = false) {
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return Boolean(fallback);
	}

	if (typeof rawValue === 'boolean') {
		return rawValue;
	}

	const normalized = String(rawValue).trim().toLowerCase();
	if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
		return true;
	}
	if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
		return false;
	}

	return Boolean(fallback);
}

function parseNonNegativeIntegerOption(rawValue, fallback = 0) {
	const numeric = Number(rawValue);
	if (!Number.isFinite(numeric) || numeric < 0) {
		return Math.max(0, Math.floor(Number(fallback) || 0));
	}

	return Math.floor(numeric);
}

function normalizeRelayEndpointConfig(rawValue, fallback = { host: '', port: 3478, tls: false, username: '', password: '' }) {
	const value = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
	const fallbackValue = fallback && typeof fallback === 'object' ? fallback : { host: '', port: 3478, tls: false, username: '', password: '' };
	const host = normalizeRelayHost(value.host ?? value.server ?? fallbackValue.host ?? '');
	const rawPort = value.port ?? fallbackValue.port;
	const port = Number(rawPort) > 0 ? Number(rawPort) : 3478;
	const tls = parseBooleanOption(value.tls, fallbackValue.tls);
	const username = String(value.username ?? value.user ?? fallbackValue.username ?? '').trim();
	const password = String(value.password ?? fallbackValue.password ?? '').trim();

	return {
		host,
		port,
		tls,
		username,
		password,
	};
}

function normalizeRelayHost(rawHost) {
	let value = String(rawHost || '').trim();
	if (!value) {
		return '';
	}

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		try {
			const parsed = new URL(value);
			return String(parsed.hostname || '').trim();
		} catch {
			// Fallback below.
		}
	}

	value = value.replace(/^(stun|stuns|turn|turns):/i, '');
	value = value.replace(/^\/\//, '');
	if (value.includes('/')) {
		value = value.split('/')[0];
	}

	if (value.startsWith('[') && value.includes(']')) {
		return value.slice(1, value.indexOf(']')).trim();
	}

	const colonCount = (value.match(/:/g) || []).length;
	if (colonCount === 1) {
		const [candidateHost, candidatePort] = value.split(':');
		if (/^\d+$/.test(String(candidatePort || '').trim())) {
			return String(candidateHost || '').trim();
		}
	}

	return value.trim();
}

async function resolveRelayHostAddresses(host) {
	const safeHost = normalizeRelayHost(host);
	if (!safeHost) {
		return [];
	}

	if (net.isIP(safeHost)) {
		return [{ address: safeHost, family: net.isIP(safeHost) }];
	}

	try {
		const lookupResults = await dns.promises.lookup(safeHost, { all: true, verbatim: false });
		if (Array.isArray(lookupResults) && lookupResults.length > 0) {
			return lookupResults;
		}
	} catch {
		// Resolve fallback below.
	}

	const resolved = [];
	try {
		const ipv4 = await dns.promises.resolve4(safeHost);
		for (const address of ipv4) {
			resolved.push({ address, family: 4 });
		}
	} catch {
		// ignore
	}

	try {
		const ipv6 = await dns.promises.resolve6(safeHost);
		for (const address of ipv6) {
			resolved.push({ address, family: 6 });
		}
	} catch {
		// ignore
	}

	return resolved;
}

function createStunHeader(messageType, bodyLength, transactionId) {
	const header = Buffer.alloc(STUN_HEADER_LENGTH);
	header.writeUInt16BE(Number(messageType) & 0xffff, 0);
	header.writeUInt16BE(Number(bodyLength) & 0xffff, 2);
	header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
	transactionId.copy(header, 8, 0, 12);
	return header;
}

function encodeStunAttribute(type, value) {
	const rawValue = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
	const padding = (4 - (rawValue.length % 4)) % 4;
	const attribute = Buffer.alloc(4 + rawValue.length + padding);
	attribute.writeUInt16BE(Number(type) & 0xffff, 0);
	attribute.writeUInt16BE(rawValue.length, 2);
	rawValue.copy(attribute, 4);
	return attribute;
}

function parseStunMessage(message) {
	if (!Buffer.isBuffer(message) || message.length < STUN_HEADER_LENGTH) {
		return null;
	}

	const bodyLength = message.readUInt16BE(2);
	const totalLength = STUN_HEADER_LENGTH + bodyLength;
	if (message.length < totalLength) {
		return null;
	}
	if (message.readUInt32BE(4) !== STUN_MAGIC_COOKIE) {
		return null;
	}

	const attributes = [];
	let offset = STUN_HEADER_LENGTH;
	while (offset + 4 <= totalLength) {
		const type = message.readUInt16BE(offset);
		const length = message.readUInt16BE(offset + 2);
		const valueStart = offset + 4;
		const valueEnd = valueStart + length;
		if (valueEnd > totalLength) {
			return null;
		}
		attributes.push({
			type,
			length,
			value: message.subarray(valueStart, valueEnd),
		});
		offset = valueEnd + ((4 - (length % 4)) % 4);
	}

	return {
		type: message.readUInt16BE(0),
		transactionId: message.subarray(8, 20),
		attributes,
		raw: message.subarray(0, totalLength),
	};
}

function getFirstStunAttribute(message, attributeType) {
	if (!message || !Array.isArray(message.attributes)) {
		return null;
	}

	return message.attributes.find((attribute) => Number(attribute?.type) === Number(attributeType)) || null;
}

function getStunTextAttribute(message, attributeType) {
	const attribute = getFirstStunAttribute(message, attributeType);
	if (!attribute || !Buffer.isBuffer(attribute.value)) {
		return '';
	}

	return attribute.value.toString('utf8').trim();
}

function getStunErrorDetails(message) {
	const attribute = getFirstStunAttribute(message, STUN_ATTR_ERROR_CODE);
	if (!attribute || !Buffer.isBuffer(attribute.value) || attribute.value.length < 4) {
		return null;
	}

	const errorClass = Number(attribute.value[2] || 0) & 0x07;
	const errorNumber = Number(attribute.value[3] || 0);
	const code = errorClass * 100 + errorNumber;
	const reason = attribute.value.subarray(4).toString('utf8').trim();
	return {
		code,
		reason,
	};
}

function buildTurnAllocateRequest({ username = '', realm = '', nonce = '', password = '' } = {}) {
	const transactionId = crypto.randomBytes(12);
	const requestedTransport = encodeStunAttribute(TURN_ATTR_REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]));

	if (!username || !realm || !nonce || !password) {
		const body = requestedTransport;
		return {
			transactionId,
			message: Buffer.concat([createStunHeader(TURN_ALLOCATE_REQUEST, body.length, transactionId), body]),
		};
	}

	const authAttributes = Buffer.concat([
		requestedTransport,
		encodeStunAttribute(STUN_ATTR_USERNAME, Buffer.from(String(username), 'utf8')),
		encodeStunAttribute(STUN_ATTR_REALM, Buffer.from(String(realm), 'utf8')),
		encodeStunAttribute(STUN_ATTR_NONCE, Buffer.from(String(nonce), 'utf8')),
	]);
	const bodyLengthWithIntegrity = authAttributes.length + 24;
	const headerForIntegrity = createStunHeader(TURN_ALLOCATE_REQUEST, bodyLengthWithIntegrity, transactionId);
	const integrityKey = crypto.createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
	const integrityValue = crypto.createHmac('sha1', integrityKey).update(Buffer.concat([headerForIntegrity, authAttributes])).digest();
	const messageIntegrity = encodeStunAttribute(STUN_ATTR_MESSAGE_INTEGRITY, integrityValue);
	const body = Buffer.concat([authAttributes, messageIntegrity]);

	return {
		transactionId,
		message: Buffer.concat([createStunHeader(TURN_ALLOCATE_REQUEST, body.length, transactionId), body]),
	};
}

function describeTurnResponseFailure(message, fallback = 'TURN request failed') {
	const error = getStunErrorDetails(message);
	if (!error) {
		return fallback;
	}

	return error.reason ? `${error.code} ${error.reason}` : `TURN error ${error.code}`;
}

function buildTurnTestFailure(error, errorType = 'connection', extra = {}) {
	return {
		ok: false,
		error: String(error || 'TURN test failed'),
		errorType,
		...extra,
	};
}

function extractTurnAuthChallenge(message) {
	const error = getStunErrorDetails(message);
	if (!error) {
		return buildTurnTestFailure('TURN server returned an invalid auth challenge', 'protocol');
	}
	if (![401, 438].includes(error.code)) {
		return buildTurnTestFailure(describeTurnResponseFailure(message, 'TURN allocate failed'), 'connection');
	}

	const realm = getStunTextAttribute(message, STUN_ATTR_REALM);
	const nonce = getStunTextAttribute(message, STUN_ATTR_NONCE);
	if (!realm || !nonce) {
		return buildTurnTestFailure('TURN auth challenge missing realm or nonce', 'protocol');
	}

	return {
		ok: true,
		realm,
		nonce,
		errorCode: error.code,
	};
}

function normalizeTurnCredentials(username, password) {
	return {
		username: String(username || '').trim(),
		password: String(password || '').trim(),
	};
}

function sendTurnAllocateRequestUdp(address, family, port, request, timeoutMs = 5000) {
	return new Promise((resolve) => {
		const safeAddress = String(address || '').trim();
		const safeFamily = Number(family) === 6 ? 6 : 4;
		const safePort = Number(port);
		if (!safeAddress || !Buffer.isBuffer(request?.message) || !Buffer.isBuffer(request?.transactionId) || request.transactionId.length !== 12 || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
			resolve({ ok: false, error: 'invalid TURN UDP request parameters' });
			return;
		}

		const socket = dgram.createSocket(safeFamily === 6 ? 'udp6' : 'udp4');
		let finished = false;
		const finish = (result) => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {
				// ignore
			}
			resolve(result);
		};

		socket.once('error', (error) => {
			finish({ ok: false, error: error.message || 'udp error' });
		});

		socket.on('message', (message) => {
			const parsed = parseStunMessage(message);
			if (!parsed) {
				return;
			}
			if (!parsed.transactionId.equals(request.transactionId)) {
				return;
			}

			finish({
				ok: true,
				protocol: 'udp-auth',
				message: parsed,
			});
		});

		socket.send(request.message, safePort, safeAddress, (error) => {
			if (error) {
				finish({ ok: false, error: error.message || 'unable to send TURN allocate request' });
			}
		});

		const timer = setTimeout(() => {
			finish({ ok: false, error: 'timeout waiting TURN UDP response' });
		}, Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000);
	});
}

function sendTurnAllocateRequestTls(host, address, port, request, timeoutMs = 5000) {
	return new Promise((resolve) => {
		const safeHost = normalizeRelayHost(host);
		const safeAddress = String(address || '').trim();
		const safePort = Number(port);
		if (!safeHost || !safeAddress || !Buffer.isBuffer(request?.message) || !Buffer.isBuffer(request?.transactionId) || request.transactionId.length !== 12 || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
			resolve({ ok: false, error: 'invalid TURN TLS request parameters' });
			return;
		}

		let finished = false;
		let pending = Buffer.alloc(0);
		const socket = tls.connect({
			host: safeAddress,
			port: safePort,
			rejectUnauthorized: true,
			servername: safeHost,
		});
		const finish = (result) => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			try {
				socket.destroy();
			} catch {
				// ignore
			}
			resolve(result);
		};

		socket.once('secureConnect', () => {
			socket.write(request.message);
		});

		socket.on('data', (chunk) => {
			pending = Buffer.concat([pending, Buffer.from(chunk)]);
			while (pending.length >= STUN_HEADER_LENGTH) {
				const parsed = parseStunMessage(pending);
				if (!parsed) {
					return;
				}

				pending = pending.subarray(parsed.raw.length);
				if (!parsed.transactionId.equals(request.transactionId)) {
					continue;
				}

				finish({
					ok: true,
					protocol: 'tls-auth',
					message: parsed,
				});
				return;
			}
		});

		socket.once('error', (error) => {
			finish({ ok: false, error: formatTlsCertificateError(error?.message, 'tls connection failed') });
		});

		socket.once('end', () => {
			finish({ ok: false, error: 'TURN TLS socket closed before response' });
		});

		const timer = setTimeout(() => {
			finish({ ok: false, error: 'timeout waiting TURN TLS response' });
		}, Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000);
	});
}

function createTurnTlsRequester(host, address, port, timeoutMs = 5000) {
	const safeHost = normalizeRelayHost(host);
	const safeAddress = String(address || '').trim();
	const safePort = Number(port);
	if (!safeHost || !safeAddress || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
		return {
			async send() {
				return { ok: false, error: 'invalid TURN TLS request parameters' };
			},
			close() {
				// noop
			},
		};
	}

	const socket = tls.connect({
		host: safeAddress,
		port: safePort,
		rejectUnauthorized: true,
		servername: safeHost,
	});

	let pending = Buffer.alloc(0);
	const queue = [];
	let queueResolver = null;
	let closedError = '';

	const pushMessage = (message) => {
		if (queueResolver) {
			const resolve = queueResolver;
			queueResolver = null;
			resolve(message);
			return;
		}
		queue.push(message);
	};

	socket.on('data', (chunk) => {
		pending = Buffer.concat([pending, Buffer.from(chunk)]);
		while (pending.length >= STUN_HEADER_LENGTH) {
			const parsed = parseStunMessage(pending);
			if (!parsed) {
				return;
			}
			pending = pending.subarray(parsed.raw.length);
			pushMessage(parsed);
		}
	});

	socket.once('end', () => {
		closedError = 'TURN TLS socket closed before response';
		if (queueResolver) {
			const resolve = queueResolver;
			queueResolver = null;
			resolve(null);
		}
	});

	socket.once('error', (error) => {
		closedError = formatTlsCertificateError(error?.message, 'tls connection failed');
		if (queueResolver) {
			const resolve = queueResolver;
			queueResolver = null;
			resolve(null);
		}
	});

	const readyPromise = new Promise((resolve) => {
		socket.once('secureConnect', () => {
			resolve({ ok: true });
		});

		socket.once('error', (error) => {
			resolve({ ok: false, error: formatTlsCertificateError(error?.message, 'tls connection failed') });
		});
	});

	const waitNextMessage = (waitMs) => {
		if (queue.length > 0) {
			return Promise.resolve(queue.shift());
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (queueResolver) {
					queueResolver = null;
				}
				resolve(null);
			}, Math.max(1, Number(waitMs) || 1));

			queueResolver = (message) => {
				clearTimeout(timer);
				resolve(message);
			};
		});
	};

	return {
		async send(request) {
			if (!Buffer.isBuffer(request?.message) || !Buffer.isBuffer(request?.transactionId) || request.transactionId.length !== 12) {
				return { ok: false, error: 'invalid TURN TLS request parameters' };
			}

			const ready = await readyPromise;
			if (!ready?.ok) {
				return { ok: false, error: ready?.error || 'tls connection failed' };
			}

			if (closedError) {
				return { ok: false, error: closedError };
			}

			try {
				socket.write(request.message);
			} catch (error) {
				return { ok: false, error: error?.message || 'unable to send TURN allocate request' };
			}

			const startedAt = Date.now();
			const safeTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
			while (Date.now() - startedAt < safeTimeout) {
				const remainingMs = Math.max(1, safeTimeout - (Date.now() - startedAt));
				const message = await waitNextMessage(remainingMs);
				if (!message) {
					return { ok: false, error: closedError || 'timeout waiting TURN TLS response' };
				}

				if (!message.transactionId.equals(request.transactionId)) {
					continue;
				}

				return {
					ok: true,
					protocol: 'tls-auth',
					message,
				};
			}

			return { ok: false, error: 'timeout waiting TURN TLS response' };
		},

		close() {
			try {
				socket.destroy();
			} catch {
				// ignore
			}
		},
	};
}

async function performTurnAuthenticatedAllocate(sendRequest, credentials) {
	const initialRequest = buildTurnAllocateRequest();
	const initialResponse = await sendRequest(initialRequest);
	if (!initialResponse.ok) {
		return buildTurnTestFailure(initialResponse.error || 'TURN connection failed', 'connection');
	}
	if (initialResponse.message?.type === TURN_ALLOCATE_SUCCESS_RESPONSE) {
		return {
			ok: true,
			protocol: initialResponse.protocol,
			message: 'TURN allocation succeeded',
		};
	}

	const challenge = extractTurnAuthChallenge(initialResponse.message);
	if (!challenge.ok) {
		return challenge;
	}

	if (!credentials.username || !credentials.password) {
		return buildTurnTestFailure('TURN credentials are required for authenticated test', 'authentication');
	}

	for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
		const authenticatedRequest = buildTurnAllocateRequest({
			username: credentials.username,
			realm: challenge.realm,
			nonce: challenge.nonce,
			password: credentials.password,
		});
		const authenticatedResponse = await sendRequest(authenticatedRequest);
		if (!authenticatedResponse.ok) {
			return buildTurnTestFailure(authenticatedResponse.error || 'TURN connection failed', 'connection');
		}
		if (authenticatedResponse.message?.type === TURN_ALLOCATE_SUCCESS_RESPONSE) {
			return {
				ok: true,
				protocol: authenticatedResponse.protocol,
				message: 'TURN allocation authenticated',
			};
		}

		const error = getStunErrorDetails(authenticatedResponse.message);
		if (error?.code === 438) {
			const refreshedChallenge = extractTurnAuthChallenge(authenticatedResponse.message);
			if (!refreshedChallenge.ok) {
				return refreshedChallenge;
			}
			challenge.realm = refreshedChallenge.realm;
			challenge.nonce = refreshedChallenge.nonce;
			continue;
		}

		return buildTurnTestFailure(describeTurnResponseFailure(authenticatedResponse.message, 'TURN authentication failed'), 'authentication');
	}

	return buildTurnTestFailure('TURN authentication failed: stale nonce retry limit reached', 'authentication');
}

async function testTurnRelayAuthentication(host, port, useTls, username, password, timeoutMs = 5000) {
	const safeHost = normalizeRelayHost(host);
	const safePort = Number(port);
	if (!safeHost || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
		return buildTurnTestFailure('invalid host or port', 'configuration');
	}

	const addresses = await resolveRelayHostAddresses(safeHost);
	if (!addresses.length) {
		return buildTurnTestFailure(`unable to resolve host '${safeHost}'`, 'connection');
	}

	const credentials = normalizeTurnCredentials(username, password);
	const candidates = useTls ? [...addresses] : [...addresses].sort((a, b) => Number(a.family || 4) - Number(b.family || 4));
	const errors = [];
	for (const candidate of candidates) {
		let attempt;
		if (useTls) {
			const requester = createTurnTlsRequester(safeHost, candidate.address, safePort, timeoutMs);
			attempt = await performTurnAuthenticatedAllocate((request) => requester.send(request), credentials);
			requester.close();
		} else {
			const sendRequest = (request) => sendTurnAllocateRequestUdp(candidate.address, candidate.family, safePort, request, timeoutMs);
			attempt = await performTurnAuthenticatedAllocate(sendRequest, credentials);
		}
		if (attempt.ok) {
			return {
				...attempt,
				host: safeHost,
				resolvedAddress: candidate.address,
				family: candidate.family,
			};
		}
		errors.push({
			message: `${candidate.address}: ${attempt.error || 'failed'}`,
			errorType: String(attempt.errorType || '').trim().toLowerCase() || 'connection',
		});
	}

	const primaryError = errors[0] || { message: 'unable to authenticate TURN relay', errorType: 'connection' };
	return {
		...buildTurnTestFailure(primaryError.message || 'unable to authenticate TURN relay', primaryError.errorType || 'connection'),
		host: safeHost,
	};
}

function testUdpStunBindingWithAddress(address, family, port, timeoutMs = 5000) {
	return new Promise((resolve) => {
		const safeAddress = String(address || '').trim();
		const safeFamily = Number(family) === 6 ? 6 : 4;
		const safePort = Number(port);
		if (!safeAddress || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
			resolve({ ok: false, error: 'invalid address or port' });
			return;
		}

		const socket = dgram.createSocket(safeFamily === 6 ? 'udp6' : 'udp4');
		const transactionId = crypto.randomBytes(12);
		const request = Buffer.alloc(20);
		request.writeUInt16BE(0x0001, 0);
		request.writeUInt16BE(0x0000, 2);
		request.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
		transactionId.copy(request, 8);

		let finished = false;
		const finish = (result) => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {
				// ignore
			}
			resolve(result);
		};

		socket.once('error', (error) => {
			finish({ ok: false, error: error.message || 'udp error' });
		});

		socket.on('message', (message) => {
			if (!Buffer.isBuffer(message) || message.length < 20) {
				return;
			}

			const cookie = message.readUInt32BE(4);
			const responseTxId = message.subarray(8, 20);
			if (cookie !== STUN_MAGIC_COOKIE) {
				return;
			}
			if (!responseTxId.equals(transactionId)) {
				return;
			}

			finish({ ok: true, protocol: 'udp', message: 'STUN response received' });
		});

		socket.send(request, safePort, safeAddress, (error) => {
			if (error) {
				finish({ ok: false, error: error.message || 'unable to send STUN request' });
			}
		});

		const timer = setTimeout(() => {
			finish({ ok: false, error: 'timeout waiting STUN response' });
		}, Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000);
	});
}

async function testUdpStunBinding(host, port, timeoutMs = 5000) {
	const safeHost = normalizeRelayHost(host);
	const safePort = Number(port);
	if (!safeHost || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
		return { ok: false, error: 'invalid host or port' };
	}

	const addresses = await resolveRelayHostAddresses(safeHost);
	if (!addresses.length) {
		return { ok: false, error: `unable to resolve host '${safeHost}'` };
	}

	const sorted = [...addresses].sort((a, b) => Number(a.family || 4) - Number(b.family || 4));
	const errors = [];
	for (const candidate of sorted) {
		const attempt = await testUdpStunBindingWithAddress(candidate.address, candidate.family, safePort, timeoutMs);
		if (attempt.ok) {
			return {
				...attempt,
				host: safeHost,
				resolvedAddress: candidate.address,
				family: candidate.family,
			};
		}
		errors.push(`${candidate.address}: ${attempt.error || 'failed'}`);
	}

	return {
		ok: false,
		error: errors[0] || 'unable to reach STUN endpoint',
		host: safeHost,
	};
}

function testTlsRelayWithAddress(host, address, port, timeoutMs = 5000) {
	return new Promise((resolve) => {
		const safeHost = normalizeRelayHost(host);
		const safeAddress = String(address || '').trim();
		const safePort = Number(port);
		if (!safeHost || !safeAddress || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
			resolve({ ok: false, error: 'invalid host or port' });
			return;
		}

		let finished = false;
		const socket = tls.connect({
			host: safeAddress,
			port: safePort,
			rejectUnauthorized: true,
			servername: safeHost,
		});

		const finish = (result) => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			try {
				socket.destroy();
			} catch {
				// ignore
			}
			resolve(result);
		};

		socket.once('secureConnect', () => {
			finish({ ok: true, protocol: 'tls', message: 'TLS handshake completed' });
		});

		socket.once('error', (error) => {
			finish({ ok: false, error: formatTlsCertificateError(error?.message, 'tls connection failed') });
		});

		const timer = setTimeout(() => {
			finish({ ok: false, error: 'timeout during TLS handshake' });
		}, Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000);
	});
}

async function testTlsRelay(host, port, timeoutMs = 5000) {
	const safeHost = normalizeRelayHost(host);
	const safePort = Number(port);
	if (!safeHost || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
		return { ok: false, error: 'invalid host or port' };
	}

	const addresses = await resolveRelayHostAddresses(safeHost);
	if (!addresses.length) {
		return { ok: false, error: `unable to resolve host '${safeHost}'` };
	}

	const errors = [];
	for (const candidate of addresses) {
		const attempt = await testTlsRelayWithAddress(safeHost, candidate.address, safePort, timeoutMs);
		if (attempt.ok) {
			return {
				...attempt,
				host: safeHost,
				resolvedAddress: candidate.address,
				family: candidate.family,
			};
		}
		errors.push(`${candidate.address}: ${attempt.error || 'failed'}`);
	}

	return {
		ok: false,
		error: errors[0] || 'unable to complete TLS handshake',
		host: safeHost,
	};
}

class IncomingStreamPacket {
	constructor(payload = {}) {
		this.payload = payload && typeof payload === 'object' ? payload : {};
	}

	getId() {
		return String(this.payload.streamId || '');
	}

	getPhase() {
		return String(this.payload.phase || '').toLowerCase();
	}

	isStart() {
		return this.getPhase() === 'start';
	}

	isChunk() {
		return this.getPhase() === 'chunk';
	}

	isEnd() {
		return this.getPhase() === 'end';
	}

	getMetadata() {
		const value = this.payload.metadata;
		return value && typeof value === 'object' ? value : {};
	}

	getContentType() {
		return String(this.payload.contentType || 'application/octet-stream');
	}

	getChunkIndex() {
		return Number.isFinite(Number(this.payload.index)) ? Number(this.payload.index) : -1;
	}

	getChunkSize() {
		return Number.isFinite(Number(this.payload.size)) ? Number(this.payload.size) : 0;
	}

	getBase64() {
		return String(this.payload.data || '');
	}

	readChunkBuffer() {
		if (!this.isChunk()) {
			return Buffer.alloc(0);
		}

		if (Buffer.isBuffer(this.payload.binary)) {
			return this.payload.binary;
		}

		if (this.payload.binary instanceof Uint8Array) {
			return Buffer.from(this.payload.binary);
		}

		return Buffer.from(this.getBase64(), 'base64');
	}

	readChunkText(encoding = 'utf8') {
		return this.readChunkBuffer().toString(encoding);
	}
}

class IncomingStreamEndInfo {
	constructor(payload = {}) {
		this.payload = payload && typeof payload === 'object' ? payload : {};
	}

	getId() {
		return String(this.payload.streamId || '');
	}

	getSender() {
		return String(this.payload.sender || '');
	}

	getPath() {
		return String(this.payload.path || '');
	}

	getBytes() {
		return Number.isFinite(Number(this.payload.totalBytes)) ? Number(this.payload.totalBytes) : 0;
	}

	getChunks() {
		return Number.isFinite(Number(this.payload.chunks)) ? Number(this.payload.chunks) : 0;
	}

	getDigestSha256() {
		return String(this.payload.digestSha256 || '');
	}

	isValid() {
		return Boolean(this.payload.valid !== false);
	}

	getError() {
		return String(this.payload.error || '');
	}

	getMetadata() {
		const value = this.payload.metadata;
		return value && typeof value === 'object' ? value : {};
	}
}

function splitBufferIntoChunks(buffer, chunkSize) {
	const safeChunkSize = Math.max(1024, Number(chunkSize) || 64 * 1024);
	const out = [];
	for (let offset = 0; offset < buffer.length; offset += safeChunkSize) {
		out.push(buffer.subarray(offset, Math.min(offset + safeChunkSize, buffer.length)));
	}
	return out;
}

function toBufferChunk(value) {
	if (Buffer.isBuffer(value)) {
		return value;
	}

	if (value instanceof Uint8Array) {
		return Buffer.from(value);
	}

	if (value instanceof ArrayBuffer) {
		return Buffer.from(new Uint8Array(value));
	}

	if (typeof value === 'string') {
		return Buffer.from(value, 'utf8');
	}

	if (value && typeof value === 'object' && value.buffer instanceof ArrayBuffer && Number.isFinite(value.byteLength)) {
		return Buffer.from(new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength));
	}

	throw new Error('stream chunk type not supported. expected Buffer, Uint8Array, ArrayBuffer or string');
}

async function* iterateStreamSourceChunks(source, chunkSize) {
	if (source === null || source === undefined) {
		throw new Error('invalid stream source');
	}

	const emitBuffer = async function* emitBufferChunks(raw) {
		const buffer = toBufferChunk(raw);
		if (buffer.length === 0) {
			return;
		}
		for (const chunk of splitBufferIntoChunks(buffer, chunkSize)) {
			yield chunk;
		}
	};

	if (
		Buffer.isBuffer(source)
		|| source instanceof Uint8Array
		|| source instanceof ArrayBuffer
		|| typeof source === 'string'
	) {
		yield* emitBuffer(source);
		return;
	}

	if (typeof source.getReader === 'function') {
		const reader = source.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				yield* emitBuffer(value);
			}
		} finally {
			if (typeof reader.releaseLock === 'function') {
				reader.releaseLock();
			}
		}
		return;
	}

	if (typeof source[Symbol.asyncIterator] === 'function') {
		for await (const value of source) {
			yield* emitBuffer(value);
		}
		return;
	}

	if (typeof source[Symbol.iterator] === 'function') {
		for (const value of source) {
			yield* emitBuffer(value);
		}
		return;
	}

	throw new Error('stream source not iterable/readable');
}

class ReactorRuntime {
	constructor(endpointsDir, eventLogPath, options = {}) {
		this.endpoints = [];
		this.scheduledTasks = [];
		this.eventMap = new Map();
		this.endpointsDir = endpointsDir;
		this.eventLogPath = eventLogPath;
		this.platformServices = options.platformServices || createNodePlatformServices();
		this.runtimeApi = options.runtimeApi || createNodeRuntimeApi();
		this.networkMonitor = null;
		this.endpointsWatcher = null;
		this.reloadDebounceTimer = null;
		this.isReloading = false;
		this.pendingReloadReason = null;
		this.runtimeStartedAt = new Date().toISOString();
		this.watchers = [];
		this.messageListenerMap = new Map();
		this.streamListenerMap = new Map();
		this.streamEndListenerMap = new Map();
		this.activeIncomingStreams = new Map();
		this.uiStatusSink = null;
		this.reactorRootDir = options.reactorRootDir || path.dirname(this.endpointsDir);
		this.streamStorageDir = path.join(this.reactorRootDir, 'temp_files', 'streams');
		this.streamMaxActive = this.readQueueDuration('REACTOR_STREAM_MAX_ACTIVE', DEFAULT_STREAM_MAX_ACTIVE, 1);
		this.streamIdleTimeoutMs = this.readQueueDuration('REACTOR_STREAM_IDLE_TIMEOUT_MS', DEFAULT_STREAM_IDLE_TIMEOUT_MS, 30 * 1000);
		this.streamCleanupIntervalMs = this.readQueueDuration('REACTOR_STREAM_CLEANUP_INTERVAL_MS', DEFAULT_STREAM_CLEANUP_INTERVAL_MS, 5 * 1000);
		this.streamCleanupTimer = null;
		this.httpServer = null;
		this.httpServerPort = Number(options.httpServerPort || process.env.REACTOR_HTTP_PORT || DEFAULT_LOCAL_SERVER_PORT);
		this.httpServerLogs = [];
		this.reactorNamePath = path.join(this.reactorRootDir, 'name');
		this.cachedReactorName = null;
		this.exchangeManager = new ExchangeManager(this);
		const envWorkingMode = process.env.REACTOR_WORKING_MODE || '';
		const requestedWorkingMode = String(options.exchangeMode || envWorkingMode || 'node').trim().toLowerCase();
		this.exchangeMode = requestedWorkingMode === 'exchange' ? 'exchange' : 'node';
		this.exchangeHost = String(options.exchangeHost || process.env.HOST || '');
		this.exchangePort = Number(options.exchangePort || process.env.PORT || 7070);
		this.exchangeTls = Boolean(options.exchangeTls || process.env.TLS === '1' || process.env.TLS === 'true');
		this.exchangeAuthToken = String(options.exchangeToken || process.env.TOKEN || '');
		this.exchangeAuthUser = String(options.exchangeUser || process.env.REACTOR_EXCHANGE_USER || '');
		this.exchangeAuthPassword = String(options.exchangePassword || process.env.REACTOR_EXCHANGE_PASSWORD || '');
		this.stun = normalizeRelayEndpointConfig(options.stun, {
			host: String(options.stunHost || process.env.REACTOR_STUN_HOST || ''),
			port: Number(options.stunPort || process.env.REACTOR_STUN_PORT || 3478) > 0 ? Number(options.stunPort || process.env.REACTOR_STUN_PORT || 3478) : 3478,
			tls: parseBooleanOption(options.stunTls ?? process.env.REACTOR_STUN_TLS, false),
		});
		this.turn = normalizeRelayEndpointConfig(options.turn, {
			host: String(options.turnHost || process.env.REACTOR_TURN_HOST || ''),
			port: Number(options.turnPort || process.env.REACTOR_TURN_PORT || 3478) > 0 ? Number(options.turnPort || process.env.REACTOR_TURN_PORT || 3478) : 3478,
			tls: parseBooleanOption(options.turnTls ?? process.env.REACTOR_TURN_TLS, false),
		});
		this.exchangeDiscoveryEndpointEnabled = parseBooleanOption(
			options.discovery
			?? options.exchangeDiscovery
			?? options.discoveryEnabled
			?? options.exchangeDiscoveryEndpoint,
			parseBooleanOption(process.env.REACTOR_EXCHANGE_DISCOVERY_ENDPOINT, false),
		);
		this.exchangeDiscoveryEndpointPath = '/nodes';
		this.p2pSessions = new Map();
		this.p2pSessionTimeoutMs = this.readQueueDuration('REACTOR_P2P_SESSION_TIMEOUT_MS', 2 * 60 * 1000, 10 * 1000);
		this.p2pTransportManager = new P2PDataChannelManager(this);
		this.p2pAutodialAttempts = new Map();
		this.p2pAutodialCooldownMs = this.readQueueDuration('REACTOR_P2P_AUTODIAL_COOLDOWN_MS', 30 * 1000, 5 * 1000);
		this.p2pRemoteEndpointRequests = new Map();
		this.connectionsConfigPath = path.join(this.reactorRootDir, 'connections.json');
		this.tlsManager = new TlsManager(path.join(this.reactorRootDir, 'tls'));
		this.tlsEnabled = false; // impostato da startHttpServer
		this.messageQueueDir = path.join(this.reactorRootDir, 'message-queue');
		this.messageQueueLegacyPath = path.join(this.reactorRootDir, 'outgoing-message-queue.json');
		this.streamQueueDir = path.join(this.reactorRootDir, 'stream-queue');
		this.messageQueueConfigPath = path.join(this.reactorRootDir, 'message-queue-config.json');
		this.envDirPath = path.join(this.reactorRootDir, 'envs');
		this.envMap = Object.freeze({});
		this.messageQueueTtlMs = this.readQueueDuration('REACTOR_MESSAGE_QUEUE_TTL_MS', DEFAULT_MESSAGE_QUEUE_TTL_MS, 60 * 1000);
		this.messageQueueRetryMs = this.readQueueDuration('REACTOR_MESSAGE_QUEUE_RETRY_MS', DEFAULT_MESSAGE_QUEUE_RETRY_MS, 5 * 1000);
		this.watchCreatedPollMs = this.readQueueDuration('REACTOR_WATCH_CREATED_POLL_MS', DEFAULT_WATCH_CREATED_POLL_MS, 250);
		this.watchCreatedQuietMs = this.readQueueDuration('REACTOR_WATCH_CREATED_QUIET_MS', DEFAULT_WATCH_CREATED_QUIET_MS, 2000);
		this.watchCreatedLargeQuietMs = this.readQueueDuration('REACTOR_WATCH_CREATED_LARGE_QUIET_MS', DEFAULT_WATCH_CREATED_LARGE_QUIET_MS, this.watchCreatedQuietMs);
		this.watchCreatedTimeoutMs = this.readQueueDuration('REACTOR_WATCH_CREATED_TIMEOUT_MS', DEFAULT_WATCH_CREATED_TIMEOUT_MS, this.watchCreatedQuietMs);
		this.watchCreatedLargeFileBytes = Math.max(1, Number(process.env.REACTOR_WATCH_CREATED_LARGE_FILE_BYTES) || DEFAULT_WATCH_CREATED_LARGE_FILE_BYTES);
		this.messageQueueFlushTimer = null;
		this.streamQueueFlushTimer = null;
		this.isFlushingMessageQueue = false;
		this.isFlushingStreamQueue = false;
		this.exchangeStreamStartQueueTail = Promise.resolve();
		this.pendingExchangeStreamStarts = 0;
	}

	setUiStatusSink(handler) {
		this.uiStatusSink = typeof handler === 'function' ? handler : null;
	}

	publishUiStatusSnapshot(reason = '') {
		if (!this.uiStatusSink) {
			return;
		}

		try {
			this.uiStatusSink({
				reason: String(reason || ''),
				exchangeConfig: this.getExchangeConfig(),
			});
		} catch (error) {
			this.log(`[UI] status publish failed: ${error.message}`);
		}
	}

	readQueueDuration(envName, fallback, minMs) {
		const raw = Number(process.env[envName]);
		if (!Number.isFinite(raw) || raw <= 0) {
			return fallback;
		}

		return Math.max(minMs, Math.floor(raw));
	}

	serializeQueuedContent(content) {
		if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
			return { payloadType: 'base64', payload: Buffer.from(content).toString('base64') };
		}

		if (typeof content === 'string') {
			return { payloadType: 'string', payload: content };
		}

		if (content === null || content === undefined) {
			return { payloadType: 'null', payload: '' };
		}

		return { payloadType: 'json', payload: JSON.stringify(content) };
	}

	deserializeQueuedContent(payloadType, payload) {
		if (payloadType === 'base64') {
			return Buffer.from(String(payload || ''), 'base64');
		}
		if (payloadType === 'string') {
			return String(payload || '');
		}
		if (payloadType === 'null') {
			return '';
		}
		if (payloadType === 'json') {
			try {
				return JSON.parse(String(payload || 'null'));
			} catch {
				return String(payload || '');
			}
		}
		return String(payload || '');
	}

	async readMessageQueue() {
		return this.readQueueEntriesFromDir(this.messageQueueDir);
	}

	async readQueueEntriesFromDir(queueDir) {
		try {
			await fs.mkdir(queueDir, { recursive: true });
			const entries = await fs.readdir(queueDir, { withFileTypes: true });
			const queue = [];

			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith('.json')) {
					continue;
				}

				const filePath = path.join(queueDir, entry.name);
				try {
					const raw = await fs.readFile(filePath, 'utf8');
					const parsed = JSON.parse(raw);
					if (parsed && typeof parsed === 'object') {
						queue.push(parsed);
					}
				} catch {
					// Skip malformed queue entries.
				}
			}

			queue.sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));
			return queue;
		} catch {
			return [];
		}
	}

	getQueueEntryJsonPath(queueDir, id) {
		return path.join(queueDir, `${String(id || '').trim() || crypto.randomUUID()}.json`);
	}

	async replaceQueueEntriesInDir(queueDir, queue) {
		await fs.mkdir(queueDir, { recursive: true });
		const entries = await fs.readdir(queueDir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.json')) {
				await fs.unlink(path.join(queueDir, entry.name)).catch(() => {});
			}
		}

		for (const rawItem of Array.isArray(queue) ? queue : []) {
			if (!rawItem || typeof rawItem !== 'object') {
				continue;
			}

			const item = {
				...rawItem,
				id: String(rawItem.id || crypto.randomUUID()),
			};
			await fs.writeFile(
				this.getQueueEntryJsonPath(queueDir, item.id),
				`${JSON.stringify(item, null, 2)}\n`,
				'utf8',
			);
		}
	}

	async migrateLegacyMessageQueueFileIfNeeded() {
		let legacyQueue = [];
		try {
			const raw = await fs.readFile(this.messageQueueLegacyPath, 'utf8');
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				legacyQueue = parsed;
			}
		} catch {
			return;
		}

		if (legacyQueue.length > 0) {
			const currentQueue = await this.readMessageQueue();
			const mergedQueue = [...currentQueue, ...legacyQueue];
			await this.writeMessageQueue(mergedQueue);
			this.log(`[Queue] Migrated ${legacyQueue.length} legacy message(s) to message-queue directory`);
		}

		await fs.unlink(this.messageQueueLegacyPath).catch(() => {});
	}

	async loadMessageQueueConfig() {
		try {
			const raw = await fs.readFile(this.messageQueueConfigPath, 'utf8');
			const parsed = JSON.parse(raw);
			const ttlMs = Number(parsed?.ttlMs);
			const retryMs = Number(parsed?.retryMs);
			if (Number.isFinite(ttlMs) && ttlMs >= 60 * 1000) {
				this.messageQueueTtlMs = Math.floor(ttlMs);
			}
			if (Number.isFinite(retryMs) && retryMs >= 5 * 1000) {
				this.messageQueueRetryMs = Math.floor(retryMs);
			}
		} catch {
			// keep defaults when config is missing/invalid
		}
	}

	async persistMessageQueueConfig() {
		await fs.mkdir(path.dirname(this.messageQueueConfigPath), { recursive: true });
		await fs.writeFile(
			this.messageQueueConfigPath,
			`${JSON.stringify({ ttlMs: this.messageQueueTtlMs, retryMs: this.messageQueueRetryMs }, null, 2)}\n`,
			'utf8',
		);
	}

	async getMessageQueueStatus() {
		const queue = await this.readMessageQueue();
		const now = Date.now();
		const pendingItems = queue.filter((item) => item && Number(item.expiresAt || 0) > now);
		const exchangePending = pendingItems.filter((item) => item.channel === 'exchange').length;
		const directPending = pendingItems.filter((item) => item.channel !== 'exchange').length;
		const streamQueue = await this.readStreamQueue();
		const streamPending = streamQueue.filter((item) => item && Number(item.expiresAt || 0) > now).length;
		return {
			pending: pendingItems.length,
			directPending,
			exchangePending,
			streamPending,
			ttlMs: this.messageQueueTtlMs,
			ttlDays: Number((this.messageQueueTtlMs / (24 * 60 * 60 * 1000)).toFixed(2)),
			retryMs: this.messageQueueRetryMs,
			path: this.messageQueueDir,
			streamPath: this.streamQueueDir,
		};
	}

	async setMessageQueueTtlDays(ttlDays) {
		const safeDays = Number(ttlDays);
		if (!Number.isFinite(safeDays) || safeDays <= 0) {
			throw new Error('invalid queue ttl days');
		}

		this.messageQueueTtlMs = Math.max(60 * 1000, Math.floor(safeDays * 24 * 60 * 60 * 1000));
		await this.persistMessageQueueConfig();
		return this.getMessageQueueStatus();
	}

	async clearMessageQueue() {
		await this.writeMessageQueue([]);
		await this.clearStreamQueue();
		return this.getMessageQueueStatus();
	}

	async writeMessageQueue(queue) {
		await this.replaceQueueEntriesInDir(this.messageQueueDir, queue);
	}

	async enqueueMessageForRetry(entry) {
		const now = Date.now();
		const queue = await this.readMessageQueue();
		const expiresAt = now + this.messageQueueTtlMs;
		queue.push({
			id: crypto.randomUUID(),
			createdAt: now,
			expiresAt,
			nextAttemptAt: now + this.messageQueueRetryMs,
			attempts: 0,
			...entry,
		});

		await this.writeMessageQueue(queue);
		this.log(`[Queue] Message enqueued (${entry.channel}) target=${entry.target} ttlMs=${this.messageQueueTtlMs}`);
		return { queued: true, expiresAt };
	}

	async flushMessageQueue() {
		if (this.isFlushingMessageQueue) {
			return;
		}

		this.isFlushingMessageQueue = true;
		try {
			const now = Date.now();
			const queue = await this.readMessageQueue();
			if (queue.length === 0) {
				return;
			}

			const nextQueue = [];
			let delivered = 0;
			let dropped = 0;

			for (const item of queue) {
				if (!item || typeof item !== 'object') {
					continue;
				}

				if (Number(item.expiresAt || 0) <= now) {
					dropped += 1;
					continue;
				}

				if (Number(item.nextAttemptAt || 0) > now) {
					nextQueue.push(item);
					continue;
				}

				const payload = this.deserializeQueuedContent(item.payloadType, item.payload);
				try {
					if (item.channel === 'exchange') {
						await this.sendExchangeMessage(item.target, payload, { noEnqueue: true });
					} else {
						await this.sendNodeMessage(item.target, payload, item.headers || {}, { noEnqueue: true });
					}
					delivered += 1;
				} catch {
					const attempts = Number(item.attempts || 0) + 1;
					const backoff = Math.min(this.messageQueueRetryMs * Math.max(1, attempts), 30 * 60 * 1000);
					nextQueue.push({
						...item,
						attempts,
						nextAttemptAt: now + backoff,
					});
				}
			}

			await this.writeMessageQueue(nextQueue);
			if (delivered > 0 || dropped > 0) {
				this.log(`[Queue] Flush completed delivered=${delivered} dropped=${dropped} pending=${nextQueue.length}`);
			}
		} finally {
			this.isFlushingMessageQueue = false;
		}
	}

	async readStreamQueue() {
		return this.readQueueEntriesFromDir(this.streamQueueDir);
	}

	async writeStreamQueueEntry(entry) {
		const safeEntry = {
			...entry,
			id: String(entry?.id || crypto.randomUUID()),
		};
		await fs.mkdir(this.streamQueueDir, { recursive: true });
		await fs.writeFile(
			this.getQueueEntryJsonPath(this.streamQueueDir, safeEntry.id),
			`${JSON.stringify(safeEntry, null, 2)}\n`,
			'utf8',
		);
		return safeEntry;
	}

	async removeStreamQueueEntry(entry) {
		const safeId = String(entry?.id || '').trim();
		if (!safeId) {
			return;
		}

		await fs.unlink(this.getQueueEntryJsonPath(this.streamQueueDir, safeId)).catch(() => {});
		if (entry && entry.payloadPath) {
			await fs.unlink(String(entry.payloadPath)).catch(() => {});
		}
	}

	async clearStreamQueue() {
		const queue = await this.readStreamQueue();
		for (const entry of queue) {
			await this.removeStreamQueueEntry(entry);
		}
	}

	async enqueueStreamForRetry(route, target, source, options = {}) {
		const safeRoute = String(route || '').trim().toLowerCase() || 'exchange';
		const safeTarget = String(target || '').trim();
		if (!safeTarget) {
			throw new Error('invalid queued stream target');
		}

		const safeOptions = options && typeof options === 'object' ? options : {};
		const safeChunkSize = Math.max(1024, Math.min(1024 * 1024, Number(safeOptions.chunkSize) || 64 * 1024));
		const streamId = String(safeOptions.streamId || crypto.randomUUID());
		const payloadId = crypto.randomUUID();
		const payloadPath = path.join(this.streamQueueDir, `${payloadId}.bin`);
		const payloadWriter = fsNative.createWriteStream(payloadPath, { flags: 'w' });

		try {
			await fs.mkdir(this.streamQueueDir, { recursive: true });
			await pipeline(Readable.from(iterateStreamSourceChunks(source, safeChunkSize)), payloadWriter);
			const payloadStats = await fs.stat(payloadPath);
			const now = Date.now();
			const queueEntry = await this.writeStreamQueueEntry({
				id: payloadId,
				createdAt: now,
				expiresAt: now + this.messageQueueTtlMs,
				nextAttemptAt: now + this.messageQueueRetryMs,
				attempts: 0,
				route: safeRoute,
				target: safeTarget,
				streamId,
				payloadPath,
				options: {
					chunkSize: safeChunkSize,
					contentType: String(safeOptions.contentType || 'application/octet-stream'),
					metadata: safeOptions.metadata && typeof safeOptions.metadata === 'object' ? safeOptions.metadata : {},
					headers: safeOptions.headers && typeof safeOptions.headers === 'object' ? safeOptions.headers : {},
					totalBytes: Number(payloadStats.size || 0),
				},
			});

			this.log(`[Queue] Stream enqueued (${safeRoute}) target=${safeTarget} size=${Number(payloadStats.size || 0)}B`);
			return queueEntry;
		} catch (error) {
			await fs.unlink(payloadPath).catch(() => {});
			throw error;
		}
	}

	async deliverStreamQueueEntry(entry) {
		const safeEntry = entry && typeof entry === 'object' ? entry : null;
		if (!safeEntry) {
			throw new Error('invalid queued stream entry');
		}

		const payloadPath = String(safeEntry.payloadPath || '').trim();
		if (!payloadPath) {
			throw new Error('missing queued stream payload path');
		}

		await fs.access(payloadPath);
		const options = safeEntry.options && typeof safeEntry.options === 'object' ? safeEntry.options : {};
		const streamSource = fsNative.createReadStream(payloadPath, {
			highWaterMark: Math.max(1024, Math.min(1024 * 1024, Number(options.chunkSize) || 64 * 1024)),
		});
		const streamOptions = {
			...options,
			streamId: String(safeEntry.streamId || crypto.randomUUID()),
			enqueueOnFail: false,
			noEnqueue: true,
		};

		if (String(safeEntry.route || '').toLowerCase() === 'direct') {
			return this.streamToNode(safeEntry.target, streamSource, streamOptions);
		}

		return this.streamToExchange(safeEntry.target, streamSource, streamOptions);
	}

	async flushStreamQueue() {
		if (this.isFlushingStreamQueue) {
			return;
		}

		this.isFlushingStreamQueue = true;
		try {
			const queue = await this.readStreamQueue();
			if (queue.length === 0) {
				return;
			}

			const now = Date.now();
			let delivered = 0;
			let dropped = 0;

			for (const item of queue) {
				if (!item || typeof item !== 'object') {
					continue;
				}

				if (Number(item.expiresAt || 0) <= now) {
					dropped += 1;
					await this.removeStreamQueueEntry(item);
					continue;
				}

				if (Number(item.nextAttemptAt || 0) > now) {
					continue;
				}

				try {
					await this.deliverStreamQueueEntry(item);
					delivered += 1;
					await this.removeStreamQueueEntry(item);
				} catch {
					const attempts = Number(item.attempts || 0) + 1;
					const backoff = Math.min(this.messageQueueRetryMs * Math.max(1, attempts), 30 * 60 * 1000);
					await this.writeStreamQueueEntry({
						...item,
						attempts,
						nextAttemptAt: now + backoff,
					});
				}
			}

			if (delivered > 0 || dropped > 0) {
				const pending = (await this.readStreamQueue()).length;
				this.log(`[Queue] Stream flush completed delivered=${delivered} dropped=${dropped} pending=${pending}`);
			}
		} finally {
			this.isFlushingStreamQueue = false;
		}
	}

	startMessageQueueFlushTimer() {
		if (this.messageQueueFlushTimer) {
			clearInterval(this.messageQueueFlushTimer);
		}

		this.messageQueueFlushTimer = setInterval(() => {
			this.flushMessageQueue().catch((error) => {
				this.log(`[Queue] Flush failed: ${error.message}`);
			});
		}, this.messageQueueRetryMs);
	}

	startStreamQueueFlushTimer() {
		if (this.streamQueueFlushTimer) {
			clearInterval(this.streamQueueFlushTimer);
		}

		this.streamQueueFlushTimer = setInterval(() => {
			this.flushStreamQueue().catch((error) => {
				this.log(`[Queue] Stream flush failed: ${error.message}`);
			});
		}, this.messageQueueRetryMs);
	}

	resolveWatchCreatedQuietMs(sizeBytes) {
		const safeSize = Number(sizeBytes) || 0;
		if (safeSize >= this.watchCreatedLargeFileBytes) {
			return this.watchCreatedLargeQuietMs;
		}

		return this.watchCreatedQuietMs;
	}

	async waitForWatchCreatedFileReady(filePath) {
		const safePath = String(filePath || '').trim();
		if (!safePath) {
			return { ready: false };
		}

		const startedAt = Date.now();
		let lastSize = -1;
		let lastMtimeMs = -1;
		let lastChangeAt = startedAt;

		while (Date.now() - startedAt <= this.watchCreatedTimeoutMs) {
			let stats = null;
			try {
				stats = await fs.stat(safePath);
			} catch {
				await delay(this.watchCreatedPollMs);
				continue;
			}

			if (!stats || !stats.isFile()) {
				await delay(this.watchCreatedPollMs);
				continue;
			}

			const size = Number(stats.size) || 0;
			const mtimeMs = Number(stats.mtimeMs) || 0;
			if (size !== lastSize || mtimeMs !== lastMtimeMs) {
				lastSize = size;
				lastMtimeMs = mtimeMs;
				lastChangeAt = Date.now();
			}

			const quietMs = this.resolveWatchCreatedQuietMs(size);
			if (Date.now() - lastChangeAt >= quietMs) {
				await delay(this.watchCreatedPollMs);
				try {
					const confirmStats = await fs.stat(safePath);
					if (confirmStats && confirmStats.isFile()) {
						const confirmSize = Number(confirmStats.size) || 0;
						const confirmMtimeMs = Number(confirmStats.mtimeMs) || 0;
						if (confirmSize === lastSize && confirmMtimeMs === lastMtimeMs) {
							return {
								ready: true,
								size: confirmSize,
								mtimeMs: confirmMtimeMs,
							};
						}
					}
				} catch {
					// Keep waiting while file writer settles.
				}
			}

			await delay(this.watchCreatedPollMs);
		}

		return { ready: false };
	}

	addHttpServerLog(message) {
		const entry = {
			timestamp: new Date().toISOString(),
			message,
		};
		this.httpServerLogs.push(entry);
		if (this.httpServerLogs.length > 300) {
			this.httpServerLogs.shift();
		}
		this.log(`[HTTP] ${message}`);
	}

	getHttpServerConfig() {
		return {
			port: this.httpServerPort,
			active: Boolean(this.httpServer),
			reactorName: this.cachedReactorName || null,
			messageListeners: Array.from(this.messageListenerMap.entries()).map(([sender, endpoints]) => ({
				sender,
				endpoints: endpoints.map((endpoint) => endpoint.name),
			})),
			streamListeners: Array.from(this.streamListenerMap.entries()).map(([sender, endpoints]) => ({
				sender,
				endpoints: endpoints.map((endpoint) => endpoint.name),
			})),
			streamEndListeners: Array.from(this.streamEndListenerMap.entries()).map(([sender, endpoints]) => ({
				sender,
				endpoints: endpoints.map((endpoint) => endpoint.name),
			})),
		};
	}

	async getReactorName() {
		if (this.cachedReactorName) {
			return this.cachedReactorName;
		}

		try {
			const raw = await fs.readFile(this.reactorNamePath, 'utf8');
			const value = String(raw || '').trim();
			if (!value) {
				return '';
			}
			this.cachedReactorName = value;
			return value;
		} catch {
			return '';
		}
	}

	async setReactorName(nextName) {
		const sanitized = String(nextName || '').trim();
		await fs.mkdir(path.dirname(this.reactorNamePath), { recursive: true });

		if (!sanitized) {
			await fs.writeFile(this.reactorNamePath, '', 'utf8');
			this.cachedReactorName = '';
			if (this.exchangeManager && typeof this.exchangeManager.reconnectClient === 'function') {
				await this.exchangeManager.reconnectClient('reactor-name-updated').catch((error) => {
					this.log(`[Exchange] Unable to reconnect client after name update: ${error.message}`);
				});
			}
			return '';
		}

		await fs.writeFile(this.reactorNamePath, `${sanitized}\n`, 'utf8');
		this.cachedReactorName = sanitized;
		if (this.exchangeManager && typeof this.exchangeManager.reconnectClient === 'function') {
			await this.exchangeManager.reconnectClient('reactor-name-updated').catch((error) => {
				this.log(`[Exchange] Unable to reconnect client after name update: ${error.message}`);
			});
		}
		return sanitized;
	}

	getHttpServerLogs(limit = 100) {
		const safeLimit = Number(limit) > 0 ? Number(limit) : 100;
		return this.httpServerLogs.slice(-safeLimit);
	}

	async getEnvConfig() {
		return { ...this.envMap };
	}

	async setEnvConfig(nextConfig) {
		const saved = await writeEnvConfig(this.reactorRootDir, nextConfig);
		this.envMap = Object.freeze({ ...saved });
		return { ...this.envMap };
	}

	async loadEnvMapFromDisk() {
		const loaded = await readEnvConfig(this.reactorRootDir);
		this.envMap = Object.freeze({ ...loaded });
		return this.envMap;
	}

	getExchangeConfig() {
		const config = this.exchangeManager.getConfig();
		const statusDebounceMs = parseNonNegativeIntegerOption(
			process.env.REACTOR_EXCHANGE_STATUS_DEBOUNCE_MS,
			550,
		);
		return {
			...config,
			pendingQueuedStreams: this.pendingExchangeStreamStarts,
			statusDebounceMs,
			connection: this.exchangeManager && typeof this.exchangeManager.getConnectionStatus === 'function'
				? this.exchangeManager.getConnectionStatus()
				: null,
			mode: this.exchangeMode,
			host: this.exchangeHost,
			port: this.exchangePort,
			token: this.exchangeAuthToken,
			user: this.exchangeAuthUser,
			password: this.exchangeAuthPassword,
			discovery: this.exchangeDiscoveryEndpointEnabled,
			stun: normalizeRelayEndpointConfig(this.stun),
			turn: normalizeRelayEndpointConfig(this.turn),
			p2p: this.getP2PStatus(),
			exposeDiscoveryEndpoint: this.exchangeDiscoveryEndpointEnabled,
			discoveryEndpointPath: this.exchangeDiscoveryEndpointPath,
		};
	}

	cleanupExpiredP2PSessions(nowMs = Date.now()) {
		for (const [key, session] of this.p2pSessions.entries()) {
			const transportSession = this.p2pTransportManager && this.p2pTransportManager.getSession
				? this.p2pTransportManager.getSession(key)
				: null;
			const transportOpen = Boolean(
				transportSession
				&& transportSession.dataChannel
				&& transportSession.dataChannel.readyState === 'open'
				&& transportSession.isOpen,
			);

			if (transportOpen) {
				this.upsertP2PSession(key, {
					sessionId: String(transportSession.sessionId || session?.sessionId || '').trim() || undefined,
					state: 'connected-p2p',
					lastSignalType: 'connected',
					usingRelay: false,
					reason: '',
				});
				continue;
			}

			const lastUpdateMs = Number(session?.lastUpdateMs || 0);
			if (!lastUpdateMs || nowMs - lastUpdateMs > this.p2pSessionTimeoutMs) {
				this.p2pSessions.delete(key);
			}
		}
	}

	getIceServersForP2P() {
		const servers = [];

		const stunHost = String(this.stun?.host || '').trim();
		const stunPort = Number(this.stun?.port) > 0 ? Number(this.stun.port) : 3478;
		if (stunHost) {
			servers.push({ urls: [`stun:${stunHost}:${stunPort}`] });
		}

		const turnHost = String(this.turn?.host || '').trim();
		const turnPort = Number(this.turn?.port) > 0 ? Number(this.turn.port) : 3478;
		if (turnHost) {
			const turnScheme = Boolean(this.turn?.tls) ? 'turns' : 'turn';
			const username = String(this.turn?.username || this.exchangeAuthToken || '').trim();
			const credential = String(this.turn?.password || this.exchangeAuthToken || '').trim();
			const turnServer = {
				urls: [`${turnScheme}:${turnHost}:${turnPort}?transport=tcp`, `turn:${turnHost}:${turnPort}?transport=udp`],
				username,
				credential,
			};
			servers.push(turnServer);
		}

		return servers;
	}

	getP2PStatus() {
		this.cleanupExpiredP2PSessions();
		const knownRemotePeers = this.exchangeManager && typeof this.exchangeManager.getKnownRemotePeers === 'function'
			? this.exchangeManager.getKnownRemotePeers()
			: [];
		const transportSummary = this.p2pTransportManager && this.p2pTransportManager.getStatusSummary
			? this.p2pTransportManager.getStatusSummary()
			: { supported: false, activeSessions: 0 };
		const sessions = Array.from(this.p2pSessions.values())
			.map((session) => ({
				target: String(session.target || ''),
				sessionId: String(session.sessionId || ''),
				state: String(session.state || 'idle'),
				lastSignalType: String(session.lastSignalType || ''),
				lastUpdateAt: session.lastUpdateMs ? new Date(session.lastUpdateMs).toISOString() : null,
				usingRelay: Boolean(session.usingRelay),
				reason: String(session.reason || ''),
			}))
			.sort((a, b) => String(a.target).localeCompare(String(b.target)));

		const activeSessionTargets = sessions
			.filter((session) => {
				const state = String(session.state || '').trim().toLowerCase();
				return state === 'connecting' || state === 'signaling' || state === 'connected-p2p' || state === 'connected-turn';
			})
			.map((session) => String(session.target || '').trim().toLowerCase())
			.filter(Boolean);

		const remotePeers = Array.from(new Set([
			...knownRemotePeers,
			...activeSessionTargets,
		])).sort((a, b) => a.localeCompare(b));

		return {
			enabled: this.exchangeMode === 'node',
			signalingViaExchange: true,
			connectedToExchange: Boolean(
				this.exchangeManager
				&& typeof this.exchangeManager.getConnectionStatus === 'function'
				&& this.exchangeManager.getConnectionStatus().connected,
			),
			dataChannelSupported: Boolean(transportSummary.supported),
			dataChannelSessions: Number(transportSummary.activeSessions || 0),
			iceServersConfigured: this.getIceServersForP2P().length > 0,
			iceServers: this.getIceServersForP2P(),
			remotePeers,
			sessions,
		};
	}

	async handleDiscoveredRemotePeers(peers = []) {
		if (!Array.isArray(peers) || peers.length === 0) {
			return;
		}

		const normalizedPeers = peers
			.map((peer) => String(peer || '').trim().toLowerCase())
			.filter(Boolean);

		if (normalizedPeers.length === 0) {
			return;
		}

		this.logGlobalEvent('EXCHANGE/PEER_LIST_RECEIVED', `peers=${normalizedPeers.join(',')}`).catch(() => {});

		const p2pRoutingEligibility = this.getP2PRoutingEligibility();
		if (!p2pRoutingEligibility.ok) {
			this.logGlobalEvent(
				'EXCHANGE/P2P_AUTODIAL_SKIPPED',
				`reason=${p2pRoutingEligibility.reason} peers=${normalizedPeers.length}`,
			).catch(() => {});
			return;
		}

		const now = Date.now();
		const staleConnectingSessionMs = 4000;
		for (const rawPeer of normalizedPeers) {
			const target = String(rawPeer || '').trim().toLowerCase();
			if (!target) {
				continue;
			}

			const shouldInitiate = await this.shouldInitiateP2PWithPeer(target);
			if (!shouldInitiate) {
				if (!this.shouldForceInitiateP2PAsResponder(target, now)) {
					this.logGlobalEvent('EXCHANGE/P2P_AUTODIAL_SKIPPED', `reason=deterministic-responder target=${target}`).catch(() => {});
					continue;
				}
				this.logGlobalEvent('EXCHANGE/P2P_AUTODIAL_TAKEOVER', `reason=stale-peer-session target=${target}`).catch(() => {});
			}

			this.logGlobalEvent('EXCHANGE/P2P_PEER_DISCOVERED', `peer on exchange: ${target}`).catch(() => {});

			const currentSession = this.p2pSessions.get(target);
			if (currentSession) {
				const state = String(currentSession.state || '').toLowerCase();
				if (state === 'connecting' || state === 'connected-p2p' || state === 'connected-turn') {
					if (state === 'connecting') {
						const lastUpdateMs = Number(currentSession.lastUpdateMs || 0);
						if (lastUpdateMs > 0 && now - lastUpdateMs >= staleConnectingSessionMs) {
							this.logGlobalEvent(
								'EXCHANGE/P2P_AUTODIAL_RESTART',
								`reason=stale-connecting-session target=${target}`,
							).catch(() => {});

							if (this.p2pTransportManager && this.p2pTransportManager.closeSession) {
								this.p2pTransportManager.closeSession(target, false);
							}
							this.p2pSessions.delete(target);
						} else {
							this.logGlobalEvent('EXCHANGE/P2P_AUTODIAL_SKIPPED', `reason=session-state-${state} target=${target}`).catch(() => {});
							continue;
						}
					} else {
						if (this.isP2PDataChannelOpenForTarget(target)) {
							this.logGlobalEvent('EXCHANGE/P2P_AUTODIAL_SKIPPED', `reason=session-state-${state} target=${target}`).catch(() => {});
							continue;
						}

						this.logGlobalEvent(
							'EXCHANGE/P2P_AUTODIAL_RESTART',
							`reason=stale-connected-session target=${target}`,
						).catch(() => {});

						if (this.p2pTransportManager && this.p2pTransportManager.closeSession) {
							this.p2pTransportManager.closeSession(target, false);
						}
						this.p2pSessions.delete(target);
					}
				}
			}

			const lastAttemptMs = Number(this.p2pAutodialAttempts.get(target) || 0);
			const stateForRetry = String((this.p2pSessions.get(target)?.state || '')).trim().toLowerCase();
			const quickRetryStates = new Set(['idle', 'fallback-exchange', 'signaling']);
			const effectiveCooldownMs = quickRetryStates.has(stateForRetry)
				? Math.min(this.p2pAutodialCooldownMs, 5000)
				: this.p2pAutodialCooldownMs;
			if (lastAttemptMs > 0 && now - lastAttemptMs < effectiveCooldownMs) {
				this.logGlobalEvent('EXCHANGE/P2P_AUTODIAL_SKIPPED', `reason=cooldown target=${target}`).catch(() => {});
				continue;
			}

			this.p2pAutodialAttempts.set(target, now);
			this.logGlobalEvent('EXCHANGE/P2P_NEGOTIATION_START', `starting native P2P negotiation with ${target}`).catch(() => {});
			this.upsertP2PSession(target, {
				state: 'connecting',
				lastSignalType: 'offer',
				reason: '',
				usingRelay: false,
			});

			if (this.p2pTransportManager && this.p2pTransportManager.ensureConnected) {
				this.p2pTransportManager.ensureConnected(target).catch((error) => {
					this.logGlobalEvent('EXCHANGE/P2P_AUTODIAL', `failed toward ${target}: ${String(error?.message || 'p2p auto-connect failed')}`).catch(() => {});
					this.p2pAutodialAttempts.delete(target);
					this.upsertP2PSession(target, {
						state: 'fallback-exchange',
						lastSignalType: 'failed',
						usingRelay: true,
						reason: String(error?.message || 'p2p auto-connect failed'),
					});
				});
			}
		}
	}

	async shouldInitiateP2PWithPeer(target) {
		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget) {
			return false;
		}

		const localNodeName = String(await this.getReactorName() || '').trim().toLowerCase();
		if (!localNodeName) {
			return true;
		}

		if (localNodeName === safeTarget) {
			return false;
		}

		return localNodeName.localeCompare(safeTarget) < 0;
	}

	isP2PDataChannelOpenForTarget(target) {
		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget) {
			return false;
		}

		const transportSession = this.p2pTransportManager && this.p2pTransportManager.getSession
			? this.p2pTransportManager.getSession(safeTarget)
			: null;

		return Boolean(
			transportSession
			&& transportSession.dataChannel
			&& transportSession.dataChannel.readyState === 'open'
			&& transportSession.isOpen,
		);
	}

	shouldForceInitiateP2PAsResponder(target, nowMs = Date.now()) {
		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget) {
			return false;
		}

		if (this.isP2PDataChannelOpenForTarget(safeTarget)) {
			return false;
		}

		const tracked = this.p2pSessions.get(safeTarget);
		if (!tracked) {
			return true;
		}

		const state = String(tracked.state || '').trim().toLowerCase();
		const lastUpdateMs = Number(tracked.lastUpdateMs || 0);

		if (state === 'connected-p2p' || state === 'connected-turn') {
			return true;
		}

		if (!lastUpdateMs) {
			return true;
		}

		return nowMs - lastUpdateMs >= 8000;
	}

	getP2PRoutingEligibility() {
		if (this.exchangeMode !== 'node') {
			return { ok: false, reason: 'exchange-mode-not-node' };
		}

		const stunHost = String(this.stun?.host || '').trim();
		if (!stunHost) {
			return { ok: false, reason: 'stun-not-configured' };
		}

		const turnHost = String(this.turn?.host || '').trim();
		if (!turnHost) {
			return { ok: false, reason: 'turn-not-configured' };
		}

		const dataChannelSupported = Boolean(
			this.p2pTransportManager
			&& this.p2pTransportManager.isAvailable
			&& this.p2pTransportManager.isAvailable(),
		);

		if (!dataChannelSupported) {
			return { ok: false, reason: 'datachannel-transport-unavailable' };
		}

		return { ok: true, reason: 'ok' };
	}

	shouldPreferP2PForNodeRouting() {
		return this.getP2PRoutingEligibility().ok;
	}

	hasConnectedP2PRoute(targetNodeName) {
		const safeTarget = String(targetNodeName || '').trim().toLowerCase();
		if (!safeTarget) {
			return false;
		}

		if (!this.shouldPreferP2PForNodeRouting()) {
			return false;
		}

		const trackedSession = this.p2pSessions.get(safeTarget);
		const trackedState = String(trackedSession?.state || '').trim().toLowerCase();
		const stateConnected = trackedState === 'connected-p2p' || trackedState === 'connected-turn';

		const transportSession = this.p2pTransportManager && this.p2pTransportManager.getSession
			? this.p2pTransportManager.getSession(safeTarget)
			: null;

		const dataChannelOpen = Boolean(
			transportSession
			&& transportSession.dataChannel
			&& transportSession.dataChannel.readyState === 'open'
			&& transportSession.isOpen,
		);

		return stateConnected && dataChannelOpen;
	}

	resolveP2PDeliveredVia(targetNodeName) {
		const safeTarget = String(targetNodeName || '').trim().toLowerCase();
		const trackedSession = this.p2pSessions.get(safeTarget);
		const trackedState = String(trackedSession?.state || '').trim().toLowerCase();
		return trackedState === 'connected-turn' ? 'P2P_RELAY' : 'P2P_DIRECT';
	}

	upsertP2PSession(target, updates = {}) {
		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget) {
			return null;
		}

		const existing = this.p2pSessions.get(safeTarget) || {
			target: safeTarget,
			sessionId: String(updates.sessionId || '').trim() || crypto.randomUUID(),
			state: 'signaling',
			lastSignalType: '',
			lastUpdateMs: Date.now(),
			usingRelay: false,
			reason: '',
		};

		const merged = {
			...existing,
			...updates,
			target: safeTarget,
			sessionId: String(updates.sessionId || existing.sessionId || crypto.randomUUID()).trim(),
			lastSignalType: String(updates.lastSignalType || existing.lastSignalType || '').trim().toLowerCase(),
			lastUpdateMs: Date.now(),
		};

		this.p2pSessions.set(safeTarget, merged);
		this.publishUiStatusSnapshot(`p2p-session:${safeTarget}`);
		return merged;
	}

	handleExchangeSignal(signal = {}) {
		const from = String(signal.from || '').trim().toLowerCase();
		const signalType = String(signal.signalType || '').trim().toLowerCase();
		if (!from || !signalType) {
			return;
		}

		if (['offer', 'answer', 'candidate', 'connected', 'failed', 'close', 'relay'].includes(signalType)) {
			const reason = signalType === 'failed' ? String(signal?.payload?.reason || 'p2p failed') : '';
			let detail = `signal=${signalType} from=${from}`;
			if (reason) {
				detail += ` reason=${reason}`;
			}
			this.logGlobalEvent('EXCHANGE/P2P_SIGNAL', detail).catch(() => {});
		}

		if (this.p2pTransportManager && this.p2pTransportManager.handleSignal) {
			this.p2pTransportManager.handleSignal(signal).catch((error) => {
				this.log(`[P2P] signal handling error from ${from}: ${error.message}`);
			});
		}

		const nextState = signalType === 'offer' || signalType === 'answer' || signalType === 'candidate'
			? 'connecting'
			: signalType === 'connected'
			? 'connected-p2p'
			: signalType === 'relay'
			? 'connected-turn'
			: signalType === 'failed'
			? 'fallback-exchange'
			: signalType === 'close'
			? 'idle'
			: 'signaling';

		this.upsertP2PSession(from, {
			sessionId: String(signal.sessionId || '').trim() || undefined,
			state: nextState,
			lastSignalType: signalType,
			usingRelay: signalType === 'relay' || signalType === 'failed',
			reason: signalType === 'failed' ? String(signal?.payload?.reason || 'p2p failed') : '',
		});

		if (signalType === 'failed' || signalType === 'close') {
			this.p2pAutodialAttempts.delete(from);
		}
	}

	async sendP2PSignal(target, signalType, payload = null, options = {}) {
		const safeTarget = String(target || '').trim().toLowerCase();
		const safeSignalType = String(signalType || '').trim().toLowerCase();
		if (!safeTarget) {
			throw new Error('invalid p2p signaling target');
		}
		if (!safeSignalType) {
			throw new Error('invalid p2p signal type');
		}
		if (this.exchangeMode !== 'node') {
			throw new Error('p2p signaling available only in node mode');
		}

		const session = this.upsertP2PSession(safeTarget, {
			sessionId: String(options.sessionId || '').trim() || undefined,
			state: 'signaling',
			lastSignalType: safeSignalType,
			reason: '',
		});

		const result = await this.exchangeManager.sendSignalViaExchange(safeTarget, safeSignalType, payload, {
			sessionId: session.sessionId,
		});

		this.upsertP2PSession(safeTarget, {
			sessionId: session.sessionId,
			state: safeSignalType === 'close' ? 'idle' : 'signaling',
			lastSignalType: safeSignalType,
		});

		return {
			ok: true,
			...result,
			session: this.p2pSessions.get(safeTarget),
		};
	}

	async closeP2PSession(target, options = {}) {
		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget) {
			throw new Error('invalid p2p session target');
		}

		let signalResult = null;
		if (this.exchangeMode === 'node') {
			try {
				signalResult = await this.sendP2PSignal(safeTarget, 'close', options.payload || null, {
					sessionId: options.sessionId,
				});
			} catch {
				// Session can still be cleared locally if remote close signal fails.
			}
		}

		if (this.p2pTransportManager && this.p2pTransportManager.closeSession) {
			this.p2pTransportManager.closeSession(safeTarget, false);
		}

		this.p2pSessions.delete(safeTarget);
		return {
			ok: true,
			target: safeTarget,
			signal: signalResult,
		};
	}

	async getExchangeToken() {
		const config = await readConnectionsConfig(this.connectionsConfigPath);
		const token = String(config.exchange?.token || '').trim();
		return {
			exists: Boolean(token),
			token,
			path: this.connectionsConfigPath,
		};
	}

	async generateExchangeToken() {
		const token = crypto.randomBytes(32).toString('base64url');
		await fs.mkdir(path.dirname(this.connectionsConfigPath), { recursive: true });
		await writeConnectionsConfig(this.connectionsConfigPath, {
			exchange: {
				host: this.exchangeHost,
				port: this.exchangePort,
				tls: this.exchangeTls,
				token,
				user: this.exchangeAuthUser,
				password: this.exchangeAuthPassword,
				discovery: this.exchangeDiscoveryEndpointEnabled,
			},
			stun: this.stun,
			turn: this.turn,
		});
		this.exchangeAuthToken = token;
		return {
			exists: true,
			token,
			path: this.connectionsConfigPath,
		};
	}

	async getTlsConfig() {
		return this.tlsManager.getCertInfo();
	}

	async generateTlsCert(bits, days) {
		const reactorName = await this.getReactorName();
		const info = await this.tlsManager.generateCert(reactorName || 'reactor', { bits, days });
		// Riavvia il server HTTP con TLS attivo
		await this.restartHttpServer();
		return info;
	}

	async deleteTlsCert() {
		await this.tlsManager.deleteCert();
		this.tlsEnabled = false;
		await this.restartHttpServer();
	}

	async setExchangeConfig(mode, host, port, tls = false, token = '', user = '', password = '', discovery = this.exchangeDiscoveryEndpointEnabled, stun = this.stun, turn = this.turn) {
		const requestedMode = String(mode || 'node').trim().toLowerCase();
		const safeHost = String(host || '').trim();
		const safePort = Number(port) > 0 ? Number(port) : 7070;
		const safeTls = Boolean(tls);
		const safeToken = String(token || '').trim();
		const safeUser = String(user || '').trim();
		const safePassword = String(password || '');
		const safeDiscovery = parseBooleanOption(discovery, this.exchangeDiscoveryEndpointEnabled);
		const safeMode = requestedMode === 'client' ? 'node' : requestedMode === 'disabled' ? 'node' : requestedMode;
		const internalMode = safeMode === 'exchange' ? 'exchange' : 'client';

		if (!['node', 'exchange'].includes(safeMode)) {
			throw new Error('modalità exchange non valida: usa node o exchange');
		}

		this.exchangeMode = safeMode;
		this.exchangeHost = safeHost;
		this.exchangePort = safePort;
		this.exchangeTls = safeTls;
		this.exchangeAuthToken = safeToken;
		this.exchangeAuthUser = safeUser;
		this.exchangeAuthPassword = safePassword;
		this.exchangeDiscoveryEndpointEnabled = safeDiscovery;
		this.stun = normalizeRelayEndpointConfig(stun, this.stun);
		this.turn = normalizeRelayEndpointConfig(turn, this.turn);
		this.exchangeManager.configure(internalMode, safeHost, safePort, safeTls);
		await this.exchangeManager.start(this.httpServer);
		await writeConnectionsConfig(this.connectionsConfigPath, {
			exchange: {
				host: this.exchangeHost,
				port: this.exchangePort,
				tls: this.exchangeTls,
				token: this.exchangeAuthToken,
				user: this.exchangeAuthUser,
				password: this.exchangeAuthPassword,
				discovery: this.exchangeDiscoveryEndpointEnabled,
			},
			stun: this.stun,
			turn: this.turn,
		});
		return this.getExchangeConfig();
	}

	async testRelayEndpoint(kind, relayConfig = {}) {
		const safeKind = String(kind || '').trim().toLowerCase();
		if (!['stun', 'turn'].includes(safeKind)) {
			return { ok: false, error: 'invalid relay type: use stun or turn' };
		}

		const current = safeKind === 'stun' ? this.stun : this.turn;
		const endpoint = normalizeRelayEndpointConfig(relayConfig, current);
		if (!endpoint.host) {
			return { ok: false, error: `${safeKind.toUpperCase()} host is required` };
		}

		let testResult;
		if (safeKind === 'stun') {
			testResult = endpoint.tls
				? await testTlsRelay(endpoint.host, endpoint.port, 5000)
				: await testUdpStunBinding(endpoint.host, endpoint.port, 5000);
		} else {
			const turnUsername = String(endpoint.username || this.exchangeAuthToken || '').trim();
			const turnPassword = String(endpoint.password || this.exchangeAuthToken || '').trim();
			testResult = await testTurnRelayAuthentication(
				endpoint.host,
				endpoint.port,
				endpoint.tls,
				turnUsername,
				turnPassword,
				TURN_RELAY_TEST_TIMEOUT_MS,
			);
		}

		return {
			...testResult,
			kind: safeKind,
			config: endpoint,
		};
	}

	async setRelayConfig(kind, relayConfig = {}, runTest = true) {
		const safeKind = String(kind || '').trim().toLowerCase();
		if (!['stun', 'turn'].includes(safeKind)) {
			throw new Error('relay type non valido: usa stun o turn');
		}

		if (safeKind === 'stun') {
			this.stun = normalizeRelayEndpointConfig(relayConfig, this.stun);
		} else {
			this.turn = normalizeRelayEndpointConfig(relayConfig, this.turn);
		}

		await writeConnectionsConfig(this.connectionsConfigPath, {
			exchange: {
				host: this.exchangeHost,
				port: this.exchangePort,
				tls: this.exchangeTls,
				token: this.exchangeAuthToken,
				discovery: this.exchangeDiscoveryEndpointEnabled,
			},
			stun: this.stun,
			turn: this.turn,
		});

		const relay = safeKind === 'stun' ? this.stun : this.turn;
		const test = runTest ? await this.testRelayEndpoint(safeKind, relay) : { ok: true, skipped: true };
		return {
			ok: true,
			kind: safeKind,
			relay,
			test,
		};
	}

	async getExchangeLinkedNodesSnapshot() {
		const localNodeName = String(await this.getReactorName() || '').trim().toLowerCase();
		const localNodeSnapshot = {
			name: localNodeName || 'current-node',
			address: null,
			ip: null,
			port: null,
			httpPort: Number(this.httpServerPort) || DEFAULT_LOCAL_SERVER_PORT,
			httpTls: Boolean(this.tlsEnabled),
			endpointsEndpoint: null,
			connectedAt: this.runtimeStartedAt,
			lastSeenAt: new Date().toISOString(),
			userAgent: '',
			endpoints: this.getDiscoveryEndpointEntries(),
			connectedForMs: null,
			connectedForSec: null,
			isCurrent: true,
		};

		const mergeWithLocalNode = (rawNodes = []) => {
			const mergedByName = new Map();

			for (const rawNode of Array.isArray(rawNodes) ? rawNodes : []) {
				const safeName = String(rawNode?.name || '').trim().toLowerCase();
				if (!safeName) {
					continue;
				}

				const nextNode = {
					...(rawNode || {}),
					name: safeName,
					isCurrent: Boolean(localNodeName && safeName === localNodeName),
				};

				if (nextNode.isCurrent) {
					mergedByName.set(safeName, {
						...nextNode,
						...localNodeSnapshot,
						name: safeName,
						ip: nextNode.ip || localNodeSnapshot.ip,
						port: Number.isFinite(Number(nextNode.port)) ? Number(nextNode.port) : localNodeSnapshot.port,
						httpPort: Number.isFinite(Number(nextNode.httpPort)) ? Number(nextNode.httpPort) : localNodeSnapshot.httpPort,
						httpTls: Boolean(nextNode.httpTls ?? localNodeSnapshot.httpTls),
						endpointsEndpoint: nextNode.endpointsEndpoint || localNodeSnapshot.endpointsEndpoint,
						connectedAt: nextNode.connectedAt || localNodeSnapshot.connectedAt,
						lastSeenAt: nextNode.lastSeenAt || localNodeSnapshot.lastSeenAt,
						endpoints: Array.isArray(nextNode.endpoints) && nextNode.endpoints.length > 0
							? nextNode.endpoints
							: localNodeSnapshot.endpoints,
					});
					continue;
				}

				mergedByName.set(safeName, nextNode);
			}

			if (localNodeName && !mergedByName.has(localNodeName)) {
				mergedByName.set(localNodeName, { ...localNodeSnapshot, name: localNodeName });
			}

			return Array.from(mergedByName.values())
				.sort((a, b) => {
					if (a.isCurrent && !b.isCurrent) {
						return -1;
					}
					if (!a.isCurrent && b.isCurrent) {
						return 1;
					}
					return String(a.name || '').localeCompare(String(b.name || ''));
				});
		};

		if (this.exchangeMode !== 'exchange') {
			if (this.exchangeMode !== 'node') {
				return {
					ok: false,
					error: `available only in node or exchange mode (current: ${this.exchangeMode})`,
					nodes: [],
					total: 0,
				};
			}

			if (!String(this.exchangeHost || '').trim()) {
				return {
					ok: false,
					error: 'exchange host is not configured',
					nodes: [],
					total: 0,
				};
			}

			const token = String(this.exchangeAuthToken || '').trim();
			const user = String(this.exchangeAuthUser || '').trim();
			const password = String(this.exchangeAuthPassword || '');
			if (!token && !user) {
				return {
					ok: false,
					error: 'exchange credentials are not configured',
					nodes: [],
					total: 0,
				};
			}

			const scheme = this.exchangeTls ? 'https' : 'http';
			const endpointUrl = `${scheme}://${this.exchangeHost}:${this.exchangePort}${this.exchangeDiscoveryEndpointPath}`;

			try {
				const authHeader = token
					? `Bearer ${token}`
					: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

				const response = await this.platformServices.httpClient.request({
					url: endpointUrl,
					method: 'GET',
					headers: {
						Accept: 'application/json',
						Authorization: authHeader,
					},
					insecureTls: false,
				});

				let parsed = null;
				try {
					parsed = response && response.body ? JSON.parse(String(response.body)) : null;
				} catch {
					parsed = null;
				}

				if (!response || Number(response.status) !== 200 || !parsed || parsed.ok === false) {
					return {
						ok: false,
						error: parsed && parsed.error ? String(parsed.error) : `exchange discovery request failed (${response ? response.status : 'no response'})`,
						nodes: [],
						total: 0,
					};
				}

				const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
				const nodesWithEndpoints = await this.enrichDiscoveryNodesWithEndpoints(nodes);
				const mergedNodes = mergeWithLocalNode(nodesWithEndpoints);

				return {
					ok: true,
					mode: this.exchangeMode,
					endpoint: endpointUrl,
					generatedAt: parsed.generatedAt || new Date().toISOString(),
					runtimeStartedAt: this.runtimeStartedAt,
					total: mergedNodes.length,
					nodes: mergedNodes,
				};
			} catch (error) {
				const detail = this.exchangeTls
					? formatTlsCertificateError(error?.message, 'unable to reach exchange discovery endpoint')
					: String(error?.message || 'unable to reach exchange discovery endpoint');
				return {
					ok: false,
					error: detail,
					nodes: [],
					total: 0,
				};
			}
		}

		if (!this.exchangeDiscoveryEndpointEnabled) {
			return {
				ok: false,
				error: 'discovery is disabled',
				nodes: [],
				total: 0,
			};
		}

		const nodes = this.exchangeManager && typeof this.exchangeManager.getConnectedClientsDiscoveryEndpointEntries === 'function'
			? this.exchangeManager.getConnectedClientsDiscoveryEndpointEntries(Date.now())
			: [];
		const nodesWithEndpoints = await this.enrichDiscoveryNodesWithEndpoints(nodes);
		const mergedNodes = mergeWithLocalNode(nodesWithEndpoints);

		return {
			ok: true,
			mode: this.exchangeMode,
			endpoint: this.exchangeDiscoveryEndpointPath,
			generatedAt: new Date().toISOString(),
			runtimeStartedAt: this.runtimeStartedAt,
			total: mergedNodes.length,
			nodes: mergedNodes,
		};
	}

	getDiscoveryEndpointEntries() {
		const byUuid = new Map();

		for (const endpoint of Array.isArray(this.endpoints) ? this.endpoints : []) {
			if (!endpoint || !endpoint.endpointId) {
				continue;
			}

			const uuid = String(endpoint.endpointId || '').trim().toLowerCase();
			if (!uuid) {
				continue;
			}

			const nextEntry = {
				uuid,
				name: String(endpoint.name || '').trim() || 'unknown',
				triggers: Array.isArray(endpoint.events) ? endpoint.events.map((trigger) => String(trigger || '').trim()).filter(Boolean) : [],
				enabled: Boolean(endpoint.enabled),
				mutex: Boolean(endpoint.mutex),
			};

			const previous = byUuid.get(uuid);
			if (!previous) {
				byUuid.set(uuid, nextEntry);
				continue;
			}

			const preferredEntry = String(nextEntry.name || '').toLowerCase().endsWith('.ts')
				&& !String(previous.name || '').toLowerCase().endsWith('.ts')
				? previous
				: nextEntry;

			byUuid.set(uuid, {
				...preferredEntry,
				triggers: Array.from(new Set([...(previous.triggers || []), ...(nextEntry.triggers || [])])),
				enabled: previous.enabled || nextEntry.enabled,
				mutex: previous.mutex || nextEntry.mutex,
			});
		}

		return Array.from(byUuid.values()).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
	}

	isValidDiscoveryUrl(rawUrl) {
		const value = String(rawUrl || '').trim();
		if (!value) {
			return false;
		}

		try {
			const parsed = new URL(value);
			return parsed.protocol === 'http:' || parsed.protocol === 'https:';
		} catch {
			return false;
		}
	}

	buildNodeEndpointCandidates(node) {
		const candidates = [];
		const seen = new Set();
		const pushCandidate = (url, insecureTls) => {
			if (!this.isValidDiscoveryUrl(url)) {
				return;
			}
			const key = String(url).trim().toLowerCase();
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			candidates.push({ url: String(url).trim(), insecureTls: Boolean(insecureTls) });
		};

		const nodeTls = Boolean(node?.httpTls);
		const nodePort = Number(node?.httpPort);
		const hasValidPort = Number.isInteger(nodePort) && nodePort > 0 && nodePort <= 65535;

		pushCandidate(node?.endpointsEndpoint, nodeTls);

		if (hasValidPort) {
			const protocol = nodeTls ? 'https' : 'http';
			if (node?.ip) {
				pushCandidate(`${protocol}://${String(node.ip).trim()}:${nodePort}/endpoints`, nodeTls);
			}
			if (node?.name) {
				pushCandidate(`${protocol}://${String(node.name).trim()}:${nodePort}/endpoints`, nodeTls);
			}
		}

		return candidates;
	}

	async requestWithTimeout(requestPromise, timeoutMs, timeoutMessage) {
		const safeTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 2000;
		return Promise.race([
			requestPromise,
			new Promise((_, reject) => {
				setTimeout(() => reject(new Error(timeoutMessage || 'request timeout')), safeTimeout);
			}),
		]);
	}

	async enrichDiscoveryNodesWithEndpoints(nodes = []) {
		const safeNodes = Array.isArray(nodes) ? nodes : [];
		if (safeNodes.length === 0) {
			return [];
		}

		const token = String(this.exchangeAuthToken || '').trim();
		return Promise.all(
			safeNodes.map(async (node) => {
				const fallbackEndpoints = Array.isArray(node?.endpoints) ? node.endpoints : [];
				const endpointCandidates = this.buildNodeEndpointCandidates(node);
				if (endpointCandidates.length === 0) {
					return {
						...(node || {}),
						endpoints: fallbackEndpoints,
					};
				}

				for (const candidate of endpointCandidates) {
					try {
						const response = await this.requestWithTimeout(
							this.platformServices.httpClient.request({
								url: candidate.url,
								method: 'GET',
								headers: {
									Accept: 'application/json',
									...(token ? { Authorization: `Bearer ${token}` } : {}),
								},
								insecureTls: Boolean(candidate.insecureTls),
							}),
							1500,
							'node endpoints request timeout',
						);

						if (!response || Number(response.status) !== 200) {
							continue;
						}

						let parsed = null;
						try {
							parsed = response.body ? JSON.parse(String(response.body)) : null;
						} catch {
							parsed = null;
						}

						const parsedEndpoints = Array.isArray(parsed?.endpoints) ? parsed.endpoints : null;

						if (!parsed || parsed.ok === false || !Array.isArray(parsedEndpoints)) {
							continue;
						}

						return {
							...(node || {}),
							endpoints: parsedEndpoints,
							endpointsEndpoint: candidate.url,
						};
					} catch {
						// Try next endpoint candidate.
					}
				}

				return {
					...(node || {}),
					endpoints: fallbackEndpoints,
				};
			}),
		);
	}

	async testExchangeClientConnection(timeoutMs = 5000) {
		if (this.exchangeMode !== 'node') {
			return {
				connected: false,
				skipped: true,
				reason: 'exchange mode is not node/client',
				elapsedMs: 0,
			};
		}

		return this.exchangeManager.waitForClientConnection(timeoutMs);
	}

	async setHttpServerPort(port) {
		const nextPort = Number(port);
		if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
			throw new Error('invalid HTTP server port');
		}

		if (nextPort === this.httpServerPort) {
			return this.getHttpServerConfig();
		}

		this.httpServerPort = nextPort;
		await this.restartHttpServer();
		return this.getHttpServerConfig();
	}

	registerEndpointMessageListeners(endpoint) {
		if (!endpoint.enabled || !Array.isArray(endpoint.events) || !endpoint.events.includes('MESSAGE')) {
			return;
		}

		if (endpoint.messageFromAnySender || !Array.isArray(endpoint.messageSenders) || endpoint.messageSenders.length === 0) {
			const wildcardListeners = this.messageListenerMap.get('*') || [];
			wildcardListeners.push(endpoint);
			this.messageListenerMap.set('*', wildcardListeners);
			return;
		}

		for (const sender of endpoint.messageSenders) {
			const key = String(sender || '').trim().toLowerCase();
			if (!key) {
				continue;
			}

			const listeners = this.messageListenerMap.get(key) || [];
			listeners.push(endpoint);
			this.messageListenerMap.set(key, listeners);
		}
	}

	findMessageListeners(senderCandidates) {
		const listeners = [];
		for (const endpoint of this.messageListenerMap.get('*') || []) {
			listeners.push(endpoint);
		}

		for (const sender of senderCandidates || []) {
			for (const endpoint of this.messageListenerMap.get(sender) || []) {
				if (!listeners.includes(endpoint)) {
					listeners.push(endpoint);
				}
			}
		}

		return listeners;
	}

	matchesEndpointTarget(endpoint, targetEndpointSelector = null) {
		if (!targetEndpointSelector) {
			return true;
		}

		if (!endpoint || typeof endpoint !== 'object') {
			return false;
		}

		const selectorType = String(targetEndpointSelector.type || '').trim().toLowerCase();
		if (selectorType === 'id') {
			const endpointId = String(endpoint.endpointId || '').trim().toLowerCase();
			return Boolean(endpointId) && endpointId === String(targetEndpointSelector.value || '').trim().toLowerCase();
		}

		if (selectorType === 'name') {
			const endpointName = String(endpoint.name || '').trim().toLowerCase();
			return Boolean(endpointName) && endpointName === String(targetEndpointSelector.value || '').trim().toLowerCase();
		}

		return false;
	}

	filterMessageListenersByTarget(listeners, targetEndpointSelector = null) {
		if (!targetEndpointSelector) {
			return Array.isArray(listeners) ? listeners : [];
		}

		return (Array.isArray(listeners) ? listeners : [])
			.filter((endpoint) => this.matchesEndpointTarget(endpoint, targetEndpointSelector));
	}

	filterStreamListenersByTarget(listeners, targetEndpointSelector = null) {
		if (!targetEndpointSelector) {
			return Array.isArray(listeners) ? listeners : [];
		}

		return (Array.isArray(listeners) ? listeners : [])
			.filter((endpoint) => this.matchesEndpointTarget(endpoint, targetEndpointSelector));
	}

	filterStreamEndListenersByTarget(listeners, targetEndpointSelector = null) {
		if (!targetEndpointSelector) {
			return Array.isArray(listeners) ? listeners : [];
		}

		return (Array.isArray(listeners) ? listeners : [])
			.filter((endpoint) => this.matchesEndpointTarget(endpoint, targetEndpointSelector));
	}

	registerEndpointStreamListeners(endpoint) {
		if (!endpoint.enabled || !Array.isArray(endpoint.events) || !endpoint.events.includes('STREAM')) {
			return;
		}

		if (endpoint.streamFromAnySender || !Array.isArray(endpoint.streamSenders) || endpoint.streamSenders.length === 0) {
			const wildcardListeners = this.streamListenerMap.get('*') || [];
			wildcardListeners.push(endpoint);
			this.streamListenerMap.set('*', wildcardListeners);
			return;
		}

		for (const sender of endpoint.streamSenders) {
			const key = String(sender || '').trim().toLowerCase();
			if (!key) {
				continue;
			}

			const listeners = this.streamListenerMap.get(key) || [];
			listeners.push(endpoint);
			this.streamListenerMap.set(key, listeners);
		}
	}

	findStreamListeners(senderCandidates) {
		const listeners = [];
		for (const endpoint of this.streamListenerMap.get('*') || []) {
			listeners.push(endpoint);
		}

		for (const sender of senderCandidates || []) {
			for (const endpoint of this.streamListenerMap.get(sender) || []) {
				if (!listeners.includes(endpoint)) {
					listeners.push(endpoint);
				}
			}
		}

		return listeners;
	}

	registerEndpointStreamEndListeners(endpoint) {
		if (!endpoint.enabled || !Array.isArray(endpoint.events) || !endpoint.events.includes('STREAMEND')) {
			return;
		}

		if (endpoint.streamEndFromAnySender || !Array.isArray(endpoint.streamEndSenders) || endpoint.streamEndSenders.length === 0) {
			const wildcardListeners = this.streamEndListenerMap.get('*') || [];
			wildcardListeners.push(endpoint);
			this.streamEndListenerMap.set('*', wildcardListeners);
			return;
		}

		for (const sender of endpoint.streamEndSenders) {
			const key = String(sender || '').trim().toLowerCase();
			if (!key) {
				continue;
			}

			const listeners = this.streamEndListenerMap.get(key) || [];
			listeners.push(endpoint);
			this.streamEndListenerMap.set(key, listeners);
		}
	}

	findStreamEndListeners(senderCandidates) {
		const listeners = [];
		for (const endpoint of this.streamEndListenerMap.get('*') || []) {
			listeners.push(endpoint);
		}

		for (const sender of senderCandidates || []) {
			for (const endpoint of this.streamEndListenerMap.get(sender) || []) {
				if (!listeners.includes(endpoint)) {
					listeners.push(endpoint);
				}
			}
		}

		return listeners;
	}

	createIncomingStreamPacket(payload) {
		return new IncomingStreamPacket(payload);
	}

	createIncomingStreamEndInfo(payload) {
		return new IncomingStreamEndInfo(payload);
	}

	makeStreamSenderKey(senderMeta = {}) {
		return String(senderMeta.rawSender || senderMeta.rawName || senderMeta.remoteHost || 'unknown').trim().toLowerCase();
	}

	makeActiveStreamKey(senderMeta, streamId) {
		return `${this.makeStreamSenderKey(senderMeta)}|${String(streamId || '').trim()}`;
	}

	sanitizeStreamFileSegment(value) {
		return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'unknown';
	}

	startStreamCleanupTimer() {
		if (this.streamCleanupTimer) {
			clearInterval(this.streamCleanupTimer);
		}

		this.streamCleanupTimer = setInterval(() => {
			const now = Date.now();
			for (const [key, state] of this.activeIncomingStreams.entries()) {
				if (!state || Number(state.lastActivityAt || 0) + this.streamIdleTimeoutMs > now) {
					continue;
				}

				this.activeIncomingStreams.delete(key);
				fs.unlink(state.partPath).catch(() => {});
				this.log(`[STREAM] dropped stale stream key=${key}`);
			}
		}, this.streamCleanupIntervalMs);
	}

	async cleanupOrphanStreamFiles() {
		try {
			await fs.mkdir(this.streamStorageDir, { recursive: true });
			const entries = await fs.readdir(this.streamStorageDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) {
					continue;
				}
				const filePath = path.join(this.streamStorageDir, entry.name);
				if (!entry.name.endsWith('.part')) {
					continue;
				}
				await fs.unlink(filePath).catch(() => {});
			}
		} catch (error) {
			this.log(`[STREAM] orphan cleanup failed: ${error.message}`);
		}
	}

	async processIncomingStreamPacket(packet, senderMeta = {}) {
		if (!packet || typeof packet.getId !== 'function') {
			return null;
		}

		const streamId = packet.getId();
		if (!streamId) {
			return null;
		}

		const key = this.makeActiveStreamKey(senderMeta, streamId);
		const now = Date.now();

		if (packet.isStart()) {
			if (!this.activeIncomingStreams.has(key) && this.activeIncomingStreams.size >= this.streamMaxActive) {
				this.log(`[STREAM] max active streams reached (${this.streamMaxActive}), dropping streamId=${streamId}`);
				return null;
			}

			await fs.mkdir(this.streamStorageDir, { recursive: true });
			const senderSegment = this.sanitizeStreamFileSegment(this.makeStreamSenderKey(senderMeta));
			const streamSegment = this.sanitizeStreamFileSegment(streamId);
			const partPath = path.join(this.streamStorageDir, `${Date.now()}-${senderSegment}-${streamSegment}.part`);
			await fs.writeFile(partPath, Buffer.alloc(0));

			this.activeIncomingStreams.set(key, {
				key,
				streamId,
				sender: this.makeStreamSenderKey(senderMeta),
				partPath,
				lastActivityAt: now,
				createdAt: now,
				chunks: 0,
				totalBytes: 0,
				digest: crypto.createHash('sha256'),
				metadata: packet.getMetadata(),
				contentType: packet.getContentType(),
				senderCandidates: senderMeta.candidates || [],
			});
			return null;
		}

		const state = this.activeIncomingStreams.get(key);
		if (!state) {
			return null;
		}

		state.lastActivityAt = now;

		if (packet.isChunk()) {
			const chunk = packet.readChunkBuffer();
			if (chunk.length > 0) {
				await fs.appendFile(state.partPath, chunk);
				state.digest.update(chunk);
				state.totalBytes += chunk.length;
			}
			state.chunks += 1;
			return null;
		}

		if (!packet.isEnd()) {
			return null;
		}

		this.activeIncomingStreams.delete(key);
		const digestSha256 = state.digest.digest('hex');
		const expectedDigest = String(packet.payload?.digestSha256 || '').trim().toLowerCase();
		const expectedBytes = Number(packet.payload?.totalBytes);
		const hasExpectedBytes = Number.isFinite(expectedBytes) && expectedBytes >= 0;
		const validDigest = !expectedDigest || expectedDigest === digestSha256;
		const validBytes = !hasExpectedBytes || expectedBytes === state.totalBytes;
		const isValid = validDigest && validBytes;

		const finalPath = state.partPath.replace(/\.part$/i, isValid ? '.bin' : '.failed');
		await fs.rename(state.partPath, finalPath).catch(async () => {
			await fs.copyFile(state.partPath, finalPath).catch(() => {});
			await fs.unlink(state.partPath).catch(() => {});
		});

		return {
			streamId,
			sender: state.sender,
			path: finalPath,
			totalBytes: state.totalBytes,
			chunks: state.chunks,
			digestSha256,
			expectedDigestSha256: expectedDigest,
			expectedTotalBytes: hasExpectedBytes ? expectedBytes : null,
			valid: isValid,
			error: isValid ? '' : 'stream validation failed',
			metadata: state.metadata,
			contentType: state.contentType,
			senderCandidates: state.senderCandidates,
		};
	}

	async emitStreamEnd(streamEndData, senderMeta, messageHeaders = {}) {
		if (!streamEndData) {
			return [];
		}

		const messageTarget = this.resolveMessageTarget(messageHeaders || {});
		const listeners = this.filterStreamEndListenersByTarget(
			this.findStreamEndListeners(senderMeta?.candidates || streamEndData.senderCandidates || []),
			messageTarget.endpointSelector,
		);
		if (listeners.length === 0) {
			return [];
		}

		const streamEndInfo = this.createIncomingStreamEndInfo(streamEndData);
		await Promise.allSettled(
			listeners.map((endpoint) =>
				this.runEndpoint(endpoint, {
					trigger: 'STREAMEND',
					event: 'STREAMEND',
					messageSender: senderMeta?.rawSender || senderMeta?.remoteHost || streamEndData.sender || null,
					messageSenderName: senderMeta?.rawName || null,
					messageTarget: messageTarget.nodeName || null,
					messageTargetNode: messageTarget.nodeName || null,
					messageTargetEndpointId: messageTarget.endpointId || null,
					messageTargetEndpoint: messageTarget.endpointSelector ? messageTarget.endpointSelector.headerValue : null,
					messageHeaders,
					stream: null,
					streamEnd: streamEndInfo,
				}),
			),
		);

		return listeners.map((endpoint) => endpoint.name);
	}

	parseMessageBody(req, rawBuffer) {
		const headers = req.headers || {};
		const contentType = String(headers['content-type'] || '').toLowerCase();
		const bodyText = rawBuffer.toString('utf8');
		let bodyJson = null;
		if (rawBuffer.length > 0 && contentType.includes('application/json')) {
			try {
				bodyJson = JSON.parse(bodyText);
			} catch {
				bodyJson = null;
			}
		}

		return {
			contentType,
			text: bodyText,
			json: bodyJson,
			base64: rawBuffer.toString('base64'),
		};
	}

	resolveSenderCandidates(req) {
		const headers = req.headers || {};
		const rawName = String(headers['reactor-name'] || '').trim();
		const rawSender = String(headers['reactor-sender'] || '').trim();
		const remoteHost = extractRemoteHost(req.socket && req.socket.remoteAddress);
		return this.resolveSenderCandidatesFromValues(rawName, rawSender, remoteHost);
	}

	resolveSenderCandidatesFromValues(rawNameValue, rawSenderValue, remoteHostValue) {
		const rawName = String(rawNameValue || '').trim();
		const rawSender = String(rawSenderValue || '').trim();
		const remoteHost = extractRemoteHost(remoteHostValue);
		const candidates = new Set();

		if (rawName) {
			candidates.add(rawName.toLowerCase());
		}

		if (rawSender) {
			const loweredSender = rawSender.toLowerCase();
			if (isLikelyNetworkIdentity(loweredSender)) {
				const normalizedSender = normalizeHostPort(loweredSender, DEFAULT_LOCAL_SERVER_PORT);
				if (normalizedSender) {
					const [senderHost] = normalizedSender.split(':');
					candidates.add(normalizedSender);
					candidates.add(`net:${normalizedSender}`);
					if (senderHost) {
						candidates.add(`net:${senderHost}`);
					}
				}
			} else {
				candidates.add(loweredSender);
			}
		}

		if (remoteHost) {
			const normalizedRemote = normalizeHostPort(remoteHost, DEFAULT_LOCAL_SERVER_PORT);
			if (normalizedRemote) {
				candidates.add(normalizedRemote);
				candidates.add(`net:${normalizedRemote}`);
			}
			candidates.add(`net:${remoteHost}`);
		}

		return {
			rawName,
			rawSender,
			remoteHost,
			candidates: Array.from(candidates).filter(Boolean),
		};
	}

	resolveMessageTarget(headers = {}) {
		const rawNode = String(headers['reactor-target-node'] || '').trim().toLowerCase();
		const rawEndpoint = String(headers['reactor-target-endpoint'] || '').trim();
		const rawEndpointId = String(headers['reactor-target-endpoint-id'] || '').trim().toLowerCase();
		const endpointSelector = parseEndpointSelector(rawEndpoint) || (isUuidV4(rawEndpointId)
			? {
				type: 'id',
				value: rawEndpointId,
				headerValue: `id:${rawEndpointId}`,
			}
			: null);

		return {
			nodeName: rawNode || null,
			endpointSelector,
			endpointId: endpointSelector && endpointSelector.type === 'id' ? endpointSelector.value : null,
			endpointName: endpointSelector && endpointSelector.type === 'name' ? endpointSelector.value : null,
		};
	}

	readBearerToken(headers = {}) {
		const rawAuthorization = String(headers.authorization || '').trim();
		if (!rawAuthorization) {
			return '';
		}

		const match = rawAuthorization.match(/^Bearer\s+(.+)$/i);
		return match ? String(match[1] || '').trim() : '';
	}

	isExchangeDiscoveryRequestAuthorized(headers = {}) {
		const expectedToken = String(this.exchangeAuthToken || '').trim();
		if (!expectedToken) {
			return false;
		}

		const providedToken = this.readBearerToken(headers);
		return Boolean(providedToken) && providedToken === expectedToken;
	}

	async ensureProjectEndpointId(projectDir) {
		const uuidPath = path.join(projectDir, PROJECT_UUID_FILE);
		try {
			const raw = await fs.readFile(uuidPath, 'utf8');
			const existing = String(raw || '').trim().toLowerCase();
			if (isUuidV4(existing)) {
				return existing;
			}
		} catch {
			// Generate below when file is missing or unreadable.
		}

		const nextId = crypto.randomUUID().toLowerCase();
		await fs.writeFile(uuidPath, `${nextId}\n`, 'utf8');
		return nextId;
	}

	buildP2PEnvelope(content, messageHeaders = {}) {
		const normalizedHeaders = Object.fromEntries(
			Object.entries(messageHeaders && typeof messageHeaders === 'object' ? messageHeaders : {})
				.map(([key, value]) => [String(key || '').trim().toLowerCase(), value]),
		);

		if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
			return {
				kind: 'message',
				payloadType: 'base64',
				payload: Buffer.from(content).toString('base64'),
				contentType: 'application/octet-stream',
				messageHeaders: normalizedHeaders,
			};
		}

		if (typeof content === 'string') {
			return {
				kind: 'message',
				payloadType: 'string',
				payload: content,
				contentType: 'text/plain; charset=utf-8',
				messageHeaders: normalizedHeaders,
			};
		}

		if (content === null || content === undefined) {
			return {
				kind: 'message',
				payloadType: 'null',
				payload: '',
				contentType: 'text/plain; charset=utf-8',
				messageHeaders: normalizedHeaders,
			};
		}

		return {
			kind: 'message',
			payloadType: 'json',
			payload: JSON.stringify(content),
			contentType: 'application/json; charset=utf-8',
			messageHeaders: normalizedHeaders,
		};
	}

	parseIncomingP2PEnvelope(rawPayload) {
		let parsed = null;
		try {
			parsed = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
		} catch {
			parsed = {
				kind: 'message',
				payloadType: 'string',
				payload: String(rawPayload || ''),
				contentType: 'text/plain; charset=utf-8',
				messageHeaders: {},
			};
		}

		const envelope = parsed && typeof parsed === 'object' ? parsed : {};
		const payloadType = String(envelope.payloadType || 'string').trim().toLowerCase();
		let decoded;
		if (payloadType === 'base64') {
			decoded = Buffer.from(String(envelope.payload || ''), 'base64');
		} else if (payloadType === 'json') {
			try {
				decoded = JSON.parse(String(envelope.payload || 'null'));
			} catch {
				decoded = String(envelope.payload || '');
			}
		} else if (payloadType === 'null') {
			decoded = '';
		} else {
			decoded = String(envelope.payload || '');
		}

		const contentType = String(envelope.contentType || 'text/plain; charset=utf-8');
		const messageHeaders = envelope.messageHeaders && typeof envelope.messageHeaders === 'object'
			? envelope.messageHeaders
			: {};

		let bodyText = '';
		let bodyJson = null;
		let bodyBase64 = '';
		if (Buffer.isBuffer(decoded)) {
			bodyText = decoded.toString('utf8');
			bodyBase64 = decoded.toString('base64');
		} else if (typeof decoded === 'string') {
			bodyText = decoded;
			bodyBase64 = Buffer.from(decoded, 'utf8').toString('base64');
		} else {
			bodyJson = decoded;
			bodyText = JSON.stringify(decoded);
			bodyBase64 = Buffer.from(bodyText, 'utf8').toString('base64');
		}

		if (!bodyJson && contentType.toLowerCase().includes('application/json')) {
			try {
				bodyJson = JSON.parse(bodyText);
			} catch {
				bodyJson = null;
			}
		}

		return {
			contentType: contentType.toLowerCase(),
			text: bodyText,
			json: bodyJson,
			base64: bodyBase64,
			messageHeaders,
		};
	}

	async dispatchIncomingMessageEnvelope(body, senderMeta, messageHeaders = {}) {
		const messageTarget = this.resolveMessageTarget(messageHeaders || {});
		const isStreamEnvelope = Boolean(body.json && typeof body.json === 'object' && body.json.__reactorStream === true);
		const listeners = isStreamEnvelope
			? this.filterStreamListenersByTarget(this.findStreamListeners(senderMeta.candidates), messageTarget.endpointSelector)
			: this.filterMessageListenersByTarget(this.findMessageListeners(senderMeta.candidates), messageTarget.endpointSelector);

		const streamPacket = isStreamEnvelope ? this.createIncomingStreamPacket(body.json) : null;
		const streamEndData = isStreamEnvelope ? await this.processIncomingStreamPacket(streamPacket, senderMeta) : null;
		let streamEndEndpoints = [];

		if (listeners.length === 0) {
			streamEndEndpoints = streamEndData
				? await this.emitStreamEnd(streamEndData, senderMeta, messageHeaders)
				: [];
			return {
				ok: true,
				trigger: isStreamEnvelope ? 'STREAM' : 'MESSAGE',
				delivered: false,
				reason: 'no listeners',
				streamEndEndpoints,
				senderCandidates: senderMeta.candidates,
			};
		}

		await Promise.allSettled(
			listeners.map((endpoint) =>
				this.runEndpoint(endpoint, {
					trigger: isStreamEnvelope ? 'STREAM' : 'MESSAGE',
					event: isStreamEnvelope ? 'STREAM' : 'MESSAGE',
					messageSender: senderMeta.rawSender || senderMeta.remoteHost || null,
					messageSenderName: senderMeta.rawName || null,
					messageTarget: messageTarget.nodeName || null,
					messageTargetNode: messageTarget.nodeName || null,
					messageTargetEndpointId: messageTarget.endpointId || null,
					messageTargetEndpoint: messageTarget.endpointSelector ? messageTarget.endpointSelector.headerValue : null,
					messageContent: body.text,
					messageContentType: body.contentType,
					messageBodyBase64: body.base64,
					messageJson: body.json,
					stream: streamPacket,
					streamEnd: null,
					messageHeaders,
				}),
			),
		);

		streamEndEndpoints = streamEndData
			? await this.emitStreamEnd(streamEndData, senderMeta, messageHeaders)
			: [];

		return {
			ok: true,
			trigger: isStreamEnvelope ? 'STREAM' : 'MESSAGE',
			delivered: true,
			endpoints: listeners.map((endpoint) => endpoint.name),
			streamEndEndpoints,
			senderCandidates: senderMeta.candidates,
		};
	}

	async handleIncomingP2PEnvelope(fromNode, rawPayload) {
		const safeFromNode = String(fromNode || '').trim().toLowerCase();
		if (!safeFromNode) {
			return { ok: false, error: 'invalid p2p sender' };
		}

		const parsedBody = this.parseIncomingP2PEnvelope(rawPayload);
		const headers = {
			...((parsedBody.messageHeaders && typeof parsedBody.messageHeaders === 'object') ? parsedBody.messageHeaders : {}),
			'x-p2p-from': safeFromNode,
		};

		const senderMeta = {
			rawName: safeFromNode,
			rawSender: safeFromNode,
			remoteHost: null,
			candidates: [safeFromNode],
		};

		const control = parsedBody && parsedBody.json && typeof parsedBody.json === 'object'
			? parsedBody.json
			: null;
		if (control && control.__reactorP2PControl === true) {
			const action = String(control.action || '').trim().toLowerCase();
			const requestId = String(control.requestId || '').trim();

			if (action === 'endpoints-request' && requestId) {
				const responsePayload = {
					__reactorP2PControl: true,
					action: 'endpoints-response',
					requestId,
					node: String(await this.getReactorName() || '').trim(),
					endpoints: this.getDiscoveryEndpointEntries(),
					generatedAt: new Date().toISOString(),
				};

				await this.sendP2PMessage(safeFromNode, responsePayload, {
					'content-type': 'application/json; charset=utf-8',
					'x-reactor-p2p-control': 'endpoints-response',
				});

				return { ok: true, control: true, action, requestId, from: safeFromNode };
			}

			if (action === 'endpoints-response' && requestId) {
				const pending = this.p2pRemoteEndpointRequests.get(requestId);
				if (pending) {
					this.p2pRemoteEndpointRequests.delete(requestId);
					clearTimeout(pending.timeout);
					pending.resolve({
						ok: true,
						target: safeFromNode,
						requestId,
						node: String(control.node || safeFromNode).trim().toLowerCase(),
						endpoints: Array.isArray(control.endpoints) ? control.endpoints : [],
						generatedAt: String(control.generatedAt || '').trim() || null,
					});
				}

				return { ok: true, control: true, action, requestId, from: safeFromNode };
			}
		}

		return this.dispatchIncomingMessageEnvelope(parsedBody, senderMeta, headers);
	}

	async requestRemoteEndpointsP2P(targetNodeName, timeoutMs = P2P_REMOTE_ENDPOINTS_TIMEOUT_MS) {
		const safeTarget = String(targetNodeName || '').trim().toLowerCase();
		if (!safeTarget) {
			throw new Error('invalid p2p target');
		}

		const requestRemoteEndpointsViaExchangeFallback = async () => {
			const snapshot = await this.getExchangeLinkedNodesSnapshot();
			if (!snapshot?.ok) {
				throw new Error(snapshot?.error || 'exchange fallback unavailable');
			}

			const targetNode = Array.isArray(snapshot.nodes)
				? snapshot.nodes.find((node) => String(node?.name || '').trim().toLowerCase() === safeTarget)
				: null;
			if (!targetNode) {
				throw new Error(`target node not found on exchange discovery: ${safeTarget}`);
			}

			const fallbackEndpoints = Array.isArray(targetNode.endpoints) ? targetNode.endpoints : [];
			return {
				ok: true,
				target: safeTarget,
				node: safeTarget,
				source: 'exchange-discovery',
				endpoints: fallbackEndpoints,
				generatedAt: snapshot.generatedAt || new Date().toISOString(),
				fallback: true,
			};
		};

		if (!this.p2pTransportManager || !this.p2pTransportManager.isAvailable || !this.p2pTransportManager.isAvailable()) {
			return requestRemoteEndpointsViaExchangeFallback();
		}

		const requestId = crypto.randomUUID();
		const safeTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : P2P_REMOTE_ENDPOINTS_TIMEOUT_MS;

		const promise = new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.p2pRemoteEndpointRequests.delete(requestId);
					reject(new Error('p2p endpoints request timeout'));
			}, safeTimeoutMs);

			this.p2pRemoteEndpointRequests.set(requestId, { resolve, reject, timeout });
		});

		try {
			await this.sendP2PMessage(safeTarget, {
				__reactorP2PControl: true,
				action: 'endpoints-request',
				requestId,
				timestamp: new Date().toISOString(),
			}, {
				'content-type': 'application/json; charset=utf-8',
				'x-reactor-p2p-control': 'endpoints-request',
			});
		} catch (error) {
			const pending = this.p2pRemoteEndpointRequests.get(requestId);
			if (pending) {
				this.p2pRemoteEndpointRequests.delete(requestId);
				clearTimeout(pending.timeout);
			}
			throw error;
		}

		try {
			const result = await promise;
			const endpoints = Array.isArray(result?.endpoints) ? result.endpoints : [];
			return {
				...result,
				source: 'p2p-datachannel',
				endpoints,
			};
		} catch (error) {
			const fallbackResult = await requestRemoteEndpointsViaExchangeFallback();
			return {
				...fallbackResult,
				p2pError: String(error?.message || 'p2p endpoints request timeout'),
			};
		}
	}

	async sendP2PMessage(targetNodeName, content, messageHeaders = {}) {
		if (!this.p2pTransportManager || !this.p2pTransportManager.isAvailable || !this.p2pTransportManager.isAvailable()) {
			throw new Error('p2p datachannel transport unavailable');
		}

		const safeTarget = String(targetNodeName || '').trim().toLowerCase();
		if (!safeTarget) {
			throw new Error('invalid p2p target');
		}

		const envelope = this.buildP2PEnvelope(content, messageHeaders);
		const result = await this.p2pTransportManager.sendEnvelope(safeTarget, envelope);
		return {
			...result,
			target: safeTarget,
			mode: 'p2p',
			deliveredVia: this.resolveP2PDeliveredVia(safeTarget),
		};
	}

	async sendNodeMessage(target, content, extraHeaders = {}, dispatchOptions = {}) {
		const targetId = String(target || '').trim();
		if (!targetId) {
			throw new Error('invalid target. expected {endpoint}@{node} or endpoint');
		}

		const shouldEnqueueOnFail = dispatchOptions && dispatchOptions.noEnqueue
			? false
			: Boolean(dispatchOptions && dispatchOptions.enqueueOnFail);
		const parsedTarget = parseNodeDispatchTarget(targetId, this.httpServerPort);
		if (!parsedTarget) {
			throw new Error('invalid target. expected {endpoint}@{node} or endpoint');
		}

		const endpointHeaders = {
			...(extraHeaders || {}),
			'Reactor-Target-Endpoint': parsedTarget.endpointSelector.headerValue,
			...(parsedTarget.endpointSelector.type === 'id'
				? { 'Reactor-Target-Endpoint-Id': parsedTarget.endpointSelector.value }
				: {}),
		};

		if (parsedTarget.routeKind === 'local') {
			const reactorName = String(await this.getReactorName() || '').trim().toLowerCase();
			const senderHost = pickPrimaryLocalHost();
			const senderId = `${senderHost}:${this.httpServerPort}`;
			const localHeaders = {
				...endpointHeaders,
				'Reactor-Name': reactorName,
				'Reactor-Sender': senderId,
				'Reactor-Target-Node': reactorName,
			};

			const parsedBody = this.parseIncomingP2PEnvelope(this.buildP2PEnvelope(content, localHeaders));
			const senderMeta = this.resolveSenderCandidatesFromValues(reactorName, senderId, senderHost);
			const dispatch = await this.dispatchIncomingMessageEnvelope(parsedBody, senderMeta, localHeaders);

			return {
				target: targetId,
				via: 'local',
				deliveredVia: 'LOCAL',
				...dispatch,
			};
		}

		if (parsedTarget.routeKind === 'logical') {
			const logicalHeaders = {
				...endpointHeaders,
				'Reactor-Target-Node': parsedTarget.nodeName,
			};

			if (this.hasConnectedP2PRoute(parsedTarget.nodeName)) {
				try {
					return await this.sendP2PMessage(parsedTarget.nodeName, content, logicalHeaders);
				} catch (p2pError) {
					this.log(`[P2P] fallback to exchange for ${parsedTarget.nodeName}: ${p2pError.message}`);
				}
			}

			return this.sendExchangeMessage(`${parsedTarget.endpointSelector.headerValue}@${parsedTarget.nodeName}`, content, {
				...dispatchOptions,
				enqueueOnFail: shouldEnqueueOnFail,
			});
		}

		const effectiveTarget = parsedTarget.directAddress;
		const effectiveHeaders = {
			...endpointHeaders,
			'Reactor-Target-Node': parsedTarget.nodeSelector || `net:${parsedTarget.directAddress}`,
		};

		let hasExplicitPort = false;
		if (/^https?:\/\//i.test(effectiveTarget)) {
			try {
				const parsedTarget = new URL(effectiveTarget);
				hasExplicitPort = Boolean(parsedTarget.port);
			} catch {
				hasExplicitPort = false;
			}
		} else {
			hasExplicitPort = /^([^:]+):(\d{1,5})$/.test(effectiveTarget);
		}

		const preferredPorts = hasExplicitPort
			? [null]
			: Array.from(new Set([this.httpServerPort, DEFAULT_LOCAL_SERVER_PORT].filter((port) => Number.isInteger(port) && port > 0)));

		const normalizedTargets = hasExplicitPort
			? [normalizeHostPort(effectiveTarget, this.httpServerPort)].filter(Boolean)
			: preferredPorts.map((port) => normalizeHostPort(effectiveTarget, port)).filter(Boolean);

		if (normalizedTargets.length === 0) {
			throw new Error('invalid target. expected {endpoint}@net:host:port');
		}

		let payload = content;
		let contentType = 'text/plain; charset=utf-8';
		if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
			payload = Buffer.from(content);
			contentType = 'application/octet-stream';
		} else if (typeof content === 'string') {
			payload = content;
		} else if (content === null || content === undefined) {
			payload = '';
		} else {
			payload = JSON.stringify(content);
			contentType = 'application/json; charset=utf-8';
		}

		const reactorName = await this.getReactorName();
		const senderId = `${pickPrimaryLocalHost()}:${this.httpServerPort}`;
		let lastError = null;

		for (let index = 0; index < normalizedTargets.length; index += 1) {
			const normalizedTarget = normalizedTargets[index];
			const [host, portString] = normalizedTarget.split(':');
			const port = Number(portString || DEFAULT_LOCAL_SERVER_PORT);
			const isLast = index === normalizedTargets.length - 1;
			const shortTimeout = isLast ? undefined : 2000;

			// Se TLS abilitato localmente, tenta prima HTTPS (cert self-signed → rejectUnauthorized: false)
			if (this.tlsEnabled) {
				try {
					const result = await this._sendHttpsMessage(host, port, payload, contentType, reactorName, senderId, effectiveHeaders, shortTimeout || 3000);
					return {
						target: targetId,
						endpoint: `https://${host}:${port}/message`,
						...result,
					};
				} catch {
					// Fallback a HTTP
				}
			}

			const endpoint = `http://${host}:${port}/message`;
			const request = new this.runtimeApi.HttpClient.Request({
				url: endpoint,
				method: 'POST',
				headers: {
					'content-type': contentType,
					'Reactor-Name': reactorName || '',
					'Reactor-Sender': senderId,
					...effectiveHeaders,
				},
				body: payload,
			});

			try {
				const response = await this.runtimeApi.HttpClient.sendRequest(request, shortTimeout);
				return {
					target: targetId,
					endpoint,
					statusCode: response.statusCode,
					statusText: response.statusText,
					headers: response.headers,
					body: response.body,
				};
			} catch (error) {
				lastError = error;
			}
		}

		if (lastError) {
			if (dispatchOptions.noEnqueue || !shouldEnqueueOnFail) {
				throw lastError;
			}

			const serialized = this.serializeQueuedContent(content);
			const queueResult = await this.enqueueMessageForRetry({
				channel: 'direct',
				target: targetId,
				headers: effectiveHeaders,
				payloadType: serialized.payloadType,
				payload: serialized.payload,
			});

			return {
				target: targetId,
				via: 'direct',
				queued: true,
				reason: String(lastError.message || 'send failed'),
				...queueResult,
			};
		}

		// Se nessun target diretto era disponibile, il messaggio fallisce
		if (dispatchOptions.noEnqueue || !shouldEnqueueOnFail) {
			throw new Error(`No direct route found for ${targetId}`);
		}

		const serialized = this.serializeQueuedContent(content);
		const queueResult = await this.enqueueMessageForRetry({
			channel: 'direct',
			target: targetId,
			headers: effectiveHeaders,
			payloadType: serialized.payloadType,
			payload: serialized.payload,
		});

		return {
			target: targetId,
			via: 'direct',
			queued: true,
			reason: 'no direct route found',
			...queueResult,
		};
	}

	async sendExchangeMessage(target, content, options = {}) {
		const shouldEnqueueOnFail = options && options.noEnqueue
			? false
			: Boolean(options && options.enqueueOnFail);

		try {
			const result = await this.exchangeManager.sendViaExchange(target, content, {
				enqueueOnFail: shouldEnqueueOnFail,
			});
			return {
				...result,
				deliveredVia: 'EXCHANGE',
			};
		} catch (error) {
			if (options && (options.noEnqueue || !shouldEnqueueOnFail)) {
				throw error;
			}

			const serialized = this.serializeQueuedContent(content);
			const queueResult = await this.enqueueMessageForRetry({
				channel: 'exchange',
				target: String(target || '').trim().toLowerCase(),
				headers: {},
				payloadType: serialized.payloadType,
				payload: serialized.payload,
			});

			return {
				target: String(target || '').trim().toLowerCase(),
				via: 'exchange',
				deliveredVia: 'EXCHANGE',
				queued: true,
				reason: String(error?.message || 'exchange send failed'),
				...queueResult,
			};
		}
	}

	resolveStreamRetryConfig(options = {}) {
		const safeOptions = options && typeof options === 'object' ? options : {};
		const maxRetriesRaw = Number.isFinite(Number(safeOptions.retryMaxRetries))
			? Number(safeOptions.retryMaxRetries)
			: Number(safeOptions.maxRetries);
		const retryDelayRaw = Number.isFinite(Number(safeOptions.retryDelayMs))
			? Number(safeOptions.retryDelayMs)
			: 1000;
		const reconnectWaitRaw = Number.isFinite(Number(safeOptions.retryReconnectWaitMs))
			? Number(safeOptions.retryReconnectWaitMs)
			: 4000;
		const enabled = safeOptions.retry === undefined ? true : Boolean(safeOptions.retry);

		return {
			enabled,
			maxRetries: Math.max(0, Math.min(200, Number.isFinite(maxRetriesRaw) ? Math.floor(maxRetriesRaw) : 12)),
			retryDelayMs: Math.max(100, Math.min(30000, Number.isFinite(retryDelayRaw) ? Math.floor(retryDelayRaw) : 1000)),
			reconnectWaitMs: Math.max(500, Math.min(60000, Number.isFinite(reconnectWaitRaw) ? Math.floor(reconnectWaitRaw) : 4000)),
		};
	}

	async waitForExchangeReconnection(timeoutMs) {
		if (!this.exchangeManager || typeof this.exchangeManager.waitForClientConnection !== 'function') {
			await new Promise((resolve) => setTimeout(resolve, Math.max(100, Number(timeoutMs) || 1000)));
			return { connected: false, reason: 'exchange manager does not support waitForClientConnection' };
		}

		return this.exchangeManager.waitForClientConnection(timeoutMs);
	}

	isExchangeConnectionReady() {
		if (!this.exchangeManager || typeof this.exchangeManager.getConnectionStatus !== 'function') {
			return false;
		}

		const status = this.exchangeManager.getConnectionStatus();
		return Boolean(status && status.connected === true);
	}

	async acquireQueuedExchangeStreamStart(target, options = {}) {
		const safeOptions = options && typeof options === 'object' ? options : {};
		const shouldEnqueueOnFail = Boolean(safeOptions.enqueueOnFail) && !Boolean(safeOptions.noEnqueue);
		if (!shouldEnqueueOnFail) {
			return () => {};
		}

		if (this.isExchangeConnectionReady()) {
			return () => {};
		}

		const safeTarget = String(target || '').trim() || 'unknown-target';
		const previousTail = this.exchangeStreamStartQueueTail;
		let releaseTurn = null;
		const thisTurn = new Promise((resolve) => {
			releaseTurn = resolve;
		});

		this.pendingExchangeStreamStarts += 1;
		this.exchangeStreamStartQueueTail = previousTail
			.catch(() => {})
			.then(() => thisTurn);

		await previousTail.catch(() => {});
		this.log(`[Exchange] Queued stream start for ${safeTarget} (waiting for exchange connection)`);

		try {
			let waitCycles = 0;
			while (!this.isExchangeConnectionReady()) {
				waitCycles += 1;
				const waitResult = await this.waitForExchangeReconnection(5000);
				if (!waitResult || waitResult.connected !== true) {
					if (waitCycles === 1 || waitCycles % 6 === 0) {
						const reason = String(waitResult?.reason || 'exchange connection unavailable');
						this.log(`[Exchange] Stream start still queued for ${safeTarget}: ${reason}`);
					}
					await delay(250);
				}
			}
		} catch (error) {
			this.pendingExchangeStreamStarts = Math.max(0, this.pendingExchangeStreamStarts - 1);
			if (typeof releaseTurn === 'function') {
				releaseTurn();
			}
			throw error;
		}

		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.pendingExchangeStreamStarts = Math.max(0, this.pendingExchangeStreamStarts - 1);
			if (typeof releaseTurn === 'function') {
				releaseTurn();
			}
		};
	}

	async runExchangeStreamOperationWithRetry(operation, label, retryConfig, onRetry = null) {
		const safeConfig = retryConfig && typeof retryConfig === 'object'
			? retryConfig
			: this.resolveStreamRetryConfig({});
		const safeLabel = String(label || 'stream operation');

		let attempt = 0;
		while (true) {
			try {
				return await operation();
			} catch (error) {
				if (!safeConfig.enabled || attempt >= safeConfig.maxRetries) {
					throw error;
				}

				attempt += 1;
				const errorMessage = String(error?.message || 'unknown exchange stream error');
				this.log(`[Exchange] ${safeLabel} retry ${attempt}/${safeConfig.maxRetries} after error: ${errorMessage}`);

				if (typeof onRetry === 'function') {
					try {
						onRetry({ attempt, error, label: safeLabel });
					} catch {
						// Ignore callback errors, retry loop must continue.
					}
				}

				const waitResult = await this.waitForExchangeReconnection(safeConfig.reconnectWaitMs);
				if (!waitResult || waitResult.connected !== true) {
					const reason = String(waitResult?.reason || 'exchange connection not ready');
					this.log(`[Exchange] ${safeLabel} retry ${attempt}: waiting for reconnect (${reason})`);
				}

				await new Promise((resolve) => setTimeout(resolve, safeConfig.retryDelayMs));
			}
		}
	}

	async streamToNode(target, source, options = {}) {
		const safeOptions = options && typeof options === 'object' ? options : {};
		const shouldEnqueueOnFail = safeOptions && safeOptions.noEnqueue
			? false
			: Boolean(safeOptions.enqueueOnFail);
		const parsedTarget = parseNodeDispatchTarget(String(target || '').trim(), this.httpServerPort);
		const needsExchangeAtStart = Boolean(
			parsedTarget
			&& parsedTarget.routeKind === 'logical'
			&& parsedTarget.nodeName
			&& !this.hasConnectedP2PRoute(parsedTarget.nodeName),
		);

		if (needsExchangeAtStart && shouldEnqueueOnFail) {
			return this.streamToExchange(target, source, safeOptions);
		}

		let releaseQueuedStart = () => {};
		if (needsExchangeAtStart) {
			releaseQueuedStart = await this.acquireQueuedExchangeStreamStart(target, {
				enqueueOnFail: shouldEnqueueOnFail,
				noEnqueue: Boolean(safeOptions.noEnqueue),
			});
		}

		try {
			const streamDispatchOptions = {
				enqueueOnFail: shouldEnqueueOnFail,
				noEnqueue: Boolean(safeOptions.noEnqueue),
			};
			const safeChunkSize = Math.max(1024, Math.min(1024 * 1024, Number(safeOptions.chunkSize) || 64 * 1024));
			const streamId = String(safeOptions.streamId || crypto.randomUUID());
			const contentType = String(safeOptions.contentType || 'application/octet-stream');
			const metadata = safeOptions.metadata && typeof safeOptions.metadata === 'object' ? safeOptions.metadata : {};
			const headers = safeOptions.headers && typeof safeOptions.headers === 'object' ? safeOptions.headers : {};
			const totalBytesHint = Number.isFinite(Number(safeOptions.totalBytes)) ? Math.max(0, Number(safeOptions.totalBytes)) : null;

			const deliveredViaSeen = new Set();
			const trackDeliveredVia = (result) => {
				const safe = String(result?.deliveredVia || '').trim().toUpperCase();
				if (safe === 'LOCAL' || safe === 'P2P_DIRECT' || safe === 'P2P_RELAY' || safe === 'EXCHANGE') {
					deliveredViaSeen.add(safe);
				}
			};

			const startResult = await this.sendNodeMessage(target, {
				__reactorStream: true,
				phase: 'start',
				streamId,
				contentType,
				chunkSize: safeChunkSize,
				totalBytes: totalBytesHint,
				metadata,
			}, headers, streamDispatchOptions);
			releaseQueuedStart();
			releaseQueuedStart = () => {};
			trackDeliveredVia(startResult);

			let totalBytes = 0;
			let chunks = 0;
			const digest = crypto.createHash('sha256');

			for await (const chunk of iterateStreamSourceChunks(source, safeChunkSize)) {
				digest.update(chunk);
				totalBytes += chunk.length;
				const chunkResult = await this.sendNodeMessage(target, {
					__reactorStream: true,
					phase: 'chunk',
					streamId,
					index: chunks,
					encoding: 'base64',
					size: chunk.length,
					data: chunk.toString('base64'),
				}, headers, streamDispatchOptions);
				trackDeliveredVia(chunkResult);
				chunks += 1;
			}

			const digestSha256 = digest.digest('hex');
			const endResult = await this.sendNodeMessage(target, {
				__reactorStream: true,
				phase: 'end',
				streamId,
				chunks,
				totalBytes,
				digestSha256,
			}, headers, streamDispatchOptions);
			trackDeliveredVia(endResult);

			let deliveredVia = null;
			if (deliveredViaSeen.has('EXCHANGE')) {
				deliveredVia = 'EXCHANGE';
			} else if (deliveredViaSeen.has('P2P_RELAY')) {
				deliveredVia = 'P2P_RELAY';
			} else if (deliveredViaSeen.has('P2P_DIRECT')) {
				deliveredVia = 'P2P_DIRECT';
			} else if (deliveredViaSeen.has('LOCAL')) {
				deliveredVia = 'LOCAL';
			}

			return {
				target: String(target || '').trim(),
				via: 'direct',
				deliveredVia,
				streamId,
				chunks,
				totalBytes,
				digestSha256,
			};
		} finally {
			releaseQueuedStart();
		}
	}

	async streamToExchange(target, source, options = {}) {
		const safeOptions = options && typeof options === 'object' ? options : {};
		const shouldEnqueueOnFail = safeOptions && safeOptions.noEnqueue
			? false
			: Boolean(safeOptions.enqueueOnFail);
		const shouldPersistStreamOnFail = shouldEnqueueOnFail && !Boolean(safeOptions.noEnqueue);
		if (shouldPersistStreamOnFail) {
			const queuedEntry = await this.enqueueStreamForRetry('exchange', target, source, safeOptions);
			try {
				const result = await this.deliverStreamQueueEntry(queuedEntry);
				await this.removeStreamQueueEntry(queuedEntry);
				return result;
			} catch (error) {
				this.log(`[Queue] Stream delivery deferred target=${String(target || '').trim().toLowerCase()} reason=${error.message}`);
				return {
					target: String(target || '').trim().toLowerCase(),
					via: 'exchange',
					deliveredVia: 'EXCHANGE',
					queued: true,
					queueId: queuedEntry.id,
					reason: String(error?.message || 'stream delivery failed'),
					expiresAt: Number(queuedEntry.expiresAt || 0),
				};
			}
		}

		let releaseQueuedStart = await this.acquireQueuedExchangeStreamStart(target, {
			enqueueOnFail: shouldEnqueueOnFail,
			noEnqueue: Boolean(safeOptions.noEnqueue),
		});
		const retryConfig = this.resolveStreamRetryConfig(safeOptions);
		const exchangeDispatchOptions = {
			enqueueOnFail: shouldEnqueueOnFail,
			noEnqueue: true,
		};
		const safeChunkSize = Math.max(1024, Math.min(1024 * 1024, Number(safeOptions.chunkSize) || 64 * 1024));
		const streamId = String(safeOptions.streamId || crypto.randomUUID());
		const contentType = String(safeOptions.contentType || 'application/octet-stream');
		const metadata = safeOptions.metadata && typeof safeOptions.metadata === 'object' ? safeOptions.metadata : {};
		const totalBytesHint = Number.isFinite(Number(safeOptions.totalBytes)) ? Math.max(0, Number(safeOptions.totalBytes)) : null;

		try {
			await this.runExchangeStreamOperationWithRetry(() => this.sendExchangeMessage(target, {
				__reactorStream: true,
				phase: 'start',
				streamId,
				contentType,
				chunkSize: safeChunkSize,
				totalBytes: totalBytesHint,
				metadata,
			}, exchangeDispatchOptions), `stream-start:${streamId}`, retryConfig);
			releaseQueuedStart();
			releaseQueuedStart = () => {};

			let totalBytes = 0;
			let chunks = 0;
			let resumeCount = 0;
			const digest = crypto.createHash('sha256');

			for await (const chunk of iterateStreamSourceChunks(source, safeChunkSize)) {
				digest.update(chunk);
				totalBytes += chunk.length;
				if (!this.exchangeManager || typeof this.exchangeManager.sendStreamChunkBinary !== 'function') {
					throw new Error('binary exchange streaming is not supported by current exchange manager');
				}

				const currentIndex = chunks;
				await this.runExchangeStreamOperationWithRetry(() => this.exchangeManager.sendStreamChunkBinary(target, streamId, currentIndex, chunk, {
					enqueueOnFail: shouldEnqueueOnFail,
				}), `stream-chunk:${streamId}:${currentIndex}`, retryConfig, () => {
					resumeCount += 1;
				});
				chunks += 1;
			}

			const digestSha256 = digest.digest('hex');
			await this.runExchangeStreamOperationWithRetry(() => this.sendExchangeMessage(target, {
				__reactorStream: true,
				phase: 'end',
				streamId,
				chunks,
				totalBytes,
				digestSha256,
			}, exchangeDispatchOptions), `stream-end:${streamId}`, retryConfig);

			return {
				target: String(target || '').trim().toLowerCase(),
				via: 'exchange',
				deliveredVia: 'EXCHANGE',
				streamId,
				chunks,
				totalBytes,
				digestSha256,
				resumed: resumeCount > 0,
				resumeCount,
			};
		} finally {
			releaseQueuedStart();
		}
	}

	/**
	 * Invia una richiesta HTTPS a /message con rejectUnauthorized: false
	 * (supporta certificati self-signed).
	 */
	_sendHttpsMessage(host, port, payload, contentType, reactorName, senderId, extraHeaders, timeoutMs = 5000) {
		return new Promise((resolve, reject) => {
			const https = require('https');
			const body = Buffer.isBuffer(payload)
				? payload
				: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload) ?? '', 'utf8');

			const options = {
				hostname: host,
				port,
				path: '/message',
				method: 'POST',
				rejectUnauthorized: false, // accetta self-signed
				headers: {
					'content-type': contentType,
					'content-length': String(body.length),
					'Reactor-Name': reactorName || '',
					'Reactor-Sender': senderId || '',
					...extraHeaders,
				},
			};

			const req = https.request(options, (res) => {
				let data = '';
				res.on('data', (chunk) => { data += chunk; });
				res.on('end', () => {
					const statusCode = Number(res.statusCode || 0);
					const statusText = statusCode >= 200 && statusCode < 300
						? 'OK'
						: (statusCode >= 500 ? 'Server Error' : (statusCode >= 400 ? 'Client Error' : 'Unknown'));
					resolve({ statusCode, statusText, headers: res.headers, body: data });
				});
			});

			req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTPS request timeout')));
			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}

	createEndpointCoreApi(endpointName, envConfig = {}) {
		const requestCtor = this.runtimeApi.HttpClient && this.runtimeApi.HttpClient.Request;
		const sendRequest = this.runtimeApi.HttpClient && this.runtimeApi.HttpClient.sendRequest;
		const envEntries = envConfig && typeof envConfig === 'object' && !Array.isArray(envConfig) ? envConfig : {};

		function RequestFactory(method, url, body = null, headers = {}) {
			return new requestCtor(method, url, body, headers);
		}

		const parseUnitExpression = (input, unitTable) => {
			const raw = String(input == null ? '' : input).trim();
			if (!raw) {
				throw new Error('Unit conversion requires a value');
			}

			const compact = raw.replace(/,/g, '.').replace(/\s+/g, ' ').trim();
			const tokenMatcher = /([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;
			let total = 0;
			let matched = false;
			let match = null;

			while ((match = tokenMatcher.exec(compact)) !== null) {
				const amount = Number(match[1]);
				const unit = String(match[2] || '').toLowerCase();
				const multiplier = unitTable[unit];
				if (!Number.isFinite(amount) || !Number.isFinite(multiplier)) {
					throw new Error(`Invalid unit token: ${match[0]}`);
				}
				total += amount * multiplier;
				matched = true;
			}

			if (matched) {
				const leftover = compact.replace(tokenMatcher, '').replace(/\s+/g, '');
				if (leftover) {
					throw new Error(`Invalid unit expression: ${raw}`);
				}
				return total;
			}

			const numeric = Number(compact);
			if (Number.isFinite(numeric)) {
				return numeric;
			}

			throw new Error(`Invalid unit expression: ${raw}`);
		};

		const unitApi = {
			Byte: {
				conv: (value) => parseUnitExpression(value, {
					b: 1,
					byte: 1,
					bytes: 1,
					kb: 1024,
					mb: 1024 * 1024,
					gb: 1024 * 1024 * 1024,
					tb: 1024 * 1024 * 1024 * 1024,
				}),
			},
			Second: {
				conv: (value) => parseUnitExpression(value, {
					s: 1,
					sec: 1,
					secs: 1,
					second: 1,
					seconds: 1,
					m: 60,
					min: 60,
					mins: 60,
					minute: 60,
					minutes: 60,
					h: 3600,
					hr: 3600,
					hrs: 3600,
					hour: 3600,
					hours: 3600,
					d: 86400,
					day: 86400,
					days: 86400,
				}),
			},
		}

		const timeApi = {
			at: (expression = 'now') => {
				const nowSeconds = Math.floor(Date.now() / 1000);
				const raw = String(expression == null ? '' : expression).trim();
				const normalized = raw.replace(/\s+/g, ' ');
				const match = normalized.match(/^now(?:\s*([+-])\s*(.+))?$/i);

				if (!match) {
					throw new Error(`Invalid Time.at expression: ${raw}`);
				}

				const operator = match[1] || '';
				const deltaExpression = String(match[2] || '').trim();
				if (!operator) {
					return nowSeconds;
				}

				if (!deltaExpression) {
					throw new Error(`Invalid Time.at expression: ${raw}`);
				}

				const deltaSeconds = parseUnitExpression(deltaExpression, {
					s: 1,
					sec: 1,
					secs: 1,
					second: 1,
					seconds: 1,
					m: 60,
					min: 60,
					mins: 60,
					minute: 60,
					minutes: 60,
					h: 3600,
					hr: 3600,
					hrs: 3600,
					hour: 3600,
					hours: 3600,
					d: 86400,
					day: 86400,
					days: 86400,
				});

				if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
					throw new Error(`Invalid Time.at expression: ${raw}`);
				}

				const signedDelta = operator === '-' ? -deltaSeconds : deltaSeconds;
				return Math.floor(nowSeconds + signedDelta);
			},
			now: () => timeApi.at('now'),
		};

		const httpClient = {
			...(this.runtimeApi.HttpClient || {}),
			Request: RequestFactory,
			sendRequest: async (request, timeout = null) => {
				const response = await sendRequest(request, timeout);
				if (!response || typeof response !== 'object') {
					return response;
				}

				const normalizeHeaders = (headers) => {
					const normalized = Object.create(null);
					const source = headers && typeof headers === 'object' ? headers : {};
					for (const [rawName, rawValue] of Object.entries(source)) {
						const key = String(rawName || '').trim().toLowerCase();
						if (!key) {
							continue;
						}

						if (Array.isArray(rawValue)) {
							normalized[key] = rawValue.map((value) => String(value == null ? '' : value)).join(', ');
						} else {
							normalized[key] = String(rawValue == null ? '' : rawValue);
						}
					}

					Object.defineProperty(normalized, 'get', {
						enumerable: false,
						value: (name) => {
							const target = String(name || '').trim().toLowerCase();
							if (!target) {
								return undefined;
							}

							return Object.prototype.hasOwnProperty.call(normalized, target)
								? normalized[target]
								: undefined;
						},
					});

					return normalized;
				};

				const normalizedResponse = {
					...response,
					headers: normalizeHeaders(response.headers),
				};

				const responseBody = normalizedResponse.body;
				if (responseBody && typeof responseBody[Symbol.asyncIterator] === 'function') {
					return normalizedResponse;
				}

				if (typeof responseBody === 'string' && fileSystemFacade.Entry.isFile(responseBody)) {
					return {
						...normalizedResponse,
						body: new fileSystemFacade.ReadableStream(responseBody).open(),
					};
				}

				return normalizedResponse;
			},
		};

		const createReadableFileHandle = (filePath, options = {}) => {
			const safePath = String(filePath || '').trim();
			if (!safePath) {
				throw new Error('ReadableStream requires a file path');
			}

			const safeOptions = options && typeof options === 'object' ? options : {};
			const runtimeFileCtor = this.runtimeApi.FileSystem.File;
			const readHandle = {
				__type: 'ReadableStream',
				mode: 'r',
				__path: safePath,
				[Symbol.asyncIterator]: async function* () {
					const fileInstance = new runtimeFileCtor(safePath);
					const readOptions = { ...safeOptions };
					delete readOptions.mode;
					delete readOptions.append;

					if (fileInstance && typeof fileInstance.open === 'function') {
						const opened = fileInstance.open(readOptions);
						if (opened && typeof opened[Symbol.asyncIterator] === 'function') {
							for await (const chunk of opened) {
								yield chunk;
							}
							return;
						}
					}

					if (fsNative && typeof fsNative.createReadStream === 'function') {
						const fallbackStream = fsNative.createReadStream(safePath, readOptions);
						for await (const chunk of fallbackStream) {
							yield chunk;
						}
						return;
					}

					throw new Error('File.open not supported on this platform');
				},
			};

			readHandle.open = () => readHandle;
			return readHandle;
		};

		const createWritableFileHandle = (filePath, options = {}) => {
			const safePath = String(filePath || '').trim();
			if (!safePath) {
				throw new Error('WritableStream requires a file path');
			}

			if (!fsNative || typeof fsNative.createWriteStream !== 'function') {
				throw new Error('File.open write mode not supported on this platform');
			}

			const safeOptions = options && typeof options === 'object' ? options : {};
			fsNative.mkdirSync(path.dirname(safePath), { recursive: true });
			const appendMode = Boolean(safeOptions.append);
			const nativeWriteStream = fsNative.createWriteStream(safePath, {
				flags: appendMode ? 'a' : 'w',
			});

			const writableHandle = {
				__type: 'WritableStream',
				mode: 'w',
				__path: safePath,
				__native: nativeWriteStream,
				write: async (chunk) => {
					await new Promise((resolve, reject) => {
						nativeWriteStream.write(chunk, (error) => {
							if (error) {
								reject(error);
								return;
							}
							resolve();
						});
					});
				},
				close: async () => {
					await new Promise((resolve, reject) => {
						nativeWriteStream.end((error) => {
							if (error) {
								reject(error);
								return;
							}
							resolve();
						});
					});
				},
				getWriter: () => ({
					write: (chunk) => writableHandle.write(chunk),
					close: () => writableHandle.close(),
					releaseLock: () => {},
				}),
			};

			writableHandle.open = () => writableHandle;
			return writableHandle;
		};

		class CoreReadableStream {
			constructor(filePath) {
				this.filePath = String(filePath || '').trim();
				if (!this.filePath) {
					throw new Error('ReadableStream requires a file path');
				}
			}

			open(options = {}) {
				const safeOptions = options && typeof options === 'object' ? options : {};
				return createReadableFileHandle(this.filePath, {
					...safeOptions,
					mode: 'read',
				});
			}
		}

		const fileFacade = {
			open: (filePath, options = {}) => {
				const safePath = String(filePath || '').trim();
				if (!safePath) {
					throw new Error('File.open requires a file path');
				}

				const safeOptions = options && typeof options === 'object' ? options : {};
				const openMode = String(safeOptions.mode || 'read').trim().toLowerCase();

				if (openMode === 'write') {
					return createWritableFileHandle(safePath, safeOptions);
				}

				return new CoreReadableStream(safePath).open(safeOptions);
			},
			copyStream: async (inputStream, outputStream) => {
				if (!inputStream || !outputStream) {
					throw new Error('File.copyStream requires input and output streams');
				}

				if (
					outputStream
					&& typeof outputStream === 'object'
					&& String(outputStream.__type || '') === 'WritableStream'
					&& outputStream.__native
				) {
					await pipeline(inputStream, outputStream.__native);
					return true;
				}

				if (typeof outputStream.getWriter === 'function') {
					const writer = outputStream.getWriter();
					try {
						for await (const chunk of inputStream) {
							await writer.write(chunk);
						}
						await writer.close();
						return true;
					} finally {
						writer.releaseLock();
					}
				}

				await pipeline(inputStream, outputStream);
				return true;
			},
			delete: async (filePath) => {
				const safePath = String(filePath || '').trim();
				if (!safePath) {
					throw new Error('File.delete requires a file path');
				}

				const runtimeFileCtor = this.runtimeApi.FileSystem.File;
				const fileInstance = new runtimeFileCtor(safePath);
				if (!fileInstance || typeof fileInstance.delete !== 'function') {
					throw new Error('File.delete not supported on this platform');
				}

				return Boolean(await fileInstance.delete());
			},
		};

		const fileSystemFacade = {
			...(this.runtimeApi.FileSystem || {}),
			File: Object.assign(this.runtimeApi.FileSystem.File, {
				open: (filePath, options = {}) => fileFacade.open(filePath, options),
				copyStream: (inputStream, outputStream) => fileFacade.copyStream(inputStream, outputStream),
				delete: (filePath) => fileFacade.delete(filePath),
			}),
			ReadableStream: CoreReadableStream,
		};

		const resolveWebCrypto = () => {
			if (globalThis.crypto && globalThis.crypto.subtle) {
				return globalThis.crypto;
			}

			if (crypto.webcrypto && crypto.webcrypto.subtle) {
				return crypto.webcrypto;
			}

			throw new Error('Sekrypt API requires WebCrypto support');
		};

		const encodeBase64 = (bytes) => {
			if (typeof Buffer !== 'undefined') {
				return Buffer.from(bytes).toString('base64');
			}

			let binary = '';
			for (const byte of bytes) {
				binary += String.fromCharCode(byte);
			}
			return btoa(binary);
		};

		const decodeBase64ToBytes = (value) => {
			const normalized = String(value || '').trim();
			if (!normalized) {
				return new Uint8Array(0);
			}

			if (typeof Buffer !== 'undefined') {
				return new Uint8Array(Buffer.from(normalized, 'base64'));
			}

			const binary = atob(normalized);
			const out = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index += 1) {
				out[index] = binary.charCodeAt(index);
			}
			return out;
		};

		const decodePemContent = (pem, kind = 'key') => {
			const stripped = String(pem || '')
				.replace(/-----BEGIN [^-]+-----/g, '')
				.replace(/-----END [^-]+-----/g, '')
				.replace(/\s+/g, '');

			if (!stripped) {
				throw new Error(`Invalid ${kind}`);
			}

			return decodeBase64ToBytes(stripped);
		};

		const chunkToBytes = (chunk) => {
			if (chunk instanceof Uint8Array) {
				return chunk;
			}

			if (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk)) {
				return new Uint8Array(chunk);
			}

			if (chunk instanceof ArrayBuffer) {
				return new Uint8Array(chunk);
			}

			if (ArrayBuffer.isView(chunk)) {
				return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			}

			if (typeof chunk === 'string') {
				return new TextEncoder().encode(chunk);
			}

			return new TextEncoder().encode(String(chunk ?? ''));
		};

		const readAllBytesFromStream = async (stream) => {
			const chunks = [];
			let total = 0;

			if (stream && typeof stream.getReader === 'function') {
				const reader = stream.getReader();
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (done) {
							break;
						}

						const bytes = chunkToBytes(value);
						chunks.push(bytes);
						total += bytes.byteLength;
					}
				} finally {
					reader.releaseLock();
				}
			} else if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
				for await (const chunk of stream) {
					const bytes = chunkToBytes(chunk);
					chunks.push(bytes);
					total += bytes.byteLength;
				}
			} else {
				throw new Error('Sekrypt requires a readable stream');
			}

			const merged = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.byteLength;
			}

			return merged;
		};

		const buildSingleChunkStream = (bytes) => ({
			__type: 'EncryptedStream',
			async *[Symbol.asyncIterator]() {
				yield bytes;
			},
		});

		const encodeCryptoPayload = (cryptoValue) => {
			const json = JSON.stringify(cryptoValue);
			const bytes = new TextEncoder().encode(json);
			return encodeBase64(bytes);
		};

		const decodeCryptoPayload = (cryptoValue) => {
			const bytes = decodeBase64ToBytes(cryptoValue);
			const json = new TextDecoder().decode(bytes);
			return JSON.parse(json);
		};

		const normalizeCryptoMetadata = (cryptoValue) => {
			if (typeof cryptoValue === 'string') {
				return decodeCryptoPayload(cryptoValue);
			}

			if (cryptoValue && typeof cryptoValue === 'object') {
				return cryptoValue;
			}

			throw new Error('Sekrypt.decryptFile requires valid crypto metadata');
		};

		const importPrivateKey = async (subtle, privateKeyPem) => {
			const privateKeyBytes = decodePemContent(privateKeyPem, 'private key');
			return subtle.importKey(
				'pkcs8',
				privateKeyBytes,
				{ name: 'RSA-OAEP', hash: 'SHA-256' },
				false,
				['decrypt'],
			);
		};

		const requireBase64Field = (metadata, key, contextName) => {
			const value = String(metadata?.[key] || '').trim();
			if (!value) {
				throw new Error(`Sekrypt.decryptFile requires ${contextName}`);
			}
			return decodeBase64ToBytes(value);
		};

		const decryptAesGcm = async (subtle, cipherBytes, keyBytes, ivBytes) => {
			const aesKey = await subtle.importKey(
				'raw',
				keyBytes,
				{ name: 'AES-GCM', length: 256 },
				false,
				['decrypt'],
			);

			return subtle.decrypt(
				{ name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
				aesKey,
				cipherBytes,
			);
		};

		const resolveResourceCrypto = async (subtle, cryptoValue, privateKeyPem) => {
			const metadata = normalizeCryptoMetadata(cryptoValue);
			const type = String(metadata?.type || '').toLowerCase();
			const resourceIv = requireBase64Field(metadata, 'resourceIV', 'crypto.resourceIV');
			const privateKey = await importPrivateKey(subtle, privateKeyPem);

			if (type === 'user') {
				const encryptedResourceKey = requireBase64Field(metadata, 'encResourceKey', 'crypto.encResourceKey');
				const resourceKey = await subtle.decrypt(
					{ name: 'RSA-OAEP' },
					privateKey,
					encryptedResourceKey,
				);

				return {
					resourceIv,
					resourceKey: new Uint8Array(resourceKey),
				};
			}

			if (type === 'group') {
				const encryptedGroupKey = requireBase64Field(metadata, 'encGroupKey', 'crypto.encGroupKey');
				const resourceGroupIv = requireBase64Field(metadata, 'resourceGroupIV', 'crypto.resourceGroupIV');
				const encryptedResourceGroupKey = requireBase64Field(metadata, 'encResourceGroupKey', 'crypto.encResourceGroupKey');

				const groupKey = await subtle.decrypt(
					{ name: 'RSA-OAEP' },
					privateKey,
					encryptedGroupKey,
				);

				const resourceKey = await decryptAesGcm(
					subtle,
					encryptedResourceGroupKey,
					new Uint8Array(groupKey),
					resourceGroupIv,
				);

				return {
					resourceIv,
					resourceKey: new Uint8Array(resourceKey),
				};
			}

			throw new Error(`Sekrypt.decryptFile unsupported crypto type: ${type || 'unknown'}`);
		};

		const encryptionFacade = {
			encodeCrypto: (cryptoValue) => encodeCryptoPayload(cryptoValue),
			decodeCrypto: (cryptoValue) => decodeCryptoPayload(cryptoValue),
			encryptFile: async (stream, publicKey) => {
				const cryptoApi = resolveWebCrypto();
				const subtle = cryptoApi.subtle;

				const plainBytes = await readAllBytesFromStream(stream);
				const publicKeyBytes = decodePemContent(publicKey);

				const importedPublicKey = await subtle.importKey(
					'spki',
					publicKeyBytes,
					{ name: 'RSA-OAEP', hash: 'SHA-256' },
					false,
					['encrypt'],
				);

				const aesKey = await subtle.generateKey(
					{ name: 'AES-GCM', length: 256 },
					true,
					['encrypt', 'decrypt'],
				);

				const rawAesKey = await subtle.exportKey('raw', aesKey);
				const resourceIv = cryptoApi.getRandomValues(new Uint8Array(12));

				const encryptedContent = await subtle.encrypt(
					{ name: 'AES-GCM', iv: resourceIv, tagLength: 128 },
					aesKey,
					plainBytes,
				);

				const encryptedResourceKey = await subtle.encrypt(
					{ name: 'RSA-OAEP' },
					importedPublicKey,
					rawAesKey,
				);

				return {
					content: buildSingleChunkStream(new Uint8Array(encryptedContent)),
					crypto: {
						type: 'user',
						resourceIV: encodeBase64(resourceIv),
						encResourceKey: encodeBase64(new Uint8Array(encryptedResourceKey)),
					},
				};
			},
			decryptFile: async (stream, cryptoValue, privateKey) => {
				const cryptoApi = resolveWebCrypto();
				const subtle = cryptoApi.subtle;

				const encryptedBytes = await readAllBytesFromStream(stream);
				const { resourceIv, resourceKey } = await resolveResourceCrypto(subtle, cryptoValue, privateKey);

				const decryptedContent = await decryptAesGcm(
					subtle,
					encryptedBytes,
					resourceKey,
					resourceIv,
				);

				return buildSingleChunkStream(new Uint8Array(decryptedContent));
			},
		};

		const normalizeEventPath = (rawPath) => normalizeWatchEventPath(rawPath);

		class Event {
			constructor(type, data = {}, timestamp = new Date().toISOString()) {
				this.type = String(type || '').trim().toUpperCase();
				this.data = data && typeof data === 'object' ? data : {};
				this.timestamp = String(timestamp || new Date().toISOString());
				Object.freeze(this.data);
				Object.freeze(this);
			}
		}

		class WatchEvent extends Event {
			constructor(data = {}, timestamp) {
				const normalizedWatchPath = normalizeEventPath(data.watchPath);
				const normalizedEntryPath = normalizeEventPath(data.entryPath || data.path || (normalizedWatchPath && data.relativePath ? `${normalizedWatchPath}/${data.relativePath}` : ''));
				const computedRelativePath = computeWatchRelativePath(normalizedEntryPath, normalizedWatchPath);
				const resolvedRelativePath = normalizedEntryPath
					? computedRelativePath
					: String(data.relativePath || computedRelativePath);
				super('WATCH', {
					watchPath: normalizedWatchPath,
					entryPath: normalizedEntryPath,
					relativePath: resolvedRelativePath,
					watchType: data.watchType || null,
				}, timestamp);
			}

			get watchPath() {
				return this.data.watchPath;
			}

			get relativePath() {
				return this.data.relativePath;
			}

			get watchType() {
				return this.data.watchType;
			}
		}

		class MessageEvent extends Event {
			constructor(data = {}, timestamp) {
				super('MESSAGE', {
					sender: data.sender || null,
					senderName: data.senderName || null,
					target: data.target || null,
					targetNode: data.targetNode || null,
					targetEndpoint: data.targetEndpoint || null,
					targetEndpointId: data.targetEndpointId || null,
					content: data.content || '',
					contentType: data.contentType || '',
					bodyBase64: data.bodyBase64 || '',
					json: data.json === undefined ? null : data.json,
					headers: data.headers && typeof data.headers === 'object' ? data.headers : {},
				}, timestamp);
			}
		}

		class StreamEvent extends Event {
			constructor(data = {}, timestamp) {
				super('STREAM', {
					sender: data.sender || null,
					senderName: data.senderName || null,
					target: data.target || null,
					targetNode: data.targetNode || null,
					targetEndpoint: data.targetEndpoint || null,
					targetEndpointId: data.targetEndpointId || null,
					content: data.content || '',
					contentType: data.contentType || '',
					bodyBase64: data.bodyBase64 || '',
					json: data.json === undefined ? null : data.json,
					headers: data.headers && typeof data.headers === 'object' ? data.headers : {},
					stream: data.stream || null,
				}, timestamp);
			}
		}

		class StreamEndEvent extends Event {
			constructor(data = {}, timestamp) {
				const resolvedTmpPath = String(
					data.tmpPath
					|| (
						data.streamEnd && typeof data.streamEnd.getPath === 'function'
							? data.streamEnd.getPath()
							: ''
					)
					|| '',
				);
				const resolvedMetadata = data.metadata && typeof data.metadata === 'object'
					? data.metadata
					: (
						data.streamEnd && typeof data.streamEnd.getMetadata === 'function'
							? data.streamEnd.getMetadata()
							: {}
					);
				super('STREAMEND', {
					sender: data.sender || null,
					senderName: data.senderName || null,
					target: data.target || null,
					targetNode: data.targetNode || null,
					targetEndpoint: data.targetEndpoint || null,
					targetEndpointId: data.targetEndpointId || null,
					content: data.content || '',
					contentType: data.contentType || '',
					bodyBase64: data.bodyBase64 || '',
					json: data.json === undefined ? null : data.json,
					headers: data.headers && typeof data.headers === 'object' ? data.headers : {},
					metadata: resolvedMetadata,
					tmpPath: resolvedTmpPath,
					streamEnd: data.streamEnd || null,
				}, timestamp);
			}

			get metadata() {
				return this.data.metadata;
			}

			get tmpPath() {
				return this.data.tmpPath;
			}
		}

		class ScheduleEvent extends Event {
			constructor(data = {}, timestamp) {
				super('SCHEDULE', {
					expression: data.expression || null,
				}, timestamp);
			}
		}

		class RuntimeEvent extends Event {
			constructor(data = {}, timestamp) {
				super('EVENT', {
					name: data.name || null,
					networkChange: data.networkChange || null,
				}, timestamp);
			}

			get name() {
				return this.data.name;
			}
		}

		class ManualEvent extends Event {
			constructor(data = {}, timestamp) {
				super('MANUAL_TEST', {
					reason: data.reason || 'ON_DEMAND',
				}, timestamp);
			}
		}

		const createEventFromContext = (context = {}) => {
			const trigger = String(context.trigger || '').trim().toUpperCase();
			switch (trigger) {
				case 'WATCH':
					return new WatchEvent({
						watchPath: context.watchPath || '',
						entryPath: context.watchEntryPath || '',
						relativePath: context.watchRelativePath || '',
						watchType: context.watchType || null,
					});
				case 'MESSAGE':
					return new MessageEvent({
						sender: context.messageSender || null,
						senderName: context.messageSenderName || null,
						target: context.messageTarget || null,
						targetNode: context.messageTargetNode || null,
						targetEndpoint: context.messageTargetEndpoint || null,
						targetEndpointId: context.messageTargetEndpointId || null,
						content: context.messageContent || '',
						contentType: context.messageContentType || '',
						bodyBase64: context.messageBodyBase64 || '',
						json: context.messageJson === undefined ? null : context.messageJson,
						headers: context.messageHeaders || {},
					});
				case 'STREAM':
					return new StreamEvent({
						sender: context.messageSender || null,
						senderName: context.messageSenderName || null,
						target: context.messageTarget || null,
						targetNode: context.messageTargetNode || null,
						targetEndpoint: context.messageTargetEndpoint || null,
						targetEndpointId: context.messageTargetEndpointId || null,
						content: context.messageContent || '',
						contentType: context.messageContentType || '',
						bodyBase64: context.messageBodyBase64 || '',
						json: context.messageJson === undefined ? null : context.messageJson,
						headers: context.messageHeaders || {},
						stream: context.stream || null,
					});
				case 'STREAMEND':
					return new StreamEndEvent({
						sender: context.messageSender || null,
						senderName: context.messageSenderName || null,
						target: context.messageTarget || null,
						targetNode: context.messageTargetNode || null,
						targetEndpoint: context.messageTargetEndpoint || null,
						targetEndpointId: context.messageTargetEndpointId || null,
						content: context.messageContent || '',
						contentType: context.messageContentType || '',
						bodyBase64: context.messageBodyBase64 || '',
						json: context.messageJson === undefined ? null : context.messageJson,
						headers: context.messageHeaders || {},
						metadata: context.streamEnd && typeof context.streamEnd.getMetadata === 'function'
							? context.streamEnd.getMetadata()
							: (context.streamEndMetadata || {}),
						tmpPath: context.streamEnd && typeof context.streamEnd.getPath === 'function'
							? context.streamEnd.getPath()
							: (context.streamEndPath || null),
						streamEnd: context.streamEnd || null,
					});
				case 'SCHEDULE':
					return new ScheduleEvent({
						expression: context.expression || null,
					});
				case 'EVENT':
					return new RuntimeEvent({
						name: context.event || null,
						networkChange: context.networkChange || null,
					});
				case 'MANUAL_TEST':
					return new ManualEvent({
						reason: context.event || 'ON_DEMAND',
					});
				default:
					return new Event(trigger || 'UNKNOWN', {
						...context,
					});
			}
		};

		return {
			Event,
			WatchEvent,
			MessageEvent,
			StreamEvent,
			StreamEndEvent,
			ScheduleEvent,
			RuntimeEvent,
			ManualEvent,
			__createEventFromContext: createEventFromContext,
			Node: {
				getHomeDirectory: async () => {
					if (!this.runtimeApi.System || typeof this.runtimeApi.System.getHomeDirectory !== 'function') {
						throw new Error('Node.getHomeDirectory not supported on this platform');
					}

					const rawHomeDirectory = await this.runtimeApi.System.getHomeDirectory();
					const normalizedHomeDirectory = String(rawHomeDirectory || '').replace(/\\/g, '/');
					if (!normalizedHomeDirectory) {
						return '';
					}

					if (normalizedHomeDirectory === '/' || /^[A-Za-z]:\/$/.test(normalizedHomeDirectory)) {
						return normalizedHomeDirectory;
					}

					return normalizedHomeDirectory.replace(/\/+$/, '');
				},
				sendMessage: async (target, content, optionsOrEnqueueOnFail = false) => {
					let headers = {};
					let enqueueOnFail = false;

					if (typeof optionsOrEnqueueOnFail === 'boolean') {
						enqueueOnFail = optionsOrEnqueueOnFail;
					} else if (optionsOrEnqueueOnFail && typeof optionsOrEnqueueOnFail === 'object') {
						headers = optionsOrEnqueueOnFail.headers || {};
						enqueueOnFail = Boolean(optionsOrEnqueueOnFail.enqueueOnFail);
					}

					return this.sendNodeMessage(target, content, headers, { enqueueOnFail });
				},
				stream: async (target, source, options = {}) => {
					return this.streamToNode(target, source, options);
				},
				exchange: () => ({
					sendMessage: async (target, content) => {
						if (this.exchangeMode !== 'node') {
							throw new Error('exchange routing is available only when REACTOR_WORKING_MODE=node');
						}
						return this.sendExchangeMessage(target, content);
					},
					stream: async (target, source, options = {}) => {
						if (this.exchangeMode !== 'node') {
							throw new Error('exchange routing is available only when REACTOR_WORKING_MODE=node');
						}
						return this.streamToExchange(target, source, options);
					},
				}),
			},
			File: fileFacade,
			api: this.runtimeApi,
			FileSystem: fileSystemFacade,
			HttpClient: httpClient,
			Sekrypt: encryptionFacade,
			Unit: unitApi,
			Time: timeApi,
			Device: this.runtimeApi.Device,
			System: this.runtimeApi.System,
			Env: {
				get: (name, defaultValue = '') => {
					const safeName = String(name || '').trim();
					if (!safeName) {
						return String(defaultValue == null ? '' : defaultValue);
					}

					if (Object.prototype.hasOwnProperty.call(envEntries, safeName)) {
						return String(envEntries[safeName] == null ? '' : envEntries[safeName]);
					}

					return String(defaultValue == null ? '' : defaultValue);
				},
			},
			log: async (message) => {
				this.log(`${endpointName}: ${message}`);
			},
		};
	}

	async handleHttpRequest(req, res) {
		const method = String(req.method || 'GET').toUpperCase();
		let pathname = '/';
		let query = '';
		let queryParams = {};

		try {
			const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
			pathname = parsedUrl.pathname || '/';
			query = parsedUrl.search || '';
			queryParams = Object.fromEntries(parsedUrl.searchParams.entries());
		} catch {
			pathname = '/';
			query = '';
			queryParams = {};
		}

		if (method === 'GET' && pathname === '/') {
			this.addHttpServerLog('GET / -> 200');
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					service: 'reactor',
					status: 'healthy',
					timestamp: new Date().toISOString(),
					uptimeSec: Math.floor(process.uptime()),
					httpPort: this.httpServerPort,
					endpointsCount: this.endpoints.length,
				}),
			);
			return;
		}

		if (method === 'GET' && pathname === '/endpoints') {
			if (String(this.exchangeAuthToken || '').trim() && !this.isExchangeDiscoveryRequestAuthorized(req.headers || {})) {
				this.addHttpServerLog('GET /endpoints -> 401 (invalid bearer token)');
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
				return;
			}

			const endpoints = this.getDiscoveryEndpointEntries();
			const nodeName = await this.getReactorName();
			this.addHttpServerLog(`GET /endpoints -> 200 endpoints=${endpoints.length}`);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					node: nodeName,
					generatedAt: new Date().toISOString(),
					total: endpoints.length,
					endpoints,
				}),
			);
			return;
		}

		if (method === 'GET' && pathname === this.exchangeDiscoveryEndpointPath) {
			if (this.exchangeMode !== 'exchange') {
				this.addHttpServerLog(`GET ${pathname} -> 403 (disabled in mode=${this.exchangeMode})`);
				res.writeHead(403, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						ok: false,
						error: 'endpoint available only in exchange mode',
						mode: this.exchangeMode,
					}),
				);
				return;
			}

			if (!this.exchangeDiscoveryEndpointEnabled) {
				this.addHttpServerLog(`GET ${pathname} -> 404 (endpoint disabled)`);
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'endpoint not found' }));
				return;
			}

			if (!String(this.exchangeAuthToken || '').trim()) {
				this.addHttpServerLog(`GET ${pathname} -> 503 (token not configured)`);
				res.writeHead(503, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'exchange token not configured' }));
				return;
			}

			if (!this.isExchangeDiscoveryRequestAuthorized(req.headers || {})) {
				this.addHttpServerLog(`GET ${pathname} -> 401 (invalid bearer token)`);
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
				return;
			}

			const nodes = this.exchangeManager && typeof this.exchangeManager.getConnectedClientsDiscoveryEndpointEntries === 'function'
				? this.exchangeManager.getConnectedClientsDiscoveryEndpointEntries(Date.now())
				: [];
			const nodesWithEndpoints = await this.enrichDiscoveryNodesWithEndpoints(nodes);

			this.addHttpServerLog(`GET ${pathname} -> 200 nodes=${nodesWithEndpoints.length}`);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					mode: this.exchangeMode,
					endpoint: this.exchangeDiscoveryEndpointPath,
					generatedAt: new Date().toISOString(),
					total: nodesWithEndpoints.length,
					nodes: nodesWithEndpoints,
				}),
			);
			return;
		}

		if (method === 'POST' && pathname === '/message') {
			if (this.exchangeMode !== 'node') {
				this.addHttpServerLog(`POST /message -> 403 (disabled in mode=${this.exchangeMode})`);
				res.writeHead(403, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						ok: false,
						error: 'endpoint disabled in current working mode',
						mode: this.exchangeMode,
					}),
				);
				return;
			}

			const bodyChunks = [];
			for await (const chunk of req) {
				bodyChunks.push(chunk);
			}
			const rawBuffer = Buffer.concat(bodyChunks);
			const body = this.parseMessageBody(req, rawBuffer);
			const senderMeta = this.resolveSenderCandidates(req);
			const dispatch = await this.dispatchIncomingMessageEnvelope(body, senderMeta, req.headers || {});

			this.addHttpServerLog(
				`POST /message sender=${senderMeta.rawSender || senderMeta.rawName || senderMeta.remoteHost || 'unknown'} -> ${Array.isArray(dispatch?.endpoints) ? dispatch.endpoints.length : 0} endpoint(s)`,
			);

			const statusCode = dispatch && dispatch.delivered ? 200 : 202;
			res.writeHead(statusCode, { 'content-type': 'application/json' });
			res.end(JSON.stringify(dispatch || { ok: false, error: 'dispatch failed' }));
			return;
		}

		this.addHttpServerLog(`${method} ${pathname} -> 404`);
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: false, error: 'endpoint not found', method, path: pathname }));
	}

	async startHttpServer() {
		if (this.httpServer) {
			return;
		}

		const requestHandler = (req, res) => {
			this.handleHttpRequest(req, res).catch((error) => {
				this.addHttpServerLog(`request handling failed: ${error.message}`);
				res.writeHead(500, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'internal server error' }));
			});
		};

		// Tenta di usare HTTPS se esiste un certificato TLS
		const tlsCert = await this.tlsManager.loadCert();

		await new Promise((resolve, reject) => {
			let server;
			if (tlsCert) {
				const https = require('https');
				server = https.createServer({ cert: tlsCert.cert, key: tlsCert.key }, requestHandler);
			} else {
				server = http.createServer(requestHandler);
			}

			server.once('error', reject);
			server.listen(this.httpServerPort, () => {
				server.off('error', reject);
				this.httpServer = server;
				this.tlsEnabled = Boolean(tlsCert);
				const proto = tlsCert ? 'HTTPS' : 'HTTP';
				const tlsLabel = tlsCert ? 'TLS enabled (certificate loaded)' : 'TLS disabled (no certificate found)';
				this.addHttpServerLog(`listening on port ${this.httpServerPort} (${proto}) - ${tlsLabel}`);
				resolve();
			});
		});
	}

	async stopHttpServer() {
		if (!this.httpServer) {
			return;
		}

		const server = this.httpServer;
		this.httpServer = null;
		await new Promise((resolve) => server.close(() => resolve()));
		this.addHttpServerLog('stopped');
	}

	async restartHttpServer() {
		await this.stopHttpServer();
		await this.startHttpServer();
	}

	findEndpointByPath(filePath) {
		const normalizedFilePath = path.resolve(filePath || '');
		return this.endpoints.find((candidate) => path.resolve(candidate.path) === normalizedFilePath) || null;
	}

	resolveEndpointEventLogPath(filePath) {
		const endpoint = this.findEndpointByPath(filePath);
		if (endpoint && endpoint.eventLogPath) {
			return endpoint.eventLogPath;
		}

		if (!filePath) {
			return this.eventLogPath;
		}

		const normalizedFilePath = path.resolve(filePath);
		return path.join(path.dirname(normalizedFilePath), 'activity.log');
	}

	log(message) {
		console.log(`[Reactor] ${message}`);
	}

	buildReadableGlobalLogLine(category, message) {
		const safeCategory = String(category || 'LOG').trim() || 'LOG';
		const safeMessage = String(message || '').trim() || '-';
		return `${new Date().toISOString()} [${safeCategory}] ${safeMessage}`;
	}

	formatEventLogLine(entry) {
		if (typeof entry === 'string') {
			const raw = entry.trim();
			if (!raw) {
				return this.buildReadableGlobalLogLine('LOG', '-');
			}
			if (!(raw.startsWith('{') && raw.endsWith('}'))) {
				return this.buildReadableGlobalLogLine('LOG', raw);
			}

			try {
				const parsed = JSON.parse(raw);
				return this.formatEventLogLine(parsed);
			} catch {
				return this.buildReadableGlobalLogLine('LOG', raw);
			}
		}

		if (!entry || typeof entry !== 'object') {
			return this.buildReadableGlobalLogLine('LOG', String(entry || '-'));
		}

		const timestamp = String(entry.timestamp || new Date().toISOString()).trim() || new Date().toISOString();
		const type = String(entry.type || 'LOG').trim().toUpperCase() || 'LOG';
		const phase = String(entry.phase || '').trim().toUpperCase();
		const category = phase ? `${type}/${phase}` : type;

		let message = String(entry.message || '').trim();
		if (!message) {
			message = String(entry.error || '').trim();
		}

		if (!message && type === 'ENDPOINT_EXECUTION') {
			const endpointName = String(entry?.endpoint?.name || '').trim() || 'unknown';
			const trigger = String(entry?.trigger || '').trim() || 'unknown';
			const event = String(entry?.event || '').trim() || 'unknown';
			message = `endpoint=${endpointName} trigger=${trigger} event=${event}`;
		}

		if (!message && type === 'MESSAGE_RECEIVED') {
			const senderName = String(entry.senderName || '').trim() || 'unknown';
			const remoteHost = String(entry.remoteHost || '').trim() || 'unknown';
			const contentType = String(entry.contentType || '').trim() || 'unknown';
			message = `sender=${senderName} remote=${remoteHost} contentType=${contentType}`;
		}

		if (!message) {
			message = JSON.stringify(entry);
		}

		if (entry.exchangeMode) {
			message = `${message} (mode=${entry.exchangeMode})`;
		}

		return `${timestamp} [${category}] ${message}`;
	}

	async logGlobalEvent(category, message) {
		await this.writeEventLog(this.eventLogPath, this.buildReadableGlobalLogLine(category, message));
	}

	async writeEventLog(logPath, entry) {
		const logLine = `${this.formatEventLogLine(entry)}\n`;
		try {
			if (this.platformServices && this.platformServices.fileWriter && this.platformServices.fileWriter.appendText) {
				await this.platformServices.fileWriter.appendText(logPath, logLine, 'utf8');
				return;
			}

			await fs.appendFile(logPath, logLine, 'utf8');
		} catch (error) {
			this.log(`Failed to write activity.log: ${error.message}`);
		}
	}

	async recordExecutionEvent({ endpoint, context, scope = 'PROJECT', phase, durationMs = null, output = null, error = null }) {
		const effectiveEndpoint = endpoint;
		if (!effectiveEndpoint) {
			return;
		}

		const logPath = effectiveEndpoint.eventLogPath || this.eventLogPath;
		await this.writeEventLog(logPath, {
			timestamp: new Date().toISOString(),
			type: 'ENDPOINT_EXECUTION',
			scope,
			phase,
			endpoint: {
				name: effectiveEndpoint.name,
				path: effectiveEndpoint.path,
				state: effectiveEndpoint.state,
			},
			trigger: context.trigger,
			event: context.event || null,
			expression: context.expression || null,
			watchPath: context.watchPath || null,
			watchEntryPath: context.watchEntryPath || context.watchPath || null,
			watchRelativePath: context.watchRelativePath || null,
			watchType: context.watchType || null,
			durationMs,
			output,
			error,
		});
	}

	async init() {
		await this.loadMessageQueueConfig();
		await this.migrateLegacyMessageQueueFileIfNeeded();
		await fs.mkdir(this.endpointsDir, { recursive: true });
		await fs.mkdir(this.streamStorageDir, { recursive: true });
		await fs.mkdir(this.messageQueueDir, { recursive: true });
		await fs.mkdir(this.streamQueueDir, { recursive: true });
		await this.loadEnvMapFromDisk();
		await this.cleanupOrphanStreamFiles();
		this.startStreamCleanupTimer();
		await this.getReactorName();
		await this.discoverEndpoints();
		this.setupSchedules();
		this.setupWatchers();
		await this.startHttpServer();
		this.setupEndpointsWatcher();
		this.setupNetworkWatcher();
		if (this.exchangeMode === 'exchange' || this.exchangeMode === 'node') {
			const internalMode = this.exchangeMode === 'exchange' ? 'exchange' : 'client';
			this.exchangeManager.configure(internalMode, this.exchangeHost, this.exchangePort, this.exchangeTls);
			await this.exchangeManager.start(this.httpServer).catch((err) => {
				this.log(`[Exchange] Avvio fallito: ${err.message}`);
			});
		}
		this.startMessageQueueFlushTimer();
		this.startStreamQueueFlushTimer();
		await this.flushMessageQueue();
		await this.flushStreamQueue();
		await this.emitEvent('BOOT');
	}

	clearSchedules() {
		for (const task of this.scheduledTasks) {
			task.cancelled = true;
			if (task.timeoutId) {
				clearTimeout(task.timeoutId);
			}
		}
		this.scheduledTasks = [];
	}

	queueReload(reason) {
		if (this.reloadDebounceTimer) {
			clearTimeout(this.reloadDebounceTimer);
		}

		this.reloadDebounceTimer = setTimeout(() => {
			this.reloadDebounceTimer = null;
			this.reloadEndpoints(reason).catch((error) => {
				this.log(`Hot reload failed: ${error.message}`);
			});
		}, 250);
	}

	async reloadEndpoints(reason) {
		if (this.isReloading) {
			this.pendingReloadReason = reason;
			return;
		}

		this.isReloading = true;
		this.log(`Hot reload endpoints (${reason})`);

		try {
			this.clearSchedules();
			await this.loadEnvMapFromDisk();

			await this.discoverEndpoints();
			this.setupSchedules();
			this.setupWatchers();
			this.log(`Hot reload complete: ${this.endpoints.length} endpoint(s) active`);
		} finally {
			this.isReloading = false;

			if (this.pendingReloadReason) {
				const nextReason = this.pendingReloadReason;
				this.pendingReloadReason = null;
				this.queueReload(nextReason);
			}
		}
	}

	setupEndpointsWatcher() {
		if (this.endpointsWatcher) {
			return;
		}

		try {
			this.endpointsWatcher = fsNative.watch(this.endpointsDir, { persistent: true }, (eventType, filename) => {
				if (!filename || String(filename).includes('node_modules')) {
					return;
				}
				this.queueReload(`${eventType}:${filename}`);
			});
			this.log(`Watching endpoints directory for hot reload: ${this.endpointsDir}`);
		} catch (error) {
			this.log(`Failed to watch endpoints directory: ${error.message}`);
		}
	}

	async collectEndpointFiles() {
		const entries = await fs.readdir(this.endpointsDir, { withFileTypes: true });
		const endpointFiles = [];

		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.ts')) {
				endpointFiles.push(path.join(this.endpointsDir, entry.name));
				continue;
			}

			if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
				continue;
			}

			const projectDir = path.join(this.endpointsDir, entry.name);
			let projectEntries;
			try {
				projectEntries = await fs.readdir(projectDir, { withFileTypes: true });
			} catch (error) {
				this.log(`Skipping ${projectDir}: ${error.message}`);
				continue;
			}

			const bootEntry = projectEntries.find((projectEntry) => projectEntry.isFile() && projectEntry.name === 'boot.ts');
			if (bootEntry) {
				endpointFiles.push(path.join(projectDir, bootEntry.name));
				continue;
			}

			for (const projectEntry of projectEntries) {
				if (projectEntry.isFile() && projectEntry.name.endsWith('.ts')) {
					endpointFiles.push(path.join(projectDir, projectEntry.name));
				}
			}
		}

		const endpointEntries = await Promise.all(
			endpointFiles.map(async (endpointPath) => ({
				path: endpointPath,
				position: await this.readEndpointPositionForFile(endpointPath),
			})),
		);

		endpointEntries.sort((a, b) => {
			const aPosition = Number.isInteger(a.position) ? a.position : Number.MAX_SAFE_INTEGER;
			const bPosition = Number.isInteger(b.position) ? b.position : Number.MAX_SAFE_INTEGER;
			if (aPosition !== bPosition) {
				return aPosition - bPosition;
			}
			return String(a.path || '').localeCompare(String(b.path || ''));
		});

		return endpointEntries;
	}

	async readEndpointPositionForFile(endpointPath) {
		try {
			const normalizedEndpointsDir = path.resolve(this.endpointsDir);
			const normalizedEndpointPath = path.resolve(endpointPath);
			const endpointDir = path.dirname(normalizedEndpointPath);
			const isProjectEndpoint = path.dirname(endpointDir) === normalizedEndpointsDir;
			if (!isProjectEndpoint) {
				return Number.MAX_SAFE_INTEGER;
			}

			const positionPath = path.join(endpointDir, 'position');
			const raw = await fs.readFile(positionPath, 'utf8');
			const parsed = Number.parseInt(String(raw || '').trim(), 10);
			if (Number.isInteger(parsed) && parsed >= 0) {
				return parsed;
			}
		} catch {
			// Keep fallback ordering when position file is missing or invalid.
		}

		return Number.MAX_SAFE_INTEGER;
	}

	async discoverEndpoints() {
		const envConfig = this.envMap;
		this.endpoints = [];
		this.eventMap.clear();
		this.messageListenerMap.clear();
		this.streamListenerMap.clear();
		this.streamEndListenerMap.clear();

		try {
			await fs.mkdir(this.endpointsDir, { recursive: true });
		} catch (error) {
			throw error;
		}

		const endpointEntries = await this.collectEndpointFiles();

		for (const endpointEntry of endpointEntries) {
			const endpointPath = endpointEntry.path;
			try {
				const source = await fs.readFile(endpointPath, 'utf8');
				const metadata = parseEndpointMetadata(source);
				const normalizedEndpointsDir = path.resolve(this.endpointsDir);
				const normalizedEndpointPath = path.resolve(endpointPath);
				const endpointDir = path.dirname(normalizedEndpointPath);
				const endpointBaseName = path.basename(normalizedEndpointPath).toLowerCase();
				const isProjectEndpoint = path.dirname(endpointDir) === normalizedEndpointsDir;
				const isProjectBootEndpoint = endpointBaseName === 'boot.ts' && isProjectEndpoint;
				const displayName = isProjectBootEndpoint ? path.basename(endpointDir) : path.basename(endpointPath);
				const projectDir = isProjectEndpoint ? endpointDir : null;
				const endpointId = projectDir ? await this.ensureProjectEndpointId(projectDir) : null;
				const coreApi = this.createEndpointCoreApi(displayName, envConfig);
				const moduleExports = loadEndpointModule(endpointPath, source, {
					virtualModules: {
						core: coreApi,
					},
				});
				const runner = moduleExports.run || moduleExports.default;

				if (typeof runner !== 'function') {
					this.log(`Skipping ${displayName}: missing exported run() or default function`);
					continue;
				}

				const endpoint = {
					path: endpointPath,
					name: displayName,
					position: Number.isInteger(endpointEntry.position)
						&& endpointEntry.position >= 0
						&& endpointEntry.position !== Number.MAX_SAFE_INTEGER
						? endpointEntry.position
						: null,
					projectDir,
					uuid: endpointId,
					endpointId: endpointId,
					createEvent: typeof coreApi.__createEventFromContext === 'function'
						? coreApi.__createEventFromContext
						: null,
					eventLogPath: path.join(path.dirname(normalizedEndpointPath), 'activity.log'),
					run: runner,
					schedule: metadata.schedule,
					events: metadata.events,
					messageSenders: metadata.messageSenders || [],
					messageFromAnySender: Boolean(metadata.messageFromAnySender),
					streamSenders: metadata.streamSenders || [],
					streamFromAnySender: Boolean(metadata.streamFromAnySender),
					streamEndSenders: metadata.streamEndSenders || [],
					streamEndFromAnySender: Boolean(metadata.streamEndFromAnySender),
					state: metadata.state,
					enabled: metadata.state !== 'DISABLED',
					debug: Boolean(metadata.debug),
					mutex: metadata.mutex,
					watch: metadata.watch || [], // Existing watch property
					watchRules: metadata.watchRules || [], // New watchRules property
					isRunning: false,
				};

				this.endpoints.push(endpoint);
				this.log(
					`Loaded ${endpoint.name} @enabled=${endpoint.enabled ? 'TRUE' : 'FALSE'} @schedule=${endpoint.schedule || 'none'} @on=${
						endpoint.events.join(', ') || 'none'
					} @messageFrom=${
						endpoint.events.includes('MESSAGE')
							? endpoint.messageFromAnySender || endpoint.messageSenders.length === 0
								? '*'
								: endpoint.messageSenders.join(', ')
							: 'none'
					} @streamFrom=${
						endpoint.events.includes('STREAM')
							? endpoint.streamFromAnySender || !Array.isArray(endpoint.streamSenders) || endpoint.streamSenders.length === 0
								? '*'
								: endpoint.streamSenders.join(', ')
							: 'none'
					} @streamEndFrom=${
						endpoint.events.includes('STREAMEND')
							? endpoint.streamEndFromAnySender || !Array.isArray(endpoint.streamEndSenders) || endpoint.streamEndSenders.length === 0
								? '*'
								: endpoint.streamEndSenders.join(', ')
							: 'none'
					} @watch=${endpoint.watch.length > 0 ? endpoint.watch.join(', ') : 'none'} @debug=${endpoint.debug ? 'TRUE' : 'FALSE'} @mutex=${endpoint.mutex ? 'TRUE' : 'FALSE'} (from ${this.endpointsDir})`,
				);

				if (!endpoint.enabled) {
					this.log(`Endpoint ${endpoint.name} is DISABLED, skipping schedule and event registration`);
					continue;
				}

				for (const eventName of endpoint.events) {
					const endpointsForEvent = this.eventMap.get(eventName) || [];
					endpointsForEvent.push(endpoint);
					this.eventMap.set(eventName, endpointsForEvent);
				}

				this.registerEndpointMessageListeners(endpoint);
				this.registerEndpointStreamListeners(endpoint);
				this.registerEndpointStreamEndListeners(endpoint);
			} catch (error) {
				this.log(`Failed to load endpoint ${endpointPath}: ${error.message}`);
			}
		}

		if (this.exchangeManager && typeof this.exchangeManager.updateClientDiscoveryEndpoints === 'function') {
			this.exchangeManager.updateClientDiscoveryEndpoints(this.getDiscoveryEndpointEntries());
		}
	}

	async reorderEndpointsByPaths(paths = []) {
		if (!Array.isArray(paths)) {
			throw new Error('invalid endpoint order payload');
		}

		const normalizedEndpointsRoot = path.resolve(this.endpointsDir);
		const orderedPaths = paths
			.map((value) => String(value || '').trim())
			.filter(Boolean)
			.map((value) => path.resolve(value))
			.filter((value) => value.startsWith(normalizedEndpointsRoot + path.sep));

		const endpointByPath = new Map();
		for (const endpoint of this.endpoints) {
			if (!endpoint || !endpoint.path || !endpoint.projectDir) {
				continue;
			}
			endpointByPath.set(path.resolve(endpoint.path), endpoint);
		}

		const seenProjects = new Set();
		const orderedEndpoints = [];

		for (const orderedPath of orderedPaths) {
			const endpoint = endpointByPath.get(orderedPath);
			if (!endpoint || !endpoint.projectDir) {
				continue;
			}

			const projectKey = path.resolve(endpoint.projectDir);
			if (seenProjects.has(projectKey)) {
				continue;
			}

			seenProjects.add(projectKey);
			orderedEndpoints.push(endpoint);
		}

		for (const endpoint of this.endpoints) {
			if (!endpoint || !endpoint.projectDir) {
				continue;
			}

			const projectKey = path.resolve(endpoint.projectDir);
			if (seenProjects.has(projectKey)) {
				continue;
			}

			seenProjects.add(projectKey);
			orderedEndpoints.push(endpoint);
		}

		await Promise.all(
			orderedEndpoints.map(async (endpoint, index) => {
				const positionPath = path.join(endpoint.projectDir, 'position');
				await fs.writeFile(positionPath, `${index}\n`, 'utf8');
			}),
		);

		await this.reloadEndpoints('ui-reorder-endpoints');
		return {
			ok: true,
			updated: orderedEndpoints.length,
		};
	}

	setupSchedules() {
		for (const endpoint of this.endpoints) {
			if (!endpoint.enabled) {
				continue;
			}

			const intervalMs = parseScheduleExpression(endpoint.schedule);
			if (!intervalMs) {
				continue;
			}

			const scheduledTask = {
				cancelled: false,
				timeoutId: null,
			};

			const scheduleNext = () => {
				if (scheduledTask.cancelled) {
					return;
				}

				const delayMs = getDelayToNextMidnightBoundary(intervalMs);
				scheduledTask.timeoutId = setTimeout(async () => {
					if (scheduledTask.cancelled) {
						return;
					}

					await this.runEndpoint(endpoint, { trigger: 'SCHEDULE', expression: endpoint.schedule });
					scheduleNext();
				}, delayMs);
			};

			scheduleNext();
			this.scheduledTasks.push(scheduledTask);

			const firstDelayMs = getDelayToNextMidnightBoundary(intervalMs);
			this.log(
				`Scheduled ${endpoint.name} every ${Math.floor(intervalMs / 1000)}s (midnight-aligned, next run in ${Math.ceil(firstDelayMs / 1000)}s)`,
			);
		}
	}

	async emitEvent(eventName, eventData = null) {
		const listeners = this.eventMap.get(eventName) || [];
		if (listeners.length === 0) {
			this.log(`Emitting event ${eventName} - no listeners`);
			if (eventName === 'NET_UP' || eventName === 'WIFI_ON') {
				this.flushMessageQueue().catch((error) => {
					this.log(`[Queue] Flush on ${eventName} failed: ${error.message}`);
				});
				this.flushStreamQueue().catch((error) => {
					this.log(`[Queue] Stream flush on ${eventName} failed: ${error.message}`);
				});
			}
			return;
		}

		this.log(`Emitting event ${eventName} to ${listeners.length} endpoint(s): ${listeners.map(s => s.name).join(', ')}`);
		await Promise.allSettled(
			listeners.map((endpoint) => this.runEndpoint(endpoint, {
				trigger: 'EVENT',
				event: eventName,
				networkChange: eventName === 'NET_CHANGE' ? eventData : null,
			})),
		);

		if (eventName === 'NET_UP' || eventName === 'WIFI_ON') {
			this.flushMessageQueue().catch((error) => {
				this.log(`[Queue] Flush on ${eventName} failed: ${error.message}`);
			});
			this.flushStreamQueue().catch((error) => {
				this.log(`[Queue] Stream flush on ${eventName} failed: ${error.message}`);
			});
		}
	}

	async runEndpoint(endpoint, context) {
		const forceRun = Boolean(context && context.force);

		if (!endpoint.enabled && !forceRun) {
			this.log(`Skipping ${endpoint.name}: state is DISABLED`);
			return;
		}

		if (!endpoint.enabled && forceRun) {
			this.log(`Running ${endpoint.name} on demand despite @enabled FALSE`);
		}

		if (endpoint.mutex && endpoint.isRunning) {
			this.log(`Skipping ${endpoint.name}: @mutex active and previous execution still running`);
			return;
		}

		if (endpoint.mutex) {
			endpoint.isRunning = true;
		}

		const endpointLogPath = endpoint.eventLogPath || this.eventLogPath;
		if (path.resolve(this.eventLogPath) !== path.resolve(endpointLogPath)) {
			await this.writeEventLog(this.eventLogPath, {
				timestamp: new Date().toISOString(),
				type: 'ENDPOINT_EXECUTION',
				scope: 'GLOBAL',
				phase: 'START',
				endpoint: {
					name: endpoint.name,
					path: endpoint.path,
					state: endpoint.state,
				},
				trigger: context.trigger,
				event: context.event || null,
				expression: context.expression || null,
			});
		}
		await this.recordExecutionEvent({
			endpoint,
			context,
			scope: 'PROJECT',
			phase: 'START',
		});

		try {
			const eventObject = endpoint && typeof endpoint.createEvent === 'function'
				? endpoint.createEvent(context || {})
				: { ...context };
			await Promise.resolve(endpoint.run(eventObject));
			this.log(`Completed ${endpoint.name}`);
		} catch (error) {
			this.log(`Error in ${endpoint.name}: ${error.stack || error.message}`);
			if (endpoint && endpoint.debug && this.runtimeApi && this.runtimeApi.Device && typeof this.runtimeApi.Device.notify === 'function') {
				try {
					const message = String((error && error.message) || 'Unknown error');
					await Promise.resolve(this.runtimeApi.Device.notify(message));
				} catch (notifyError) {
					this.log(`Debug notify failed in ${endpoint.name}: ${notifyError.message}`);
				}
			}
		} finally {
			if (endpoint.mutex) {
				endpoint.isRunning = false;
			}
		}
	}

	setupNetworkWatcher() {
		this.networkMonitor = new NetworkMonitor((eventName, eventData) => this.emitEvent(eventName, eventData));
		this.networkMonitor.start(5000);
	}

	setupWatchers() {
		for (const watcher of this.watchers) {
			if (watcher && watcher.close) {
				watcher.close();
			}
		}
		this.watchers = [];

		for (const endpoint of this.endpoints) {
			if (!endpoint.enabled || !Array.isArray(endpoint.watchRules) || endpoint.watchRules.length === 0) {
				continue;
			}

			for (const watchRule of endpoint.watchRules) {
				const watchPath = watchRule && watchRule.path ? String(watchRule.path) : '';
				if (!watchPath) {
					continue;
				}
				const isRecursiveWatch = Boolean(watchRule && watchRule.recursive === true);

				const listenerSet = Array.isArray(watchRule.listeners)
					? new Set(watchRule.listeners)
					: ALL_WATCH_LISTENERS;
				const pendingCreatedDispatches = new Map();

				if (Array.isArray(watchRule.listeners) && watchRule.listeners.length === 0) {
					this.log(`Skipping @watch ${watchPath} in ${endpoint.name}: no valid listeners in filter list`);
					continue;
				}

				try {
					const endpointDir = path.dirname(endpoint.path);
					const resolvedWatchPath = path.resolve(endpointDir, watchPath);

					try {
						fsNative.accessSync(resolvedWatchPath, fsNative.constants.F_OK);
					} catch {
						this.log(`Watch path does not exist: ${resolvedWatchPath} (from @watch in ${endpoint.name})`);
						continue;
					}

					const knownEntries = new Map();
					collectKnownEntries(resolvedWatchPath, knownEntries);

					const watcher = fsNative.watch(resolvedWatchPath, { recursive: isRecursiveWatch }, (eventType, filename) => {
						if (this.isReloading || !filename) {
							return;
						}

						if (!isRecursiveWatch) {
							const rawName = String(filename);
							if (rawName.includes('/') || rawName.includes('\\\\')) {
								return;
							}
						}

						const fullPath = normalizeWatchEventPath(path.join(resolvedWatchPath, String(filename)));
						const normalizedWatchPath = normalizeWatchEventPath(resolvedWatchPath);
						const watchType = detectWatchType(eventType, fullPath, knownEntries);
						if (!watchType || !listenerSet.has(watchType)) {
							return;
						}

						if (watchType === 'file:created') {
							if (pendingCreatedDispatches.has(fullPath)) {
								return;
							}

							const pending = (async () => {
								const readyResult = await this.waitForWatchCreatedFileReady(fullPath);
								if (!readyResult.ready || this.isReloading) {
									return;
								}
								const relativePath = computeWatchRelativePath(fullPath, normalizedWatchPath);

								this.log(`[WATCH] ${endpoint.name}: file:created at ${fullPath} (stable)`);
								this.runEndpoint(endpoint, {
									trigger: 'WATCH',
									watchPath: normalizedWatchPath,
									watchEntryPath: fullPath,
									watchRelativePath: relativePath,
									watchType,
								}).catch((error) => {
									this.log(`Error running ${endpoint.name} on watch event: ${error.message}`);
								});
							})().finally(() => {
								pendingCreatedDispatches.delete(fullPath);
							});

							pendingCreatedDispatches.set(fullPath, pending);
							return;
						}

						this.log(`[WATCH] ${endpoint.name}: ${watchType} at ${fullPath}`);
						const relativePath = computeWatchRelativePath(fullPath, normalizedWatchPath);
						this.runEndpoint(endpoint, {
							trigger: 'WATCH',
							watchPath: normalizedWatchPath,
							watchEntryPath: fullPath,
							watchRelativePath: relativePath,
							watchType,
						}).catch((error) => {
							this.log(`Error running ${endpoint.name} on watch event: ${error.message}`);
						});
					});

					this.watchers.push(watcher);
					this.log(`Watching ${resolvedWatchPath} for endpoint ${endpoint.name} [${Array.from(listenerSet).join(', ')}] recursive=${isRecursiveWatch ? 'true' : 'false'}`);
				} catch (error) {
					this.log(`Failed to setup watcher for ${watchPath} in ${endpoint.name}: ${error.message}`);
				}
			}
		}
	}

	cleanup() {
		this.clearSchedules();

		if (this.p2pTransportManager && this.p2pTransportManager.sessions) {
			for (const target of this.p2pTransportManager.sessions.keys()) {
				this.p2pTransportManager.closeSession(target, false);
			}
		}

		if (this.streamCleanupTimer) {
			clearInterval(this.streamCleanupTimer);
			this.streamCleanupTimer = null;
		}

		for (const [, state] of this.activeIncomingStreams.entries()) {
			if (state && state.partPath) {
				fs.unlink(state.partPath).catch(() => {});
			}
		}
		this.activeIncomingStreams.clear();

		if (this.reloadDebounceTimer) {
			clearTimeout(this.reloadDebounceTimer);
			this.reloadDebounceTimer = null;
		}

		if (this.endpointsWatcher) {
			this.endpointsWatcher.close();
			this.endpointsWatcher = null;
		}

		if (this.networkMonitor) {
			this.networkMonitor.stop();
		}

		if (this.messageQueueFlushTimer) {
			clearInterval(this.messageQueueFlushTimer);
			this.messageQueueFlushTimer = null;
		}

		if (this.streamQueueFlushTimer) {
			clearInterval(this.streamQueueFlushTimer);
			this.streamQueueFlushTimer = null;
		}

		if (this.httpServer) {
			this.httpServer.close();
			this.httpServer = null;
		}

		for (const watcher of this.watchers) {
			if (watcher && watcher.close) {
				watcher.close();
			}
		}
		this.watchers = [];
	}
}

module.exports = { ReactorRuntime };
