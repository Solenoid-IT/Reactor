const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs/promises');
const path = require('path');

const RECONNECT_DELAY_MS = 5000;
const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 45000;
const DEFAULT_UNDELIVERED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_UNDELIVERED_RETRY_MS = 30 * 1000;

function parseLogicalExchangeTarget(rawTarget) {
	const trimmed = String(rawTarget || '').trim();
	if (!trimmed) {
		return null;
	}

	const slashIndex = trimmed.indexOf('/');
	if (slashIndex === -1) {
		return {
			nodeName: trimmed.toLowerCase(),
			scriptId: null,
			rawTarget: trimmed,
		};
	}

	const nodeName = trimmed.slice(0, slashIndex).trim().toLowerCase();
	const scriptId = trimmed.slice(slashIndex + 1).trim().toLowerCase();
	if (!nodeName || !scriptId) {
		return null;
	}

	return {
		nodeName,
		scriptId,
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
				authenticated: true,
				reason: '',
				lastError: '',
				lastCloseReason: '',
				lastCloseCode: 0,
				lastPongAt: null,
			};
		}

		const wsState = this.wsClient ? this.wsClient.readyState : WebSocket.CLOSED;
		if (wsState === WebSocket.OPEN) {
			return {
				mode: this.mode,
				state: 'connected',
				connected: true,
				authenticated: true,
				reason: '',
				lastError: '',
				lastCloseReason: '',
				lastCloseCode: 0,
				lastPongAt: this._clientLastPongAt ? new Date(this._clientLastPongAt).toISOString() : null,
			};
		}

		if (wsState === WebSocket.CONNECTING) {
			return {
				mode: this.mode,
				state: 'connecting',
				connected: false,
				authenticated: false,
				reason: 'connecting to exchange',
				lastError: this._clientLastError,
				lastCloseReason: this._clientLastCloseReason,
				lastCloseCode: this._clientLastCloseCode,
				lastPongAt: this._clientLastPongAt ? new Date(this._clientLastPongAt).toISOString() : null,
			};
		}

		const reason = this._clientLastError || this._clientLastCloseReason || (this._clientLastTimeoutAt ? 'heartbeat timeout' : '') || 'disconnected';
		return {
			mode: this.mode,
			state: 'disconnected',
			connected: false,
			authenticated: false,
			reason,
			lastError: this._clientLastError,
			lastCloseReason: this._clientLastCloseReason,
			lastCloseCode: this._clientLastCloseCode,
			lastPongAt: this._clientLastPongAt ? new Date(this._clientLastPongAt).toISOString() : null,
		};
	}

	_readHeartbeatValue(envName, fallback, minValue) {
		const raw = Number(process.env[envName]);
		if (!Number.isFinite(raw)) {
			return fallback;
		}

		return Math.max(minValue, Math.floor(raw));
	}

	_sanitizeDiscoveryScripts(rawScripts) {
		if (!Array.isArray(rawScripts)) {
			return [];
		}

		return rawScripts
			.map((script) => ({
				uuid: String(script?.uuid || '').trim().toLowerCase(),
				name: String(script?.name || '').trim() || 'unknown',
				triggers: Array.isArray(script?.triggers)
					? script.triggers.map((trigger) => String(trigger || '').trim()).filter(Boolean)
					: [],
				enabled: Boolean(script?.enabled),
				mutex: Boolean(script?.mutex),
			}))
			.filter((script) => script.uuid);
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

	async _enqueueUndeliveredMessage(to, from, content, contentType, targetScriptId = null) {
		const now = Date.now();
		const queue = await this._readUndeliveredQueue();
		queue.push({
			id: `${now}-${Math.random().toString(16).slice(2)}`,
			to,
			targetScriptId: targetScriptId || null,
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
						targetScriptId: item.targetScriptId || null,
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
		if (this.runtime && this.runtime.getExchangeToken) {
			try {
				const info = await this.runtime.getExchangeToken();
				return String(info?.token || '').trim();
			} catch {
				return String(this.runtime.exchangeAuthToken || '').trim();
			}
		}

		return String(this.runtime.exchangeAuthToken || '').trim();
	}

	_readBearerToken(request) {
		const rawAuthorization = String(request?.headers?.authorization || '').trim();
		if (!rawAuthorization) {
			return '';
		}

		const match = rawAuthorization.match(/^Bearer\s+(.+)$/i);
		return match ? String(match[1] || '').trim() : '';
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

		if (this.wss) {
			const wss = this.wss;
			this.wss = null;
			await new Promise((resolve) => wss.close(() => resolve()));
		}

		if (this.wsClient) {
			try { this.wsClient.terminate(); } catch { /* ignore */ }
			this.wsClient = null;
		}

		this.connectedClients.clear();
		this._connectedClientDetails.clear();
		this._knownRemotePeers.clear();
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
				const discoveryScripts = this._sanitizeDiscoveryScripts(packet.scripts);
				const discoveryPort = this._normalizeDiscoveryPort(packet.httpPort);
				const discoveryTls = Boolean(packet.httpTls);
				const scriptsEndpoint = this._sanitizeDiscoveryEndpoint(packet.scriptsEndpoint);

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
						scripts: discoveryScripts,
						httpPort: discoveryPort,
						httpTls: discoveryTls,
						scriptsEndpoint,
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
				}
			} else if (packet.type === 'profile' && clientName && this._connectedClientDetails.has(clientName)) {
				const current = this._connectedClientDetails.get(clientName);
				const nextPort = Object.prototype.hasOwnProperty.call(packet, 'httpPort')
					? this._normalizeDiscoveryPort(packet.httpPort)
					: current?.httpPort ?? null;
				const nextTls = Object.prototype.hasOwnProperty.call(packet, 'httpTls')
					? Boolean(packet.httpTls)
					: Boolean(current?.httpTls);
				const nextEndpoint = Object.prototype.hasOwnProperty.call(packet, 'scriptsEndpoint')
					? this._sanitizeDiscoveryEndpoint(packet.scriptsEndpoint)
					: current?.scriptsEndpoint || null;
				this._connectedClientDetails.set(clientName, {
					...current,
					scripts: this._sanitizeDiscoveryScripts(packet.scripts),
					httpPort: nextPort,
					httpTls: nextTls,
					scriptsEndpoint: nextEndpoint,
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
				packet.targetScriptId || null,
			).catch(() => {});
			return;
		}

		try {
			targetWs.send(JSON.stringify({
				type: 'message',
				from: fromName || 'unknown',
				targetScriptId: packet.targetScriptId || null,
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
				packet.targetScriptId || null,
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
			return;
		}

		const signalType = String(packet.signalType || '').trim().toLowerCase();
		if (!signalType) {
			return;
		}

		try {
			targetWs.send(JSON.stringify({
				type: 'signal',
				from: fromName || 'unknown',
				sessionId: String(packet.sessionId || '').trim() || null,
				signalType,
				payload: packet.payload !== undefined ? packet.payload : null,
				targetScriptId: packet.targetScriptId || null,
				timestamp: new Date().toISOString(),
			}));
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

	// ---------------------------------------------------------------------------
	// EXCHANGE CLIENT — si connette a ws://host:port
	// ---------------------------------------------------------------------------

	_startClient() {
		if (this._stopped) return;

		const scheme = this.tls ? 'wss' : 'ws';
		const url = `${scheme}://${this.host}:${this.port}`;
		this.runtime.log(`[Exchange] Connecting to exchange: ${url}`);

		let ws;
		try {
			// rejectUnauthorized: false per supportare certificati self-signed
			const token = String(this.runtime.exchangeAuthToken || '').trim();
			const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
			ws = new WebSocket(url, { rejectUnauthorized: false, headers });
		} catch (err) {
			this.runtime.log(`[Exchange] Unable to create client: ${err.message}`);
			this._scheduleReconnect();
			return;
		}

		this.wsClient = ws;
		this._knownRemotePeers.clear();
		this._clientRegistered = false;
		this._emitConnectionStatus('exchange-connecting');

		ws.on('open', async () => {
			this._clientLastError = '';
			this._clientLastCloseReason = '';
			this._clientLastCloseCode = 0;
			this._clientConnectedAt = Date.now();
			this._clientLastPongAt = Date.now();
			this._emitConnectionStatus('exchange-open');
			this._startClientHeartbeat(ws);
			try {
				const name = await this.runtime.getReactorName();
				const safeName = String(name || '').trim() || 'unnamed';
				const token = String(this.runtime.exchangeAuthToken || '').trim();
				const scripts = typeof this.runtime.getDiscoveryScriptEntries === 'function'
					? this.runtime.getDiscoveryScriptEntries()
					: [];
				ws.send(JSON.stringify({
					type: 'register',
					name: safeName,
					token,
					scripts,
					httpPort: Number(this.runtime.httpServerPort) || 7070,
					httpTls: Boolean(this.runtime.tlsEnabled),
				}));
				this.runtime.log(`[Exchange] Connected as: ${safeName}`);
			} catch (err) {
				this.runtime.log(`[Exchange] Registration error: ${err.message}`);
			}
		});

		ws.on('message', (data, isBinary) => {
			this._clientLastPongAt = Date.now();
			if (isBinary) {
				const meta = this._clientPendingBinaryChunkMeta.shift();
				if (!meta) {
					this.runtime.log('[Exchange] Received binary frame without metadata, dropping');
					return;
				}

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
				this._handleIncomingStreamEnvelope(sender, payload, '', 'application/octet-stream');
				return;
			}

			let packet;
			try { packet = JSON.parse(String(data)); } catch { return; }
			if (packet && packet.type === 'message') this._handleIncomingMessage(packet);
			if (packet && packet.type === 'signal') this._handleIncomingSignal(packet);
			if (packet && packet.type === 'peer-list') this._handleIncomingPeerList(packet);
			if (packet && packet.type === 'stream-chunk-bin') {
				this._clientPendingBinaryChunkMeta.push(packet);
			}
			if (packet && packet.type === 'auth-error') {
				this.runtime.log(`[Exchange] Authentication failed: ${packet.error || 'invalid exchange token'}`);
				this._clientLastError = String(packet.error || 'invalid exchange token');
				this._clientRegistered = false;
				this._emitConnectionStatus('exchange-auth-error');
			}
		});

		ws.on('pong', () => {
			this._clientLastPongAt = Date.now();
		});

		ws.on('close', (code, reason) => {
			this._stopClientHeartbeat();
			if (this.wsClient === ws) this.wsClient = null;
			this._knownRemotePeers.clear();
			this._clientConnectedAt = 0;
			this._clientRegistered = false;
			this._clientLastCloseCode = Number(code) || 0;
			this._clientLastCloseReason = String(reason || '').trim();
			this.runtime.log('[Exchange] Connection closed, reconnecting...');
			this._emitConnectionStatus('exchange-close');
			this._scheduleReconnect();
		});

		ws.on('error', (err) => {
			this._stopClientHeartbeat();
			this._knownRemotePeers.clear();
			this._clientLastError = String(err?.message || 'unknown error');
			this._clientRegistered = false;
			this.runtime.log(`[Exchange] Error: ${err.message}`);
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
			if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
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

		return {
			connected: Boolean(this.wsClient && this.wsClient.readyState === WebSocket.OPEN),
			skipped: false,
			reason,
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
				scriptId: String(packet.targetScriptId || '').trim().toLowerCase() || null,
			});
			return;
		}

		this.runtime.log(`[Exchange] Message from: ${from}`);
		const targetScriptId = String(packet.targetScriptId || '').trim().toLowerCase() || null;
		const listeners = this.runtime.filterMessageListenersByTarget(
			this.runtime.findMessageListeners([from.toLowerCase()]),
			targetScriptId,
		);

		Promise.allSettled(
			listeners.map((script) =>
				this.runtime.runScript(script, {
					trigger: 'MESSAGE',
					event: 'MESSAGE',
					messageSender: from,
					messageSenderName: from,
					messageTarget: String(packet.to || '').trim().toLowerCase() || null,
					messageTargetNode: String(packet.to || '').trim().toLowerCase() || null,
					messageTargetScriptId: targetScriptId,
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
				targetScriptId: String(packet.targetScriptId || '').trim().toLowerCase() || null,
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
		const targetScriptId = String(targetMeta.scriptId || '').trim().toLowerCase() || null;
		const targetNode = String(targetMeta.nodeName || '').trim().toLowerCase() || null;

		this.runtime.log(`[Exchange] Message from: ${from}`);
		const listeners = this.runtime.filterStreamListenersByTarget(
			this.runtime.findStreamListeners(senderMeta.candidates),
			targetScriptId,
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

				await Promise.allSettled(
					listeners.map((script) =>
						this.runtime.runScript(script, {
							trigger: 'STREAM',
							event: 'STREAM',
							messageSender: from,
							messageSenderName: from,
							messageTarget: targetNode,
							messageTargetNode: targetNode,
							messageTargetScriptId: targetScriptId,
							messageContent: safeRawContent,
							messageContentType: contentType,
							messageBodyBase64: safeMessageBodyBase64,
							messageJson: streamEnvelope,
							stream: streamPacket,
							streamEnd: null,
							messageHeaders: {
								'x-exchange-from': from,
								'Reactor-Target-Node': targetNode || '',
								'Reactor-Target-Script-Id': targetScriptId || '',
							},
						}),
					),
				);

				if (streamEndData && this.runtime && typeof this.runtime.emitStreamEnd === 'function') {
						await this.runtime.emitStreamEnd(streamEndData, senderMeta, {
							'x-exchange-from': from,
							'Reactor-Target-Node': targetNode || '',
							'Reactor-Target-Script-Id': targetScriptId || '',
						});
				}
			})
			.catch(() => {});
	}

	// ---------------------------------------------------------------------------
	// API pubblica
	// ---------------------------------------------------------------------------

	async sendViaExchange(target, content) {
		if (this.mode !== 'client') throw new Error('not in client mode');
		if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
			throw new Error('exchange client not connected');
		}

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
			targetScriptId: parsedTarget.scriptId || null,
			content: serializedContent,
			contentType,
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
			targetScriptId: parsedTarget.scriptId || null,
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

	async sendStreamChunkBinary(target, streamId, index, chunkBuffer) {
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

		const buffer = Buffer.isBuffer(chunkBuffer) ? chunkBuffer : Buffer.from(chunkBuffer || []);
		const safeIndex = Number.isFinite(Number(index)) ? Number(index) : -1;

		this.wsClient.send(JSON.stringify({
			type: 'stream-chunk-bin',
			to,
			streamId: safeStreamId,
			index: safeIndex,
			size: buffer.length,
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
		const connectedClientsDetails = this.getConnectedClientsDiscoveryEntries(now);
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

	getConnectedClientsDiscoveryEntries(nowMs = Date.now()) {
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
					scriptsEndpoint: detail?.scriptsEndpoint || null,
					connectedAt: connectedAt || null,
					lastSeenAt: detail?.lastSeenAt || null,
					userAgent: detail?.userAgent || '',
					scripts: this._sanitizeDiscoveryScripts(detail?.scripts),
					connectedForMs,
					connectedForSec: Number.isFinite(connectedForMs) ? Math.floor(connectedForMs / 1000) : null,
				};
			})
			.sort((a, b) => String(a.name).localeCompare(String(b.name)));
	}

	updateClientDiscoveryScripts(scripts = []) {
		if (this.mode !== 'client' || !this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
			return;
		}

		try {
			this.wsClient.send(JSON.stringify({
				type: 'profile',
				scripts: this._sanitizeDiscoveryScripts(scripts),
				httpPort: Number(this.runtime.httpServerPort) || 7070,
				httpTls: Boolean(this.runtime.tlsEnabled),
			}));
		} catch {
			// Ignore profile update failures: scripts will be re-sent on reconnect.
		}
	}
}

module.exports = { ExchangeManager };
