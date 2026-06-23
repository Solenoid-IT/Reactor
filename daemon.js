const fs = require('fs/promises');
const fsNative = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { ReactorRuntime } = require('./src/runtime');

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

async function createControlServer(runtime, socketPath, onStopRequested) {
	if (process.platform !== 'win32') {
		try {
			await fs.unlink(socketPath);
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
	}

	const server = net.createServer((socket) => {
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

	await fs.mkdir(dataDir, { recursive: true });
	await fs.mkdir(scriptsDir, { recursive: true });
	await fs.mkdir(path.dirname(eventLogPath), { recursive: true });

	const runtime = new ReactorRuntime(scriptsDir, eventLogPath);
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
	controlServer = await createControlServer(runtime, daemonSocketPath, shutdown);
	runtime.log(`Daemon mode active (scriptsDir=${scriptsDir}, eventLogPath=${eventLogPath}, socket=${daemonSocketPath})`);
}

main().catch((error) => {
	console.error('[Reactor Daemon] Startup failed:', error.stack || error.message);
	process.exit(1);
});
