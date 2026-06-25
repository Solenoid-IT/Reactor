const fs = require('fs/promises');
const fsNative = require('fs');
const http = require('http');
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
		this.httpServer = null;
		this.httpServerPort = Number(options.httpServerPort || process.env.REACTOR_HTTP_PORT || 7000);
		this.httpServerLogs = [];
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
			routes: Array.from(this.routeMap.entries()).map(([routeKey, scripts]) => ({
				route: routeKey,
				scripts: scripts.map((script) => script.name),
			})),
		};
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

	async handleRouteRequest(req, res) {
		const method = String(req.method || 'GET').toUpperCase();
		let pathname = '/';
		let query = '';

		try {
			const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
			pathname = parsedUrl.pathname || '/';
			query = parsedUrl.search || '';
		} catch {
			pathname = '/';
			query = '';
		}

		if (method === 'GET' && pathname === '/health') {
			this.addHttpServerLog('GET /health -> 200');
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
		this.addHttpServerLog(`${method} ${pathname} -> ${listeners.length} script(s)`);

		await Promise.allSettled(
			listeners.map((script) =>
				this.runScript(script, {
					trigger: 'ROUTE',
					event: 'HTTP_ROUTE',
					routeMethod: method,
					routePath: pathname,
					routeQuery: query,
					routeBody: body,
					routeHeaders: req.headers || {},
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
				const moduleExports = loadScriptModule(scriptPath, source);
				const runner = moduleExports.run || moduleExports.default;
				const normalizedScriptsDir = path.resolve(this.scriptsDir);
				const normalizedScriptPath = path.resolve(scriptPath);
				const scriptDir = path.dirname(normalizedScriptPath);
				const scriptBaseName = path.basename(normalizedScriptPath).toLowerCase();
				const isProjectBootScript = scriptBaseName === 'boot.ts' && path.dirname(scriptDir) === normalizedScriptsDir;
				const displayName = isProjectBootScript ? path.basename(scriptDir) : path.basename(scriptPath);

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
			await Promise.resolve(
				script.run({
					...context,
					api: this.runtimeApi,
					FileSystem: this.runtimeApi.FileSystem,
					HttpClient: this.runtimeApi.HttpClient,
					Device: this.runtimeApi.Device,
					System: this.runtimeApi.System,
					log: async (message) => {
						this.log(`${script.name}: ${message}`);
					},
				}),
			);
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
