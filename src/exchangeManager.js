const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const { DEFAULT_LOCAL_SERVER_PORT } = require('./runtime/coreUtils');

const RECONNECT_DELAY_MS = 5000;
const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 45000;
const DEFAULT_UNDELIVERED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_UNDELIVERED_RETRY_MS = 30 * 1000;
const DEFAULT_PENDING_SIGNAL_TTL_MS = 15000;

function closeWebSocketAndWait(ws, timeoutMs = 1500) {
	if (!ws || ws.readyState === WebSocket.CLOSED) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		let settled = false;
		let timer = null;

		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			ws.off('close', finish);
			resolve();
		};

		ws.once('close', finish);
		timer = setTimeout(() => {
			try {
				if (ws.readyState !== WebSocket.CLOSED) {
					ws.terminate();
				}
			} catch {
				// ignore forced close failures
			}
			finish();
		}, Math.max(0, Number(timeoutMs) || 0));

		try {
			if (ws.readyState === WebSocket.OPEN) {
				ws.close(1000, 'reactor reconfigure');
			} else if (ws.readyState !== WebSocket.CLOSING) {
				ws.terminate();
			}
		} catch {
			finish();
		}
	});
}

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

function parseExchangeEndpointSelector(rawSelector) {
	const trimmed = String(rawSelector || '').trim();
	if (!trimmed) {
		return null;
	}

	const lowered = trimmed.toLowerCase();
	if (lowered.startsWith('id:')) {
		const endpointId = lowered.slice(3).trim();
		if (!endpointId) {
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

function parseLogicalExchangeTarget(rawTarget) {
	const trimmed = String(rawTarget || '').trim();
	if (!trimmed) {
		return null;
	}

	const atIndex = trimmed.lastIndexOf('@');
	if (atIndex === -1) {
		return {
			nodeName: trimmed.toLowerCase(),
			endpointSelector: null,
			endpointId: null,
			rawTarget: trimmed,
		};
	}

	const endpointRaw = trimmed.slice(0, atIndex).trim();
	const nodeName = trimmed.slice(atIndex + 1).trim().toLowerCase();
	const endpointSelector = parseExchangeEndpointSelector(endpointRaw);
	if (!nodeName || !endpointSelector) {
		return null;
	}

	return {
		nodeName,
		endpointSelector,
		endpointId: endpointSelector.type === 'id' ? endpointSelector.value : null,
		rawTarget: trimmed,
	};
}

/**
 * ExchangeManager — due modalità:
 *
 * - exchange: WS server attaccato all'HTTP server esistente (stessa porta HTTP).
 *             I client si registrano per nome e i messaggi vengono instradati src→dst.
 *
	 * - client:   WS client che si connette all'exchange (ws://host:port).
 *             Riceve messaggi → triggera i listener MESSAGE locali.
 *             Node.sendMessage() usa l'exchange come canale di uscita.
 *
 * Protocollo JSON:
 *   { type: 'register', name: 'my-name', token: 'shared-secret' }
 *   { type: 'message', to: 'target', content: '...', contentType: '...' }
 *   { type: 'message', from: 'sender', content: '...', contentType: '...' }  (deliver)
 */
class ExchangeManager {
	constructor(runtime) {
		this.runtime = runtime;
		this.mode = 'disabled'; // 'disabled' | 'exchange' | 'client'
		this.host = ''; // client mode: exchange server host
		this.port = 7070; // client mode: exchange server port (= HTTP port of exchange)
		this.tls = false; // usa WSS (wss://) invece di WS (ws://)
		this.wss = null; // WebSocketServer noServer (exchange mode)
		this.wsClient = null; // WebSocket client (client mode)
		this.connectedClients = new Map(); // name → ws (exchange mode)
		this.reconnectTimer = null;
		this._stopped = false;
		this._httpServer = null;
		this._upgradeHandler = null;
		this._serverHeartbeatTimer = null;
		this._clientHeartbeatTimer = null;
		this._clientLastPongAt = 0;
		this._clientLastPingAt = 0;
		this._clientLastTimeoutAt = 0;
		this._serverLastSweepAt = 0;
		this._serverPingsSent = 0;
		this._serverPongsReceived = 0;
		this._serverTerminatedClients = 0;
		this._connectedClientDetails = new Map();
		this._socketClientMeta = new WeakMap();
		this._serverPendingBinaryChunkMeta = new WeakMap();
		this._clientPendingBinaryChunkMeta = [];
		this._clientPendingBinaryFrames = [];
		this._clientDeliveredBinaryMeta = new Map();
		this._clientLastError = '';
		this._clientLastCloseReason = '';
		this._clientLastCloseCode = 0;
		this._clientConnectedAt = 0;
		this._clientRegistered = false;
		this._knownRemotePeers = new Set();
		this._heartbeatIntervalMs = this._readHeartbeatValue('REACTOR_EXCHANGE_HEARTBEAT_INTERVAL_MS', DEFAULT_WS_HEARTBEAT_INTERVAL_MS, 3000);
		this._heartbeatTimeoutMs = this._readHeartbeatValue('REACTOR_EXCHANGE_HEARTBEAT_TIMEOUT_MS', DEFAULT_WS_HEARTBEAT_TIMEOUT_MS, this._heartbeatIntervalMs + 1000);
		this._connectionLogPath = path.join(this.runtime.reactorRootDir || process.cwd(), 'exchange-connections.log');
		this._activeConnectionsPath = path.join(this.runtime.reactorRootDir || process.cwd(), 'exchange-active-connections.json');
		this._undeliveredQueuePath = path.join(this.runtime.reactorRootDir || process.cwd(), 'exchange-undelivered-queue.json');
		this._undeliveredQueueTtlMs = this._readHeartbeatValue('REACTOR_MESSAGE_QUEUE_TTL_MS', DEFAULT_UNDELIVERED_TTL_MS, 60 * 1000);
		this._undeliveredQueueRetryMs = this._readHeartbeatValue('REACTOR_MESSAGE_QUEUE_RETRY_MS', DEFAULT_UNDELIVERED_RETRY_MS, 5 * 1000);
		this._undeliveredFlushTimer = null;
		this._isFlushingUndelivered = false;
		this._pendingSignalTtlMs = this._readHeartbeatValue('REACTOR_SIGNAL_QUEUE_TTL_MS', DEFAULT_PENDING_SIGNAL_TTL_MS, 1000);
		this._pendingSignalsByTarget = new Map();
	}

	_enqueuePendingSignal(target, outboundSignal) {
		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget || !outboundSignal || typeof outboundSignal !== 'object') {
			return;
		}

		const now = Date.now();
		const expiresAt = now + this._pendingSignalTtlMs;
		const queue = this._pendingSignalsByTarget.get(safeTarget) || [];
		queue.push({
			queuedAt: now,
			expiresAt,
			packet: outboundSignal,
		});
		this._pendingSignalsByTarget.set(safeTarget, queue);
	}

	_flushPendingSignalsForTarget(target) {
		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget) {
			return;
		}

		const targetWs = this.connectedClients.get(safeTarget);
		if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
			return;
		}

		const now = Date.now();
		const queue = this._pendingSignalsByTarget.get(safeTarget) || [];
		if (queue.length === 0) {
			return;
		}

		const remaining = [];
		let delivered = 0;
		for (const item of queue) {
			if (!item || !item.packet || Number(item.expiresAt || 0) <= now) {
				continue;
			}

			try {
				targetWs.send(JSON.stringify(item.packet));
				delivered += 1;
			} catch {
				remaining.push(item);
			}
		}

		if (remaining.length > 0) {
			this._pendingSignalsByTarget.set(safeTarget, remaining);
		} else {
			this._pendingSignalsByTarget.delete(safeTarget);
		}

		if (delivered > 0) {
			this.runtime.log(`[Exchange] Flushed ${delivered} queued signaling packet(s) to ${safeTarget}`);
		}
	}

	_emitConnectionStatus(reason = '') {
		if (!this.runtime || typeof this.runtime.publishUiStatusSnapshot !== 'function') {
			return;
		}

		this.runtime.publishUiStatusSnapshot(reason);
	}

	getConnectionStatus() {
		if (this.mode === 'exchange') {
			return {
				mode: this.mode,
				state: this.wss ? 'connected' : 'disconnected',
				connected: Boolean(this.wss),
				connectedAt: null,
				authenticated: true,
				reason: '',
				lastError: '',
				lastCloseReason: '',
				lastCloseCode: 0,
				lastPongAt: null,
			};
		}

		const wsState = this.wsClient ? this.wsClient.readyState : WebSocket.CLOSED;
		if (wsState === WebSocket.OPEN && this._clientRegistered) {
			return {
				mode: this.mode,
				state: 'connected',
				connected: true,
				connectedAt: this._clientConnectedAt ? new Date(this._clientConnectedAt).toISOString() : null,
				authenticated: true,
				reason: '',
				lastError: '',
				lastCloseReason: '',
				lastCloseCode: 0,
				lastPongAt: this._clientLastPongAt ? new Date(this._clientLastPongAt).toISOString() : null,
			};
		}

		const errorType = this._classifyClientFailureType(this._clientLastError || this._clientLastCloseReason, this._clientLastCloseCode);
		if (wsState === WebSocket.OPEN) {
			return {
				mode: this.mode,
				state: errorType === 'authentication' ? 'auth-failed' : 'connecting',
				connected: false,
				connectedAt: this._clientConnectedAt ? new Date(this._clientConnectedAt).toISOString() : null,
				authenticated: false,
				reason: this._clientLastError || (errorType === 'authentication' ? 'authentication failed' : 'waiting for exchange registration'),
				lastError: this._clientLastError,
				lastCloseReason: this._clientLastCloseReason,
				lastCloseCode: this._clientLastCloseCode,
				lastPongAt: this._clientLastPongAt ? new Date(this._clientLastPongAt).toISOString() : null,
				errorType,
			};
		}

		if (wsState === WebSocket.CONNECTING) {
			return {
				mode: this.mode,
				state: 'connecting',
				connected: false,
				connectedAt: null,
				authenticated: false,
				reason: 'connecting to exchange',
				lastError: this._clientLastError,
				lastCloseReason: this._clientLastCloseReason,
				lastCloseCode: this._clientLastCloseCode,
				lastPongAt: this._clientLastPongAt ? new Date(this._clientLastPongAt).toISOString() : null,
				errorType: 'connection',
			};
		}

		const reason = this._clientLastError || this._clientLastCloseReason || (this._clientLastTimeoutAt ? 'heartbeat timeout' : '') || 'disconnected';
		return {
			mode: this.mode,
			state: errorType === 'authentication' ? 'auth-failed' : 'disconnected',
			connected: false,
			connectedAt: null,
			authenticated: false,
			reason,
			lastError: this._clientLastError,
			lastCloseReason: this._clientLastCloseReason,
			lastCloseCode: this._clientLastCloseCode,
			lastPongAt: this._clientLastPongAt ? new Date(this._clientLastPongAt).toISOString() : null,
			errorType,
		};
	}

	_classifyClientFailureType(reason, closeCode = 0) {
		const safeReason = String(reason || '').trim().toLowerCase();
		if (Number(closeCode) === 4001) {
			return 'authentication';
		}
		if (!safeReason) {
			return 'connection';
		}
		if (
			safeReason.includes('invalid exchange token')
			|| safeReason.includes('auth error')
			|| safeReason.includes('unauthorized')
			|| safeReason.includes('bearer token')
			|| safeReason.includes('http 401')
		) {
			return 'authentication';
		}
		if (
			safeReason.includes('self signed')
			|| safeReason.includes('unable to verify')
			|| safeReason.includes('certificate')
			|| safeReason.includes('x509')
		) {
			return 'tls-certificate';
		}
		return 'connection';
	}

	_readHeartbeatValue(envName, fallback, minValue) {
		const raw = Number(process.env[envName]);
		if (!Number.isFinite(raw)) {
			return fallback;
		}

		return Math.max(minValue, Math.floor(raw));
	}

	_sanitizeDiscoveryEndpoints(rawEndpoints) {
		if (!Array.isArray(rawEndpoints)) {
			return [];
		}

		return rawEndpoints
			.map((endpoint) => ({
				uuid: String(endpoint?.uuid || '').trim().toLowerCase(),
				name: String(endpoint?.name || '').trim() || 'unknown',
				triggers: Array.isArray(endpoint?.triggers)
					? endpoint.triggers.map((trigger) => String(trigger || '').trim()).filter(Boolean)
					: [],
				enabled: Boolean(endpoint?.enabled),
				mutex: Boolean(endpoint?.mutex),
			}))
			.filter((endpoint) => endpoint.uuid);
	}

	_normalizeDiscoveryPort(rawPort) {
		const port = Number(rawPort);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return null;
		}
		return port;
	}

	_sanitizeDiscoveryEndpoint(rawEndpoint) {
		const value = String(rawEndpoint || '').trim();
		if (!value) {
			return null;
		}

		try {
			const parsed = new URL(value);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				return null;
			}
			parsed.hash = '';
			return parsed.toString();
		} catch {
			return null;
		}
	}

	async _appendConnectionLog(event, details = {}) {
		try {
			const entry = {
				timestamp: new Date().toISOString(),
				event,
				...details,
			};
			await fs.appendFile(this._connectionLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
		} catch {
			// Connection logging should not impact runtime.
		}
	}

	_serializeActiveConnections() {
		return Array.from(this._connectedClientDetails.values())
			.map((detail) => ({
				name: detail.name || 'unknown',
				registrationAt: detail.registrationAt || detail.connectedAt || null,
				lastSeenAt: detail.lastSeenAt || null,
				ip: detail.ip || null,
				port: Number.isFinite(detail.port) ? detail.port : null,
				userAgent: detail.userAgent || '',
			}))
			.sort((a, b) => String(a.name).localeCompare(String(b.name)));
	}

	async _writeActiveConnectionsSnapshot() {
		try {
			const payload = this._serializeActiveConnections();
			await fs.writeFile(this._activeConnectionsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
		} catch {
			// Snapshot persistence should not impact runtime.
		}
	}

	async _readUndeliveredQueue() {
		try {
			const raw = await fs.readFile(this._undeliveredQueuePath, 'utf8');
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	async _writeUndeliveredQueue(queue) {
		await fs.writeFile(this._undeliveredQueuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
	}

	async _enqueueUndeliveredMessage(to, from, content, contentType, targetEndpoint = null, targetEndpointId = null) {
		const now = Date.now();
		const queue = await this._readUndeliveredQueue();
		queue.push({
			id: `${now}-${Math.random().toString(16).slice(2)}`,
			to,
			targetEndpoint: targetEndpoint || null,
			targetEndpointId: targetEndpointId || null,
			from,
			content,
			contentType,
			createdAt: now,
			expiresAt: now + this._undeliveredQueueTtlMs,
			nextAttemptAt: now + this._undeliveredQueueRetryMs,
			attempts: 0,
		});
		await this._writeUndeliveredQueue(queue);
		this.runtime.log(`[Exchange] Queued undelivered message for ${to}`);
	}

	_startUndeliveredFlushTimer() {
		if (this._undeliveredFlushTimer) {
			clearInterval(this._undeliveredFlushTimer);
		}

		this._undeliveredFlushTimer = setInterval(() => {
			this._flushUndeliveredQueue().catch((error) => {
				this.runtime.log(`[Exchange] Undelivered queue flush failed: ${error.message}`);
			});
		}, this._undeliveredQueueRetryMs);
	}

	_stopUndeliveredFlushTimer() {
		if (this._undeliveredFlushTimer) {
			clearInterval(this._undeliveredFlushTimer);
			this._undeliveredFlushTimer = null;
		}
	}

	async _flushUndeliveredQueue(recipientFilter = null) {
		if (this._isFlushingUndelivered) {
			return;
		}

		this._isFlushingUndelivered = true;
		try {
			const now = Date.now();
			const queue = await this._readUndeliveredQueue();
			if (queue.length === 0) {
				return;
			}

			const nextQueue = [];
			let delivered = 0;

			for (const item of queue) {
				if (!item || typeof item !== 'object') {
					continue;
				}
				if (Number(item.expiresAt || 0) <= now) {
					continue;
				}
				if (recipientFilter && item.to !== recipientFilter) {
					nextQueue.push(item);
					continue;
				}
				if (Number(item.nextAttemptAt || 0) > now) {
					nextQueue.push(item);
					continue;
				}

				const targetWs = this.connectedClients.get(String(item.to || '').toLowerCase());
				if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
					const attempts = Number(item.attempts || 0) + 1;
					nextQueue.push({
						...item,
						attempts,
						nextAttemptAt: now + Math.min(this._undeliveredQueueRetryMs * attempts, 30 * 60 * 1000),
					});
					continue;
				}

				try {
					targetWs.send(JSON.stringify({
						type: 'message',
						from: item.from || 'unknown',
						targetEndpoint: item.targetEndpoint || null,
						targetEndpointId: item.targetEndpointId || null,
						content: item.content !== undefined ? item.content : '',
						contentType: String(item.contentType || 'text/plain'),
					}));
					delivered += 1;
				} catch {
					const attempts = Number(item.attempts || 0) + 1;
					nextQueue.push({
						...item,
						attempts,
						nextAttemptAt: now + Math.min(this._undeliveredQueueRetryMs * attempts, 30 * 60 * 1000),
					});
				}
			}

			await this._writeUndeliveredQueue(nextQueue);
			if (delivered > 0) {
				this.runtime.log(`[Exchange] Flushed ${delivered} queued message(s)`);
			}
		} finally {
			this._isFlushingUndelivered = false;
		}
	}

	_resolveClientNetwork(request, ws) {
		const forwardedIp = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
		const ip = forwardedIp || String(request?.socket?.remoteAddress || ws?._socket?.remoteAddress || 'unknown');

		const forwardedPort = Number(String(request?.headers?.['x-forwarded-port'] || '').trim());
		const socketPort = Number(request?.socket?.remotePort || ws?._socket?.remotePort || 0);
		const port = Number.isFinite(forwardedPort) && forwardedPort > 0 ? forwardedPort : socketPort > 0 ? socketPort : null;

		return { ip, port };
	}

	_resolveClientAddress(request, ws) {
		const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
		if (forwarded) {
			return forwarded;
		}
		return String(request?.socket?.remoteAddress || ws?._socket?.remoteAddress || 'unknown');
	}

	configure(mode, host, port, tls = false) {
		this.mode = String(mode || 'disabled');
		this.host = String(host || '').trim();
		this.port = Number(port) > 0 ? Number(port) : 7070;
		this.tls = Boolean(tls);
	}

	async _getExpectedExchangeToken() {
		const runtimeToken = String(this.runtime?.exchangeAuthToken || '').trim();
		if (runtimeToken) {
			return runtimeToken;
		}

		if (this.runtime && this.runtime.getExchangeToken) {
			try {
				const info = await this.runtime.getExchangeToken();
				return String(info?.token || '').trim();
			} catch {
				return runtimeToken;
			}
		}

		return runtimeToken;
	}

	_readBearerToken(request) {
		const rawAuthorization = String(request?.headers?.authorization || '').trim();
		if (!rawAuthorization) {
			return '';
		}

		const match = rawAuthorization.match(/^Bearer\s+(.+)$/i);
		return match ? String(match[1] || '').trim() : '';
	}

	_resolveExchangePath(rawPath, fallback = '/') {
		const value = String(rawPath || '').trim();
		if (!value) {
			return fallback;
		}

		try {
			const parsed = new URL(value, 'http://localhost');
			return `${parsed.pathname || '/'}${parsed.search || ''}`;
		} catch {
			if (value.startsWith('/')) {
				return value;
			}
			return fallback;
		}
	}

	_requestJson({ method = 'GET', path: requestPath = '/', body = null, headers = {} } = {}) {
		const requestBody = body === null ? null : JSON.stringify(body);
		const transport = this.tls ? https : http;
		const timeoutMs = 10000;
		const options = {
			protocol: this.tls ? 'https:' : 'http:',
			hostname: this.host,
			port: this.port,
			method: String(method || 'GET').toUpperCase(),
			path: this._resolveExchangePath(requestPath, '/'),
			headers: {
				Accept: 'application/json',
				...headers,
			},
			timeout: timeoutMs,
		};

		if (this.tls) {
			options.rejectUnauthorized = true;
		}

		if (requestBody !== null) {
			options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
			options.headers['Content-Length'] = Buffer.byteLength(requestBody);
		}

		return new Promise((resolve, reject) => {
			const req = transport.request(options, (response) => {
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('end', () => {
					const statusCode = Number(response.statusCode) || 0;
					const raw = Buffer.concat(chunks).toString('utf8').trim();
					let parsedBody = null;
					if (raw) {
						try {
							parsedBody = JSON.parse(raw);
						} catch {
							parsedBody = null;
						}
					}

					if (statusCode < 200 || statusCode >= 300) {
						const serverError = parsedBody && typeof parsedBody.error === 'string' ? parsedBody.error : '';
						const detail = serverError || raw || `HTTP ${statusCode}`;
						reject(new Error(`HTTP ${statusCode}: ${detail}`));
						return;
					}

					resolve({
						statusCode,
						body: parsedBody,
						raw,
					});
				});
			});

			req.on('timeout', () => {
				req.destroy(new Error('request timeout'));
			});

			req.on('error', (error) => {
				reject(error);
			});

			if (requestBody !== null) {
				req.write(requestBody);
			}

			req.end();
		});
	}

	async _bootstrapClientWebSocketSession(registerPacket) {
		const token = String(this.runtime.exchangeAuthToken || '').trim();
		const user = String(this.runtime.exchangeAuthUser || '').trim();
		const password = String(this.runtime.exchangeAuthPassword || '');
		const headers = token
			? { Authorization: `Bearer ${token}` }
			: user
			? { Authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}` }
			: {};
		const payload = {
			clientName: String(registerPacket?.name || '').trim() || 'unnamed',
			user,
			password,
		};

		const response = await this._requestJson({
			method: 'POST',
			path: '/register',
			body: payload,
			headers,
		});

		const responseBody = response && typeof response.body === 'object' && response.body ? response.body : {};
		if (!responseBody.ok) {
			throw new Error(String(responseBody.error || 'invalid register response'));
		}

		const sessionId = String(responseBody.sessionId || '').trim();
		if (!sessionId) {
			throw new Error('invalid register response: missing sessionId');
		}

		const wsPath = this._resolveExchangePath(
			responseBody.wsPath || `/ws?sessionId=${encodeURIComponent(sessionId)}`,
			`/ws?sessionId=${encodeURIComponent(sessionId)}`,
		);
		const scheme = this.tls ? 'wss' : 'ws';
		return {
			sessionId,
			wsUrl: `${scheme}://${this.host}:${this.port}${wsPath}`,
			expiresAt: String(responseBody.expiresAt || '').trim() || null,
		};
	}

	_rejectUpgrade(socket, statusCode, message) {
		try {
			socket.write(
				`HTTP/1.1 ${statusCode} ${message}\r\n` +
				'Content-Type: text/plain; charset=utf-8\r\n' +
				'Connection: close\r\n' +
				`Content-Length: ${Buffer.byteLength(message)}\r\n` +
				'\r\n' +
				message,
			);
		} catch {
			// ignore socket write failures during rejected upgrade
		}

		try {
			socket.destroy();
		} catch {
			// ignore destroy failures
		}
	}

	/** Avvia l'exchange. Deve essere chiamata dopo che l'httpServer è in ascolto. */
	async start(httpServer) {
		await this.stop();
		this._stopped = false;
		await fs.mkdir(path.dirname(this._undeliveredQueuePath), { recursive: true });

		if (this.mode === 'exchange') {
			this._startServer(httpServer);
		} else if (this.mode === 'client' && this.host) {
			this._startClient();
		}
	}

	async stop() {
		this._stopped = true;
		this._stopServerHeartbeat();
		this._stopClientHeartbeat();
		this._stopUndeliveredFlushTimer();

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		if (this._httpServer && this._upgradeHandler) {
			this._httpServer.removeListener('upgrade', this._upgradeHandler);
			this._httpServer = null;
			this._upgradeHandler = null;
		}

		const serverClientSockets = new Set();
		if (this.wss && this.wss.clients) {
			for (const client of this.wss.clients) {
				serverClientSockets.add(client);
			}
		}
		for (const client of this.connectedClients.values()) {
			serverClientSockets.add(client);
		}
		await Promise.all(Array.from(serverClientSockets, (client) => closeWebSocketAndWait(client)));

		if (this.wss) {
			const wss = this.wss;
			this.wss = null;
			await new Promise((resolve) => wss.close(() => resolve()));
		}

		if (this.wsClient) {
			const wsClient = this.wsClient;
			this.wsClient = null;
			await closeWebSocketAndWait(wsClient);
		}

		this.connectedClients.clear();
		this._connectedClientDetails.clear();
		this._knownRemotePeers.clear();
		this._pendingSignalsByTarget.clear();
		await this._writeActiveConnectionsSnapshot();
	}

	_broadcastClientPeerList() {
		if (this.mode !== 'exchange') {
			return;
		}

		const peers = Array.from(this.connectedClients.keys())
			.map((name) => String(name || '').trim().toLowerCase())
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b));

		const payload = JSON.stringify({
			type: 'peer-list',
			peers,
			timestamp: new Date().toISOString(),
		});

		for (const ws of this.connectedClients.values()) {
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				continue;
			}

			try {
				ws.send(payload);
			} catch {
				// Ignore peer list notification failures for disconnected sockets.
			}
		}
	}

	_extractRemotePeerNamesFromPacket(packet = {}) {
		const peers = Array.isArray(packet.peers) ? packet.peers : [];
		const selfName = String(this.runtime?.cachedReactorName || '').trim().toLowerCase();
		const next = new Set();

		for (const peer of peers) {
			const safePeer = String(peer || '').trim().toLowerCase();
			if (!safePeer) {
				continue;
			}
			if (selfName && safePeer === selfName) {
				continue;
			}
			next.add(safePeer);
		}

		return next;
	}

	_handleIncomingPeerList(packet = {}) {
		this._knownRemotePeers = this._extractRemotePeerNamesFromPacket(packet);
		if (this.runtime && typeof this.runtime.logGlobalEvent === 'function') {
			const peers = this.getKnownRemotePeers();
			this.runtime.logGlobalEvent('EXCHANGE/PEER_LIST', `received peer-list peers=${peers.join(',') || 'none'}`).catch(() => {});
		}
		if (this.runtime && typeof this.runtime.handleDiscoveredRemotePeers === 'function') {
			this.runtime.handleDiscoveredRemotePeers(this.getKnownRemotePeers()).catch(() => {});
		}
	}

	getKnownRemotePeers() {
		return Array.from(this._knownRemotePeers.values()).sort((a, b) => a.localeCompare(b));
	}

	// ---------------------------------------------------------------------------
	// EXCHANGE SERVER — si aggancia all'HTTP server esistente (stessa porta)
	// ---------------------------------------------------------------------------

	_startServer(httpServer) {
		this.wss = new WebSocketServer({ noServer: true });
		this.wss.on('connection', (ws, request) => this._handleClientConnection(ws, request));
		this._startServerHeartbeat();
		this._startUndeliveredFlushTimer();

		this._httpServer = httpServer;
		this._upgradeHandler = (request, socket, head) => {
			(async () => {
				if (this.mode !== 'exchange' || !this.wss) {
					socket.destroy();
					return;
				}

				const expectedToken = await this._getExpectedExchangeToken();
				const providedToken = this._readBearerToken(request);

				if (expectedToken && providedToken !== expectedToken) {
					this.runtime.log('[Exchange] Upgrade rejected: invalid Authorization Bearer token');
					this._appendConnectionLog('AUTH_REJECTED_UPGRADE', {
						address: this._resolveClientAddress(request),
						reason: 'invalid bearer token',
					});
					this._rejectUpgrade(socket, 401, 'Unauthorized');
					return;
				}

				this.wss.handleUpgrade(request, socket, head, (ws) => {
					this.wss.emit('connection', ws, request);
				});
			})().catch(() => {
				this._rejectUpgrade(socket, 500, 'Internal Server Error');
			});
		};

		httpServer.on('upgrade', this._upgradeHandler);
		void this._writeActiveConnectionsSnapshot();
		const httpProto = this.runtime && this.runtime.tlsEnabled ? 'HTTPS' : 'HTTP';
		const wsProto = this.runtime && this.runtime.tlsEnabled ? 'WSS' : 'WS';
		const tlsLabel = this.runtime && this.runtime.tlsEnabled ? 'TLS enabled (certificate loaded)' : 'TLS disabled (no certificate found)';
		const portLabel = this.runtime && this.runtime.httpServerPort ? ` ${this.runtime.httpServerPort}` : '';
		this.runtime.log(`[Exchange] WebSocket server active on ${httpProto}/${wsProto}${portLabel} - ${tlsLabel}`);
	}

	_handleClientConnection(ws, request) {
		let clientName = null;
		ws.isAlive = true;
		const connectedAt = new Date().toISOString();
		const { ip, port } = this._resolveClientNetwork(request, ws);
		const address = this._resolveClientAddress(request, ws);
		const userAgent = String(request?.headers?.['user-agent'] || '').trim();
		this._socketClientMeta.set(ws, { address, connectedAt, userAgent });
		this._appendConnectionLog('CONNECTION_OPEN', {
			address,
			ip,
			port,
			userAgent,
		});

		ws.on('pong', () => {
			ws.isAlive = true;
			this._serverPongsReceived += 1;
		});

		ws.on('message', (data, isBinary) => {
			ws.isAlive = true;
			if (isBinary) {
				this._routeBinaryChunkData(ws, data, clientName || 'unknown');
				return;
			}

			let packet;
			try { packet = JSON.parse(String(data)); } catch { return; }
			if (!packet || typeof packet !== 'object') return;

			if (packet.type === 'register') {
				const name = String(packet.name || '').trim().toLowerCase();
				const providedToken = String(packet.token || '').trim();
				const expectedToken = String(this.runtime.exchangeAuthToken || '').trim();
				const discoveryEndpoints = this._sanitizeDiscoveryEndpoints(packet.endpoints);
				const discoveryPort = this._normalizeDiscoveryPort(packet.httpPort);
				const discoveryTls = Boolean(packet.httpTls);
				const endpointsEndpoint = this._sanitizeDiscoveryEndpoint(packet.endpointsEndpoint);

				if (expectedToken && providedToken !== expectedToken) {
					this.runtime.log(`[Exchange] Registration rejected for ${name || 'unknown'}: invalid token`);
					this._appendConnectionLog('AUTH_REJECTED_REGISTER', {
						name: name || 'unknown',
						address,
						reason: 'invalid exchange token',
					});
					ws.send(JSON.stringify({ type: 'auth-error', error: 'invalid exchange token' }));
					ws.close(4001, 'invalid exchange token');
					return;
				}

				if (name) {
					const previousWs = this.connectedClients.get(name);
					if (previousWs && previousWs !== ws) {
						try {
							previousWs.close(1000, 'replaced by new registration');
						} catch {
							// Ignore failures while closing stale sockets.
						}
					}
					if (clientName && clientName !== name) this.connectedClients.delete(clientName);
					clientName = name;
					this.connectedClients.set(clientName, ws);
					this._clientRegistered = true;
					this._connectedClientDetails.set(clientName, {
						name: clientName,
						address,
						ip,
						port,
						registrationAt: connectedAt,
						connectedAt,
						lastSeenAt: new Date().toISOString(),
						userAgent,
						endpoints: discoveryEndpoints,
						httpPort: discoveryPort,
						httpTls: discoveryTls,
						endpointsEndpoint,
					});
					void this._writeActiveConnectionsSnapshot();
					this._appendConnectionLog('CLIENT_REGISTERED', {
						name: clientName,
						address,
						ip,
						port,
						userAgent,
					});
					this.runtime.log(`[Exchange] Client registered: ${clientName}`);
					ws.send(JSON.stringify({ type: 'registered', name: clientName }));
					this._emitConnectionStatus('exchange-registered');
					this._broadcastClientPeerList();
					this._flushUndeliveredQueue(clientName).catch(() => {});
					this._flushPendingSignalsForTarget(clientName);
				}
			} else if (packet.type === 'profile' && clientName && this._connectedClientDetails.has(clientName)) {
				const current = this._connectedClientDetails.get(clientName);
				const nextPort = Object.prototype.hasOwnProperty.call(packet, 'httpPort')
					? this._normalizeDiscoveryPort(packet.httpPort)
					: current?.httpPort ?? null;
				const nextTls = Object.prototype.hasOwnProperty.call(packet, 'httpTls')
					? Boolean(packet.httpTls)
					: Boolean(current?.httpTls);
				const nextEndpoint = Object.prototype.hasOwnProperty.call(packet, 'endpointsEndpoint')
					? this._sanitizeDiscoveryEndpoint(packet.endpointsEndpoint)
					: current?.endpointsEndpoint || null;
				this._connectedClientDetails.set(clientName, {
					...current,
					endpoints: this._sanitizeDiscoveryEndpoints(packet.endpoints),
					httpPort: nextPort,
					httpTls: nextTls,
					endpointsEndpoint: nextEndpoint,
					lastSeenAt: new Date().toISOString(),
				});
				void this._writeActiveConnectionsSnapshot();
			} else if (packet.type === 'message') {
				if (clientName && this._connectedClientDetails.has(clientName)) {
					const current = this._connectedClientDetails.get(clientName);
					this._connectedClientDetails.set(clientName, {
						...current,
						lastSeenAt: new Date().toISOString(),
					});
				}
				this._routeMessage(packet, clientName);
			} else if (packet.type === 'signal') {
				if (clientName && this._connectedClientDetails.has(clientName)) {
					const current = this._connectedClientDetails.get(clientName);
					this._connectedClientDetails.set(clientName, {
						...current,
						lastSeenAt: new Date().toISOString(),
					});
				}
				this._routeSignal(packet, clientName);
			} else if (packet.type === 'stream-chunk-bin') {
				this._routeBinaryChunkAnnouncement(packet, clientName || 'unknown', ws);
			}
		});

		ws.on('close', () => {
			ws.isAlive = false;
			this._serverPendingBinaryChunkMeta.delete(ws);
			if (clientName) {
				if (this.connectedClients.get(clientName) === ws) {
					this.connectedClients.delete(clientName);
					this._connectedClientDetails.delete(clientName);
					this._broadcastClientPeerList();
					this._emitConnectionStatus('exchange-server-client-close');
					void this._writeActiveConnectionsSnapshot();
					this._appendConnectionLog('CLIENT_DISCONNECTED', {
						name: clientName,
						address,
						ip,
						port,
					});
					this.runtime.log(`[Exchange] Client disconnected: ${clientName}`);
				}
			}
		});

		ws.on('error', (err) => {
			this.runtime.log(`[Exchange] Client error ${clientName || 'unknown'}: ${err.message}`);
		});
	}

	_routeMessage(packet, fromName) {
		const to = String(packet.to || '').trim().toLowerCase();
		if (!to) return;

		const targetWs = this.connectedClients.get(to);
		if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
			this.runtime.log(`[Exchange] Target not found or disconnected: ${to}`);
			this._enqueueUndeliveredMessage(
				to,
				fromName || 'unknown',
				packet.content !== undefined ? packet.content : '',
				String(packet.contentType || 'text/plain'),
				packet.targetEndpoint || null,
				packet.targetEndpointId || null,
			).catch(() => {});
			return;
		}

		try {
			targetWs.send(JSON.stringify({
				type: 'message',
				from: fromName || 'unknown',
				targetEndpoint: packet.targetEndpoint || null,
				targetEndpointId: packet.targetEndpointId || null,
				content: packet.content !== undefined ? packet.content : '',
				contentType: String(packet.contentType || 'text/plain'),
			}));
			this.runtime.log(`[Exchange] Routed: ${fromName || 'unknown'} -> ${to}`);
		} catch (err) {
			this.runtime.log(`[Exchange] Routing error to ${to}: ${err.message}`);
			this._enqueueUndeliveredMessage(
				to,
				fromName || 'unknown',
				packet.content !== undefined ? packet.content : '',
				String(packet.contentType || 'text/plain'),
				packet.targetEndpoint || null,
				packet.targetEndpointId || null,
			).catch(() => {});
		}
	}

	_routeSignal(packet, fromName) {
		const to = String(packet.to || '').trim().toLowerCase();
		if (!to) {
			return;
		}

		const targetWs = this.connectedClients.get(to);
		if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
			this.runtime.log(`[Exchange] Signaling target not found or disconnected: ${to}`);
			const safeSignalType = String(packet.signalType || '').trim().toLowerCase();
			if (safeSignalType) {
				this._enqueuePendingSignal(to, {
					type: 'signal',
					from: fromName || 'unknown',
					sessionId: String(packet.sessionId || '').trim() || null,
					signalType: safeSignalType,
					payload: packet.payload !== undefined ? packet.payload : null,
					targetEndpoint: packet.targetEndpoint || null,
					targetEndpointId: packet.targetEndpointId || null,
					timestamp: new Date().toISOString(),
				});
			}
			return;
		}

		const signalType = String(packet.signalType || '').trim().toLowerCase();
		if (!signalType) {
			return;
		}

		try {
			const outboundSignal = {
				type: 'signal',
				from: fromName || 'unknown',
				sessionId: String(packet.sessionId || '').trim() || null,
				signalType,
				payload: packet.payload !== undefined ? packet.payload : null,
				targetEndpoint: packet.targetEndpoint || null,
				targetEndpointId: packet.targetEndpointId || null,
				timestamp: new Date().toISOString(),
			};

			targetWs.send(JSON.stringify(outboundSignal));
		} catch (error) {
			this.runtime.log(`[Exchange] Signaling routing error to ${to}: ${error.message}`);
		}
	}

	_queueServerPendingBinaryChunkMeta(sourceWs, meta) {
		const queue = this._serverPendingBinaryChunkMeta.get(sourceWs) || [];
		queue.push(meta);
		this._serverPendingBinaryChunkMeta.set(sourceWs, queue);
	}

	_shiftServerPendingBinaryChunkMeta(sourceWs) {
		const queue = this._serverPendingBinaryChunkMeta.get(sourceWs) || [];
		const meta = queue.shift() || null;
		if (queue.length > 0) {
			this._serverPendingBinaryChunkMeta.set(sourceWs, queue);
		} else {
			this._serverPendingBinaryChunkMeta.delete(sourceWs);
		}
		return meta;
	}

	_routeBinaryChunkAnnouncement(packet, fromName, sourceWs) {
		const to = String(packet.to || '').trim().toLowerCase();
		if (!to) {
			return;
		}

		const streamId = String(packet.streamId || '').trim();
		if (!streamId) {
			return;
		}

		const targetWs = this.connectedClients.get(to);
		if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
			this.runtime.log(`[Exchange] Binary stream target not found: ${to}`);
			return;
		}

		const meta = {
			to,
			from: fromName || 'unknown',
			streamId,
			index: Number.isFinite(Number(packet.index)) ? Number(packet.index) : -1,
			size: Number.isFinite(Number(packet.size)) ? Number(packet.size) : 0,
		};

		this._queueServerPendingBinaryChunkMeta(sourceWs, meta);

		try {
			targetWs.send(JSON.stringify({
				type: 'stream-chunk-bin',
				from: meta.from,
				streamId: meta.streamId,
				index: meta.index,
				size: meta.size,
			}));
		} catch (error) {
			this.runtime.log(`[Exchange] Failed to announce binary chunk to ${to}: ${error.message}`);
		}
	}

	_routeBinaryChunkData(sourceWs, data, fromName) {
		const meta = this._shiftServerPendingBinaryChunkMeta(sourceWs);
		if (!meta) {
			this.runtime.log(`[Exchange] Unexpected binary frame from ${fromName || 'unknown'}: missing metadata`);
			return;
		}

		const targetWs = this.connectedClients.get(meta.to);
		if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
			this.runtime.log(`[Exchange] Binary chunk dropped: target disconnected ${meta.to}`);
			return;
		}

		try {
			targetWs.send(data, { binary: true });
		} catch (error) {
			this.runtime.log(`[Exchange] Failed routing binary chunk to ${meta.to}: ${error.message}`);
		}
	}

	_handleClientIncomingBinaryChunk(meta, data) {
		const binaryChunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
		const payload = {
			__reactorStream: true,
			phase: 'chunk',
			streamId: String(meta.streamId || ''),
			index: Number.isFinite(Number(meta.index)) ? Number(meta.index) : -1,
			size: binaryChunk.length,
			encoding: 'binary',
			binary: binaryChunk,
		};

		const sender = String(meta.from || 'unknown');
		this._rememberDeliveredClientBinaryMeta(meta);
		this.runtime.log(`[TRANSFER] exchange binary chunk received from=${sender} streamId=${payload.streamId || '-'} index=${payload.index} bytes=${binaryChunk.length}`);
		this._handleIncomingStreamEnvelope(sender, payload, '', 'application/octet-stream');
	}

	_makeClientBinaryMetaKey(meta) {
		if (!meta || typeof meta !== 'object') {
			return '';
		}
		const streamId = String(meta.streamId || '').trim();
		const index = Number.isFinite(Number(meta.index)) ? Number(meta.index) : -1;
		if (!streamId || index < 0) {
			return '';
		}
		return `${streamId}:${index}`;
	}

	_cleanupDeliveredClientBinaryMeta(nowMs = Date.now()) {
		const ttlMs = 30 * 1000;
		for (const [key, timestamp] of this._clientDeliveredBinaryMeta.entries()) {
			if (!Number.isFinite(Number(timestamp)) || (nowMs - Number(timestamp)) > ttlMs) {
				this._clientDeliveredBinaryMeta.delete(key);
			}
		}
	}

	_rememberDeliveredClientBinaryMeta(meta) {
		this._cleanupDeliveredClientBinaryMeta();
		const key = this._makeClientBinaryMetaKey(meta);
		if (!key) {
			return;
		}
		this._clientDeliveredBinaryMeta.set(key, Date.now());
	}

	_wasClientBinaryMetaRecentlyDelivered(meta) {
		this._cleanupDeliveredClientBinaryMeta();
		const key = this._makeClientBinaryMetaKey(meta);
		if (!key) {
			return false;
		}
		return this._clientDeliveredBinaryMeta.has(key);
	}

	// ---------------------------------------------------------------------------
	// EXCHANGE CLIENT — bootstrap su POST /register, poi connessione WS /ws?sessionId=...
	// ---------------------------------------------------------------------------

	_startClient() {
		if (this._stopped) return;

		Promise.resolve()
			.then(async () => {
				const packet = await this._buildClientRegisterPacket();
				const session = await this._bootstrapClientWebSocketSession(packet);
				const url = session.wsUrl;
				this.runtime.log(`[Exchange] Connecting to exchange: ${url}`);

				const options = {};
				if (this.tls) {
					options.rejectUnauthorized = true;
				}

				const ws = new WebSocket(url, options);

				this.wsClient = ws;
				this._knownRemotePeers.clear();
				this._clientRegistered = false;
				this._emitConnectionStatus('exchange-connecting');

				ws.on('open', async () => {
					if (this.wsClient !== ws) {
						this.runtime.log('[Exchange] Stale client connection opened, ignoring');
						try {
							ws.terminate();
						} catch {
							// Ignore close errors for stale sockets.
						}
						return;
					}

					this._clientLastError = '';
					this._clientLastCloseReason = '';
					this._clientLastCloseCode = 0;
					this._clientConnectedAt = Date.now();
					this._clientLastPongAt = Date.now();
					this._clientPendingBinaryChunkMeta = [];
					this._clientPendingBinaryFrames = [];
					this._clientDeliveredBinaryMeta.clear();
					this._emitConnectionStatus('exchange-open');
					this._startClientHeartbeat(ws);
					try {
						ws.send(JSON.stringify(packet));
						this.runtime.log(`[Exchange] Connected as: ${packet.name}`);
					} catch (err) {
						this.runtime.log(`[Exchange] Registration error: ${err.message}`);
					}
				});

				ws.on('message', (data, isBinary) => {
					if (this.wsClient !== ws) {
						return;
					}

					this._clientLastPongAt = Date.now();
					if (isBinary) {
						const meta = this._clientPendingBinaryChunkMeta.shift();
						if (!meta) {
							const buffered = Buffer.isBuffer(data) ? data : Buffer.from(data);
							this._clientPendingBinaryFrames.push(buffered);
							this.runtime.log(`[TRANSFER] exchange binary frame queued awaiting metadata bytes=${buffered.length} pending=${this._clientPendingBinaryFrames.length}`);
							return;
						}

						this._handleClientIncomingBinaryChunk(meta, data);
						return;
					}

					let packet;
					try { packet = JSON.parse(String(data)); } catch { return; }
					if (packet && packet.type === 'message') this._handleIncomingMessage(packet);
					if (packet && packet.type === 'signal') this._handleIncomingSignal(packet);
					if (packet && packet.type === 'peer-list') this._handleIncomingPeerList(packet);
					if (packet && packet.type === 'registered') {
						this._clientRegistered = true;
						this._clientLastError = '';
						this._clientLastCloseReason = '';
						this._clientLastCloseCode = 0;
						this._emitConnectionStatus('exchange-registered');
					}
					if (packet && packet.type === 'stream-chunk-bin') {
						if (this._wasClientBinaryMetaRecentlyDelivered(packet)) {
							this.runtime.log(`[TRANSFER] exchange duplicate binary metadata ignored from=${String(packet.from || 'unknown')} streamId=${String(packet.streamId || '')} index=${Number.isFinite(Number(packet.index)) ? Number(packet.index) : -1}`);
							return;
						}

						const pendingFrame = this._clientPendingBinaryFrames.shift();
						if (pendingFrame) {
							this.runtime.log(`[TRANSFER] exchange metadata matched delayed binary from=${String(packet.from || 'unknown')} streamId=${String(packet.streamId || '')} index=${Number.isFinite(Number(packet.index)) ? Number(packet.index) : -1}`);
							this._handleClientIncomingBinaryChunk(packet, pendingFrame);
						} else {
							this._clientPendingBinaryChunkMeta.push(packet);
							this.runtime.log(`[TRANSFER] exchange binary metadata queued from=${String(packet.from || 'unknown')} streamId=${String(packet.streamId || '')} index=${Number.isFinite(Number(packet.index)) ? Number(packet.index) : -1} pending=${this._clientPendingBinaryChunkMeta.length}`);
						}
					}
					if (packet && packet.type === 'auth-error') {
						this.runtime.log(`[Exchange] Authentication failed: ${packet.error || 'invalid exchange token'}`);
						this._clientLastError = String(packet.error || 'invalid exchange token');
						this._clientRegistered = false;
						this._emitConnectionStatus('exchange-auth-error');
					}
				});

				ws.on('pong', () => {
					if (this.wsClient !== ws) {
						return;
					}

					this._clientLastPongAt = Date.now();
				});

				ws.on('close', (code, reason) => {
					const isCurrentSocket = this.wsClient === ws;
					if (!isCurrentSocket) {
						this.runtime.log('[Exchange] Stale client connection closed');
						return;
					}

					this._stopClientHeartbeat();
					this.wsClient = null;
					this._knownRemotePeers.clear();
					this._clientPendingBinaryChunkMeta = [];
					this._clientPendingBinaryFrames = [];
					this._clientDeliveredBinaryMeta.clear();
					this._clientConnectedAt = 0;
					this._clientRegistered = false;
					this._clientLastCloseCode = Number(code) || 0;
					this._clientLastCloseReason = String(reason || '').trim();
					this.runtime.log('[Exchange] Connection closed, reconnecting...');
					this._emitConnectionStatus('exchange-close');
					this._scheduleReconnect();
				});

				ws.on('error', (err) => {
					const isCurrentSocket = this.wsClient === ws;
					if (!isCurrentSocket) {
						this.runtime.log(`[Exchange] Stale client connection error ignored: ${err?.message || 'unknown error'}`);
						return;
					}

					this._stopClientHeartbeat();
					this._knownRemotePeers.clear();
					this._clientLastError = this.tls
						? formatTlsCertificateError(err?.message || 'tls connection failed')
						: String(err?.message || 'unknown error');
					this._clientRegistered = false;
					this.runtime.log(`[Exchange] Error: ${this._clientLastError}`);
					this._emitConnectionStatus('exchange-error');
					this._scheduleReconnect();
				});
			})
			.catch((err) => {
				const detail = this.tls
					? formatTlsCertificateError(err?.message || 'failed exchange register bootstrap')
					: String(err?.message || 'failed exchange register bootstrap');
				this.runtime.log(`[Exchange] Unable to create client: ${detail}`);
				this._clientLastError = detail;
				this._clientRegistered = false;
				this._emitConnectionStatus('exchange-error');
				this._scheduleReconnect();
			});
	}

	async waitForClientConnection(timeoutMs = 5000) {
		if (this.mode !== 'client') {
			return {
				connected: false,
				skipped: true,
				reason: 'exchange mode is not client',
				elapsedMs: 0,
			};
		}

		const safeTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
		const startedAt = Date.now();

		while (Date.now() - startedAt <= safeTimeoutMs) {
			if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN && this._clientRegistered) {
				return {
					connected: true,
					skipped: false,
					reason: '',
					elapsedMs: Date.now() - startedAt,
				};
			}

			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		let reason = this._clientLastError || this._clientLastCloseReason || 'timeout waiting for connection';
		if (!reason && this._clientLastCloseCode) {
			reason = `connection closed (${this._clientLastCloseCode})`;
		}
		const errorType = this._classifyClientFailureType(reason, this._clientLastCloseCode);

		return {
			connected: Boolean(this.wsClient && this.wsClient.readyState === WebSocket.OPEN && this._clientRegistered),
			skipped: false,
			reason,
			errorType,
			elapsedMs: Date.now() - startedAt,
		};
	}

	_startServerHeartbeat() {
		this._stopServerHeartbeat();
		this._serverHeartbeatTimer = setInterval(() => {
			this._serverLastSweepAt = Date.now();
			if (!this.wss) {
				return;
			}

			for (const ws of this.wss.clients) {
				if (ws.isAlive === false) {
					for (const [name, socket] of this.connectedClients.entries()) {
						if (socket === ws) {
							this.connectedClients.delete(name);
							this._connectedClientDetails.delete(name);
							this._broadcastClientPeerList();
							this._appendConnectionLog('CLIENT_TERMINATED_HEARTBEAT', { name });
							void this._writeActiveConnectionsSnapshot();
							break;
						}
					}
					this._serverTerminatedClients += 1;
					try { ws.terminate(); } catch { /* ignore */ }
					continue;
				}

				ws.isAlive = false;
				this._serverPingsSent += 1;
				try { ws.ping(); } catch { /* ignore ping errors */ }
			}
		}, this._heartbeatIntervalMs);
	}

	_stopServerHeartbeat() {
		if (this._serverHeartbeatTimer) {
			clearInterval(this._serverHeartbeatTimer);
			this._serverHeartbeatTimer = null;
		}
	}

	_startClientHeartbeat(ws) {
		this._stopClientHeartbeat();
		this._clientHeartbeatTimer = setInterval(() => {
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				return;
			}

			if (Date.now() - this._clientLastPongAt > this._heartbeatTimeoutMs) {
				this._clientLastTimeoutAt = Date.now();
				this.runtime.log('[Exchange] Heartbeat timeout: closing client WS connection');
				try { ws.terminate(); } catch { /* ignore */ }
				return;
			}

			this._clientLastPingAt = Date.now();
			try { ws.ping(); } catch { /* ignore ping errors */ }
		}, this._heartbeatIntervalMs);
	}

	_stopClientHeartbeat() {
		if (this._clientHeartbeatTimer) {
			clearInterval(this._clientHeartbeatTimer);
			this._clientHeartbeatTimer = null;
		}
	}

	_scheduleReconnect() {
		if (this._stopped || this.mode !== 'client') return;
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this._startClient();
		}, RECONNECT_DELAY_MS);
	}

	_handleIncomingMessage(packet) {
		const from = String(packet.from || 'unknown');
		const content = packet.content !== undefined ? String(packet.content) : '';
		const contentType = String(packet.contentType || 'text/plain');
		let messageJson = null;
		if (contentType.toLowerCase().includes('application/json')) {
			try {
				messageJson = JSON.parse(content);
			} catch {
				messageJson = null;
			}
		}
		const isStreamEnvelope = Boolean(messageJson && typeof messageJson === 'object' && messageJson.__reactorStream === true);
		if (isStreamEnvelope) {
			this._handleIncomingStreamEnvelope(from, messageJson, content, contentType, {
				nodeName: String(packet.to || '').trim().toLowerCase() || null,
				endpointSelector: String(packet.targetEndpoint || '').trim().toLowerCase() || null,
				endpointId: String(packet.targetEndpointId || '').trim().toLowerCase() || null,
			});
			return;
		}

		const isSystemMessage = Boolean(messageJson && typeof messageJson === 'object' && messageJson.__reactorSystem === true);
		if (isSystemMessage) {
			if (this.runtime && typeof this.runtime.handleIncomingSystemMessage === 'function') {
				this.runtime.handleIncomingSystemMessage(messageJson, from).catch(() => {});
			}
			return;
		}

		this.runtime.log(`[Exchange] Message from: ${from}`);
		const targetEndpointSelector = String(packet.targetEndpoint || '').trim().toLowerCase() || null;
		const targetEndpointId = String(packet.targetEndpointId || '').trim().toLowerCase() || null;
		const listeners = this.runtime.filterMessageListenersByTarget(
			this.runtime.findMessageListeners([from.toLowerCase()]),
			targetEndpointSelector
				? {
					type: targetEndpointSelector.startsWith('id:') ? 'id' : 'name',
					value: targetEndpointSelector.startsWith('id:') ? targetEndpointSelector.slice(3).trim() : targetEndpointSelector,
					headerValue: targetEndpointSelector,
				}
				: (targetEndpointId
					? { type: 'id', value: targetEndpointId, headerValue: `id:${targetEndpointId}` }
					: null),
		);

		Promise.allSettled(
			listeners.map((endpoint) =>
				this.runtime.runEndpoint(endpoint, {
					trigger: 'MESSAGE',
					event: 'MESSAGE',
					messageSender: from,
					messageSenderName: from,
					messageTarget: String(packet.to || '').trim().toLowerCase() || null,
					messageTargetNode: String(packet.to || '').trim().toLowerCase() || null,
					messageTargetEndpointId: targetEndpointId,
					messageTargetEndpoint: targetEndpointSelector || (targetEndpointId ? `id:${targetEndpointId}` : null),
					messageContent: content,
					messageContentType: contentType,
					messageBodyBase64: Buffer.from(content, 'utf8').toString('base64'),
					messageJson,
					stream: null,
					streamEnd: null,
					messageHeaders: { 'x-exchange-from': from },
				}),
			),
		).catch(() => {});
	}

	_handleIncomingSignal(packet) {
		const from = String(packet.from || 'unknown').trim().toLowerCase();
		const signalType = String(packet.signalType || '').trim().toLowerCase();
		if (!from || !signalType) {
			return;
		}

		if (this.runtime && typeof this.runtime.handleExchangeSignal === 'function') {
			this.runtime.handleExchangeSignal({
				from,
				sessionId: String(packet.sessionId || '').trim() || null,
				signalType,
				payload: packet.payload !== undefined ? packet.payload : null,
				targetEndpoint: String(packet.targetEndpoint || '').trim().toLowerCase() || null,
				targetEndpointId: String(packet.targetEndpointId || '').trim().toLowerCase() || null,
				timestamp: String(packet.timestamp || '').trim() || new Date().toISOString(),
			});
		}
	}

	_handleIncomingStreamEnvelope(from, streamEnvelope, rawContent = '', contentType = 'application/json', targetMeta = {}) {
		const senderMeta = {
			rawName: from,
			rawSender: from,
			remoteHost: from,
			candidates: [from.toLowerCase()],
		};
		const targetEndpointSelector = String(targetMeta.endpointSelector || '').trim().toLowerCase() || null;
		const targetEndpointId = String(targetMeta.endpointId || '').trim().toLowerCase() || null;
		const targetNode = String(targetMeta.nodeName || '').trim().toLowerCase() || null;

		this.runtime.log(`[Exchange] Message from: ${from}`);
		const listeners = this.runtime.filterStreamListenersByTarget(
			this.runtime.findStreamListeners(senderMeta.candidates),
			targetEndpointSelector
				? {
					type: targetEndpointSelector.startsWith('id:') ? 'id' : 'name',
					value: targetEndpointSelector.startsWith('id:') ? targetEndpointSelector.slice(3).trim() : targetEndpointSelector,
					headerValue: targetEndpointSelector,
				}
				: (targetEndpointId
					? { type: 'id', value: targetEndpointId, headerValue: `id:${targetEndpointId}` }
					: null),
		);
		const streamPacket = this.runtime && this.runtime.createIncomingStreamPacket
			? this.runtime.createIncomingStreamPacket(streamEnvelope)
			: null;

		const safeRawContent = typeof rawContent === 'string' ? rawContent : '';
		const safeMessageBodyBase64 = safeRawContent ? Buffer.from(safeRawContent, 'utf8').toString('base64') : '';

		Promise.resolve()
			.then(async () => {
				const streamEndData = this.runtime && typeof this.runtime.processIncomingStreamPacket === 'function'
					? await this.runtime.processIncomingStreamPacket(streamPacket, senderMeta)
					: null;

				const systemStreamMetadata = this.runtime && typeof this.runtime.resolveSystemEndpointTransferMetadata === 'function'
					? this.runtime.resolveSystemEndpointTransferMetadata(streamPacket, senderMeta, streamEndData)
					: null;

				if (systemStreamMetadata) {
					if (streamEndData && this.runtime && typeof this.runtime.handleIncomingEndpointTransferStream === 'function') {
						await this.runtime.handleIncomingEndpointTransferStream(streamEndData);
					}
					return;
				}

				await Promise.allSettled(
					listeners.map((endpoint) =>
						this.runtime.runEndpoint(endpoint, {
							trigger: 'STREAM',
							event: 'STREAM',
							messageSender: from,
							messageSenderName: from,
							messageTarget: targetNode,
							messageTargetNode: targetNode,
							messageTargetEndpointId: targetEndpointId,
							messageTargetEndpoint: targetEndpointSelector || (targetEndpointId ? `id:${targetEndpointId}` : null),
							messageContent: safeRawContent,
							messageContentType: contentType,
							messageBodyBase64: safeMessageBodyBase64,
							messageJson: streamEnvelope,
							stream: streamPacket,
							streamEnd: null,
							messageHeaders: {
								'x-exchange-from': from,
								'Reactor-Target-Node': targetNode || '',
								'Reactor-Target-Endpoint': targetEndpointSelector || (targetEndpointId ? `id:${targetEndpointId}` : ''),
								'Reactor-Target-Endpoint-Id': targetEndpointId || '',
							},
						}),
					),
				);

				if (streamEndData && this.runtime && typeof this.runtime.emitStreamEnd === 'function') {
						await this.runtime.emitStreamEnd(streamEndData, senderMeta, {
							'x-exchange-from': from,
							'Reactor-Target-Node': targetNode || '',
							'Reactor-Target-Endpoint': targetEndpointSelector || (targetEndpointId ? `id:${targetEndpointId}` : ''),
							'Reactor-Target-Endpoint-Id': targetEndpointId || '',
						});
				}
			})
			.catch(() => {});
	}

	// ---------------------------------------------------------------------------
	// API pubblica
	// ---------------------------------------------------------------------------

	async sendViaExchange(target, content, options = {}) {
		if (this.mode !== 'client') throw new Error('not in client mode');
		if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
			throw new Error('exchange client not connected');
		}

		const shouldEnqueueOnFail = Boolean(options && options.enqueueOnFail);

		let serializedContent, contentType;
		if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
			serializedContent = Buffer.from(content).toString('base64');
			contentType = 'application/octet-stream;base64';
		} else if (typeof content === 'string') {
			serializedContent = content;
			contentType = 'text/plain';
		} else if (content === null || content === undefined) {
			serializedContent = '';
			contentType = 'text/plain';
		} else {
			serializedContent = JSON.stringify(content);
			contentType = 'application/json';
		}

		const parsedTarget = parseLogicalExchangeTarget(target);
		if (!parsedTarget || !parsedTarget.nodeName) throw new Error('invalid exchange target');

		this.wsClient.send(JSON.stringify({
			type: 'message',
			to: parsedTarget.nodeName,
			targetEndpoint: parsedTarget.endpointSelector ? parsedTarget.endpointSelector.headerValue : null,
			targetEndpointId: parsedTarget.endpointId || null,
			content: serializedContent,
			contentType,
			enqueueOnFail: shouldEnqueueOnFail,
		}));
		return {
			target: parsedTarget.rawTarget,
			via: 'exchange',
			queued: false,
		};
	}

	async sendSignalViaExchange(target, signalType, payload = null, options = {}) {
		if (this.mode !== 'client') {
			throw new Error('not in client mode');
		}
		if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
			throw new Error('exchange client not connected');
		}

		const parsedTarget = parseLogicalExchangeTarget(target);
		if (!parsedTarget || !parsedTarget.nodeName) {
			throw new Error('invalid signaling target');
		}

		const safeSignalType = String(signalType || '').trim().toLowerCase();
		if (!safeSignalType) {
			throw new Error('invalid signal type');
		}

		this.wsClient.send(JSON.stringify({
			type: 'signal',
			to: parsedTarget.nodeName,
			targetEndpoint: parsedTarget.endpointSelector ? parsedTarget.endpointSelector.headerValue : null,
			targetEndpointId: parsedTarget.endpointId || null,
			sessionId: String(options.sessionId || '').trim() || null,
			signalType: safeSignalType,
			payload,
			timestamp: new Date().toISOString(),
		}));

		return {
			target: parsedTarget.rawTarget,
			sessionId: String(options.sessionId || '').trim() || null,
			signalType: safeSignalType,
			via: 'exchange-signaling',
		};
	}

	async sendStreamChunkBinary(target, streamId, index, chunkBuffer, options = {}) {
		if (this.mode !== 'client') {
			throw new Error('not in client mode');
		}
		if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
			throw new Error('exchange client not connected');
		}

		const to = String(target || '').trim().toLowerCase();
		if (!to) {
			throw new Error('invalid exchange target');
		}

		const safeStreamId = String(streamId || '').trim();
		if (!safeStreamId) {
			throw new Error('invalid streamId');
		}

		const shouldEnqueueOnFail = Boolean(options && options.enqueueOnFail);

		const buffer = Buffer.isBuffer(chunkBuffer) ? chunkBuffer : Buffer.from(chunkBuffer || []);
		const safeIndex = Number.isFinite(Number(index)) ? Number(index) : -1;

		this.wsClient.send(JSON.stringify({
			type: 'stream-chunk-bin',
			to,
			streamId: safeStreamId,
			index: safeIndex,
			size: buffer.length,
			enqueueOnFail: shouldEnqueueOnFail,
		}));
		this.wsClient.send(buffer, { binary: true });

		return {
			target: to,
			streamId: safeStreamId,
			index: safeIndex,
			size: buffer.length,
			via: 'exchange',
			queued: false,
		};
	}

	getConfig() {
		const isClientConnected =
			this.mode === 'client' && Boolean(this.wsClient) && this.wsClient.readyState === WebSocket.OPEN;
		const now = Date.now();
		const connectedClientsDetails = this.getConnectedClientsDiscoveryEndpointEntries(now);
		return {
			mode: this.mode,
			host: this.host,
			port: this.port,
			tls: this.tls,
			active: this.mode === 'exchange' ? Boolean(this.wss) : this.mode === 'client' ? isClientConnected : false,
			connectedClients: this.mode === 'exchange' ? Array.from(this.connectedClients.keys()) : [],
			connectedClientsDetails,
			activeConnectionsPath: this._activeConnectionsPath,
			heartbeat: {
				intervalMs: this._heartbeatIntervalMs,
				timeoutMs: this._heartbeatTimeoutMs,
				server: {
					lastSweepAt: this._serverLastSweepAt ? new Date(this._serverLastSweepAt).toISOString() : null,
					pingsSent: this._serverPingsSent,
					pongsReceived: this._serverPongsReceived,
					terminatedClients: this._serverTerminatedClients,
				},
				client: {
					lastPingAt: this._clientLastPingAt ? new Date(this._clientLastPingAt).toISOString() : null,
					lastPongAt: this._clientLastPongAt ? new Date(this._clientLastPongAt).toISOString() : null,
					lastTimeoutAt: this._clientLastTimeoutAt ? new Date(this._clientLastTimeoutAt).toISOString() : null,
					timeSinceLastPongMs: this._clientLastPongAt ? now - this._clientLastPongAt : null,
				},
			},
			connectionLogPath: this._connectionLogPath,
		};
	}

	getConnectedClientsDiscoveryEndpointEntries(nowMs = Date.now()) {
		if (this.mode !== 'exchange') {
			return [];
		}

		return Array.from(this._connectedClientDetails.values())
			.map((detail) => {
				const connectedAt = String(detail?.registrationAt || detail?.connectedAt || '').trim();
				const connectedAtMs = connectedAt ? Date.parse(connectedAt) : NaN;
				const connectedForMs = Number.isFinite(connectedAtMs) ? Math.max(0, nowMs - connectedAtMs) : null;

				return {
					name: detail?.name || 'unknown',
					address: detail?.address || null,
					ip: detail?.ip || null,
					port: Number.isFinite(Number(detail?.port)) ? Number(detail.port) : null,
					httpPort: Number.isFinite(Number(detail?.httpPort)) ? Number(detail.httpPort) : null,
					httpTls: Boolean(detail?.httpTls),
					endpointsEndpoint: detail?.endpointsEndpoint || null,
					connectedAt: connectedAt || null,
					lastSeenAt: detail?.lastSeenAt || null,
					userAgent: detail?.userAgent || '',
					endpoints: this._sanitizeDiscoveryEndpoints(detail?.endpoints),
					connectedForMs,
					connectedForSec: Number.isFinite(connectedForMs) ? Math.floor(connectedForMs / 1000) : null,
				};
			})
			.sort((a, b) => String(a.name).localeCompare(String(b.name)));
	}

	updateClientDiscoveryEndpoints(endpoints = []) {
		if (this.mode !== 'client' || !this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
			return;
		}

		try {
			this.wsClient.send(JSON.stringify({
				type: 'profile',
				endpoints: this._sanitizeDiscoveryEndpoints(endpoints),
				httpPort: Number(this.runtime.httpServerPort) || DEFAULT_LOCAL_SERVER_PORT,
				httpTls: Boolean(this.runtime.tlsEnabled),
			}));
		} catch {
			// Ignore profile update failures: endpoints will be re-sent on reconnect.
		}
	}

	async _buildClientRegisterPacket() {
		const name = await this.runtime.getReactorName();
		const safeName = String(name || '').trim() || 'unnamed';
		const token = String(this.runtime.exchangeAuthToken || '').trim();
		const endpoints = typeof this.runtime.getDiscoveryEndpointEntries === 'function'
			? this.runtime.getDiscoveryEndpointEntries()
			: [];

		return {
			type: 'register',
			name: safeName,
			token,
			endpoints,
			httpPort: Number(this.runtime.httpServerPort) || DEFAULT_LOCAL_SERVER_PORT,
			httpTls: Boolean(this.runtime.tlsEnabled),
		};
	}

	async refreshClientRegistration(reason = 'runtime-update') {
		if (this.mode !== 'client' || !this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
			return { ok: false, reason: 'exchange client not connected' };
		}

		const packet = await this._buildClientRegisterPacket();
		this.wsClient.send(JSON.stringify(packet));
		this.runtime.log(`[Exchange] Client registration refreshed (${String(reason || 'runtime-update')}): ${packet.name}`);
		return { ok: true, name: packet.name };
	}

	async reconnectClient(reason = 'runtime-update') {
		if (this.mode !== 'client') {
			return { ok: false, reason: 'exchange mode is not client' };
		}
		if (!this.host) {
			return { ok: false, reason: 'exchange host is empty' };
		}

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		const currentWs = this.wsClient;
		this.wsClient = null;
		this._clientRegistered = false;
		this._knownRemotePeers.clear();

		if (currentWs) {
			try {
				currentWs.terminate();
			} catch {
				// Ignore close errors while forcing reconnect.
			}
		}

		this.runtime.log(`[Exchange] Reconnecting client (${String(reason || 'runtime-update')})`);
		this._startClient();
		return { ok: true };
	}
}

module.exports = { ExchangeManager };
