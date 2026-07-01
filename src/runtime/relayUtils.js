const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns');
const net = require('net');
const tls = require('tls');

function parseBooleanOption(rawValue, fallback = false) {
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return Boolean(fallback);
	}

	if (typeof rawValue === 'boolean') {
		return rawValue;
	}

	const normalized = String(rawValue).trim().toLowerCase();
	if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
		return true;
	}
	if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
		return false;
	}

	return Boolean(fallback);
}

function normalizeRelayHost(rawHost) {
	let value = String(rawHost || '').trim();
	if (!value) {
		return '';
	}

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		try {
			const parsed = new URL(value);
			return String(parsed.hostname || '').trim();
		} catch {
			// Fallback below.
		}
	}

	value = value.replace(/^(stun|stuns|turn|turns):/i, '');
	value = value.replace(/^\/\//, '');
	if (value.includes('/')) {
		value = value.split('/')[0];
	}

	if (value.startsWith('[') && value.includes(']')) {
		return value.slice(1, value.indexOf(']')).trim();
	}

	const colonCount = (value.match(/:/g) || []).length;
	if (colonCount === 1) {
		const [candidateHost, candidatePort] = value.split(':');
		if (/^\d+$/.test(String(candidatePort || '').trim())) {
			return String(candidateHost || '').trim();
		}
	}

	return value.trim();
}

function normalizeRelayEndpointConfig(rawValue, fallback = { host: '', port: 3478, tls: false, username: '', password: '' }) {
	const value = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
	const fallbackValue = fallback && typeof fallback === 'object' ? fallback : { host: '', port: 3478, tls: false, username: '', password: '' };
	const host = normalizeRelayHost(value.host ?? value.server ?? fallbackValue.host ?? '');
	const rawPort = value.port ?? fallbackValue.port;
	const port = Number(rawPort) > 0 ? Number(rawPort) : 3478;
	const tlsEnabled = parseBooleanOption(value.tls, fallbackValue.tls);
	const username = String(value.username ?? value.user ?? fallbackValue.username ?? '').trim();
	const password = String(value.password ?? fallbackValue.password ?? '').trim();

	return {
		host,
		port,
		tls: tlsEnabled,
		username,
		password,
	};
}

async function resolveRelayHostAddresses(host) {
	const safeHost = normalizeRelayHost(host);
	if (!safeHost) {
		return [];
	}

	if (net.isIP(safeHost)) {
		return [{ address: safeHost, family: net.isIP(safeHost) }];
	}

	try {
		const lookupResults = await dns.promises.lookup(safeHost, { all: true, verbatim: false });
		if (Array.isArray(lookupResults) && lookupResults.length > 0) {
			return lookupResults;
		}
	} catch {
		// Resolve fallback below.
	}

	const resolved = [];
	try {
		const ipv4 = await dns.promises.resolve4(safeHost);
		for (const address of ipv4) {
			resolved.push({ address, family: 4 });
		}
	} catch {
		// ignore
	}

	try {
		const ipv6 = await dns.promises.resolve6(safeHost);
		for (const address of ipv6) {
			resolved.push({ address, family: 6 });
		}
	} catch {
		// ignore
	}

	return resolved;
}

function testUdpStunBindingWithAddress(address, family, port, timeoutMs = 5000) {
	return new Promise((resolve) => {
		const safeAddress = String(address || '').trim();
		const safeFamily = Number(family) === 6 ? 6 : 4;
		const safePort = Number(port);
		if (!safeAddress || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
			resolve({ ok: false, error: 'invalid address or port' });
			return;
		}

		const socket = dgram.createSocket(safeFamily === 6 ? 'udp6' : 'udp4');
		const transactionId = crypto.randomBytes(12);
		const request = Buffer.alloc(20);
		request.writeUInt16BE(0x0001, 0);
		request.writeUInt16BE(0x0000, 2);
		request.writeUInt32BE(0x2112A442, 4);
		transactionId.copy(request, 8);

		let finished = false;
		const finish = (result) => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {
				// ignore
			}
			resolve(result);
		};

		socket.once('error', (error) => {
			finish({ ok: false, error: error.message || 'udp error' });
		});

		socket.on('message', (message) => {
			if (!Buffer.isBuffer(message) || message.length < 20) {
				return;
			}

			const cookie = message.readUInt32BE(4);
			const responseTxId = message.subarray(8, 20);
			if (cookie !== 0x2112A442) {
				return;
			}
			if (!responseTxId.equals(transactionId)) {
				return;
			}

			finish({ ok: true, protocol: 'udp', message: 'STUN response received' });
		});

		socket.send(request, safePort, safeAddress, (error) => {
			if (error) {
				finish({ ok: false, error: error.message || 'unable to send STUN request' });
			}
		});

		const timer = setTimeout(() => {
			finish({ ok: false, error: 'timeout waiting STUN response' });
		}, Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000);
	});
}

async function testUdpStunBinding(host, port, timeoutMs = 5000) {
	const safeHost = normalizeRelayHost(host);
	const safePort = Number(port);
	if (!safeHost || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
		return { ok: false, error: 'invalid host or port' };
	}

	const addresses = await resolveRelayHostAddresses(safeHost);
	if (!addresses.length) {
		return { ok: false, error: `unable to resolve host '${safeHost}'` };
	}

	const sorted = [...addresses].sort((a, b) => Number(a.family || 4) - Number(b.family || 4));
	const errors = [];
	for (const candidate of sorted) {
		const attempt = await testUdpStunBindingWithAddress(candidate.address, candidate.family, safePort, timeoutMs);
		if (attempt.ok) {
			return {
				...attempt,
				host: safeHost,
				resolvedAddress: candidate.address,
				family: candidate.family,
			};
		}
		errors.push(`${candidate.address}: ${attempt.error || 'failed'}`);
	}

	return {
		ok: false,
		error: errors[0] || 'unable to reach STUN endpoint',
		host: safeHost,
	};
}

function testTlsRelayWithAddress(host, address, port, timeoutMs = 5000) {
	return new Promise((resolve) => {
		const safeHost = normalizeRelayHost(host);
		const safeAddress = String(address || '').trim();
		const safePort = Number(port);
		if (!safeHost || !safeAddress || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
			resolve({ ok: false, error: 'invalid host or port' });
			return;
		}

		let finished = false;
		const socket = tls.connect({
			host: safeAddress,
			port: safePort,
			rejectUnauthorized: false,
			servername: safeHost,
		});

		const finish = (result) => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			try {
				socket.destroy();
			} catch {
				// ignore
			}
			resolve(result);
		};

		socket.once('secureConnect', () => {
			finish({ ok: true, protocol: 'tls', message: 'TLS handshake completed' });
		});

		socket.once('error', (error) => {
			finish({ ok: false, error: error.message || 'tls connection failed' });
		});

		const timer = setTimeout(() => {
			finish({ ok: false, error: 'timeout during TLS handshake' });
		}, Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000);
	});
}

async function testTlsRelay(host, port, timeoutMs = 5000) {
	const safeHost = normalizeRelayHost(host);
	const safePort = Number(port);
	if (!safeHost || !Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
		return { ok: false, error: 'invalid host or port' };
	}

	const addresses = await resolveRelayHostAddresses(safeHost);
	if (!addresses.length) {
		return { ok: false, error: `unable to resolve host '${safeHost}'` };
	}

	const errors = [];
	for (const candidate of addresses) {
		const attempt = await testTlsRelayWithAddress(safeHost, candidate.address, safePort, timeoutMs);
		if (attempt.ok) {
			return {
				...attempt,
				host: safeHost,
				resolvedAddress: candidate.address,
				family: candidate.family,
			};
		}
		errors.push(`${candidate.address}: ${attempt.error || 'failed'}`);
	}

	return {
		ok: false,
		error: errors[0] || 'unable to complete TLS handshake',
		host: safeHost,
	};
}

module.exports = {
	normalizeRelayEndpointConfig,
	normalizeRelayHost,
	parseBooleanOption,
	resolveRelayHostAddresses,
	testTlsRelay,
	testTlsRelayWithAddress,
	testUdpStunBinding,
	testUdpStunBindingWithAddress,
};