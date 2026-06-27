const fs = require('fs/promises');
const fsNative = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { parseScheduleExpression } = require('./scheduleParser');
const { parseScriptMetadata } = require('./metadata');
const { loadScriptModule } = require('./scriptLoader');
const { NetworkMonitor } = require('./networkMonitor');
const { createNodePlatformServices } = require('./platform/nodePlatformServices');
const { createNodeRuntimeApi } = require('./platform/nodeRuntimeApi');

const ALL_WATCH_LISTENERS = new Set([
	'file:created',
	'file:deleted',
	'file:moved',
	'file:changed',
	'dir:created',
	'dir:deleted',
	'dir:moved',
]);

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
		this.routeMap = new Map();
		this.messageListenerMap = new Map();
		this.httpServer = null;
		this.httpServerPort = Number(options.httpServerPort || process.env.REACTOR_HTTP_PORT || 7070);
		this.httpServerLogs = [];
		this.reactorRootDir = options.reactorRootDir || path.dirname(this.scriptsDir);
		this.reactorNamePath = path.join(this.reactorRootDir, 'name');
		this.cachedReactorName = null;
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
			routes: Array.from(this.routeMap.entries()).map(([routeKey, scripts]) => ({
				route: routeKey,
				scripts: scripts.map((script) => script.name),
			})),
			messageListeners: Array.from(this.messageListenerMap.entries()).map(([sender, scripts]) => ({
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

	async setHttpServerPort(port) {
		const nextPort = Number(port);
		if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
			throw new Error('invalid HTTP server port');
		}

		if (nextPort === this.httpServerPort) {
			return this.getHttpServerConfig();
		}

		this.httpServerPort = nextPort;
		await this.restartHttpRouteServer();
		return this.getHttpServerConfig();
	}

	registerScriptRoutes(script) {
		if (!script.enabled || !Array.isArray(script.routes) || script.routes.length === 0) {
			return;
		}

		for (const route of script.routes) {
			if (!route || !route.method || !route.path) {
				continue;
			}

			const routeKey = `${String(route.method).toUpperCase()} ${route.path}`;
			const listeners = this.routeMap.get(routeKey) || [];
			listeners.push(script);
			this.routeMap.set(routeKey, listeners);
		}
	}

	findRouteListeners(method, routePath) {
		const methodKey = `${String(method || '').toUpperCase()} ${routePath}`;
		const wildcardKey = `* ${routePath}`;
		const listeners = [];

		for (const script of this.routeMap.get(methodKey) || []) {
			listeners.push(script);
		}

		for (const script of this.routeMap.get(wildcardKey) || []) {
			if (!listeners.includes(script)) {
				listeners.push(script);
			}
		}

		return listeners;
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

	async sendNodeMessage(target, content, extraHeaders = {}) {
		const targetId = String(target || '').trim();
		const normalizedTarget = normalizeHostPort(targetId, 7070);
		if (!normalizedTarget) {
			throw new Error('invalid target. expected host or host:port');
		}

		const [host, portString] = normalizedTarget.split(':');
		const port = Number(portString || 7070);
		const endpoint = `http://${host}:${port}/message`;

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
		const request = new this.runtimeApi.HttpClient.Request({
			url: endpoint,
			method: 'POST',
			headers: {
				'content-type': contentType,
				'Reactor-Name': reactorName || '',
				'Reactor-Sender': senderId,
				...extraHeaders,
			},
			body: payload,
		});

		const response = await this.runtimeApi.HttpClient.sendRequest(request);
		return {
			target: normalizedTarget,
			endpoint,
			status: response.status,
			headers: response.headers,
			body: response.body,
		};
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

		return {
			Node: {
				sendMessage: async (target, content, options = {}) => {
					const normalizedOptions = options && typeof options === 'object' ? options : {};
					const headers = normalizedOptions.headers || {};
					return this.sendNodeMessage(target, content, headers);
				},
			},
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

	async handleRouteRequest(req, res) {
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
					routesCount: this.routeMap.size,
				}),
			);
			return;
		}

		if (method === 'POST' && pathname === '/message') {
			const bodyChunks = [];
			for await (const chunk of req) {
				bodyChunks.push(chunk);
			}
			const rawBuffer = Buffer.concat(bodyChunks);
			const body = this.parseMessageBody(req, rawBuffer);
			const senderMeta = this.resolveSenderCandidates(req);
			const listeners = this.findMessageListeners(senderMeta.candidates);

			this.addHttpServerLog(
				`POST /message sender=${senderMeta.rawSender || senderMeta.rawName || senderMeta.remoteHost || 'unknown'} -> ${listeners.length} script(s)`,
			);

			if (listeners.length === 0) {
				res.writeHead(202, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						ok: true,
						trigger: 'MESSAGE',
						delivered: false,
						reason: 'no listeners',
						senderCandidates: senderMeta.candidates,
					}),
				);
				return;
			}

			await Promise.allSettled(
				listeners.map((script) =>
					this.runScript(script, {
						trigger: 'MESSAGE',
						event: 'MESSAGE',
						messageSender: senderMeta.rawSender || senderMeta.remoteHost || null,
						messageSenderName: senderMeta.rawName || null,
						messageContent: body.text,
						messageContentType: body.contentType,
						messageBodyBase64: body.base64,
						messageJson: body.json,
						messageHeaders: req.headers || {},
					}),
				),
			);

			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					trigger: 'MESSAGE',
					delivered: true,
					scripts: listeners.map((script) => script.name),
					senderCandidates: senderMeta.candidates,
				}),
			);
			return;
		}

		const listeners = this.findRouteListeners(method, pathname);
		if (listeners.length === 0) {
			this.addHttpServerLog(`${method} ${pathname} -> 404 (no matching @route)`);
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: false, error: 'route not found', method, path: pathname }));
			return;
		}

		const bodyChunks = [];
		for await (const chunk of req) {
			bodyChunks.push(chunk);
		}

		const body = Buffer.concat(bodyChunks).toString('utf8');
		const headers = req.headers || {};
		const contentType = String(headers['content-type'] || '').toLowerCase();
		let bodyJson = null;
		if (body && contentType.includes('application/json')) {
			try {
				bodyJson = JSON.parse(body);
			} catch {
				bodyJson = null;
			}
		}

		const request = {
			method,
			path: pathname,
			query,
			queryParams,
			headers,
			body,
			bodyJson,
		};
		this.addHttpServerLog(`${method} ${pathname} -> ${listeners.length} script(s)`);

		await Promise.allSettled(
			listeners.map((script) =>
				this.runScript(script, {
					trigger: 'ROUTE',
					event: 'HTTP_ROUTE',
					request,
					routeMethod: method,
					routePath: pathname,
					routeQuery: query,
					routeBody: body,
					routeHeaders: headers,
				}),
			),
		);

		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				ok: true,
				trigger: 'ROUTE',
				method,
				path: pathname,
				scripts: listeners.map((script) => script.name),
			}),
		);
	}

	async startHttpRouteServer() {
		if (this.httpServer) {
			return;
		}

		await new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				this.handleRouteRequest(req, res).catch((error) => {
					this.addHttpServerLog(`request handling failed: ${error.message}`);
					res.writeHead(500, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ ok: false, error: 'internal server error' }));
				});
			});

			server.once('error', reject);
			server.listen(this.httpServerPort, () => {
				server.off('error', reject);
				this.httpServer = server;
				this.addHttpServerLog(`listening on port ${this.httpServerPort}`);
				resolve();
			});
		});
	}

	async stopHttpRouteServer() {
		if (!this.httpServer) {
			return;
		}

		const server = this.httpServer;
		this.httpServer = null;
		await new Promise((resolve) => server.close(() => resolve()));
		this.addHttpServerLog('stopped');
	}

	async restartHttpRouteServer() {
		await this.stopHttpRouteServer();
		await this.startHttpRouteServer();
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
			routeMethod: context.routeMethod || null,
			routePath: context.routePath || null,
			durationMs,
			output,
			error,
		});
	}

	async init() {
		await fs.mkdir(this.scriptsDir, { recursive: true });
		await this.getReactorName();
		await this.discoverScripts();
		this.setupSchedules();
		this.setupWatchers();
		await this.startHttpRouteServer();
		this.setupScriptsWatcher();
		this.setupNetworkWatcher();
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
		this.routeMap.clear();
		this.messageListenerMap.clear();

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
				const isProjectBootScript = scriptBaseName === 'boot.ts' && path.dirname(scriptDir) === normalizedScriptsDir;
				const displayName = isProjectBootScript ? path.basename(scriptDir) : path.basename(scriptPath);
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
					eventLogPath: path.join(path.dirname(normalizedScriptPath), 'activity.log'),
					run: runner,
					schedule: metadata.schedule,
					events: metadata.events,
					messageSenders: metadata.messageSenders || [],
					messageFromAnySender: Boolean(metadata.messageFromAnySender),
					state: metadata.state,
					enabled: metadata.state !== 'DISABLED',
					mutex: metadata.mutex,
					watch: metadata.watch || [], // Existing watch property
					watchRules: metadata.watchRules || [], // New watchRules property
					routes: metadata.routes || [],
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
					} @watch=${script.watch.length > 0 ? script.watch.join(', ') : 'none'} @route=${
						script.routes.length > 0 ? script.routes.map((route) => route.raw).join(', ') : 'none'
					} @mutex=${script.mutex ? 'on' : 'off'} (from ${this.scriptsDir})`,
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

				this.registerScriptRoutes(script);
				this.registerScriptMessageListeners(script);
			} catch (error) {
				this.log(`Failed to load script ${scriptPath}: ${error.message}`);
			}
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

	async emitEvent(eventName) {
		const listeners = this.eventMap.get(eventName) || [];
		if (listeners.length === 0) {
			this.log(`Emitting event ${eventName} - no listeners`);
			return;
		}

		this.log(`Emitting event ${eventName} to ${listeners.length} script(s): ${listeners.map(s => s.name).join(', ')}`);
		await Promise.allSettled(
			listeners.map((script) => this.runScript(script, { trigger: 'EVENT', event: eventName })),
		);
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
				routeMethod: context.routeMethod || null,
				routePath: context.routePath || null,
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
		this.networkMonitor = new NetworkMonitor((eventName) => this.emitEvent(eventName));
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
