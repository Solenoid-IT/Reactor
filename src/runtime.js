const fs = require('fs/promises');
const fsNative = require('fs');
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { readWorkingModeConfig, writeWorkingModeConfig } = require('./workingModeConfig');
const { parseScheduleExpression } = require('./scheduleParser');
const { parseScriptMetadata } = require('./metadata');
const { loadScriptModule } = require('./scriptLoader');
const { NetworkMonitor } = require('./networkMonitor');
const { createNodePlatformServices } = require('./platform/nodePlatformServices');
const { createNodeRuntimeApi } = require('./platform/nodeRuntimeApi');
const { ExchangeManager } = require('./exchangeManager');
const { TlsManager } = require('./tlsManager');
const { P2PDataChannelManager } = require('./p2pDataChannelManager');

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
const PROJECT_UUID_FILE = 'uuid';

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

function isUuidV4(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function parseLogicalNodeTarget(rawTarget) {
	const trimmed = String(rawTarget || '').trim();
	if (!trimmed || trimmed.includes('://')) {
		return null;
	}

	const slashIndex = trimmed.indexOf('/');
	if (slashIndex === -1) {
		if (trimmed.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(trimmed) || trimmed.includes('.')) {
			return null;
		}

		return {
			nodeName: trimmed.toLowerCase(),
			scriptId: null,
			rawTarget: trimmed,
		};
	}

	const nodeName = trimmed.slice(0, slashIndex).trim().toLowerCase();
	const scriptId = trimmed.slice(slashIndex + 1).trim().toLowerCase();
	if (!nodeName || !scriptId || !isUuidV4(scriptId)) {
		return null;
	}

	if (nodeName.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(nodeName) || nodeName.includes('.')) {
		return null;
	}

	return {
		nodeName,
		scriptId,
		rawTarget: trimmed,
	};
}

function parseScriptScopedTarget(rawTarget) {
	const trimmed = String(rawTarget || '').trim();
	if (!trimmed || trimmed.includes('://')) {
		return null;
	}

	const slashIndex = trimmed.indexOf('/');
	if (slashIndex === -1) {
		return null;
	}

	const baseTarget = trimmed.slice(0, slashIndex).trim();
	const scriptId = trimmed.slice(slashIndex + 1).trim().toLowerCase();
	if (!baseTarget || !isUuidV4(scriptId)) {
		return null;
	}

	const isDirectAddress = baseTarget.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(baseTarget) || baseTarget.includes('.');
	return {
		baseTarget,
		scriptId,
		isDirectAddress,
		rawTarget: trimmed,
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

function normalizeHostPort(value, defaultPort = 7070) {
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
		request.writeUInt32BE(0x2112A442, 4);
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
			if (cookie !== 0x2112A442) {
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
			rejectUnauthorized: false,
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
			finish({ ok: false, error: error.message || 'tls connection failed' });
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
	constructor(scriptsDir, eventLogPath, options = {}) {
		this.scripts = [];
		this.scheduledTasks = [];
		this.eventMap = new Map();
		this.scriptsDir = scriptsDir;
		this.eventLogPath = eventLogPath;
		this.platformServices = options.platformServices || createNodePlatformServices();
		this.runtimeApi = options.runtimeApi || createNodeRuntimeApi();
		this.networkMonitor = null;
		this.scriptsWatcher = null;
		this.reloadDebounceTimer = null;
		this.isReloading = false;
		this.pendingReloadReason = null;
		this.watchers = [];
		this.messageListenerMap = new Map();
		this.streamListenerMap = new Map();
		this.streamEndListenerMap = new Map();
		this.activeIncomingStreams = new Map();
		this.reactorRootDir = options.reactorRootDir || path.dirname(this.scriptsDir);
		this.streamStorageDir = path.join(this.reactorRootDir, 'temp_files', 'streams');
		this.streamMaxActive = this.readQueueDuration('REACTOR_STREAM_MAX_ACTIVE', DEFAULT_STREAM_MAX_ACTIVE, 1);
		this.streamIdleTimeoutMs = this.readQueueDuration('REACTOR_STREAM_IDLE_TIMEOUT_MS', DEFAULT_STREAM_IDLE_TIMEOUT_MS, 30 * 1000);
		this.streamCleanupIntervalMs = this.readQueueDuration('REACTOR_STREAM_CLEANUP_INTERVAL_MS', DEFAULT_STREAM_CLEANUP_INTERVAL_MS, 5 * 1000);
		this.streamCleanupTimer = null;
		this.httpServer = null;
		this.httpServerPort = Number(options.httpServerPort || process.env.REACTOR_HTTP_PORT || 7070);
		this.httpServerLogs = [];
		this.reactorNamePath = path.join(this.reactorRootDir, 'name');
		this.cachedReactorName = null;
		this.exchangeManager = new ExchangeManager(this);
		const envWorkingMode = process.env.REACTOR_WORKING_MODE || '';
		const requestedWorkingMode = String(options.exchangeMode || envWorkingMode || 'node').trim().toLowerCase();
		this.exchangeMode = requestedWorkingMode === 'exchange' ? 'exchange' : 'node';
		this.exchangeHost = String(options.exchangeHost || process.env.REACTOR_EXCHANGE_HOST || '');
		this.exchangePort = Number(options.exchangePort || process.env.REACTOR_EXCHANGE_PORT || 7070);
		this.exchangeTls = Boolean(options.exchangeTls || process.env.REACTOR_EXCHANGE_TLS === '1' || process.env.REACTOR_EXCHANGE_TLS === 'true');
		this.exchangeAuthToken = String(options.exchangeToken || process.env.REACTOR_EXCHANGE_TOKEN || '');
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
		this.workingModeConfigPath = path.join(this.reactorRootDir, 'working-mode.json');
		this.tlsManager = new TlsManager(path.join(this.reactorRootDir, 'tls'));
		this.tlsEnabled = false; // impostato da startHttpServer
		this.messageQueuePath = path.join(this.reactorRootDir, 'outgoing-message-queue.json');
		this.messageQueueConfigPath = path.join(this.reactorRootDir, 'message-queue-config.json');
		this.messageQueueTtlMs = this.readQueueDuration('REACTOR_MESSAGE_QUEUE_TTL_MS', DEFAULT_MESSAGE_QUEUE_TTL_MS, 60 * 1000);
		this.messageQueueRetryMs = this.readQueueDuration('REACTOR_MESSAGE_QUEUE_RETRY_MS', DEFAULT_MESSAGE_QUEUE_RETRY_MS, 5 * 1000);
		this.messageQueueFlushTimer = null;
		this.isFlushingMessageQueue = false;
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
		try {
			const raw = await fs.readFile(this.messageQueuePath, 'utf8');
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
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
		return {
			pending: pendingItems.length,
			directPending,
			exchangePending,
			ttlMs: this.messageQueueTtlMs,
			ttlDays: Number((this.messageQueueTtlMs / (24 * 60 * 60 * 1000)).toFixed(2)),
			retryMs: this.messageQueueRetryMs,
			path: this.messageQueuePath,
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
		return this.getMessageQueueStatus();
	}

	async writeMessageQueue(queue) {
		await fs.mkdir(path.dirname(this.messageQueuePath), { recursive: true });
		await fs.writeFile(this.messageQueuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
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
			messageListeners: Array.from(this.messageListenerMap.entries()).map(([sender, scripts]) => ({
				sender,
				scripts: scripts.map((script) => script.name),
			})),
			streamListeners: Array.from(this.streamListenerMap.entries()).map(([sender, scripts]) => ({
				sender,
				scripts: scripts.map((script) => script.name),
			})),
			streamEndListeners: Array.from(this.streamEndListenerMap.entries()).map(([sender, scripts]) => ({
				sender,
				scripts: scripts.map((script) => script.name),
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
			return '';
		}

		await fs.writeFile(this.reactorNamePath, `${sanitized}\n`, 'utf8');
		this.cachedReactorName = sanitized;
		return sanitized;
	}

	getHttpServerLogs(limit = 100) {
		const safeLimit = Number(limit) > 0 ? Number(limit) : 100;
		return this.httpServerLogs.slice(-safeLimit);
	}

	getExchangeConfig() {
		const config = this.exchangeManager.getConfig();
		return {
			...config,
			mode: this.exchangeMode,
			host: this.exchangeHost,
			port: this.exchangePort,
			token: this.exchangeAuthToken,
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
			servers.push({
				urls: [`${turnScheme}:${turnHost}:${turnPort}?transport=tcp`, `turn:${turnHost}:${turnPort}?transport=udp`],
				username,
				credential,
			});
		}

		return servers;
	}

	getP2PStatus() {
		this.cleanupExpiredP2PSessions();
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

		return {
			enabled: this.exchangeMode === 'node',
			signalingViaExchange: true,
			dataChannelSupported: Boolean(transportSummary.supported),
			dataChannelSessions: Number(transportSummary.activeSessions || 0),
			iceServersConfigured: this.getIceServersForP2P().length > 0,
			iceServers: this.getIceServersForP2P(),
			sessions,
		};
	}

	shouldPreferP2PForNodeRouting() {
		if (this.exchangeMode !== 'node') {
			return false;
		}

		const stunHost = String(this.stun?.host || '').trim();
		const turnHost = String(this.turn?.host || '').trim();
		if (!stunHost || !turnHost) {
			return false;
		}

		return Boolean(this.p2pTransportManager && this.p2pTransportManager.isAvailable && this.p2pTransportManager.isAvailable());
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
		return merged;
	}

	handleExchangeSignal(signal = {}) {
		const from = String(signal.from || '').trim().toLowerCase();
		const signalType = String(signal.signalType || '').trim().toLowerCase();
		if (!from || !signalType) {
			return;
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
		const config = await readWorkingModeConfig(this.workingModeConfigPath);
		const token = String(config.token || '').trim();
		return {
			exists: Boolean(token),
			token,
			path: this.workingModeConfigPath,
		};
	}

	async generateExchangeToken() {
		const token = crypto.randomBytes(32).toString('base64url');
		await fs.mkdir(path.dirname(this.workingModeConfigPath), { recursive: true });
		await writeWorkingModeConfig(this.workingModeConfigPath, {
			type: this.exchangeMode,
			host: this.exchangeHost,
			port: this.exchangePort,
			tls: this.exchangeTls,
			token,
			discovery: this.exchangeDiscoveryEndpointEnabled,
			stun: this.stun,
			turn: this.turn,
		});
		this.exchangeAuthToken = token;
		return {
			exists: true,
			token,
			path: this.workingModeConfigPath,
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

	async setExchangeConfig(mode, host, port, tls = false, token = '', discovery = this.exchangeDiscoveryEndpointEnabled, stun = this.stun, turn = this.turn) {
		const requestedMode = String(mode || 'node').trim().toLowerCase();
		const safeHost = String(host || '').trim();
		const safePort = Number(port) > 0 ? Number(port) : 7070;
		const safeTls = Boolean(tls);
		const safeToken = String(token || '').trim();
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
		this.exchangeDiscoveryEndpointEnabled = safeDiscovery;
		this.stun = normalizeRelayEndpointConfig(stun, this.stun);
		this.turn = normalizeRelayEndpointConfig(turn, this.turn);
		this.exchangeManager.configure(internalMode, safeHost, safePort, safeTls);
		await this.exchangeManager.start(this.httpServer);
		await writeWorkingModeConfig(this.workingModeConfigPath, {
			type: this.exchangeMode,
			host: this.exchangeHost,
			port: this.exchangePort,
			tls: this.exchangeTls,
			token: this.exchangeAuthToken,
			discovery: this.exchangeDiscoveryEndpointEnabled,
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

		const testResult = endpoint.tls
			? await testTlsRelay(endpoint.host, endpoint.port, 5000)
			: await testUdpStunBinding(endpoint.host, endpoint.port, 5000);

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

		await writeWorkingModeConfig(this.workingModeConfigPath, {
			type: this.exchangeMode,
			host: this.exchangeHost,
			port: this.exchangePort,
			tls: this.exchangeTls,
			token: this.exchangeAuthToken,
			discovery: this.exchangeDiscoveryEndpointEnabled,
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
			if (!token) {
				return {
					ok: false,
					error: 'exchange token is not configured',
					nodes: [],
					total: 0,
				};
			}

			const scheme = this.exchangeTls ? 'https' : 'http';
			const endpointUrl = `${scheme}://${this.exchangeHost}:${this.exchangePort}${this.exchangeDiscoveryEndpointPath}`;

			try {
				const response = await this.platformServices.httpClient.request({
					url: endpointUrl,
					method: 'GET',
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${token}`,
					},
					insecureTls: Boolean(this.exchangeTls),
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
				const reactorName = (await this.getReactorName()).trim().toLowerCase();
				const filteredNodes = reactorName
					? nodes.filter((node) => String(node && node.name ? node.name : '').trim().toLowerCase() !== reactorName)
					: nodes;

				return {
					ok: true,
					mode: this.exchangeMode,
					endpoint: endpointUrl,
					generatedAt: parsed.generatedAt || new Date().toISOString(),
					total: filteredNodes.length,
					nodes: filteredNodes,
				};
			} catch (error) {
				return {
					ok: false,
					error: error.message || 'unable to reach exchange discovery endpoint',
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

		const nodes = this.exchangeManager && typeof this.exchangeManager.getConnectedClientsDiscoveryEntries === 'function'
			? this.exchangeManager.getConnectedClientsDiscoveryEntries(Date.now())
			: [];
		const nodesWithScripts = await this.enrichDiscoveryNodesWithScripts(nodes);

		return {
			ok: true,
			mode: this.exchangeMode,
			endpoint: this.exchangeDiscoveryEndpointPath,
			generatedAt: new Date().toISOString(),
			total: nodesWithScripts.length,
			nodes: nodesWithScripts,
		};
	}

	getDiscoveryScriptEntries() {
		const byUuid = new Map();

		for (const script of Array.isArray(this.scripts) ? this.scripts : []) {
			if (!script || !script.scriptId) {
				continue;
			}

			const uuid = String(script.scriptId || '').trim().toLowerCase();
			if (!uuid) {
				continue;
			}

			const nextEntry = {
				uuid,
				name: String(script.name || '').trim() || 'unknown',
				triggers: Array.isArray(script.events) ? script.events.map((trigger) => String(trigger || '').trim()).filter(Boolean) : [],
				enabled: Boolean(script.enabled),
				mutex: Boolean(script.mutex),
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

	buildNodeScriptsEndpointCandidates(node) {
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

		pushCandidate(node?.scriptsEndpoint, nodeTls);

		if (hasValidPort) {
			const protocol = nodeTls ? 'https' : 'http';
			if (node?.ip) {
				pushCandidate(`${protocol}://${String(node.ip).trim()}:${nodePort}/scripts`, nodeTls);
			}
			if (node?.name) {
				pushCandidate(`${protocol}://${String(node.name).trim()}:${nodePort}/scripts`, nodeTls);
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

	async enrichDiscoveryNodesWithScripts(nodes = []) {
		const safeNodes = Array.isArray(nodes) ? nodes : [];
		if (safeNodes.length === 0) {
			return [];
		}

		const token = String(this.exchangeAuthToken || '').trim();
		return Promise.all(
			safeNodes.map(async (node) => {
				const fallbackScripts = Array.isArray(node?.scripts) ? node.scripts : [];
				const endpointCandidates = this.buildNodeScriptsEndpointCandidates(node);
				if (endpointCandidates.length === 0) {
					return {
						...(node || {}),
						scripts: fallbackScripts,
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
							'node scripts request timeout',
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

						if (!parsed || parsed.ok === false || !Array.isArray(parsed.scripts)) {
							continue;
						}

						return {
							...(node || {}),
							scripts: parsed.scripts,
							scriptsEndpoint: candidate.url,
						};
					} catch {
						// Try next endpoint candidate.
					}
				}

				return {
					...(node || {}),
					scripts: fallbackScripts,
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

	registerScriptMessageListeners(script) {
		if (!script.enabled || !Array.isArray(script.events) || !script.events.includes('MESSAGE')) {
			return;
		}

		if (script.messageFromAnySender || !Array.isArray(script.messageSenders) || script.messageSenders.length === 0) {
			const wildcardListeners = this.messageListenerMap.get('*') || [];
			wildcardListeners.push(script);
			this.messageListenerMap.set('*', wildcardListeners);
			return;
		}

		for (const sender of script.messageSenders) {
			const key = String(sender || '').trim().toLowerCase();
			if (!key) {
				continue;
			}

			const listeners = this.messageListenerMap.get(key) || [];
			listeners.push(script);
			this.messageListenerMap.set(key, listeners);
		}
	}

	findMessageListeners(senderCandidates) {
		const listeners = [];
		for (const script of this.messageListenerMap.get('*') || []) {
			listeners.push(script);
		}

		for (const sender of senderCandidates || []) {
			for (const script of this.messageListenerMap.get(sender) || []) {
				if (!listeners.includes(script)) {
					listeners.push(script);
				}
			}
		}

		return listeners;
	}

	filterMessageListenersByTarget(listeners, targetScriptId = null) {
		if (!targetScriptId) {
			return Array.isArray(listeners) ? listeners : [];
		}

		return (Array.isArray(listeners) ? listeners : [])
			.filter((script) => String(script?.scriptId || '').trim().toLowerCase() === targetScriptId);
	}

	filterStreamListenersByTarget(listeners, targetScriptId = null) {
		if (!targetScriptId) {
			return Array.isArray(listeners) ? listeners : [];
		}

		return (Array.isArray(listeners) ? listeners : [])
			.filter((script) => String(script?.scriptId || '').trim().toLowerCase() === targetScriptId);
	}

	filterStreamEndListenersByTarget(listeners, targetScriptId = null) {
		if (!targetScriptId) {
			return Array.isArray(listeners) ? listeners : [];
		}

		return (Array.isArray(listeners) ? listeners : [])
			.filter((script) => String(script?.scriptId || '').trim().toLowerCase() === targetScriptId);
	}

	registerScriptStreamListeners(script) {
		if (!script.enabled || !Array.isArray(script.events) || !script.events.includes('STREAM')) {
			return;
		}

		if (script.streamFromAnySender || !Array.isArray(script.streamSenders) || script.streamSenders.length === 0) {
			const wildcardListeners = this.streamListenerMap.get('*') || [];
			wildcardListeners.push(script);
			this.streamListenerMap.set('*', wildcardListeners);
			return;
		}

		for (const sender of script.streamSenders) {
			const key = String(sender || '').trim().toLowerCase();
			if (!key) {
				continue;
			}

			const listeners = this.streamListenerMap.get(key) || [];
			listeners.push(script);
			this.streamListenerMap.set(key, listeners);
		}
	}

	findStreamListeners(senderCandidates) {
		const listeners = [];
		for (const script of this.streamListenerMap.get('*') || []) {
			listeners.push(script);
		}

		for (const sender of senderCandidates || []) {
			for (const script of this.streamListenerMap.get(sender) || []) {
				if (!listeners.includes(script)) {
					listeners.push(script);
				}
			}
		}

		return listeners;
	}

	registerScriptStreamEndListeners(script) {
		if (!script.enabled || !Array.isArray(script.events) || !script.events.includes('STREAMEND')) {
			return;
		}

		if (script.streamEndFromAnySender || !Array.isArray(script.streamEndSenders) || script.streamEndSenders.length === 0) {
			const wildcardListeners = this.streamEndListenerMap.get('*') || [];
			wildcardListeners.push(script);
			this.streamEndListenerMap.set('*', wildcardListeners);
			return;
		}

		for (const sender of script.streamEndSenders) {
			const key = String(sender || '').trim().toLowerCase();
			if (!key) {
				continue;
			}

			const listeners = this.streamEndListenerMap.get(key) || [];
			listeners.push(script);
			this.streamEndListenerMap.set(key, listeners);
		}
	}

	findStreamEndListeners(senderCandidates) {
		const listeners = [];
		for (const script of this.streamEndListenerMap.get('*') || []) {
			listeners.push(script);
		}

		for (const sender of senderCandidates || []) {
			for (const script of this.streamEndListenerMap.get(sender) || []) {
				if (!listeners.includes(script)) {
					listeners.push(script);
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
			messageTarget.scriptId,
		);
		if (listeners.length === 0) {
			return [];
		}

		const streamEndInfo = this.createIncomingStreamEndInfo(streamEndData);
		await Promise.allSettled(
			listeners.map((script) =>
				this.runScript(script, {
					trigger: 'STREAMEND',
					event: 'STREAMEND',
					messageSender: senderMeta?.rawSender || senderMeta?.remoteHost || streamEndData.sender || null,
					messageSenderName: senderMeta?.rawName || null,
					messageTarget: messageTarget.nodeName || null,
					messageTargetNode: messageTarget.nodeName || null,
					messageTargetScriptId: messageTarget.scriptId || null,
					messageHeaders,
					stream: null,
					streamEnd: streamEndInfo,
				}),
			),
		);

		return listeners.map((script) => script.name);
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
		const candidates = new Set();

		const normalizedSender = normalizeHostPort(rawSender, 7070);
		if (normalizedSender) {
			candidates.add(normalizedSender);
		}

		if (rawName) {
			candidates.add(rawName.toLowerCase());
		}

		if (remoteHost) {
			candidates.add(normalizeHostPort(remoteHost, 7070));
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
		const rawScriptId = String(headers['reactor-target-script-id'] || '').trim().toLowerCase();

		return {
			nodeName: rawNode || null,
			scriptId: isUuidV4(rawScriptId) ? rawScriptId : null,
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

	async ensureProjectScriptId(projectDir) {
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
			? this.filterStreamListenersByTarget(this.findStreamListeners(senderMeta.candidates), messageTarget.scriptId)
			: this.filterMessageListenersByTarget(this.findMessageListeners(senderMeta.candidates), messageTarget.scriptId);

		const streamPacket = isStreamEnvelope ? this.createIncomingStreamPacket(body.json) : null;
		const streamEndData = isStreamEnvelope ? await this.processIncomingStreamPacket(streamPacket, senderMeta) : null;
		let streamEndScripts = [];

		if (listeners.length === 0) {
			streamEndScripts = streamEndData
				? await this.emitStreamEnd(streamEndData, senderMeta, messageHeaders)
				: [];
			return {
				ok: true,
				trigger: isStreamEnvelope ? 'STREAM' : 'MESSAGE',
				delivered: false,
				reason: 'no listeners',
				streamEndScripts,
				senderCandidates: senderMeta.candidates,
			};
		}

		await Promise.allSettled(
			listeners.map((script) =>
				this.runScript(script, {
					trigger: isStreamEnvelope ? 'STREAM' : 'MESSAGE',
					event: isStreamEnvelope ? 'STREAM' : 'MESSAGE',
					messageSender: senderMeta.rawSender || senderMeta.remoteHost || null,
					messageSenderName: senderMeta.rawName || null,
					messageTarget: messageTarget.nodeName || null,
					messageTargetNode: messageTarget.nodeName || null,
					messageTargetScriptId: messageTarget.scriptId || null,
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

		streamEndScripts = streamEndData
			? await this.emitStreamEnd(streamEndData, senderMeta, messageHeaders)
			: [];

		return {
			ok: true,
			trigger: isStreamEnvelope ? 'STREAM' : 'MESSAGE',
			delivered: true,
			scripts: listeners.map((script) => script.name),
			streamEndScripts,
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

		return this.dispatchIncomingMessageEnvelope(parsedBody, senderMeta, headers);
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
		};
	}

	async sendNodeMessage(target, content, extraHeaders = {}, dispatchOptions = {}) {
		const targetId = String(target || '').trim();
		if (!targetId) {
			throw new Error('invalid target. expected host or host:port');
		}

		const scriptScopedTarget = parseScriptScopedTarget(targetId);
		if (scriptScopedTarget && !scriptScopedTarget.isDirectAddress) {
			const scopedHeaders = {
				...(extraHeaders || {}),
				'Reactor-Target-Node': String(scriptScopedTarget.baseTarget || '').trim().toLowerCase(),
				'Reactor-Target-Script-Id': scriptScopedTarget.scriptId,
			};

			if (this.shouldPreferP2PForNodeRouting()) {
				try {
					return await this.sendP2PMessage(scriptScopedTarget.baseTarget, content, scopedHeaders);
				} catch (p2pError) {
					this.log(`[P2P] fallback to exchange for ${scriptScopedTarget.baseTarget}: ${p2pError.message}`);
				}
			}

			return this.sendExchangeMessage(targetId, content, dispatchOptions);
		}

		const effectiveTarget = scriptScopedTarget && scriptScopedTarget.isDirectAddress
			? scriptScopedTarget.baseTarget
			: targetId;
		const effectiveHeaders = {
			...(extraHeaders || {}),
			...(scriptScopedTarget && scriptScopedTarget.isDirectAddress
				? {
					'Reactor-Target-Node': String(scriptScopedTarget.baseTarget || '').trim().toLowerCase(),
					'Reactor-Target-Script-Id': scriptScopedTarget.scriptId,
				}
				: {}),
		};

		const logicalTarget = parseLogicalNodeTarget(targetId);
		if (logicalTarget) {
			if (this.shouldPreferP2PForNodeRouting()) {
				try {
					return await this.sendP2PMessage(logicalTarget.nodeName, content, extraHeaders || {});
				} catch (p2pError) {
					this.log(`[P2P] fallback to exchange for ${logicalTarget.nodeName}: ${p2pError.message}`);
				}
			}

			return this.sendExchangeMessage(targetId, content, dispatchOptions);
		}

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
			: Array.from(new Set([this.httpServerPort, 7070].filter((port) => Number.isInteger(port) && port > 0)));

		const normalizedTargets = hasExplicitPort
			? [normalizeHostPort(effectiveTarget, this.httpServerPort)].filter(Boolean)
			: preferredPorts.map((port) => normalizeHostPort(effectiveTarget, port)).filter(Boolean);

		if (normalizedTargets.length === 0) {
			throw new Error('invalid target. expected host or host:port');
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
			const port = Number(portString || 7070);
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
					status: response.status,
					headers: response.headers,
					body: response.body,
				};
			} catch (error) {
				lastError = error;
			}
		}

		if (lastError) {
			if (dispatchOptions.noEnqueue) {
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
		if (dispatchOptions.noEnqueue) {
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
		try {
			return await this.exchangeManager.sendViaExchange(target, content);
		} catch (error) {
			if (options && options.noEnqueue) {
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
				queued: true,
				reason: String(error?.message || 'exchange send failed'),
				...queueResult,
			};
		}
	}

	async streamToNode(target, source, options = {}) {
		const safeOptions = options && typeof options === 'object' ? options : {};
		const safeChunkSize = Math.max(1024, Math.min(1024 * 1024, Number(safeOptions.chunkSize) || 64 * 1024));
		const streamId = String(safeOptions.streamId || crypto.randomUUID());
		const contentType = String(safeOptions.contentType || 'application/octet-stream');
		const metadata = safeOptions.metadata && typeof safeOptions.metadata === 'object' ? safeOptions.metadata : {};
		const headers = safeOptions.headers && typeof safeOptions.headers === 'object' ? safeOptions.headers : {};
		const totalBytesHint = Number.isFinite(Number(safeOptions.totalBytes)) ? Math.max(0, Number(safeOptions.totalBytes)) : null;

		await this.sendNodeMessage(target, {
			__reactorStream: true,
			phase: 'start',
			streamId,
			contentType,
			chunkSize: safeChunkSize,
			totalBytes: totalBytesHint,
			metadata,
		}, headers);

		let totalBytes = 0;
		let chunks = 0;
		const digest = crypto.createHash('sha256');

		for await (const chunk of iterateStreamSourceChunks(source, safeChunkSize)) {
			digest.update(chunk);
			totalBytes += chunk.length;
			await this.sendNodeMessage(target, {
				__reactorStream: true,
				phase: 'chunk',
				streamId,
				index: chunks,
				encoding: 'base64',
				size: chunk.length,
				data: chunk.toString('base64'),
			}, headers);
			chunks += 1;
		}

		const digestSha256 = digest.digest('hex');
		await this.sendNodeMessage(target, {
			__reactorStream: true,
			phase: 'end',
			streamId,
			chunks,
			totalBytes,
			digestSha256,
		}, headers);

		return {
			target: String(target || '').trim(),
			via: 'direct',
			streamId,
			chunks,
			totalBytes,
			digestSha256,
		};
	}

	async streamToExchange(target, source, options = {}) {
		const safeOptions = options && typeof options === 'object' ? options : {};
		const safeChunkSize = Math.max(1024, Math.min(1024 * 1024, Number(safeOptions.chunkSize) || 64 * 1024));
		const streamId = String(safeOptions.streamId || crypto.randomUUID());
		const contentType = String(safeOptions.contentType || 'application/octet-stream');
		const metadata = safeOptions.metadata && typeof safeOptions.metadata === 'object' ? safeOptions.metadata : {};
		const totalBytesHint = Number.isFinite(Number(safeOptions.totalBytes)) ? Math.max(0, Number(safeOptions.totalBytes)) : null;

		await this.sendExchangeMessage(target, {
			__reactorStream: true,
			phase: 'start',
			streamId,
			contentType,
			chunkSize: safeChunkSize,
			totalBytes: totalBytesHint,
			metadata,
		});

		let totalBytes = 0;
		let chunks = 0;
		const digest = crypto.createHash('sha256');

		for await (const chunk of iterateStreamSourceChunks(source, safeChunkSize)) {
			digest.update(chunk);
			totalBytes += chunk.length;
			if (!this.exchangeManager || typeof this.exchangeManager.sendStreamChunkBinary !== 'function') {
				throw new Error('binary exchange streaming is not supported by current exchange manager');
			}

			await this.exchangeManager.sendStreamChunkBinary(target, streamId, chunks, chunk);
			chunks += 1;
		}

		const digestSha256 = digest.digest('hex');
		await this.sendExchangeMessage(target, {
			__reactorStream: true,
			phase: 'end',
			streamId,
			chunks,
			totalBytes,
			digestSha256,
		});

		return {
			target: String(target || '').trim().toLowerCase(),
			via: 'exchange',
			streamId,
			chunks,
			totalBytes,
			digestSha256,
		};
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
				res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
			});

			req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTPS request timeout')));
			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}

	createScriptCoreApi(scriptName) {
		const requestCtor = this.runtimeApi.HttpClient && this.runtimeApi.HttpClient.Request;
		const sendRequest = this.runtimeApi.HttpClient && this.runtimeApi.HttpClient.sendRequest;

		function RequestFactory(...args) {
			return new requestCtor(...args);
		}

		const httpClient = {
			...(this.runtimeApi.HttpClient || {}),
			Request: RequestFactory,
			sendRequest: (request, timeout) => sendRequest(request, timeout),
		};

		const fileFacade = {
			readStream: (filePath, options = {}) => {
				const safePath = String(filePath || '').trim();
				if (!safePath) {
					throw new Error('File.readStream requires a file path');
				}

				const fileInstance = new this.runtimeApi.FileSystem.File(safePath);
				if (fileInstance && typeof fileInstance.readStream === 'function') {
					return fileInstance.readStream(options || {});
				}

				if (fsNative && typeof fsNative.createReadStream === 'function') {
					return fsNative.createReadStream(safePath, options || {});
				}

				throw new Error('File.readStream not supported on this platform');
			},
		};

		return {
			Node: {
				sendMessage: async (target, content, options = {}) => {
					const normalizedOptions = options && typeof options === 'object' ? options : {};
					const headers = normalizedOptions.headers || {};
					return this.sendNodeMessage(target, content, headers);
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
			FileSystem: this.runtimeApi.FileSystem,
			HttpClient: httpClient,
			Device: this.runtimeApi.Device,
			System: this.runtimeApi.System,
			log: async (message) => {
				this.log(`${scriptName}: ${message}`);
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
					scriptsCount: this.scripts.length,
				}),
			);
			return;
		}

		if (method === 'GET' && pathname === '/scripts') {
			if (String(this.exchangeAuthToken || '').trim() && !this.isExchangeDiscoveryRequestAuthorized(req.headers || {})) {
				this.addHttpServerLog('GET /scripts -> 401 (invalid bearer token)');
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
				return;
			}

			const scripts = this.getDiscoveryScriptEntries();
			const nodeName = await this.getReactorName();
			this.addHttpServerLog(`GET /scripts -> 200 scripts=${scripts.length}`);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					node: nodeName,
					generatedAt: new Date().toISOString(),
					total: scripts.length,
					scripts,
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

			const nodes = this.exchangeManager && typeof this.exchangeManager.getConnectedClientsDiscoveryEntries === 'function'
				? this.exchangeManager.getConnectedClientsDiscoveryEntries(Date.now())
				: [];
			const nodesWithScripts = await this.enrichDiscoveryNodesWithScripts(nodes);

			this.addHttpServerLog(`GET ${pathname} -> 200 nodes=${nodesWithScripts.length}`);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					mode: this.exchangeMode,
					endpoint: this.exchangeDiscoveryEndpointPath,
					generatedAt: new Date().toISOString(),
					total: nodesWithScripts.length,
					nodes: nodesWithScripts,
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
				`POST /message sender=${senderMeta.rawSender || senderMeta.rawName || senderMeta.remoteHost || 'unknown'} -> ${Array.isArray(dispatch?.scripts) ? dispatch.scripts.length : 0} script(s)`,
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

	findScriptByPath(filePath) {
		const normalizedFilePath = path.resolve(filePath || '');
		return this.scripts.find((candidate) => path.resolve(candidate.path) === normalizedFilePath) || null;
	}

	resolveScriptEventLogPath(filePath) {
		const script = this.findScriptByPath(filePath);
		if (script && script.eventLogPath) {
			return script.eventLogPath;
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

	async writeEventLog(logPath, entry) {
		const logLine = `${JSON.stringify(entry)}\n`;
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

	async recordExecutionEvent({ script, context, scope = 'PROJECT', phase, durationMs = null, output = null, error = null }) {
		const logPath = script.eventLogPath || this.eventLogPath;
		await this.writeEventLog(logPath, {
			timestamp: new Date().toISOString(),
			type: 'SCRIPT_EXECUTION',
			scope,
			phase,
			script: {
				name: script.name,
				path: script.path,
				state: script.state,
			},
			trigger: context.trigger,
			event: context.event || null,
			expression: context.expression || null,
			watchPath: context.watchPath || null,
			watchType: context.watchType || null,
			durationMs,
			output,
			error,
		});
	}

	async init() {
		await this.loadMessageQueueConfig();
		await fs.mkdir(this.scriptsDir, { recursive: true });
		await fs.mkdir(this.streamStorageDir, { recursive: true });
		await this.cleanupOrphanStreamFiles();
		this.startStreamCleanupTimer();
		await this.getReactorName();
		await this.discoverScripts();
		this.setupSchedules();
		this.setupWatchers();
		await this.startHttpServer();
		this.setupScriptsWatcher();
		this.setupNetworkWatcher();
		if (this.exchangeMode === 'exchange' || this.exchangeMode === 'node') {
			const internalMode = this.exchangeMode === 'exchange' ? 'exchange' : 'client';
			this.exchangeManager.configure(internalMode, this.exchangeHost, this.exchangePort, this.exchangeTls);
			await this.exchangeManager.start(this.httpServer).catch((err) => {
				this.log(`[Exchange] Avvio fallito: ${err.message}`);
			});
		}
		this.startMessageQueueFlushTimer();
		await this.flushMessageQueue();
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
			this.reloadScripts(reason).catch((error) => {
				this.log(`Hot reload failed: ${error.message}`);
			});
		}, 250);
	}

	async reloadScripts(reason) {
		if (this.isReloading) {
			this.pendingReloadReason = reason;
			return;
		}

		this.isReloading = true;
		this.log(`Hot reload scripts (${reason})`);

		try {
			this.clearSchedules();

			await this.discoverScripts();
			this.setupSchedules();
			this.setupWatchers();
			this.log(`Hot reload complete: ${this.scripts.length} script(s) active`);
		} finally {
			this.isReloading = false;

			if (this.pendingReloadReason) {
				const nextReason = this.pendingReloadReason;
				this.pendingReloadReason = null;
				this.queueReload(nextReason);
			}
		}
	}

	setupScriptsWatcher() {
		if (this.scriptsWatcher) {
			return;
		}

		try {
			this.scriptsWatcher = fsNative.watch(this.scriptsDir, { persistent: true }, (eventType, filename) => {
				if (!filename || String(filename).includes('node_modules')) {
					return;
				}
				this.queueReload(`${eventType}:${filename}`);
			});
			this.log(`Watching scripts directory for hot reload: ${this.scriptsDir}`);
		} catch (error) {
			this.log(`Failed to watch scripts directory: ${error.message}`);
		}
	}

	async collectScriptFiles() {
		const entries = await fs.readdir(this.scriptsDir, { withFileTypes: true });
		const scriptFiles = [];

		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.ts')) {
				scriptFiles.push(path.join(this.scriptsDir, entry.name));
				continue;
			}

			if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
				continue;
			}

			const projectDir = path.join(this.scriptsDir, entry.name);
			let projectEntries;
			try {
				projectEntries = await fs.readdir(projectDir, { withFileTypes: true });
			} catch (error) {
				this.log(`Skipping ${projectDir}: ${error.message}`);
				continue;
			}

			const bootEntry = projectEntries.find((projectEntry) => projectEntry.isFile() && projectEntry.name === 'boot.ts');
			if (bootEntry) {
				scriptFiles.push(path.join(projectDir, bootEntry.name));
				continue;
			}

			for (const projectEntry of projectEntries) {
				if (projectEntry.isFile() && projectEntry.name.endsWith('.ts')) {
					scriptFiles.push(path.join(projectDir, projectEntry.name));
				}
			}
		}

		scriptFiles.sort((a, b) => a.localeCompare(b));
		return scriptFiles;
	}

	async discoverScripts() {
		this.scripts = [];
		this.eventMap.clear();
		this.messageListenerMap.clear();
		this.streamListenerMap.clear();
		this.streamEndListenerMap.clear();

		try {
			await fs.mkdir(this.scriptsDir, { recursive: true });
		} catch (error) {
			throw error;
		}

		const scriptFiles = await this.collectScriptFiles();

		for (const scriptPath of scriptFiles) {
			try {
				const source = await fs.readFile(scriptPath, 'utf8');
				const metadata = parseScriptMetadata(source);
				const normalizedScriptsDir = path.resolve(this.scriptsDir);
				const normalizedScriptPath = path.resolve(scriptPath);
				const scriptDir = path.dirname(normalizedScriptPath);
				const scriptBaseName = path.basename(normalizedScriptPath).toLowerCase();
				const isProjectScript = path.dirname(scriptDir) === normalizedScriptsDir;
				const isProjectBootScript = scriptBaseName === 'boot.ts' && isProjectScript;
				const displayName = isProjectBootScript ? path.basename(scriptDir) : path.basename(scriptPath);
				const projectDir = isProjectScript ? scriptDir : null;
				const scriptId = projectDir ? await this.ensureProjectScriptId(projectDir) : null;
				const coreApi = this.createScriptCoreApi(displayName);
				const moduleExports = loadScriptModule(scriptPath, source, {
					virtualModules: {
						core: coreApi,
					},
				});
				const runner = moduleExports.run || moduleExports.default;

				if (typeof runner !== 'function') {
					this.log(`Skipping ${displayName}: missing exported run() or default function`);
					continue;
				}

				const script = {
					path: scriptPath,
					name: displayName,
					projectDir,
					scriptId,
					eventLogPath: path.join(path.dirname(normalizedScriptPath), 'activity.log'),
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
					mutex: metadata.mutex,
					watch: metadata.watch || [], // Existing watch property
					watchRules: metadata.watchRules || [], // New watchRules property
					isRunning: false,
				};

				this.scripts.push(script);
				this.log(
					`Loaded ${script.name} @state=${script.state} @schedule=${script.schedule || 'none'} @on=${
						script.events.join(', ') || 'none'
					} @messageFrom=${
						script.events.includes('MESSAGE')
							? script.messageFromAnySender || script.messageSenders.length === 0
								? '*'
								: script.messageSenders.join(', ')
							: 'none'
					} @streamFrom=${
						script.events.includes('STREAM')
							? script.streamFromAnySender || !Array.isArray(script.streamSenders) || script.streamSenders.length === 0
								? '*'
								: script.streamSenders.join(', ')
							: 'none'
					} @streamEndFrom=${
						script.events.includes('STREAMEND')
							? script.streamEndFromAnySender || !Array.isArray(script.streamEndSenders) || script.streamEndSenders.length === 0
								? '*'
								: script.streamEndSenders.join(', ')
							: 'none'
					} @watch=${script.watch.length > 0 ? script.watch.join(', ') : 'none'} @mutex=${script.mutex ? 'on' : 'off'} (from ${this.scriptsDir})`,
				);

				if (!script.enabled) {
					this.log(`Script ${script.name} is DISABLED, skipping schedule and event registration`);
					continue;
				}

				for (const eventName of script.events) {
					const scriptsForEvent = this.eventMap.get(eventName) || [];
					scriptsForEvent.push(script);
					this.eventMap.set(eventName, scriptsForEvent);
				}

				this.registerScriptMessageListeners(script);
				this.registerScriptStreamListeners(script);
				this.registerScriptStreamEndListeners(script);
			} catch (error) {
				this.log(`Failed to load script ${scriptPath}: ${error.message}`);
			}
		}

		if (this.exchangeManager && typeof this.exchangeManager.updateClientDiscoveryScripts === 'function') {
			this.exchangeManager.updateClientDiscoveryScripts(this.getDiscoveryScriptEntries());
		}
	}

	setupSchedules() {
		for (const script of this.scripts) {
			if (!script.enabled) {
				continue;
			}

			const intervalMs = parseScheduleExpression(script.schedule);
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

					await this.runScript(script, { trigger: 'SCHEDULE', expression: script.schedule });
					scheduleNext();
				}, delayMs);
			};

			scheduleNext();
			this.scheduledTasks.push(scheduledTask);

			const firstDelayMs = getDelayToNextMidnightBoundary(intervalMs);
			this.log(
				`Scheduled ${script.name} every ${Math.floor(intervalMs / 1000)}s (midnight-aligned, next run in ${Math.ceil(firstDelayMs / 1000)}s)`,
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
			}
			return;
		}

		this.log(`Emitting event ${eventName} to ${listeners.length} script(s): ${listeners.map(s => s.name).join(', ')}`);
		await Promise.allSettled(
			listeners.map((script) => this.runScript(script, {
				trigger: 'EVENT',
				event: eventName,
				networkChange: eventName === 'NET_CHANGE' ? eventData : null,
			})),
		);

		if (eventName === 'NET_UP' || eventName === 'WIFI_ON') {
			this.flushMessageQueue().catch((error) => {
				this.log(`[Queue] Flush on ${eventName} failed: ${error.message}`);
			});
		}
	}

	async runScript(script, context) {
		const forceRun = Boolean(context && context.force);

		if (!script.enabled && !forceRun) {
			this.log(`Skipping ${script.name}: state is DISABLED`);
			return;
		}

		if (!script.enabled && forceRun) {
			this.log(`Running ${script.name} on demand despite @state DISABLED`);
		}

		if (script.mutex && script.isRunning) {
			this.log(`Skipping ${script.name}: @mutex active and previous execution still running`);
			return;
		}

		if (script.mutex) {
			script.isRunning = true;
		}

		const scriptLogPath = script.eventLogPath || this.eventLogPath;
		if (path.resolve(this.eventLogPath) !== path.resolve(scriptLogPath)) {
			await this.writeEventLog(this.eventLogPath, {
				timestamp: new Date().toISOString(),
				type: 'SCRIPT_EXECUTION',
				scope: 'GLOBAL',
				phase: 'START',
				script: {
					name: script.name,
					path: script.path,
					state: script.state,
				},
				trigger: context.trigger,
				event: context.event || null,
				expression: context.expression || null,
			});
		}
		await this.recordExecutionEvent({
			script,
			context,
			scope: 'PROJECT',
			phase: 'START',
		});

		try {
			await Promise.resolve(script.run({ ...context }));
			this.log(`Completed ${script.name}`);
		} catch (error) {
			this.log(`Error in ${script.name}: ${error.stack || error.message}`);
		} finally {
			if (script.mutex) {
				script.isRunning = false;
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

		for (const script of this.scripts) {
			if (!script.enabled || !Array.isArray(script.watchRules) || script.watchRules.length === 0) {
				continue;
			}

			for (const watchRule of script.watchRules) {
				const watchPath = watchRule && watchRule.path ? String(watchRule.path) : '';
				if (!watchPath) {
					continue;
				}

				const listenerSet = Array.isArray(watchRule.listeners)
					? new Set(watchRule.listeners)
					: ALL_WATCH_LISTENERS;

				if (Array.isArray(watchRule.listeners) && watchRule.listeners.length === 0) {
					this.log(`Skipping @watch ${watchPath} in ${script.name}: no valid listeners in filter list`);
					continue;
				}

				try {
					const scriptDir = path.dirname(script.path);
					const resolvedWatchPath = path.resolve(scriptDir, watchPath);

					try {
						fsNative.accessSync(resolvedWatchPath, fsNative.constants.F_OK);
					} catch {
						this.log(`Watch path does not exist: ${resolvedWatchPath} (from @watch in ${script.name})`);
						continue;
					}

					const knownEntries = new Map();
					collectKnownEntries(resolvedWatchPath, knownEntries);

					const watcher = fsNative.watch(resolvedWatchPath, { recursive: true }, (eventType, filename) => {
						if (this.isReloading || !filename) {
							return;
						}

						const fullPath = path.join(resolvedWatchPath, String(filename));
						const watchType = detectWatchType(eventType, fullPath, knownEntries);
						if (!watchType || !listenerSet.has(watchType)) {
							return;
						}

						this.log(`[WATCH] ${script.name}: ${watchType} at ${fullPath}`);
						this.runScript(script, {
							trigger: 'WATCH',
							watchPath: fullPath,
							watchType,
						}).catch((error) => {
							this.log(`Error running ${script.name} on watch event: ${error.message}`);
						});
					});

					this.watchers.push(watcher);
					this.log(`Watching ${resolvedWatchPath} for script ${script.name} [${Array.from(listenerSet).join(', ')}]`);
				} catch (error) {
					this.log(`Failed to setup watcher for ${watchPath} in ${script.name}: ${error.message}`);
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

		if (this.scriptsWatcher) {
			this.scriptsWatcher.close();
			this.scriptsWatcher = null;
		}

		if (this.networkMonitor) {
			this.networkMonitor.stop();
		}

		if (this.messageQueueFlushTimer) {
			clearInterval(this.messageQueueFlushTimer);
			this.messageQueueFlushTimer = null;
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
