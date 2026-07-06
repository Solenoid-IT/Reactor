const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

function parsePositiveInt(value, fallback, minValue) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	const safeMin = Number.isFinite(minValue) ? minValue : 1;
	return Math.max(safeMin, Math.floor(parsed));
}

function getDefaultDataDir() {
	switch (process.platform) {
		case 'darwin':
			return path.join(os.homedir(), 'Library', 'Application Support', 'Reactor');
		case 'win32':
			return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Reactor');
		default:
			return path.join(os.homedir(), '.config', 'Reactor');
	}
}

function parseEnvFile(content) {
	const result = {};
	const lines = String(content || '').split(/\r?\n/);

	for (const rawLine of lines) {
		const line = String(rawLine || '').trim();
		if (!line || line.startsWith('#')) {
			continue;
		}

		const separatorIndex = line.indexOf('=');
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		if (!key) {
			continue;
		}

		let value = line.slice(separatorIndex + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
			value = value.slice(1, -1);
		}

		result[key] = value;
	}

	return result;
}

async function loadEnvFileIfPresent(filePath) {
	if (!filePath) {
		return false;
	}

	try {
		if (!fs.existsSync(filePath)) {
			return false;
		}
		const content = await fsp.readFile(filePath, 'utf8');
		const parsed = parseEnvFile(content);
		for (const [key, value] of Object.entries(parsed)) {
			if (!Object.prototype.hasOwnProperty.call(process.env, key) || process.env[key] === undefined || process.env[key] === '') {
				process.env[key] = value;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function readBearerToken(headerValue) {
	const raw = String(headerValue || '').trim();
	if (!raw) {
		return '';
	}

	const match = raw.match(/^Bearer\s+(.+)$/i);
	return match ? String(match[1] || '').trim() : '';
}

function safeJsonParse(value) {
	try {
		return JSON.parse(String(value));
	} catch {
		return null;
	}
}

function sendJson(res, statusCode, payload, headers = {}) {
	const body = `${JSON.stringify(payload, null, 2)}\n`;
	res.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		...headers,
	});
	res.end(body);
}

function sendText(res, statusCode, text, headers = {}) {
	res.writeHead(statusCode, {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		...headers,
	});
	res.end(`${String(text || '')}\n`);
}

function normalizeName(value) {
	return String(value || '').trim().toLowerCase();
}

function normalizeAddress(request, ws) {
	const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
	if (forwarded) {
		return forwarded;
	}
	return String(request?.socket?.remoteAddress || ws?._socket?.remoteAddress || 'unknown');
}

function normalizePortValue(value) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		return null;
	}
	return parsed;
}

function parseBooleanFlag(value) {
	return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parseTlsMode(value) {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'proxy' || normalized === 'offload') {
		return 'proxy';
	}
	return 'direct';
}

function getLocalCertDir() {
	return path.join(__dirname, 'cert');
}

function getTlsDir(dataDir) {
	const explicitTlsDir = String(process.env.REACTOR_TLS_DIR || '').trim();
	if (explicitTlsDir) {
		return explicitTlsDir;
	}

	if (String(process.env.REACTOR_DATA_DIR || '').trim()) {
		return path.join(dataDir, 'tls');
	}

	return getLocalCertDir();
}

function getTlsPaths(dataDir) {
	const tlsDir = getTlsDir(dataDir);
	return {
		tlsDir,
		certPath: path.join(tlsDir, 'cert.pem'),
		keyPath: path.join(tlsDir, 'key.pem'),
	};
}

class ReactorExchangeDaemon {
	constructor(options = {}) {
		this.host = String(options.host || '0.0.0.0').trim() || '0.0.0.0';
		this.port = normalizePortValue(options.port) || 7070;
		this.token = String(options.token || '').trim();
		this.tlsEnabled = Boolean(options.tlsEnabled);
		this.tlsMode = parseTlsMode(options.tlsMode || 'direct');
		this.tlsCertPath = String(options.tlsCertPath || '').trim() || null;
		this.tlsKeyPath = String(options.tlsKeyPath || '').trim() || null;
		this.heartbeatIntervalMs = parsePositiveInt(options.heartbeatIntervalMs, 15000, 3000);
		this.heartbeatTimeoutMs = parsePositiveInt(options.heartbeatTimeoutMs, 45000, this.heartbeatIntervalMs + 1000);
		this.dataDir = String(options.dataDir || getDefaultDataDir()).trim() || getDefaultDataDir();
		this.connectionLogPath = path.join(this.dataDir, 'exchange-connections.log');
		this.activeConnectionsPath = path.join(this.dataDir, 'exchange-active-connections.json');
		this.tlsReloadIntervalMs = parsePositiveInt(options.tlsReloadIntervalMs, 5000, 1000);
		this.httpServer = null;
		this.wss = null;
		this.startedAt = null;
		this.stopping = false;
		this.directTlsActive = false;
		this.tlsContextHash = null;
		this.tlsReloadTimer = null;
		this.tlsReloadHadError = false;
		this.tlsBootstrapWarned = false;
		this.transportSwitchInProgress = false;
		this.clientsByName = new Map();
		this.wsState = new WeakMap();
		this.serverHeartbeatTimer = null;
		this.snapshotWriteChain = Promise.resolve();
	}

	isDirectTlsRequested() {
		return this.tlsEnabled && this.tlsMode === 'direct';
	}

	isDirectTlsActive() {
		return this.directTlsActive;
	}

	computeTlsContextHash(cert, key) {
		return crypto
			.createHash('sha256')
			.update(Buffer.isBuffer(cert) ? cert : Buffer.from(String(cert || '')))
			.update(Buffer.from('\0'))
			.update(Buffer.isBuffer(key) ? key : Buffer.from(String(key || '')))
			.digest('hex');
	}

	async loadTlsMaterial() {
		if (!this.tlsCertPath || !this.tlsKeyPath) {
			throw new Error('TLS direct mode requires both certificate and key paths');
		}

		const [cert, key] = await Promise.all([
			fsp.readFile(this.tlsCertPath),
			fsp.readFile(this.tlsKeyPath),
		]);

		return {
			cert,
			key,
			hash: this.computeTlsContextHash(cert, key),
		};
	}

	createServerForMode(useDirectTls, tlsMaterial = null) {
		if (useDirectTls) {
			const cert = tlsMaterial?.cert;
			const key = tlsMaterial?.key;
			return https.createServer({ cert, key }, (request, response) => {
				void this.handleHttpRequest(request, response);
			});
		}

		return http.createServer((request, response) => {
			void this.handleHttpRequest(request, response);
		});
	}

	attachServerHandlers(server) {
		server.on('upgrade', (request, socket, head) => {
			void this.handleUpgrade(request, socket, head);
		});
	}

	listenOnServer(server) {
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.port, this.host, () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
	}

	closeServer(server) {
		if (!server) {
			return Promise.resolve();
		}

		return new Promise((resolve) => server.close(() => resolve()));
	}

	async switchToDirectTlsRuntime(tlsMaterial) {
		if (!this.httpServer || this.transportSwitchInProgress) {
			return false;
		}

		this.transportSwitchInProgress = true;
		const previousServer = this.httpServer;
		try {
			await this.closeServer(previousServer);

			const tlsServer = this.createServerForMode(true, tlsMaterial);
			this.attachServerHandlers(tlsServer);

			try {
				await this.listenOnServer(tlsServer);
			} catch (error) {
				await this.closeServer(tlsServer);
				const fallbackServer = this.createServerForMode(false);
				this.attachServerHandlers(fallbackServer);
				await this.listenOnServer(fallbackServer);
				this.httpServer = fallbackServer;
				this.directTlsActive = false;
				this.tlsContextHash = null;
				throw error;
			}

			this.httpServer = tlsServer;
			this.directTlsActive = true;
			this.tlsContextHash = tlsMaterial.hash;
			this.tlsReloadHadError = false;
			this.tlsBootstrapWarned = false;
			this.log(`TLS direct mode activated at runtime (cert: ${this.tlsCertPath})`);
			return true;
		} finally {
			this.transportSwitchInProgress = false;
		}
	}

	startTlsHotReloadLoop() {
		if (!this.isDirectTlsRequested() || !this.httpServer) {
			return;
		}

		if (this.tlsReloadTimer) {
			clearInterval(this.tlsReloadTimer);
		}

		this.tlsReloadTimer = setInterval(() => {
			void this.reloadTlsContextIfChanged();
		}, this.tlsReloadIntervalMs);

		if (this.tlsReloadTimer.unref) {
			this.tlsReloadTimer.unref();
		}
	}

	async reloadTlsContextIfChanged() {
		if (!this.isDirectTlsRequested() || !this.httpServer) {
			return false;
		}

		if (!this.isDirectTlsActive()) {
			try {
				const material = await this.loadTlsMaterial();
				return this.switchToDirectTlsRuntime(material);
			} catch (error) {
				if (!this.tlsBootstrapWarned) {
					this.tlsBootstrapWarned = true;
					this.logError(`TLS direct mode pending certificate files (${this.tlsCertPath}, ${this.tlsKeyPath}): ${error.message}`);
				}
				return false;
			}
		}

		if (typeof this.httpServer.setSecureContext !== 'function') {
			return false;
		}

		try {
			const { cert, key, hash } = await this.loadTlsMaterial();
			this.tlsBootstrapWarned = false;
			if (hash === this.tlsContextHash) {
				if (this.tlsReloadHadError) {
					this.tlsReloadHadError = false;
					this.log('TLS certificate files are stable again; keeping current secure context');
				}
				return false;
			}

			this.httpServer.setSecureContext({ cert, key });
			this.tlsContextHash = hash;
			if (this.tlsReloadHadError) {
				this.tlsReloadHadError = false;
				this.log('TLS certificate hot reload recovered successfully');
			} else {
				this.log('TLS certificate hot reload applied');
			}
			return true;
		} catch (error) {
			if (!this.tlsReloadHadError) {
				this.tlsReloadHadError = true;
				this.logError(`TLS certificate hot reload failed, keeping previous certificate: ${error.message}`);
			}
			return false;
		}
	}

	async start() {
		if (this.httpServer) {
			return;
		}

		await fsp.mkdir(this.dataDir, { recursive: true });
		this.startedAt = new Date().toISOString();

		const shouldUseDirectTls = this.isDirectTlsRequested();
		if (shouldUseDirectTls) {
			try {
				const material = await this.loadTlsMaterial();
				this.httpServer = this.createServerForMode(true, material);
				this.directTlsActive = true;
				this.tlsContextHash = material.hash;
				this.tlsBootstrapWarned = false;
			} catch (error) {
				this.directTlsActive = false;
				this.tlsContextHash = null;
				this.tlsBootstrapWarned = true;
				this.logError(`TLS certificate files not available (${this.tlsCertPath}, ${this.tlsKeyPath}), fallback to HTTP/WS: ${error.message}`);
				this.httpServer = this.createServerForMode(false);
			}
		} else {
			this.directTlsActive = false;
			this.tlsContextHash = null;
			this.tlsBootstrapWarned = false;
			this.httpServer = this.createServerForMode(false);
		}

		this.wss = new WebSocketServer({ noServer: true });
		this.wss.on('connection', (ws, request) => this.handleSocketConnection(ws, request));
		this.attachServerHandlers(this.httpServer);

		await this.listenOnServer(this.httpServer);

		this.startHeartbeatSweep();
		this.startTlsHotReloadLoop();
		this.writeActiveConnectionsSnapshot().catch(() => {});
		const protocol = this.isDirectTlsActive() ? 'https' : 'http';
		this.log(`Exchange daemon listening on ${protocol}://${this.host}:${this.port}`);
		if (this.tlsEnabled) {
			if (this.tlsMode === 'proxy') {
				this.log('TLS mode: proxy (terminated by reverse proxy)');
			} else if (this.isDirectTlsActive()) {
				this.log(`TLS mode: direct (cert: ${this.tlsCertPath}, hot-reload every ${this.tlsReloadIntervalMs}ms)`);
			} else {
				this.log('TLS mode: direct requested but not active (running HTTP/WS fallback due to missing/invalid cert files)');
			}
		}
		this.log('Discovery endpoint available at GET /nodes');
	}

	async stop() {
		this.stopping = true;
		if (this.serverHeartbeatTimer) {
			clearInterval(this.serverHeartbeatTimer);
			this.serverHeartbeatTimer = null;
		}

		if (this.tlsReloadTimer) {
			clearInterval(this.tlsReloadTimer);
			this.tlsReloadTimer = null;
		}

		for (const ws of this.clientsByName.values()) {
			try {
				ws.terminate();
			} catch {
				// ignore termination errors
			}
		}
		this.clientsByName.clear();

		if (this.wss) {
			const wss = this.wss;
			this.wss = null;
			await new Promise((resolve) => wss.close(() => resolve()));
		}

		if (this.httpServer) {
			const server = this.httpServer;
			this.httpServer = null;
			await new Promise((resolve) => server.close(() => resolve()));
		}

		await this.writeActiveConnectionsSnapshot();
	}

	log(message) {
		console.log(`[Exchange] ${message}`);
	}

	logError(message) {
		console.error(`[Exchange] ${message}`);
	}

	async appendConnectionLog(event, details = {}) {
		try {
			const entry = {
				timestamp: new Date().toISOString(),
				event,
				...details,
			};
			await fsp.appendFile(this.connectionLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
		} catch {
			// Logging must never break routing.
		}
	}

	getExpectedToken() {
		return this.token;
	}

	readRequestToken(request) {
		return readBearerToken(request?.headers?.authorization || '');
	}

	isAuthorizedToken(token) {
		const expected = this.getExpectedToken();
		if (!expected) {
			return true;
		}
		return String(token || '').trim() === expected;
	}

	async handleHttpRequest(request, response) {
		const pathname = new URL(request.url || '/', 'http://localhost').pathname;

		if (request.method === 'OPTIONS') {
			response.writeHead(204, {
				'cache-control': 'no-store',
				allow: 'GET, HEAD, OPTIONS',
				'content-length': '0',
			});
			response.end();
			return;
		}

		if (pathname === '/' || pathname === '/health') {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				sendText(response, 405, 'Method Not Allowed', { allow: 'GET, HEAD, OPTIONS' });
				return;
			}

			const directTls = this.isDirectTlsActive();
			const body = {
				ok: true,
				service: 'reactor-exchange',
				startedAt: this.startedAt,
				scheme: directTls ? 'https' : 'http',
				connectedClients: this.clientsByName.size,
				tls: {
					enabled: this.tlsEnabled,
					mode: this.tlsMode,
					requestedDirectTermination: this.isDirectTlsRequested(),
					directTermination: directTls,
					certPath: directTls ? this.tlsCertPath : null,
					hotReloadIntervalMs: this.isDirectTlsRequested() ? this.tlsReloadIntervalMs : null,
				},
				heartbeat: {
					intervalMs: this.heartbeatIntervalMs,
					timeoutMs: this.heartbeatTimeoutMs,
				},
			};

			if (request.method === 'HEAD') {
				response.writeHead(200, { 'cache-control': 'no-store' });
				response.end();
				return;
			}

			sendJson(response, 200, body);
			return;
		}

		if (pathname === '/nodes') {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				sendText(response, 405, 'Method Not Allowed', { allow: 'GET, HEAD, OPTIONS' });
				return;
			}

			const requestToken = this.readRequestToken(request);
			if (!this.isAuthorizedToken(requestToken)) {
				sendText(response, 401, 'Unauthorized', { 'www-authenticate': 'Bearer realm="reactor-exchange"' });
				return;
			}

			const snapshot = this.getDiscoverySnapshot();
			if (request.method === 'HEAD') {
				response.writeHead(200, { 'cache-control': 'no-store' });
				response.end();
				return;
			}

			sendJson(response, 200, snapshot);
			return;
		}

		sendText(response, 404, 'Not Found');
	}

	async handleUpgrade(request, socket, head) {
		try {
			if (!this.httpServer || !this.wss) {
				socket.destroy();
				return;
			}

			const requestToken = this.readRequestToken(request);
			if (!this.isAuthorizedToken(requestToken)) {
				socket.write(
					'HTTP/1.1 401 Unauthorized\r\n' +
					'Content-Type: text/plain; charset=utf-8\r\n' +
					'Connection: close\r\n' +
					'WWW-Authenticate: Bearer realm="reactor-exchange"\r\n' +
					'Content-Length: 12\r\n' +
					'\r\n' +
					'Unauthorized',
				);
				socket.destroy();
				return;
			}

			this.wss.handleUpgrade(request, socket, head, (ws) => {
				this.wss.emit('connection', ws, request);
			});
		} catch (error) {
			try {
				socket.destroy();
			} catch {
				// ignore
			}
			this.logError(`upgrade failed: ${error.message}`);
		}
	}

	startHeartbeatSweep() {
		if (this.serverHeartbeatTimer) {
			clearInterval(this.serverHeartbeatTimer);
		}

		this.serverHeartbeatTimer = setInterval(() => {
			if (!this.wss) {
				return;
			}

			for (const ws of this.wss.clients) {
				const state = this.wsState.get(ws);
				if (!state) {
					continue;
				}

				if (ws.isAlive === false) {
					this.terminateSocket(ws, 'heartbeat timeout', 4000);
					continue;
				}

				ws.isAlive = false;
				try {
					ws.ping();
				} catch {
					this.terminateSocket(ws, 'ping failed', 4001);
				}
			}
		}, this.heartbeatIntervalMs);

		if (this.serverHeartbeatTimer.unref) {
			this.serverHeartbeatTimer.unref();
		}
	}

	getClientDetailsSnapshot(nowMs = Date.now()) {
		return Array.from(this.clientsByName.values())
			.map((record) => {
				const connectedAt = record.registrationAt || record.connectedAt || null;
				const connectedAtMs = connectedAt ? Date.parse(connectedAt) : NaN;
				const connectedForMs = Number.isFinite(connectedAtMs) ? Math.max(0, nowMs - connectedAtMs) : null;

				return {
					name: record.name || 'unknown',
					address: record.address || null,
					ip: record.ip || null,
					port: Number.isFinite(Number(record.port)) ? Number(record.port) : null,
					httpPort: Number.isFinite(Number(record.httpPort)) ? Number(record.httpPort) : null,
					httpTls: Boolean(record.httpTls),
					endpointsEndpoint: record.endpointsEndpoint || null,
					connectedAt,
					lastSeenAt: record.lastSeenAt || null,
					userAgent: record.userAgent || '',
					endpoints: Array.isArray(record.endpoints) ? record.endpoints : [],
					connectedForMs,
					connectedForSec: Number.isFinite(connectedForMs) ? Math.floor(connectedForMs / 1000) : null,
				};
			})
			.sort((left, right) => String(left.name).localeCompare(String(right.name)));
	}

	getDiscoverySnapshot(nowMs = Date.now()) {
		return {
			ok: true,
			service: 'reactor-exchange',
			source: 'exchange-discovery',
			generatedAt: new Date(nowMs).toISOString(),
			startedAt: this.startedAt,
			endpoint: '/nodes',
			total: this.clientsByName.size,
			nodes: this.getClientDetailsSnapshot(nowMs),
		};
	}

	getStatusSnapshot(nowMs = Date.now()) {
		const directTls = this.isDirectTlsActive();
		return {
			service: 'reactor-exchange',
			startedAt: this.startedAt,
			active: Boolean(this.httpServer),
			scheme: directTls ? 'https' : 'http',
			host: this.host,
			port: this.port,
			tls: {
				enabled: this.tlsEnabled,
				mode: this.tlsMode,
				requestedDirectTermination: this.isDirectTlsRequested(),
				directTermination: directTls,
				certPath: directTls ? this.tlsCertPath : null,
				hotReloadIntervalMs: this.isDirectTlsRequested() ? this.tlsReloadIntervalMs : null,
			},
			connectedClients: Array.from(this.clientsByName.keys()).sort((left, right) => left.localeCompare(right)),
			connectedClientsDetails: this.getClientDetailsSnapshot(nowMs),
			heartbeat: {
				intervalMs: this.heartbeatIntervalMs,
				timeoutMs: this.heartbeatTimeoutMs,
			},
			connectionLogPath: this.connectionLogPath,
			activeConnectionsPath: this.activeConnectionsPath,
		};
	}

	async writeActiveConnectionsSnapshot() {
		const payload = this.getClientDetailsSnapshot();
		const serialized = `${JSON.stringify(payload, null, 2)}\n`;

		this.snapshotWriteChain = this.snapshotWriteChain
			.then(() => fsp.writeFile(this.activeConnectionsPath, serialized, 'utf8'))
			.catch(() => {});

		return this.snapshotWriteChain;
	}

	getWsState(ws) {
		let state = this.wsState.get(ws);
		if (!state) {
			state = {
				name: null,
				address: null,
				ip: null,
				port: null,
				userAgent: '',
				connectedAt: new Date().toISOString(),
				registrationAt: null,
				lastSeenAt: new Date().toISOString(),
				binaryQueue: [],
				endpoints: [],
				httpPort: null,
				httpTls: false,
				endpointsEndpoint: null,
			};
			this.wsState.set(ws, state);
		}
		return state;
	}

	updateClientRecord(ws, patch = {}) {
		const state = this.getWsState(ws);
		Object.assign(state, patch, {
			lastSeenAt: new Date().toISOString(),
		});

		if (state.name) {
			const nextRecord = {
				name: state.name,
				address: state.address,
				ip: state.ip,
				port: state.port,
				connectedAt: state.connectedAt,
				registrationAt: state.registrationAt,
				lastSeenAt: state.lastSeenAt,
				userAgent: state.userAgent,
				endpoints: Array.isArray(state.endpoints) ? state.endpoints : [],
				httpPort: state.httpPort,
				httpTls: state.httpTls,
				endpointsEndpoint: state.endpointsEndpoint,
				ws,
			};
			this.clientsByName.set(state.name, nextRecord);
		}
	}

	removeClientRecord(ws, reason = '') {
		const state = this.wsState.get(ws);
		if (!state) {
			return null;
		}

		if (state.name) {
			const current = this.clientsByName.get(state.name);
			if (current && current.ws === ws) {
				this.clientsByName.delete(state.name);
			}
		}

		this.wsState.delete(ws);
		void this.writeActiveConnectionsSnapshot();
		if (state.name) {
			void this.appendConnectionLog('CLIENT_DISCONNECTED', {
				name: state.name,
				address: state.address,
				ip: state.ip,
				port: state.port,
				reason,
			});
			this.broadcastPeerList();
		}
		return state;
	}

	broadcastPeerList() {
		const peers = Array.from(this.clientsByName.keys())
			.map((name) => String(name || '').trim().toLowerCase())
			.filter(Boolean)
			.sort((left, right) => left.localeCompare(right));

		const payload = JSON.stringify({
			type: 'peer-list',
			peers,
			timestamp: new Date().toISOString(),
		});

		for (const record of this.clientsByName.values()) {
			if (!record?.ws || record.ws.readyState !== WebSocket.OPEN) {
				continue;
			}
			try {
				record.ws.send(payload);
			} catch {
				// ignore individual failures
			}
		}
	}

	async handleSocketConnection(ws, request) {
		ws.isAlive = true;
		ws.binaryType = 'nodebuffer';

		const state = this.getWsState(ws);
		state.address = normalizeAddress(request, ws);
		state.ip = String(request?.socket?.remoteAddress || ws?._socket?.remoteAddress || 'unknown');
		state.port = Number(request?.socket?.remotePort || ws?._socket?.remotePort || 0) || null;
		state.userAgent = String(request?.headers?.['user-agent'] || '').trim();
		state.connectedAt = new Date().toISOString();
		state.lastSeenAt = state.connectedAt;

		void this.appendConnectionLog('CONNECTION_OPEN', {
			address: state.address,
			ip: state.ip,
			port: state.port,
			userAgent: state.userAgent,
		});

		ws.on('pong', () => {
			ws.isAlive = true;
			const nextState = this.getWsState(ws);
			nextState.lastSeenAt = new Date().toISOString();
		});

		ws.on('message', (data, isBinary) => {
			ws.isAlive = true;
			const nextState = this.getWsState(ws);
			nextState.lastSeenAt = new Date().toISOString();

			if (isBinary) {
				this.routeBinaryPayload(ws, data);
				return;
			}

			const packet = safeJsonParse(data);
			if (!packet || typeof packet !== 'object') {
				return;
			}

			void this.handlePacket(ws, packet);
		});

		ws.on('close', (code, reason) => {
			void this.handleSocketClose(ws, Number(code) || 0, String(reason || '').trim());
		});

		ws.on('error', (error) => {
			this.logError(`client error: ${error.message}`);
		});
	}

	async handleSocketClose(ws, code, reason) {
		const state = this.wsState.get(ws);
		if (!state) {
			return;
		}

		if (state.name) {
			const current = this.clientsByName.get(state.name);
			if (current && current.ws === ws) {
				this.clientsByName.delete(state.name);
			}
		}

		this.wsState.delete(ws);
		this.broadcastPeerList();
		await this.writeActiveConnectionsSnapshot();
		await this.appendConnectionLog(code === 4000 ? 'CLIENT_TERMINATED_HEARTBEAT' : 'CLIENT_DISCONNECTED', {
			name: state.name || 'unknown',
			address: state.address,
			ip: state.ip,
			port: state.port,
			code,
			reason,
		});
	}

	async handlePacket(ws, packet) {
		const type = String(packet.type || '').trim().toLowerCase();
		if (!type) {
			return;
		}

		if (type === 'register') {
			await this.handleRegisterPacket(ws, packet);
			return;
		}

		const state = this.getWsState(ws);
		if (!state.name) {
			this.rejectUnauthenticatedPacket(ws, 'not registered');
			return;
		}

		if (type === 'heartbeat') {
			state.lastSeenAt = new Date().toISOString();
			this.sendSafe(ws, {
				type: 'heartbeat-ack',
				name: state.name,
				timestamp: new Date().toISOString(),
			});
			return;
		}

		if (type === 'profile') {
			this.applyProfileUpdate(ws, packet);
			return;
		}

		if (type === 'message') {
			this.routeMessage(ws, packet);
			return;
		}

		if (type === 'signal') {
			this.routeSignal(ws, packet);
			return;
		}

		if (type === 'stream-chunk-bin') {
			this.queueBinaryAnnouncement(ws, packet);
			return;
		}

		if (type === 'unregister') {
			this.terminateSocket(ws, 'unregister requested', 1000);
			return;
		}
	}

	async handleRegisterPacket(ws, packet) {
		const state = this.getWsState(ws);
		const name = normalizeName(packet.name);
		const providedToken = String(packet.token || '').trim();

		if (!name) {
			this.rejectWithAuthError(ws, 'invalid node name');
			return;
		}

		if (!this.isAuthorizedToken(providedToken)) {
			this.rejectWithAuthError(ws, 'invalid exchange token');
			return;
		}

		const previous = this.clientsByName.get(name);
		if (previous && previous.ws && previous.ws !== ws) {
			try {
				previous.ws.close(1000, 'replaced by new registration');
			} catch {
				// ignore replacement close failures
			}
		}

		state.name = name;
		state.registrationAt = new Date().toISOString();
		state.lastSeenAt = state.registrationAt;
		state.endpoints = Array.isArray(packet.endpoints) ? packet.endpoints : [];
		state.httpPort = normalizePortValue(packet.httpPort);
		state.httpTls = Boolean(packet.httpTls);
		state.endpointsEndpoint = String(packet.endpointsEndpoint || '').trim() || null;

		this.clientsByName.set(name, {
			name,
			ws,
			address: state.address,
			ip: state.ip,
			port: state.port,
			connectedAt: state.connectedAt,
			registrationAt: state.registrationAt,
			lastSeenAt: state.lastSeenAt,
			userAgent: state.userAgent,
			endpoints: state.endpoints,
			httpPort: state.httpPort,
			httpTls: state.httpTls,
			endpointsEndpoint: state.endpointsEndpoint,
		});

		this.sendSafe(ws, {
			type: 'registered',
			name,
			timestamp: new Date().toISOString(),
		});

		void this.appendConnectionLog('CLIENT_REGISTERED', {
			name,
			address: state.address,
			ip: state.ip,
			port: state.port,
			userAgent: state.userAgent,
		});

		this.broadcastPeerList();
		await this.writeActiveConnectionsSnapshot();
	}

	applyProfileUpdate(ws, packet) {
		const state = this.getWsState(ws);
		if (!state.name) {
			return;
		}

		state.endpoints = Array.isArray(packet.endpoints) ? packet.endpoints : state.endpoints;
		if (Object.prototype.hasOwnProperty.call(packet, 'httpPort')) {
			state.httpPort = normalizePortValue(packet.httpPort);
		}
		if (Object.prototype.hasOwnProperty.call(packet, 'httpTls')) {
			state.httpTls = Boolean(packet.httpTls);
		}
		if (Object.prototype.hasOwnProperty.call(packet, 'endpointsEndpoint')) {
			state.endpointsEndpoint = String(packet.endpointsEndpoint || '').trim() || null;
		}
		state.lastSeenAt = new Date().toISOString();

		this.clientsByName.set(state.name, {
			...this.clientsByName.get(state.name),
			name: state.name,
			ws,
			address: state.address,
			ip: state.ip,
			port: state.port,
			connectedAt: state.connectedAt,
			registrationAt: state.registrationAt,
			lastSeenAt: state.lastSeenAt,
			userAgent: state.userAgent,
			endpoints: state.endpoints,
			httpPort: state.httpPort,
			httpTls: state.httpTls,
			endpointsEndpoint: state.endpointsEndpoint,
		});

		void this.writeActiveConnectionsSnapshot();
	}

	routeMessage(ws, packet) {
		const state = this.getWsState(ws);
		const target = normalizeName(packet.to);
		if (!target) {
			this.sendRouteError(ws, 'message', '', 'missing target');
			return;
		}

		const recipient = this.clientsByName.get(target);
		if (!recipient || !recipient.ws || recipient.ws.readyState !== WebSocket.OPEN) {
			this.sendRouteError(ws, 'message', target, 'target not connected');
			return;
		}

		const payload = {
			type: 'message',
			from: state.name,
			to: target,
			targetEndpoint: String(packet.targetEndpoint || '').trim() || null,
			targetEndpointId: String(packet.targetEndpointId || '').trim() || null,
			content: packet.content !== undefined ? packet.content : '',
			contentType: String(packet.contentType || 'text/plain'),
		};

		this.sendSafe(recipient.ws, payload);
	}

	routeSignal(ws, packet) {
		const state = this.getWsState(ws);
		const target = normalizeName(packet.to);
		const signalType = String(packet.signalType || '').trim().toLowerCase();

		if (!target || !signalType) {
			this.sendRouteError(ws, 'signal', target, 'missing target or signal type');
			return;
		}

		const recipient = this.clientsByName.get(target);
		if (!recipient || !recipient.ws || recipient.ws.readyState !== WebSocket.OPEN) {
			this.sendRouteError(ws, 'signal', target, 'target not connected');
			return;
		}

		this.sendSafe(recipient.ws, {
			type: 'signal',
			from: state.name,
			to: target,
			sessionId: String(packet.sessionId || '').trim() || null,
			signalType,
			payload: packet.payload !== undefined ? packet.payload : null,
			targetEndpoint: String(packet.targetEndpoint || '').trim() || null,
			targetEndpointId: String(packet.targetEndpointId || '').trim() || null,
			timestamp: String(packet.timestamp || '').trim() || new Date().toISOString(),
		});
	}

	queueBinaryAnnouncement(ws, packet) {
		const state = this.getWsState(ws);
		const target = normalizeName(packet.to);
		const streamId = String(packet.streamId || '').trim();
		if (!target || !streamId) {
			this.sendRouteError(ws, 'stream-chunk-bin', target, 'missing target or streamId');
			return;
		}

		const recipient = this.clientsByName.get(target);
		if (!recipient || !recipient.ws || recipient.ws.readyState !== WebSocket.OPEN) {
			this.sendRouteError(ws, 'stream-chunk-bin', target, 'target not connected');
			return;
		}

		state.binaryQueue.push({
			to: target,
			from: state.name,
			streamId,
			index: Number.isFinite(Number(packet.index)) ? Number(packet.index) : -1,
			size: Number.isFinite(Number(packet.size)) ? Number(packet.size) : 0,
		});

		this.sendSafe(recipient.ws, {
			type: 'stream-chunk-bin',
			from: state.name,
			to: target,
			streamId,
			index: Number.isFinite(Number(packet.index)) ? Number(packet.index) : -1,
			size: Number.isFinite(Number(packet.size)) ? Number(packet.size) : 0,
		});
	}

	routeBinaryPayload(ws, data) {
		const state = this.getWsState(ws);
		const meta = state.binaryQueue.shift();
		if (!meta) {
			this.sendRouteError(ws, 'binary', '', 'binary frame without stream metadata');
			return;
		}

		const recipient = this.clientsByName.get(meta.to);
		if (!recipient || !recipient.ws || recipient.ws.readyState !== WebSocket.OPEN) {
			this.sendRouteError(ws, 'binary', meta.to, 'target not connected');
			return;
		}

		try {
			recipient.ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data), { binary: true });
		} catch (error) {
			this.sendRouteError(ws, 'binary', meta.to, error.message);
		}
	}

	sendRouteError(ws, kind, target, reason) {
		this.sendSafe(ws, {
			type: 'route-error',
			kind,
			target: target || null,
			reason: String(reason || 'route failed'),
			timestamp: new Date().toISOString(),
		});
	}

	rejectUnauthenticatedPacket(ws, reason) {
		this.sendSafe(ws, {
			type: 'auth-error',
			error: String(reason || 'not registered'),
		});
		try {
			ws.close(4001, String(reason || 'not registered'));
		} catch {
			// ignore close errors
		}
	}

	rejectWithAuthError(ws, errorMessage) {
		this.sendSafe(ws, {
			type: 'auth-error',
			error: String(errorMessage || 'invalid exchange token'),
		});
		try {
			ws.close(4001, String(errorMessage || 'invalid exchange token'));
		} catch {
			// ignore close errors
		}
	}

	sendSafe(ws, payload) {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return false;
		}

		try {
			ws.send(JSON.stringify(payload));
			return true;
		} catch {
			return false;
		}
	}

	terminateSocket(ws, reason, code = 4000) {
		try {
			ws.close(code, reason);
		} catch {
			try {
				ws.terminate();
			} catch {
				// ignore
			}
		}
	}
}

async function createDaemonFromEnvironment() {
	const envFilePath = process.env.REACTOR_ENV_FILE || path.join(process.cwd(), '.env');
	await loadEnvFileIfPresent(envFilePath);

	const port = normalizePortValue(
		process.env.REACTOR_HTTP_PORT
		|| process.env.PORT,
	) || 7070;
	const host = String(
		process.env.REACTOR_HTTP_HOST
		|| process.env.BIND_HOST
		|| '0.0.0.0',
	).trim() || '0.0.0.0';
	const token = String(
		process.env.TOKEN
		|| '',
	).trim();
	const dataDir = String(process.env.REACTOR_DATA_DIR || getDefaultDataDir()).trim() || getDefaultDataDir();
	const tlsEnabled = parseBooleanFlag(process.env.REACTOR_EXCHANGE_TLS || process.env.TLS);
	const tlsProxyEnabled = parseBooleanFlag(process.env.REACTOR_EXCHANGE_TLS_PROXY || process.env.TLS_PROXY);
	const tlsMode = tlsProxyEnabled
		? 'proxy'
		: parseTlsMode(process.env.REACTOR_EXCHANGE_TLS_MODE || process.env.TLS_MODE || 'direct');
	const tlsPaths = getTlsPaths(dataDir);
	const heartbeatIntervalMs = parsePositiveInt(process.env.REACTOR_EXCHANGE_HEARTBEAT_INTERVAL_MS, 15000, 3000);
	const heartbeatTimeoutMs = parsePositiveInt(process.env.REACTOR_EXCHANGE_HEARTBEAT_TIMEOUT_MS, 45000, heartbeatIntervalMs + 1000);
	const tlsReloadIntervalMs = parsePositiveInt(process.env.TLS_RELOAD_INTERVAL_MS, 5000, 1000);

	return new ReactorExchangeDaemon({
		host,
		port,
		token,
		dataDir,
		tlsEnabled,
		tlsMode,
		tlsCertPath: tlsPaths.certPath,
		tlsKeyPath: tlsPaths.keyPath,
		tlsReloadIntervalMs,
		heartbeatIntervalMs,
		heartbeatTimeoutMs,
	});
}

async function main() {
	const daemon = await createDaemonFromEnvironment();

	const shutdown = async () => {
		try {
			await daemon.stop();
		} catch (error) {
			console.error(`[Exchange] shutdown failed: ${error.message}`);
		}
	};

	process.once('SIGINT', () => {
		void shutdown().finally(() => process.exit(0));
	});
	process.once('SIGTERM', () => {
		void shutdown().finally(() => process.exit(0));
	});
	process.once('uncaughtException', (error) => {
		console.error(`[Exchange] uncaught exception: ${error.stack || error.message}`);
		void shutdown().finally(() => process.exit(1));
	});
	process.once('unhandledRejection', (error) => {
		const message = error && error.stack ? error.stack : String(error || 'unhandled rejection');
		console.error(`[Exchange] unhandled rejection: ${message}`);
		void shutdown().finally(() => process.exit(1));
	});

	await daemon.start();

	const status = daemon.getStatusSnapshot();
	console.log(`[Exchange] status: ${JSON.stringify(status)}`);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`[Exchange] fatal error: ${error.stack || error.message}`);
		process.exit(1);
	});
}

module.exports = {
	ReactorExchangeDaemon,
	createDaemonFromEnvironment,
	loadEnvFileIfPresent,
};
