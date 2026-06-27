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
	console.log('  node daemonctl.js delete <script-name>');
	console.log('  node daemonctl.js set-name <reactor-name>');
	console.log('  node daemonctl.js set-port <1-65535>');
	console.log('  node daemonctl.js stop');
	process.exit(1);
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
			console.log(`${script.name}\t${script.state}\t${script.path}`);
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

	usage();
}

main().catch((error) => {
	console.error(`[daemonctl] ${error.message}`);
	process.exit(1);
});
