const path = require('path');
const { execFileSync } = require('child_process');
const fsSync = require('fs');
const { TlsManager } = require('./src/tlsManager');

function usage() {
	console.log('Usage:');
	console.log('  node coturnctl.js generate-tls-cert [--cn <name>] [--bits <1024-8192>] [--days <1-36500>]');
	console.log('  node coturnctl.js fix-tls-perms');
	process.exit(1);
}

function isRunningInsideDocker() {
	return fsSync.existsSync('/.dockerenv');
}

function scheduleContainerRestart() {
	if (!isRunningInsideDocker()) {
		try {
			execFileSync(
				'sh',
				['-lc', 'docker compose restart coturn >/dev/null 2>&1 || docker-compose restart coturn >/dev/null 2>&1'],
				{ cwd: __dirname, stdio: 'ignore' },
			);
			return true;
		} catch {
			return false;
		}
	}

	execFileSync(
		'sh',
		['-lc', '(sleep 1; kill -TERM 1) >/dev/null 2>&1 &'],
		{ stdio: 'ignore' },
	);

	return true;
}

function extractGenerateCertArgs(args) {
	const values = [...args];
	let cn = 'turn.local';
	let bits;
	let days;

	for (let index = 0; index < values.length; index += 1) {
		const value = String(values[index] || '').trim();
		if (value === '--cn') {
			cn = String(values[index + 1] || '').trim() || cn;
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
		}
	}

	if (values.length > 0) {
		usage();
	}

	if (bits !== undefined && (!Number.isInteger(bits) || bits < 1024 || bits > 8192)) {
		console.error('[coturnctl] generate-tls-cert: --bits must be an integer between 1024 and 8192');
		process.exit(1);
	}

	if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 36500)) {
		console.error('[coturnctl] generate-tls-cert: --days must be an integer between 1 and 36500');
		process.exit(1);
	}

	return { cn, bits, days };
}

async function main() {
	const [, , command, ...rest] = process.argv;
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		usage();
	}

	const certDir = path.join(__dirname, 'cert');
	const tlsManager = new TlsManager(certDir);

	if (command === 'generate-tls-cert') {
		const { cn, bits, days } = extractGenerateCertArgs(rest);
		const result = await tlsManager.generateCert(cn, { bits, days });
		console.log(`cert.pem: ${path.join(certDir, 'cert.pem')}`);
		console.log(`key.pem:  ${path.join(certDir, 'key.pem')}`);
		console.log(`subject:  ${result.subject || '-'}`);
		console.log(`notAfter: ${result.notAfter || '-'}`);
		scheduleContainerRestart();
		return;
	}

	if (command === 'fix-tls-perms') {
		if (rest.length > 0) {
			usage();
		}

		await tlsManager.fixPermissions();
		console.log('TLS permissions normalized');
		console.log(`dir:      ${certDir} (700)`);
		console.log(`cert.pem: ${path.join(certDir, 'cert.pem')} (644)`);
		console.log(`key.pem:  ${path.join(certDir, 'key.pem')} (600)`);
		return;
	}

	usage();
}

main().catch((error) => {
	console.error(`[coturnctl] ${error.message}`);
	process.exit(1);
});
