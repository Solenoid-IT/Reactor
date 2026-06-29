const net = require('net');
const os = require('os');
const path = require('path');

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

function getDaemonSocketPath() {
	const dataDir = process.env.REACTOR_DATA_DIR || getDefaultDataDir();
	return process.env.REACTOR_DAEMON_SOCKET || path.join(dataDir, 'reactor-daemon.sock');
}

function usage() {
	console.log('Usage:');
	console.log('  node daemonctl.js list');
	console.log('  node daemonctl.js status');
	console.log('  node daemonctl.js run <script-name>');
	console.log('  node daemonctl.js test <script-name>');
	console.log('  node daemonctl.js script-id <script-name>');
	console.log('  node daemonctl.js delete <script-name>');
	console.log('  node daemonctl.js set-name <reactor-name>');
	console.log('  node daemonctl.js set-port <1-65535>');
	console.log('  node daemonctl.js set-exchange exchange [port] [--tls] [--token <token>] [--discovery|--no-discovery]');
	console.log('  node daemonctl.js set-exchange node <host> [port] [--tls] [--token <token>] [--discovery|--no-discovery]');
	console.log('  node daemonctl.js set-discovery <on|off>');
	console.log('  node daemonctl.js get-exchange');
	console.log('  node daemonctl.js get-exchange-token');
	console.log('  node daemonctl.js generate-exchange-token');
	console.log('  node daemonctl.js generate-tls-cert [--bits <1024-8192>] [--days <1-36500>]');
	console.log('  node daemonctl.js stop');
	process.exit(1);
}

function extractTlsCertFlags(args) {
	const values = [...args];
	let bits;
	let days;

	for (let index = 0; index < values.length; index += 1) {
		const value = String(values[index] || '').trim();
		if (value === '--bits') {
			bits = Number(values[index + 1]);
			values.splice(index, 2);
			index -= 1;
			continue;
		}
		if (value === '--days') {
			days = Number(values[index + 1]);
			values.splice(index, 2);
			index -= 1;
		}
	}

	if (values.length > 0) {
		usage();
	}

	if (bits !== undefined && (!Number.isInteger(bits) || bits < 1024 || bits > 8192)) {
		console.error('[daemonctl] generate-tls-cert: --bits must be an integer between 1024 and 8192');
		process.exit(1);
	}

	if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 36500)) {
		console.error('[daemonctl] generate-tls-cert: --days must be an integer between 1 and 36500');
		process.exit(1);
	}

	return { bits, days };
}

function extractExchangeFlags(args) {
	const values = [...args];
	let tls = false;
	let token = '';
	let discovery;

	for (let index = 0; index < values.length; index += 1) {
		const value = String(values[index] || '').trim();
		if (value === '--tls') {
			tls = true;
			values.splice(index, 1);
			index -= 1;
			continue;
		}
		if (value === '--token') {
			token = String(values[index + 1] || '').trim();
			values.splice(index, 2);
			index -= 1;
			continue;
		}
		if (value === '--discovery') {
			discovery = true;
			values.splice(index, 1);
			index -= 1;
			continue;
		}
		if (value === '--no-discovery') {
			discovery = false;
			values.splice(index, 1);
			index -= 1;
			continue;
		}
		if (value === '--enable-discovery') {
			discovery = true;
			values.splice(index, 1);
			index -= 1;
			continue;
		}
		if (value === '--disable-discovery') {
			discovery = false;
			values.splice(index, 1);
			index -= 1;
			continue;
		}
		if (value === '--expose-discovery') {
			discovery = true;
			values.splice(index, 1);
			index -= 1;
			continue;
		}
		if (value === '--hide-discovery') {
			discovery = false;
			values.splice(index, 1);
			index -= 1;
		}
	}

	return { args: values, tls, token, discovery };
}

async function sendCommand(payload) {
	const socketPath = getDaemonSocketPath();

	return new Promise((resolve, reject) => {
		const client = net.createConnection(socketPath);
		let output = '';

		client.on('connect', () => {
			client.end(`${JSON.stringify(payload)}\n`);
		});

		client.on('data', (chunk) => {
			output += chunk.toString('utf8');
		});

		client.on('end', () => {
			try {
				resolve(JSON.parse(output || '{}'));
			} catch (error) {
				reject(new Error(`invalid daemon response: ${error.message}`));
			}
		});

		client.on('error', (error) => {
			reject(new Error(`cannot connect to daemon socket (${socketPath}): ${error.message}`));
		});
	});
}

async function main() {
	const [, , command, ...rest] = process.argv;
	if (!command) {
		usage();
	}

	if (command === 'list') {
		const response = await sendCommand({ command: 'list' });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'list failed'}`);
			process.exit(1);
		}

		for (const script of response.scripts || []) {
			console.log(`${script.name}\t${script.state}\t${script.scriptId || '-'}\t${script.path}`);
		}
		return;
	}

	if (command === 'status') {
		const response = await sendCommand({ command: 'status' });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'status failed'}`);
			process.exit(1);
		}

		console.log(`PID: ${response.pid}`);
		console.log(`Uptime(s): ${response.uptimeSec}`);
		console.log(`Loaded scripts: ${response.scriptsCount}`);
		return;
	}

	if (command === 'run' || command === 'test') {
		const name = rest.join(' ').trim();
		if (!name) {
			usage();
		}

		const response = await sendCommand({ command: 'run', name });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'run failed'}`);
			process.exit(1);
		}

		console.log(`Executed: ${response.script} (${response.path})`);
		return;
	}

	if (command === 'script-id') {
		const name = rest.join(' ').trim();
		if (!name) {
			usage();
		}

		const response = await sendCommand({ command: 'script-id', name });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'script-id failed'}`);
			process.exit(1);
		}

		console.log(response.scriptId || '');
		return;
	}

	if (command === 'delete') {
		const name = rest.join(' ').trim();
		if (!name) {
			usage();
		}

		const response = await sendCommand({ command: 'delete', name });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'delete failed'}`);
			process.exit(1);
		}

		console.log(`Deleted: ${response.script} (${response.path})`);
		return;
	}

	if (command === 'set-name') {
		const name = rest.join(' ').trim();
		if (!name) {
			usage();
		}

		const response = await sendCommand({ command: 'set-name', name });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'set-name failed'}`);
			process.exit(1);
		}

		console.log(`Reactor name set: ${response.name}`);
		return;
	}

	if (command === 'set-port') {
		const rawPort = String(rest[0] || '').trim();
		const port = Number(rawPort);
		if (!rawPort || !Number.isFinite(port) || port < 1 || port > 65535) {
			usage();
		}

		const response = await sendCommand({ command: 'set-port', port });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'set-port failed'}`);
			process.exit(1);
		}

		console.log(`HTTP port set: ${response.port}`);
		return;
	}

	if (command === 'stop') {
		const response = await sendCommand({ command: 'stop' });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'stop failed'}`);
			process.exit(1);
		}

		console.log(response.message || 'Shutdown requested');
		return;
	}

	if (command === 'get-exchange') {
		const response = await sendCommand({ command: 'get-exchange' });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'get-exchange failed'}`);
			process.exit(1);
		}
		const ex = response.exchange || {};
		console.log(`Mode:   ${ex.mode || 'disabled'}`);
		console.log(`Host:   ${ex.host || '-'}`);
		console.log(`Port:   ${ex.port || 7070}`);
		console.log(`TLS:    ${ex.tls ? 'yes' : 'no'}`);
		console.log(`Discovery:  ${ex.discovery ? 'enabled' : 'disabled'}`);
		if (ex.discoveryEndpointPath) {
			console.log(`NodesEP:${ex.discoveryEndpointPath}`);
		}
		console.log(`Active: ${ex.active ? 'yes' : 'no'}`);
		console.log(`Token:  ${ex.token ? 'configured' : 'missing'}`);
		if (ex.connectionLogPath) {
			console.log(`ConnLog:${ex.connectionLogPath}`);
		}
		if (ex.activeConnectionsPath) {
			console.log(`ConnJSN:${ex.activeConnectionsPath}`);
		}
		if (ex.heartbeat) {
			console.log(`HB Int: ${ex.heartbeat.intervalMs}ms`);
			console.log(`HB T/O: ${ex.heartbeat.timeoutMs}ms`);
			if (ex.heartbeat.server) {
				console.log(`HB Srv: pings=${ex.heartbeat.server.pingsSent || 0}, pongs=${ex.heartbeat.server.pongsReceived || 0}, terminated=${ex.heartbeat.server.terminatedClients || 0}`);
			}
			if (ex.heartbeat.client) {
				const lastPong = ex.heartbeat.client.lastPongAt || '-';
				const sincePong = ex.heartbeat.client.timeSinceLastPongMs;
				console.log(`HB Cli: lastPong=${lastPong}${Number.isFinite(sincePong) ? ` (${sincePong}ms ago)` : ''}`);
			}
		}
		if (Array.isArray(ex.connectedClients) && ex.connectedClients.length > 0) {
			console.log(`Clients: ${ex.connectedClients.join(', ')}`);
		}
		if (Array.isArray(ex.connectedClientsDetails) && ex.connectedClientsDetails.length > 0) {
			for (const detail of ex.connectedClientsDetails) {
				const name = detail?.name || 'unknown';
				const address = detail?.address || '-';
				const since = detail?.connectedAt || '-';
				console.log(`Client : ${name} @ ${address} (since ${since})`);
			}
		}
		return;
	}

	if (command === 'get-exchange-token') {
		const response = await sendCommand({ command: 'get-exchange-token' });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'get-exchange-token failed'}`);
			process.exit(1);
		}
		const token = response.exchangeToken || {};
		console.log(`Path:   ${token.path || '-'}`);
		console.log(`Exists: ${token.exists ? 'yes' : 'no'}`);
		console.log(`Token:  ${token.token || ''}`);
		return;
	}

	if (command === 'generate-exchange-token') {
		const response = await sendCommand({ command: 'generate-exchange-token' });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'generate-exchange-token failed'}`);
			process.exit(1);
		}
		const token = response.exchangeToken || {};
		console.log(`Generated token at: ${token.path || '-'}`);
		console.log(token.token || '');
		return;
	}

	if (command === 'generate-tls-cert') {
		const { bits, days } = extractTlsCertFlags(rest);
		const response = await sendCommand({ command: 'generate-tls-cert', bits, days });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'generate-tls-cert failed'}`);
			process.exit(1);
		}
		const tls = response.tls || {};
		console.log('Self-signed TLS certificate generated');
		console.log(`cert.pem: ${tls.certPath || '-'}`);
		console.log(`key.pem:  ${tls.keyPath || '-'}`);
		if (tls.bits) console.log(`Bits:    ${tls.bits}`);
		if (tls.days) console.log(`Days:    ${tls.days}`);
		if (tls.subject) console.log(`Subject: ${tls.subject}`);
		if (tls.notAfter) console.log(`NotAfter:${tls.notAfter}`);
		if (tls.fingerprint) console.log(`SHA256:  ${tls.fingerprint}`);
		return;
	}

	if (command === 'set-exchange') {
		const parsed = extractExchangeFlags(rest);
		const mode = String(parsed.args[0] || '').trim().toLowerCase();
		if (!['node', 'exchange'].includes(mode)) {
			console.error('[daemonctl] set-exchange: mode must be node or exchange');
			usage();
		}

		let host = '';
		let port = 7070;

		if (mode === 'exchange') {
			// set-exchange exchange [port]
			if (parsed.args[1]) {
				port = Number(parsed.args[1]);
				if (!Number.isFinite(port) || port < 1 || port > 65535) {
					console.error('[daemonctl] set-exchange: invalid port');
					process.exit(1);
				}
			}
		} else if (mode === 'node') {
			// set-exchange node <host[:port]>  OR  <host> <port>
			const hostArg = String(parsed.args[1] || '').trim();
			if (!hostArg) {
				console.error('[daemonctl] set-exchange node: host is required');
				usage();
			}
			if (hostArg.includes(':')) {
				const parts = hostArg.split(':');
				host = parts[0];
				port = Number(parts[1]);
			} else {
				host = hostArg;
				port = parsed.args[2] ? Number(parsed.args[2]) : 7070;
			}
			if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
				console.error('[daemonctl] set-exchange node: invalid host or port');
				process.exit(1);
			}
		}

		const payload = { command: 'set-exchange', mode, host, port, tls: parsed.tls, token: parsed.token };
		if (parsed.discovery !== undefined) {
			payload.discovery = parsed.discovery;
		}
		const response = await sendCommand(payload);
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'set-exchange failed'}`);
			process.exit(1);
		}
		const ex = response.exchange || {};
		console.log(`Exchange mode set: ${ex.mode}`);
		if (ex.mode === 'node') console.log(`Exchange: ${ex.tls ? 'wss' : 'ws'}://${ex.host}:${ex.port}`);
		if (ex.mode === 'exchange') console.log(`Exchange server active on port: ${ex.port}`);
		console.log(`TLS: ${ex.tls ? 'enabled' : 'disabled'}`);
		console.log(`Discovery: ${ex.discovery ? 'enabled' : 'disabled'}${ex.discoveryEndpointPath ? ` (${ex.discoveryEndpointPath})` : ''}`);
		if (ex.token) console.log('Token: configured');
		return;
	}

	if (command === 'set-discovery' || command === 'set-exchange-discovery') {
		const rawValue = String(rest[0] || '').trim().toLowerCase();
		if (!['on', 'off', 'true', 'false', '1', '0'].includes(rawValue)) {
			console.error('[daemonctl] set-discovery: value must be on|off');
			usage();
		}

		const enabled = ['on', 'true', '1'].includes(rawValue);
		const response = await sendCommand({ command: 'set-discovery', enabled });
		if (!response.ok) {
			console.error(`[daemonctl] ${response.error || 'set-discovery failed'}`);
			process.exit(1);
		}

		const ex = response.exchange || {};
		console.log(`Discovery: ${ex.discovery ? 'enabled' : 'disabled'}${ex.discoveryEndpointPath ? ` (${ex.discoveryEndpointPath})` : ''}`);
		return;
	}

	usage();
}

main().catch((error) => {
	console.error(`[daemonctl] ${error.message}`);
	process.exit(1);
});
