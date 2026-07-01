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

function buildEndpointAliases(endpoint) {
	const aliases = new Set();
	const add = (value) => {
		if (!value) {
			return;
		}
		aliases.add(String(value).trim().toLowerCase());
	};

	add(endpoint.name);
	add(endpoint.name.replace(/\.(ts|js)$/i, ''));

	const baseName = path.basename(endpoint.path);
	add(baseName);
	add(baseName.replace(/\.(ts|js)$/i, ''));

	if (baseName.toLowerCase() === 'boot.ts') {
		add(path.basename(path.dirname(endpoint.path)));
	}

	return aliases;
}

function findEndpointByName(runtime, requestedName) {
	const target = String(requestedName || '').trim().toLowerCase();
	if (!target) {
		return null;
	}

	for (const endpoint of runtime.endpoints) {
		const aliases = buildEndpointAliases(endpoint);
		if (aliases.has(target)) {
			return endpoint;
		}
	}

	return null;
}

async function deleteEndpointFromRuntime(runtime, endpoint) {
	const allowedPath = path.resolve(runtime.endpointsDir);
	const normalizedFilePath = path.resolve(endpoint.path);
	if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
		throw new Error('path not allowed');
	}

	const endpointDir = path.dirname(normalizedFilePath);
	const isBootProjectEndpoint = path.basename(normalizedFilePath).toLowerCase() === 'boot.ts' && endpointDir !== allowedPath;

	let isProjectFolder = false;
	if (isBootProjectEndpoint && path.resolve(endpointDir).startsWith(allowedPath + path.sep)) {
		try {
			await fs.access(path.join(endpointDir, 'package.json'));
			isProjectFolder = true;
		} catch {
			isProjectFolder = false;
		}
	}

	if (isProjectFolder) {
		const packageJsonPath = path.join(endpointDir, 'package.json');
		try {
			await fs.access(packageJsonPath);
			await fs.rm(endpointDir, { recursive: true, force: true });
		} catch {
			await fs.unlink(normalizedFilePath);
		}
	} else {
		await fs.unlink(normalizedFilePath);
	}

	await runtime.reloadEndpoints('daemonctl-delete-endpoint');
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
						endpoints: runtime.endpoints.map((endpoint) => ({
							name: endpoint.name,
							path: endpoint.path,
							uuid: endpoint.uuid || null,
							state: endpoint.state,
						})),
					};
					} else if (command === 'status') {
						response = {
							ok: true,
							pid: process.pid,
							uptimeSec: Math.floor(process.uptime()),
							endpointsCount: runtime.endpoints.length,
						};
				} else if (command === 'run') {
					await runtime.reloadEndpoints('daemonctl-run-endpoint');
					const endpoint = findEndpointByName(runtime, payload.name);
					if (!endpoint) {
						response = {
							ok: false,
							error: `endpoint not found: ${payload.name || ''}`,
						};
					} else {
						await runtime.runEndpoint(endpoint, {
							trigger: 'MANUAL_CLI',
							event: 'ON_DEMAND',
							force: true,
						});
						response = {
							ok: true,
							endpoint: endpoint.name,
							path: endpoint.path,
						};
					}
				} else if (command === 'endpoint-id') {
					await runtime.reloadEndpoints('daemonctl-endpoint-id');
					const endpoint = findEndpointByName(runtime, payload.name);
					if (!endpoint) {
						response = {
							ok: false,
							error: `endpoint not found: ${payload.name || ''}`,
						};
					} else if (!endpoint.uuid) {
						response = {
							ok: false,
							error: `endpoint has no project UUID: ${endpoint.name}`,
						};
					} else {
						response = {
							ok: true,
							endpoint: endpoint.name,
							path: endpoint.path,
							uuid: endpoint.uuid,
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
					const discovery = Object.prototype.hasOwnProperty.call(payload, 'discovery')
						? Boolean(payload.discovery)
						: Object.prototype.hasOwnProperty.call(payload, 'exposeDiscoveryEndpoint')
						? Boolean(payload.exposeDiscoveryEndpoint)
						: runtime.exchangeDiscoveryEndpointEnabled;
					if (!['node', 'exchange'].includes(mode)) {
						response = { ok: false, error: 'invalid mode: use node or exchange' };
					} else {
						const config = await runtime.setExchangeConfig(mode, host, port, tls, token, discovery);
						await saveExchangeConfig(mode, host, port, tls, token, discovery);
						response = { ok: true, exchange: config };
					}
				} else if (command === 'set-discovery' || command === 'set-exchange-discovery') {
					const enabled = Boolean(payload.enabled);
					const config = await runtime.setExchangeConfig(
						runtime.exchangeMode,
						runtime.exchangeHost,
						runtime.exchangePort,
						runtime.exchangeTls,
						runtime.exchangeAuthToken,
						enabled,
					);
					await saveExchangeConfig(runtime.exchangeMode, runtime.exchangeHost, runtime.exchangePort, runtime.exchangeTls, runtime.exchangeAuthToken, enabled);
					response = { ok: true, exchange: config };
				} else if (command === 'get-exchange-token') {
					response = { ok: true, exchangeToken: await runtime.getExchangeToken() };
				} else if (command === 'generate-exchange-token') {
					const exchangeToken = await runtime.generateExchangeToken();
					await saveExchangeConfig(runtime.exchangeMode, runtime.exchangeHost, runtime.exchangePort, runtime.exchangeManager.tls, exchangeToken.token, runtime.exchangeDiscoveryEndpointEnabled);
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
					await runtime.reloadEndpoints('daemonctl-delete-endpoint-preload');
					const endpoint = findEndpointByName(runtime, payload.name);
					if (!endpoint) {
						response = {
							ok: false,
							error: `endpoint not found: ${payload.name || ''}`,
						};
					} else {
						await deleteEndpointFromRuntime(runtime, endpoint);
						response = {
							ok: true,
							endpoint: endpoint.name,
							path: endpoint.path,
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
	const endpointsDir = process.env.REACTOR_ENDPOINTS_DIR || path.join(dataDir, 'endpoints');
	const eventLogPath = process.env.REACTOR_EVENT_LOG_PATH || path.join(dataDir, 'activity.log');
	const daemonSocketPath = getDaemonSocketPath(dataDir);
	const workingModeConfigPath = path.join(dataDir, 'working-mode.json');

	await fs.mkdir(dataDir, { recursive: true });
	await fs.mkdir(endpointsDir, { recursive: true });
	await fs.mkdir(path.dirname(eventLogPath), { recursive: true });

	// Carica la configurazione exchange (env vars hanno priorità > file > default)
	async function loadExchangeConfig() {
		const readEnvString = (name) => {
			if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
				return null;
			}
			const value = String(process.env[name] || '').trim();
			return value.length > 0 ? value : null;
		};

		const readEnvBool = (name) => {
			if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
				return null;
			}

			const value = String(process.env[name] || '').trim().toLowerCase();
			if (!value) {
				return null;
			}

			if (['1', 'true', 'yes', 'on', 'enabled'].includes(value)) {
				return true;
			}
			if (['0', 'false', 'no', 'off', 'disabled'].includes(value)) {
				return false;
			}

			return null;
		};

		const readEnvPort = (name) => {
			const value = readEnvString(name);
			if (!value) {
				return null;
			}

			const numericPort = Number(value);
			if (!Number.isFinite(numericPort) || numericPort < 1 || numericPort > 65535) {
				return null;
			}

			return numericPort;
		};

		const fileConfig = await readWorkingModeConfig(workingModeConfigPath);
		const envWorkingMode = String(process.env.REACTOR_WORKING_MODE || '').trim().toLowerCase();
		const normalizedWorkingMode = envWorkingMode === 'exchange' ? 'exchange' : envWorkingMode ? 'node' : '';

		return {
			mode: normalizedWorkingMode || String(fileConfig.type || 'node'),
			host: readEnvString('REACTOR_EXCHANGE_HOST') ?? String(fileConfig.host || ''),
			port: readEnvPort('REACTOR_EXCHANGE_PORT') ?? (Number(fileConfig.port) > 0 ? Number(fileConfig.port) : 7070),
			tls: readEnvBool('REACTOR_EXCHANGE_TLS') ?? Boolean(fileConfig.tls),
			token: readEnvString('REACTOR_EXCHANGE_TOKEN') ?? String(fileConfig.token || ''),
			discovery: readEnvBool('REACTOR_EXCHANGE_DISCOVERY_ENDPOINT') ?? Boolean(fileConfig.discovery),
		};
	}

	async function saveExchangeConfig(mode, host, port, tls, token, discovery = false) {
		await fs.mkdir(dataDir, { recursive: true });
		await writeWorkingModeConfig(workingModeConfigPath, {
			type: mode,
			host,
			port,
			tls: Boolean(tls),
			token: String(token || ''),
			discovery: Boolean(discovery),
		});
	}

	const exchangeCfg = await loadExchangeConfig();

	const runtime = new ReactorRuntime(endpointsDir, eventLogPath, {
		reactorRootDir: dataDir,
		exchangeMode: exchangeCfg.mode,
		exchangeHost: exchangeCfg.host,
		exchangePort: exchangeCfg.port,
		exchangeTls: exchangeCfg.tls,
		exchangeToken: exchangeCfg.token,
				discovery: exchangeCfg.discovery,
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
	runtime.log(`Daemon mode active (endpointsDir=${endpointsDir}, eventLogPath=${eventLogPath}, socket=${daemonSocketPath})`);
}

main().catch((error) => {
	console.error('[Reactor Daemon] Startup failed:', error.stack || error.message);
	process.exit(1);
});
