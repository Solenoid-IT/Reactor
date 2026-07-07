const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');

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

function getEnvFilePath() {
	return process.env.REACTOR_ENV_FILE || path.join(__dirname, '.env');
}

function getDataDir() {
	return process.env.REACTOR_DATA_DIR || getDefaultDataDir();
}

function getLocalCertDir() {
	return path.join(__dirname, 'cert');
}

function usage() {
	console.log('Usage:');
	console.log('  node daemonctl.js status');
	console.log('  node daemonctl.js generate-tls-cert [--bits <1024-8192>] [--days <1-36500>]');
	console.log('  node daemonctl.js generate-tls-cert --signed [--cn <primary-domain>] [--domain <domain>] [--webroot <path>] [--bits <1024-8192>]');
	console.log('  node daemonctl.js fix-tls-perms');
	process.exit(1);
}

function isRunningInsideDocker() {
	return fsSync.existsSync('/.dockerenv');
}


function scheduleContainerRestart() {
	if (!isRunningInsideDocker()) {
		return false;
	}

	// Delay restart so the CLI can return success after writing cert files.
	execFileSync(
		'sh',
		['-lc', '(sleep 1; kill -TERM 1) >/dev/null 2>&1 &'],
		{ stdio: 'ignore' },
	);

	return true;
}

function extractTlsCertFlags(args) {
	const values = [...args];
	let cn = 'exchange.local';
	let bits;
	let days;
	let signed = false;
	let webroot = '/var/www/html';
	const domains = [];

	for (let index = 0; index < values.length; index += 1) {
		const value = String(values[index] || '').trim();
		if (value === '--signed') {
			signed = true;
			values.splice(index, 1);
			index -= 1;
			continue;
		}
		if (value === '--cn') {
			cn = String(values[index + 1] || '').trim() || cn;
			values.splice(index, 2);
			index -= 1;
			continue;
		}
		if (value === '--domain') {
			const domain = String(values[index + 1] || '').trim();
			if (!domain) {
				usage();
			}
			domains.push(domain);
			values.splice(index, 2);
			index -= 1;
			continue;
		}
		if (value === '--webroot') {
			webroot = String(values[index + 1] || '').trim() || webroot;
			values.splice(index, 2);
			index -= 1;
			continue;
		}
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
			continue;
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

	if (signed && days !== undefined) {
		console.error('[daemonctl] generate-tls-cert: --days is only supported for self-signed certificates');
		process.exit(1);
	}

	if (signed && !webroot) {
		console.error('[daemonctl] generate-tls-cert: --webroot is required when --signed is used');
		process.exit(1);
	}

	return { cn, bits, days, signed, webroot, domains };
}

function normalizeDomains(cn, explicitDomains = []) {
	const all = [String(cn || '').trim(), ...explicitDomains.map((value) => String(value || '').trim())]
		.filter(Boolean)
		.map((value) => value.toLowerCase());

	return [...new Set(all)];
}

function runCertbotWebroot(domains, webroot, bits) {
	if (!Array.isArray(domains) || domains.length === 0) {
		throw new Error('at least one domain is required for --signed');
	}

	const certbotCmd = [
		'certbot',
		'certonly',
		'--webroot',
		'-w', webroot,
		'--rsa-key-size', String(Number.isInteger(bits) ? bits : 4096),
		'--non-interactive',
		'--agree-tos',
		'--register-unsafely-without-email',
		...domains.flatMap((domain) => ['-d', domain]),
	].join(' ');

	const shellCmd = `if [ "$(id -u)" -eq 0 ]; then ${certbotCmd}; else sudo ${certbotCmd}; fi`;

	try {
		execFileSync('sh', ['-lc', shellCmd], { stdio: 'inherit' });
	} catch (err) {
		const msg = err.stderr ? String(err.stderr).trim() : err.message;
		throw new Error(`certbot failed: ${msg}`);
	}
}

function shellEscape(value) {
	return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function installLetsEncryptCert(primaryDomain) {
	const liveDir = path.join('/etc/letsencrypt/live', primaryDomain);
	const fullchainPath = path.join(liveDir, 'fullchain.pem');
	const privkeyPath = path.join(liveDir, 'privkey.pem');
	const { tlsDir, certPath, keyPath } = getCertPaths();

	try {
		await fs.mkdir(tlsDir, { recursive: true });
		await Promise.all([
			fs.copyFile(fullchainPath, certPath),
			fs.copyFile(privkeyPath, keyPath),
		]);
		await ensureTlsPermissions({ tlsDir, certPath, keyPath });
		return;
	} catch (error) {
		if (!['EACCES', 'EPERM'].includes(error.code)) {
			throw error;
		}
	}

	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
	const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
	if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
		throw new Error('cannot resolve current uid/gid to install signed certificate');
	}

	const sudoInstallCmd = [
		'sudo', 'install', '-d', '-m', '700', '-o', String(uid), '-g', String(gid), shellEscape(tlsDir),
		'&&', 'sudo', 'install', '-m', '644', '-o', String(uid), '-g', String(gid), shellEscape(fullchainPath), shellEscape(certPath),
		'&&', 'sudo', 'install', '-m', '600', '-o', String(uid), '-g', String(gid), shellEscape(privkeyPath), shellEscape(keyPath),
	].join(' ');

	try {
		execFileSync('sh', ['-lc', sudoInstallCmd], { stdio: 'inherit' });
	} catch (error) {
		const msg = error.stderr ? String(error.stderr).trim() : error.message;
		throw new Error(`cannot install signed certificate files from /etc/letsencrypt: ${msg}`);
	}
}

function parseEnvFile(content) {
	const result = {};
	for (const rawLine of String(content || '').split(/\r?\n/)) {
		const line = String(rawLine || '').trim();
		if (!line || line.startsWith('#')) {
			continue;
		}

		const separatorIndex = line.indexOf('=');
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		if (!key) {
			continue;
		}

		let value = line.slice(separatorIndex + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
			value = value.slice(1, -1);
		}

		result[key] = value;
	}
	return result;
}

async function readEnvFile(filePath) {
	try {
		return parseEnvFile(await fs.readFile(filePath, 'utf8'));
	} catch {
		return {};
	}
}

function getConfiguredValue(env, ...keys) {
	for (const key of keys) {
		const value = String(env[key] || '').trim();
		if (value) {
			return value;
		}
	}
	return '';
}

function getPort(env) {
	const candidates = [
		getConfiguredValue(env, 'REACTOR_HTTP_PORT'),
		getConfiguredValue(env, 'REACTOR_EXCHANGE_PORT'),
		getConfiguredValue(env, 'PORT'),
	];

	for (const value of candidates) {
		const port = Number(value);
		if (Number.isInteger(port) && port > 0 && port < 65536) {
			return port;
		}
	}

	return 7070;
}

function getConnectHost(env) {
	const host = getConfiguredValue(env, 'REACTOR_HTTP_HOST', 'REACTOR_EXCHANGE_BIND_HOST', 'REACTOR_EXCHANGE_HOST', 'BIND_HOST');
	if (host === '0.0.0.0' || host === '::' || host === '::0') {
		return '127.0.0.1';
	}
	return host || '127.0.0.1';
}

function isTlsEnabled(env) {
	return ['1', 'true', 'yes', 'on'].includes(String(getConfiguredValue(env, 'REACTOR_EXCHANGE_TLS', 'TLS')).trim().toLowerCase());
}

function isTlsProxyMode(env) {
	if (['1', 'true', 'yes', 'on'].includes(String(getConfiguredValue(env, 'REACTOR_EXCHANGE_TLS_PROXY', 'TLS_PROXY')).trim().toLowerCase())) {
		return true;
	}

	const mode = String(getConfiguredValue(env, 'REACTOR_EXCHANGE_TLS_MODE', 'TLS_MODE')).trim().toLowerCase();
	return mode === 'proxy' || mode === 'offload';
}

function buildHealthUrl(env) {
	const protocol = isTlsEnabled(env) && !isTlsProxyMode(env) ? 'https' : 'http';
	return `${protocol}://${getConnectHost(env)}:${getPort(env)}/health`;
}

function getTlsDir() {
	const explicitTlsDir = String(process.env.REACTOR_TLS_DIR || '').trim();
	if (explicitTlsDir) {
		return explicitTlsDir;
	}

	if (String(process.env.REACTOR_DATA_DIR || '').trim()) {
		return path.join(getDataDir(), 'tls');
	}

	// Local CLI usage (outside Docker) keeps certs in exchange-server/cert.
	return getLocalCertDir();
}

function getCertPaths() {
	const tlsDir = getTlsDir();
	return {
		tlsDir,
		certPath: path.join(tlsDir, 'cert.pem'),
		keyPath: path.join(tlsDir, 'key.pem'),
	};
}

async function ensureTlsPermissions(paths) {
	const { tlsDir, certPath, keyPath } = paths || {};
	if (!tlsDir || !certPath || !keyPath) {
		throw new Error('TLS paths are required to set secure permissions');
	}

	// Restrictive default permissions for direct TLS usage.
	await Promise.all([
		fs.chmod(tlsDir, 0o700),
		fs.chmod(certPath, 0o644),
		fs.chmod(keyPath, 0o600),
	]);
}

function parseOpenSslCertInfo(output) {
	const info = { enabled: true };
	for (const line of String(output || '').split('\n')) {
		if (line.startsWith('subject=')) {
			info.subject = line.replace('subject=', '').trim();
		} else if (line.startsWith('notAfter=')) {
			info.notAfter = line.replace('notAfter=', '').trim();
		} else if (line.includes('Fingerprint=')) {
			info.fingerprint = line.split('=').slice(1).join('=').trim();
		}
	}
	return info;
}

async function getTlsCertInfo() {
	const { certPath, keyPath } = getCertPaths();
	try {
		await Promise.all([fs.access(certPath), fs.access(keyPath)]);
	} catch {
		return { enabled: false, certPath, keyPath };
	}

	try {
		const output = execFileSync(
			'openssl',
			['x509', '-in', certPath, '-noout', '-subject', '-enddate', '-fingerprint', '-sha256'],
			{ encoding: 'utf8', stdio: 'pipe' },
		);
		return {
			...parseOpenSslCertInfo(output),
			certPath,
			keyPath,
		};
	} catch {
		return { enabled: true, certPath, keyPath };
	}
}

function generateSelfSignedCert(reactorName, bits, days) {
	const { tlsDir, certPath, keyPath } = getCertPaths();
	const safeBits = Number.isInteger(Number(bits)) ? Number(bits) : 2048;
	const safeDays = Number.isInteger(Number(days)) ? Number(days) : 3650;
	const safeCN = String(reactorName || 'reactor').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'reactor';

	if (safeBits < 1024 || safeBits > 8192) {
		throw new Error('TLS key bits must be between 1024 and 8192');
	}
	if (safeDays < 1 || safeDays > 36500) {
		throw new Error('TLS certificate days must be between 1 and 36500');
	}

	return fs.mkdir(tlsDir, { recursive: true })
		.then(() => execFileSync(
			'openssl',
			[
				'req', '-x509',
				'-newkey', `rsa:${safeBits}`,
				'-keyout', keyPath,
				'-out', certPath,
				'-days', String(safeDays),
				'-nodes',
				'-subj', `/CN=${safeCN}`,
			],
			{ stdio: 'pipe' },
		))
		.then(() => ensureTlsPermissions({ tlsDir, certPath, keyPath }))
		.then(() => getTlsCertInfo())
		.then((info) => ({
			...info,
			bits: safeBits,
			days: safeDays,
		}));
}

function requestJson(url) {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const client = parsedUrl.protocol === 'https:' ? https : http;
		const request = client.request(
			parsedUrl,
			{
				method: 'GET',
				rejectUnauthorized: false,
				headers: {
					'cache-control': 'no-store',
				},
			},
			(response) => {
				let body = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => {
					body += chunk;
				});
				response.on('end', () => {
					try {
						resolve({
							statusCode: Number(response.statusCode || 0),
							body: body ? JSON.parse(body) : {},
						});
					} catch (error) {
						reject(new Error(`invalid JSON response: ${error.message}`));
					}
				});
			},
		);

		request.setTimeout(4000, () => request.destroy(new Error('request timeout')));
		request.on('error', reject);
		request.end();
	});
}

function formatInfo(exchange) {
	console.log(`Mode:   exchange`);
	console.log(`Host:   ${exchange.host || '-'}`);
	console.log(`Port:   ${exchange.port || 7070}`);
	console.log(`Active: ${exchange.active ? 'yes' : 'no'}`);
	console.log(`TLS:    ${exchange.tls ? 'on' : 'off'}`);
	if (exchange.connectionLogPath) {
		console.log(`ConnLog:${exchange.connectionLogPath}`);
	}
	if (exchange.activeConnectionsPath) {
		console.log(`ConnJSN:${exchange.activeConnectionsPath}`);
	}
	if (exchange.heartbeat) {
		console.log(`HB Int: ${exchange.heartbeat.intervalMs}ms`);
		console.log(`HB T/O: ${exchange.heartbeat.timeoutMs}ms`);
		if (exchange.heartbeat.server) {
			console.log(`HB Srv: pings=${exchange.heartbeat.server.pingsSent || 0}, pongs=${exchange.heartbeat.server.pongsReceived || 0}, terminated=${exchange.heartbeat.server.terminatedClients || 0}`);
		}
	}
	if (Array.isArray(exchange.connectedClients) && exchange.connectedClients.length > 0) {
		console.log(`Clients: ${exchange.connectedClients.join(', ')}`);
	}
	if (Array.isArray(exchange.connectedClientsDetails) && exchange.connectedClientsDetails.length > 0) {
		for (const detail of exchange.connectedClientsDetails) {
			const name = detail?.name || 'unknown';
			const address = detail?.address || '-';
			const since = detail?.connectedAt || '-';
			console.log(`Client : ${name} @ ${address} (since ${since})`);
		}
	}
}

async function readExchangeInfo() {
	const env = await readEnvFile(getEnvFilePath());
	const exchange = {
		host: getConfiguredValue(env, 'REACTOR_HTTP_HOST', 'REACTOR_EXCHANGE_BIND_HOST', 'REACTOR_EXCHANGE_HOST', 'BIND_HOST') || '0.0.0.0',
		port: getPort(env),
		connectionLogPath: path.join(getDataDir(), 'exchange-connections.log'),
		activeConnectionsPath: path.join(getDataDir(), 'exchange-active-connections.json'),
		active: false,
		tls: false,
		connectedClients: [],
		connectedClientsDetails: [],
		heartbeat: null,
	};

	try {
		const response = await requestJson(buildHealthUrl(env));
		const body = response.body || {};
		exchange.active = response.statusCode >= 200 && response.statusCode < 300 && Boolean(body.ok);
		exchange.tls = Boolean(body.tls);
		exchange.connectedClients = Array.isArray(body.connectedClients) ? body.connectedClients : [];
		exchange.connectedClientsDetails = Array.isArray(body.connectedClientsDetails) ? body.connectedClientsDetails : [];
		exchange.heartbeat = body.heartbeat || null;
		if (body.connectionLogPath) {
			exchange.connectionLogPath = body.connectionLogPath;
		}
		if (body.activeConnectionsPath) {
			exchange.activeConnectionsPath = body.activeConnectionsPath;
		}
	} catch (error) {
		exchange.error = error.message;
	}

	return exchange;
}

async function printStatus() {
	const exchange = await readExchangeInfo();
	formatInfo(exchange);
	if (!exchange.active && exchange.error) {
		console.log(`Health: ${exchange.error}`);
	}
}

async function handleGenerateTlsCert(rest) {
	const {
		cn,
		bits,
		days,
		signed,
		webroot,
		domains: explicitDomains,
	} = extractTlsCertFlags(rest);

	if (signed) {
		if (isRunningInsideDocker()) {
			throw new Error('generate-tls-cert --signed must run on the host (outside Docker). Run it from exchange-server/, then restart reactor-exchange.');
		}

		const domains = normalizeDomains(cn, explicitDomains);
		runCertbotWebroot(domains, webroot, bits);
		await installLetsEncryptCert(domains[0]);
		const tls = await getTlsCertInfo();
		scheduleContainerRestart();
		console.log('Signed TLS certificate generated');
		console.log(`cert.pem: ${tls.certPath || '-'}`);
		console.log(`key.pem:  ${tls.keyPath || '-'}`);
		console.log('Mode:    signed (Let\'s Encrypt)');
		console.log(`Domains: ${domains.join(', ')}`);
		if (tls.subject) console.log(`Subject: ${tls.subject}`);
		if (tls.notAfter) console.log(`NotAfter:${tls.notAfter}`);
		if (tls.fingerprint) console.log(`SHA256:  ${tls.fingerprint}`);
		return;
	}

	const reactorName = String(process.env.REACTOR_NAME || 'reactor').trim() || 'reactor';
	const tls = await generateSelfSignedCert(reactorName, bits, days);
	scheduleContainerRestart();
	console.log('Self-signed TLS certificate generated');
	console.log(`cert.pem: ${tls.certPath || '-'}`);
	console.log(`key.pem:  ${tls.keyPath || '-'}`);
	if (tls.bits) console.log(`Bits:    ${tls.bits}`);
	if (tls.days) console.log(`Days:    ${tls.days}`);
	if (tls.subject) console.log(`Subject: ${tls.subject}`);
	if (tls.notAfter) console.log(`NotAfter:${tls.notAfter}`);
	if (tls.fingerprint) console.log(`SHA256:  ${tls.fingerprint}`);
}

async function handleFixTlsPerms(rest) {
	if (rest.length > 0) {
		usage();
	}

	const tlsPaths = getCertPaths();
	await Promise.all([
		fs.access(tlsPaths.tlsDir),
		fs.access(tlsPaths.certPath),
		fs.access(tlsPaths.keyPath),
	]);

	await ensureTlsPermissions(tlsPaths);
	console.log('TLS permissions normalized');
	console.log(`dir:      ${tlsPaths.tlsDir} (700)`);
	console.log(`cert.pem: ${tlsPaths.certPath} (644)`);
	console.log(`key.pem:  ${tlsPaths.keyPath} (600)`);
}

async function main() {
	const [, , command, ...rest] = process.argv;
	if (!command) {
		usage();
	}

	if (command === 'status') {
		await printStatus();
		return;
	}

	if (command === 'generate-tls-cert') {
		await handleGenerateTlsCert(rest);
		return;
	}

	if (command === 'fix-tls-perms') {
		await handleFixTlsPerms(rest);
		return;
	}

	usage();
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`[daemonctl] ${error.stack || error.message}`);
		process.exit(1);
	});
}

module.exports = {
	getEnvFilePath,
	getDataDir,
	readExchangeInfo,
};
