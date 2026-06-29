const fs = require('fs/promises');
const fsNative = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { ReactorRuntime } = require('./src/runtime');
const { readWorkingModeConfig, writeWorkingModeConfig } = require('./src/workingModeConfig');

function installTimestampedConsoleLogging() {
	if (process.env.REACTOR_LOG_TIMESTAMPS === '0' || process.env.REACTOR_LOG_TIMESTAMPS === 'false') {
		return;
	}

	const methods = ['log', 'info', 'warn', 'error', 'debug'];
	for (const method of methods) {
		const original = console[method];
		if (typeof original !== 'function') {
			continue;
		}

		console[method] = (...args) => {
			const timestamp = new Date().toISOString();
			original.call(console, `[${timestamp}]`, ...args);
		};
	}
}

installTimestampedConsoleLogging();

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

function getDaemonSocketPath(dataDir) {
	return process.env.REACTOR_DAEMON_SOCKET || path.join(dataDir, 'reactor-daemon.sock');
}

function buildScriptAliases(script) {
	const aliases = new Set();
	const add = (value) => {
		if (!value) {
			return;
		}
		aliases.add(String(value).trim().toLowerCase());
	};

	add(script.name);
	add(script.name.replace(/\.(ts|js)$/i, ''));

	const baseName = path.basename(script.path);
	add(baseName);
	add(baseName.replace(/\.(ts|js)$/i, ''));

	if (baseName.toLowerCase() === 'boot.ts') {
		add(path.basename(path.dirname(script.path)));
	}

	return aliases;
}

function findScriptByName(runtime, requestedName) {
	const target = String(requestedName || '').trim().toLowerCase();
	if (!target) {
		return null;
	}

	for (const script of runtime.scripts) {
		const aliases = buildScriptAliases(script);
		if (aliases.has(target)) {
			return script;
		}
	}

	return null;
}

async function deleteScriptFromRuntime(runtime, script) {
	const allowedPath = path.resolve(runtime.scriptsDir);
	const normalizedFilePath = path.resolve(script.path);
	if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
		throw new Error('path not allowed');
	}

	const scriptDir = path.dirname(normalizedFilePath);
	const isBootProjectScript = path.basename(normalizedFilePath).toLowerCase() === 'boot.ts' && scriptDir !== allowedPath;

	let isProjectFolder = false;
	if (isBootProjectScript && path.resolve(scriptDir).startsWith(allowedPath + path.sep)) {
		try {
			await fs.access(path.join(scriptDir, 'package.json'));
			isProjectFolder = true;
		} catch {
			isProjectFolder = false;
		}
	}

	if (isProjectFolder) {
		const packageJsonPath = path.join(scriptDir, 'package.json');
		try {
			await fs.access(packageJsonPath);
			await fs.rm(scriptDir, { recursive: true, force: true });
		} catch {
			await fs.unlink(normalizedFilePath);
		}
	} else {
		await fs.unlink(normalizedFilePath);
	}

	await runtime.reloadScripts('daemonctl-delete-script');
}

async function createControlServer(runtime, socketPath, onStopRequested, saveExchangeConfig) {
	if (process.platform !== 'win32') {
		try {
			await fs.unlink(socketPath);
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
	}

	const server = net.createServer({ allowHalfOpen: true }, (socket) => {
		let buffer = '';

		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
		});

		socket.on('end', async () => {
			let response;
			let shouldStop = false;
			try {
				const payload = JSON.parse(buffer || '{}');
				const command = String(payload.command || '').toLowerCase();

					if (command === 'list') {
					response = {
						ok: true,
						scripts: runtime.scripts.map((script) => ({
							name: script.name,
							path: script.path,
							scriptId: script.scriptId || null,
							state: script.state,
						})),
					};
					} else if (command === 'status') {
						response = {
							ok: true,
							pid: process.pid,
							uptimeSec: Math.floor(process.uptime()),
							scriptsCount: runtime.scripts.length,
						};
				} else if (command === 'run') {
					await runtime.reloadScripts('daemonctl-run');
					const script = findScriptByName(runtime, payload.name);
					if (!script) {
						response = {
							ok: false,
							error: `script not found: ${payload.name || ''}`,
						};
					} else {
						await runtime.runScript(script, {
							trigger: 'MANUAL_CLI',
							event: 'ON_DEMAND',
							force: true,
						});
						response = {
							ok: true,
							script: script.name,
							path: script.path,
						};
					}
				} else if (command === 'script-id') {
					await runtime.reloadScripts('daemonctl-script-id');
					const script = findScriptByName(runtime, payload.name);
					if (!script) {
						response = {
							ok: false,
							error: `script not found: ${payload.name || ''}`,
						};
					} else if (!script.scriptId) {
						response = {
							ok: false,
							error: `script has no project UUID: ${script.name}`,
						};
					} else {
						response = {
							ok: true,
							script: script.name,
							path: script.path,
							scriptId: script.scriptId,
						};
					}
				} else if (command === 'set-name') {
					const nextName = String(payload.name || '').trim();
					if (!nextName) {
						response = { ok: false, error: 'name is required' };
					} else {
						const savedName = await runtime.setReactorName(nextName);
						response = { ok: true, name: savedName };
					}
				} else if (command === 'set-port') {
					const numericPort = Number(payload.port);
					if (!Number.isFinite(numericPort) || numericPort < 1 || numericPort > 65535) {
						response = { ok: false, error: 'invalid port' };
					} else {
						const config = await runtime.setHttpServerPort(numericPort);
						response = { ok: true, port: config.port };
					}
				} else if (command === 'set-exchange') {
					const mode = String(payload.mode || 'node');
					const host = String(payload.host || '').trim();
					const port = Number(payload.port) > 0 ? Number(payload.port) : 7070;
					const tls = Boolean(payload.tls);
					const token = String(payload.token || '').trim();
					if (!['node', 'exchange'].includes(mode)) {
						response = { ok: false, error: 'invalid mode: use node or exchange' };
					} else {
						const config = await runtime.setExchangeConfig(mode, host, port, tls, token);
						await saveExchangeConfig(mode, host, port, tls, token);
						response = { ok: true, exchange: config };
					}
				} else if (command === 'get-exchange-token') {
					response = { ok: true, exchangeToken: await runtime.getExchangeToken() };
				} else if (command === 'generate-exchange-token') {
					const exchangeToken = await runtime.generateExchangeToken();
					await saveExchangeConfig(runtime.exchangeMode, runtime.exchangeHost, runtime.exchangePort, runtime.exchangeManager.tls, exchangeToken.token);
					response = { ok: true, exchangeToken };
				} else if (command === 'generate-tls-cert') {
					const tlsBits = payload.bits;
					const tlsDays = payload.days;
					const tls = await runtime.generateTlsCert(tlsBits, tlsDays);
					const tlsDir = path.join(runtime.reactorRootDir, 'tls');
					response = {
						ok: true,
						tls: {
							...tls,
							certPath: path.join(tlsDir, 'cert.pem'),
							keyPath: path.join(tlsDir, 'key.pem'),
						},
					};
				} else if (command === 'get-exchange') {
					response = { ok: true, exchange: runtime.getExchangeConfig() };
				} else if (command === 'delete') {
					await runtime.reloadScripts('daemonctl-delete-script-preload');
					const script = findScriptByName(runtime, payload.name);
					if (!script) {
						response = {
							ok: false,
							error: `script not found: ${payload.name || ''}`,
						};
					} else {
						await deleteScriptFromRuntime(runtime, script);
						response = {
							ok: true,
							script: script.name,
							path: script.path,
						};
					}
				} else if (command === 'stop') {
						response = { ok: true, message: 'shutdown requested' };
						shouldStop = true;
					} else {
					response = { ok: false, error: `unsupported command: ${command || 'empty'}` };
				}
			} catch (error) {
				response = { ok: false, error: error.message };
			}

			socket.end(`${JSON.stringify(response)}\n`);

			if (response && response.ok && shouldStop) {
					onStopRequested('DAEMONCTL_STOP').catch((error) => {
						console.error('[Reactor Daemon] Stop request failed:', error.message);
					});
				}
		});
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.off('error', reject);
			resolve();
		});
	});

	if (process.platform !== 'win32') {
		fsNative.chmodSync(socketPath, 0o660);
	}

	return server;
}

async function main() {
	const dataDir = process.env.REACTOR_DATA_DIR || getDefaultDataDir();
	const scriptsDir = process.env.REACTOR_SCRIPTS_DIR || path.join(dataDir, 'projects');
	const eventLogPath = process.env.REACTOR_EVENT_LOG_PATH || path.join(dataDir, 'activity.log');
	const daemonSocketPath = getDaemonSocketPath(dataDir);
	const workingModeConfigPath = path.join(dataDir, 'working-mode.json');

	await fs.mkdir(dataDir, { recursive: true });
	await fs.mkdir(scriptsDir, { recursive: true });
	await fs.mkdir(path.dirname(eventLogPath), { recursive: true });

	// Carica la configurazione exchange (env vars hanno priorità > file > default)
	async function loadExchangeConfig() {
		const envWorkingMode = String(process.env.REACTOR_WORKING_MODE || '').trim().toLowerCase();
		const normalizedWorkingMode = envWorkingMode === 'exchange' ? 'exchange' : envWorkingMode ? 'node' : '';

		// Env vars hanno la priorità massima
		if (normalizedWorkingMode) {
			return {
				mode: normalizedWorkingMode,
				host: process.env.REACTOR_EXCHANGE_HOST || '',
				port: Number(process.env.REACTOR_EXCHANGE_PORT) || 7070,
				tls: process.env.REACTOR_EXCHANGE_TLS === '1' || process.env.REACTOR_EXCHANGE_TLS === 'true',
				token: process.env.REACTOR_EXCHANGE_TOKEN || '',
			};
		}
		try {
			const parsed = await readWorkingModeConfig(workingModeConfigPath);
			return {
				mode: String(parsed.type || 'node'),
				host: String(parsed.host || ''),
				port: Number(parsed.port) > 0 ? Number(parsed.port) : 7070,
				tls: Boolean(parsed.tls),
				token: String(parsed.token || ''),
			};
		} catch {
			return { mode: 'node', host: '', port: 7070, tls: false, token: '' };
		}
	}

	async function saveExchangeConfig(mode, host, port, tls, token) {
		await fs.mkdir(dataDir, { recursive: true });
		await writeWorkingModeConfig(workingModeConfigPath, {
			type: mode,
			host,
			port,
			tls: Boolean(tls),
			token: String(token || ''),
		});
	}

	const exchangeCfg = await loadExchangeConfig();

	const runtime = new ReactorRuntime(scriptsDir, eventLogPath, {
		reactorRootDir: dataDir,
		exchangeMode: exchangeCfg.mode,
		exchangeHost: exchangeCfg.host,
		exchangePort: exchangeCfg.port,
		exchangeTls: exchangeCfg.tls,
		exchangeToken: exchangeCfg.token,
	});
	let controlServer = null;
	let isShuttingDown = false;

	const shutdown = async (signal) => {
		if (isShuttingDown) {
			return;
		}
		isShuttingDown = true;

		try {
			runtime.log(`Received ${signal}, shutting down daemon`);
			if (controlServer) {
				await new Promise((resolve) => controlServer.close(() => resolve()));
				controlServer = null;
			}

			if (process.platform !== 'win32') {
				try {
					await fs.unlink(daemonSocketPath);
				} catch (error) {
					if (error.code !== 'ENOENT') {
						runtime.log(`Failed to cleanup daemon socket: ${error.message}`);
					}
				}
			}

			runtime.cleanup();
		} finally {
			process.exit(0);
		}
	};

	process.on('SIGINT', () => {
		shutdown('SIGINT').catch((error) => {
			console.error('[Reactor Daemon] Shutdown error:', error.message);
			process.exit(1);
		});
	});

	process.on('SIGTERM', () => {
		shutdown('SIGTERM').catch((error) => {
			console.error('[Reactor Daemon] Shutdown error:', error.message);
			process.exit(1);
		});
	});

	process.on('uncaughtException', (error) => {
		console.error('[Reactor Daemon] Uncaught exception:', error.stack || error.message);
	});

	process.on('unhandledRejection', (reason) => {
		console.error('[Reactor Daemon] Unhandled rejection:', reason);
	});

	await runtime.init();
	controlServer = await createControlServer(runtime, daemonSocketPath, shutdown, saveExchangeConfig);
	runtime.log(`Daemon mode active (scriptsDir=${scriptsDir}, eventLogPath=${eventLogPath}, socket=${daemonSocketPath})`);
}

main().catch((error) => {
	console.error('[Reactor Daemon] Startup failed:', error.stack || error.message);
	process.exit(1);
});
