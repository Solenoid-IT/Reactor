const fsNative = require('fs');
const os = require('os');
const path = require('path');

function parsePositiveInt(rawValue, fallback) {
	const parsed = Number(rawValue);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_LOCAL_SERVER_PORT = parsePositiveInt(process.env.DEFAULT_LOCAL_SERVER_PORT, 9063);

function isUuidV4(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function parseLogicalNodeTarget(rawTarget) {
	const trimmed = String(rawTarget || '').trim();
	if (!trimmed || trimmed.includes('://')) {
		return null;
	}

	const slashIndex = trimmed.indexOf('/');
	if (slashIndex === -1) {
		if (trimmed.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(trimmed) || trimmed.includes('.')) {
			return null;
		}

		return {
			nodeName: trimmed.toLowerCase(),
			uuid: null,
			rawTarget: trimmed,
		};
	}

	const nodeName = trimmed.slice(0, slashIndex).trim().toLowerCase();
	const uuid = trimmed.slice(slashIndex + 1).trim().toLowerCase();
	if (!nodeName || !uuid || !isUuidV4(uuid)) {
		return null;
	}

	if (nodeName.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(nodeName) || nodeName.includes('.')) {
		return null;
	}

	return {
		nodeName,
		uuid,
		rawTarget: trimmed,
	};
}

function parseEndpointScopedTarget(rawTarget) {
	const trimmed = String(rawTarget || '').trim();
	if (!trimmed || trimmed.includes('://')) {
		return null;
	}

	const slashIndex = trimmed.indexOf('/');
	if (slashIndex === -1) {
		return null;
	}

	const baseTarget = trimmed.slice(0, slashIndex).trim();
	const uuid = trimmed.slice(slashIndex + 1).trim().toLowerCase();
	if (!baseTarget || !isUuidV4(uuid)) {
		return null;
	}

	const isDirectAddress = baseTarget.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(baseTarget) || baseTarget.includes('.');
	return {
		baseTarget,
		uuid,
		isDirectAddress,
		rawTarget: trimmed,
	};
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

function normalizeHostPort(value, defaultPort = DEFAULT_LOCAL_SERVER_PORT) {
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

module.exports = {
	DEFAULT_LOCAL_SERVER_PORT,
	collectKnownEntries,
	detectWatchType,
	getDelayToNextMidnightBoundary,
	normalizeHostPort,
	parseEndpointScopedTarget,
	parseLogicalNodeTarget,
};