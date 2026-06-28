const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs/promises');
const path = require('path');

const RECONNECT_DELAY_MS = 5000;
const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 45000;

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
		this._heartbeatIntervalMs = this._readHeartbeatValue('REACTOR_EXCHANGE_HEARTBEAT_INTERVAL_MS', DEFAULT_WS_HEARTBEAT_INTERVAL_MS, 3000);
		this._heartbeatTimeoutMs = this._readHeartbeatValue('REACTOR_EXCHANGE_HEARTBEAT_TIMEOUT_MS', DEFAULT_WS_HEARTBEAT_TIMEOUT_MS, this._heartbeatIntervalMs + 1000);
		this._connectionLogPath = path.join(this.runtime.reactorRootDir || process.cwd(), 'exchange-connections.log');
		this._activeConnectionsPath = path.join(this.runtime.reactorRootDir || process.cwd(), 'exchange-active-connections.json');
	}

	_readHeartbeatValue(envName, fallback, minValue) {
		const raw = Number(process.env[envName]);
		if (!Number.isFinite(raw)) {
			return fallback;
		}

		return Math.max(minValue, Math.floor(raw));
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
		await this._writeActiveConnectionsSnapshot();
	}

	// ---------------------------------------------------------------------------
	// EXCHANGE SERVER — si aggancia all'HTTP server esistente (stessa porta)
	// ---------------------------------------------------------------------------

	_startServer(httpServer) {
		this.wss = new WebSocketServer({ noServer: true });
		this.wss.on('connection', (ws, request) => this._handleClientConnection(ws, request));
		this._startServerHeartbeat();

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

		ws.on('message', (data) => {
			ws.isAlive = true;
			let packet;
			try { packet = JSON.parse(String(data)); } catch { return; }
			if (!packet || typeof packet !== 'object') return;

			if (packet.type === 'register') {
				const name = String(packet.name || '').trim().toLowerCase();
				const providedToken = String(packet.token || '').trim();
				const expectedToken = String(this.runtime.exchangeAuthToken || '').trim();

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
					this._connectedClientDetails.set(clientName, {
						name: clientName,
						address,
						ip,
						port,
						registrationAt: connectedAt,
						connectedAt,
						lastSeenAt: new Date().toISOString(),
						userAgent,
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
				}
			} else if (packet.type === 'message') {
				if (clientName && this._connectedClientDetails.has(clientName)) {
					const current = this._connectedClientDetails.get(clientName);
					this._connectedClientDetails.set(clientName, {
						...current,
						lastSeenAt: new Date().toISOString(),
					});
				}
				this._routeMessage(packet, clientName);
			}
		});

		ws.on('close', () => {
			ws.isAlive = false;
			if (clientName) {
				this.connectedClients.delete(clientName);
				this._connectedClientDetails.delete(clientName);
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
			return;
		}

		try {
			targetWs.send(JSON.stringify({
				type: 'message',
				from: fromName || 'unknown',
				content: packet.content !== undefined ? packet.content : '',
				contentType: String(packet.contentType || 'text/plain'),
			}));
			this.runtime.log(`[Exchange] Routed: ${fromName || 'unknown'} -> ${to}`);
		} catch (err) {
			this.runtime.log(`[Exchange] Routing error to ${to}: ${err.message}`);
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

		ws.on('open', async () => {
			this._clientLastPongAt = Date.now();
			this._startClientHeartbeat(ws);
			try {
				const name = await this.runtime.getReactorName();
				const safeName = String(name || '').trim() || 'unnamed';
				const token = String(this.runtime.exchangeAuthToken || '').trim();
				ws.send(JSON.stringify({ type: 'register', name: safeName, token }));
				this.runtime.log(`[Exchange] Connected as: ${safeName}`);
			} catch (err) {
				this.runtime.log(`[Exchange] Registration error: ${err.message}`);
			}
		});

		ws.on('message', (data) => {
			this._clientLastPongAt = Date.now();
			let packet;
			try { packet = JSON.parse(String(data)); } catch { return; }
			if (packet && packet.type === 'message') this._handleIncomingMessage(packet);
			if (packet && packet.type === 'auth-error') {
				this.runtime.log(`[Exchange] Authentication failed: ${packet.error || 'invalid exchange token'}`);
			}
		});

		ws.on('pong', () => {
			this._clientLastPongAt = Date.now();
		});

		ws.on('close', () => {
			this._stopClientHeartbeat();
			if (this.wsClient === ws) this.wsClient = null;
			this.runtime.log('[Exchange] Connection closed, reconnecting...');
			this._scheduleReconnect();
		});

		ws.on('error', (err) => {
			this._stopClientHeartbeat();
			this.runtime.log(`[Exchange] Error: ${err.message}`);
		});
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
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this._startClient();
		}, RECONNECT_DELAY_MS);
	}

	_handleIncomingMessage(packet) {
		const from = String(packet.from || 'unknown');
		const content = packet.content !== undefined ? String(packet.content) : '';
		const contentType = String(packet.contentType || 'text/plain');

		this.runtime.log(`[Exchange] Message from: ${from}`);
		const listeners = this.runtime.findMessageListeners([from.toLowerCase()]);

		Promise.allSettled(
			listeners.map((script) =>
				this.runtime.runScript(script, {
					trigger: 'MESSAGE',
					event: 'MESSAGE',
					messageSender: from,
					messageSenderName: from,
					messageContent: content,
					messageContentType: contentType,
					messageBodyBase64: Buffer.from(content, 'utf8').toString('base64'),
					messageJson: null,
					messageHeaders: { 'x-exchange-from': from },
				}),
			),
		).catch(() => {});
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

		const to = String(target || '').trim().toLowerCase();
		if (!to) throw new Error('invalid exchange target');

		this.wsClient.send(JSON.stringify({ type: 'message', to, content: serializedContent, contentType }));
		return {
			target: to,
			via: 'exchange',
			queued: true,
		};
	}

	getConfig() {
		const isClientConnected =
			this.mode === 'client' && Boolean(this.wsClient) && this.wsClient.readyState === WebSocket.OPEN;
		const now = Date.now();
		return {
			mode: this.mode,
			host: this.host,
			port: this.port,
			tls: this.tls,
			active: this.mode === 'exchange' ? Boolean(this.wss) : this.mode === 'client' ? isClientConnected : false,
			connectedClients: this.mode === 'exchange' ? Array.from(this.connectedClients.keys()) : [],
			connectedClientsDetails: this.mode === 'exchange' ? Array.from(this._connectedClientDetails.values()) : [],
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
}

module.exports = { ExchangeManager };
