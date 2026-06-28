const { WebSocketServer, WebSocket } = require('ws');

const RECONNECT_DELAY_MS = 5000;

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
	}

	// ---------------------------------------------------------------------------
	// EXCHANGE SERVER — si aggancia all'HTTP server esistente (stessa porta)
	// ---------------------------------------------------------------------------

	_startServer(httpServer) {
		this.wss = new WebSocketServer({ noServer: true });
		this.wss.on('connection', (ws) => this._handleClientConnection(ws));

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
					this.runtime.log('[Exchange] Upgrade rifiutato: Authorization Bearer token non valido');
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
		this.runtime.log('[Exchange] Server WebSocket attivo sulla porta HTTP');
	}

	_handleClientConnection(ws) {
		let clientName = null;

		ws.on('message', (data) => {
			let packet;
			try { packet = JSON.parse(String(data)); } catch { return; }
			if (!packet || typeof packet !== 'object') return;

			if (packet.type === 'register') {
				const name = String(packet.name || '').trim().toLowerCase();
				const providedToken = String(packet.token || '').trim();
				const expectedToken = String(this.runtime.exchangeAuthToken || '').trim();

				if (expectedToken && providedToken !== expectedToken) {
					this.runtime.log(`[Exchange] Registrazione rifiutata per ${name || 'unknown'}: token non valido`);
					ws.send(JSON.stringify({ type: 'auth-error', error: 'invalid exchange token' }));
					ws.close(4001, 'invalid exchange token');
					return;
				}

				if (name) {
					if (clientName && clientName !== name) this.connectedClients.delete(clientName);
					clientName = name;
					this.connectedClients.set(clientName, ws);
					this.runtime.log(`[Exchange] Client registrato: ${clientName}`);
					ws.send(JSON.stringify({ type: 'registered', name: clientName }));
				}
			} else if (packet.type === 'message') {
				this._routeMessage(packet, clientName);
			}
		});

		ws.on('close', () => {
			if (clientName) {
				this.connectedClients.delete(clientName);
				this.runtime.log(`[Exchange] Client disconnesso: ${clientName}`);
			}
		});

		ws.on('error', (err) => {
			this.runtime.log(`[Exchange] Errore client ${clientName || 'unknown'}: ${err.message}`);
		});
	}

	_routeMessage(packet, fromName) {
		const to = String(packet.to || '').trim().toLowerCase();
		if (!to) return;

		const targetWs = this.connectedClients.get(to);
		if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
			this.runtime.log(`[Exchange] Target non trovato o disconnesso: ${to}`);
			return;
		}

		try {
			targetWs.send(JSON.stringify({
				type: 'message',
				from: fromName || 'unknown',
				content: packet.content !== undefined ? packet.content : '',
				contentType: String(packet.contentType || 'text/plain'),
			}));
			this.runtime.log(`[Exchange] Instradato: ${fromName || 'unknown'} → ${to}`);
		} catch (err) {
			this.runtime.log(`[Exchange] Errore routing verso ${to}: ${err.message}`);
		}
	}

	// ---------------------------------------------------------------------------
	// EXCHANGE CLIENT — si connette a ws://host:port
	// ---------------------------------------------------------------------------

	_startClient() {
		if (this._stopped) return;

		const scheme = this.tls ? 'wss' : 'ws';
		const url = `${scheme}://${this.host}:${this.port}`;
		this.runtime.log(`[Exchange] Connessione all'exchange: ${url}`);

		let ws;
		try {
			// rejectUnauthorized: false per supportare certificati self-signed
			const token = String(this.runtime.exchangeAuthToken || '').trim();
			const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
			ws = new WebSocket(url, { rejectUnauthorized: false, headers });
		} catch (err) {
			this.runtime.log(`[Exchange] Impossibile creare il client: ${err.message}`);
			this._scheduleReconnect();
			return;
		}

		this.wsClient = ws;

		ws.on('open', async () => {
			try {
				const name = await this.runtime.getReactorName();
				const safeName = String(name || '').trim() || 'unnamed';
				const token = String(this.runtime.exchangeAuthToken || '').trim();
				ws.send(JSON.stringify({ type: 'register', name: safeName, token }));
				this.runtime.log(`[Exchange] Connesso come: ${safeName}`);
			} catch (err) {
				this.runtime.log(`[Exchange] Errore registrazione: ${err.message}`);
			}
		});

		ws.on('message', (data) => {
			let packet;
			try { packet = JSON.parse(String(data)); } catch { return; }
			if (packet && packet.type === 'message') this._handleIncomingMessage(packet);
			if (packet && packet.type === 'auth-error') {
				this.runtime.log(`[Exchange] Autenticazione fallita: ${packet.error || 'invalid exchange token'}`);
			}
		});

		ws.on('close', () => {
			if (this.wsClient === ws) this.wsClient = null;
			this.runtime.log('[Exchange] Connessione chiusa, riconnessione...');
			this._scheduleReconnect();
		});

		ws.on('error', (err) => {
			this.runtime.log(`[Exchange] Errore: ${err.message}`);
		});
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

		this.runtime.log(`[Exchange] Messaggio da: ${from}`);
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
		if (this.mode !== 'client') throw new Error('non in modalità client');
		if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
			throw new Error('exchange client non connesso');
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
		if (!to) throw new Error('target exchange non valido');

		this.wsClient.send(JSON.stringify({ type: 'message', to, content: serializedContent, contentType }));
	}

	getConfig() {
		const isClientConnected =
			this.mode === 'client' && Boolean(this.wsClient) && this.wsClient.readyState === WebSocket.OPEN;
		return {
			mode: this.mode,
			host: this.host,
			port: this.port,
			tls: this.tls,
			active: this.mode === 'exchange' ? Boolean(this.wss) : this.mode === 'client' ? isClientConnected : false,
			connectedClients: this.mode === 'exchange' ? Array.from(this.connectedClients.keys()) : [],
		};
	}
}

module.exports = { ExchangeManager };
