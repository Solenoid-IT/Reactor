/**
 * Parses TypeScript script metadata from source code comments
 * Extracts: @state, @schedule, @on, @watch
 */

const VALID_WATCH_LISTENERS = new Set([
	'file:created',
	'file:deleted',
	'file:moved',
	'file:changed',
	'dir:created',
	'dir:deleted',
	'dir:moved',
]);

function parseWatchDirective(rawValue) {
	const trimmed = String(rawValue || '').trim();
	if (!trimmed) {
		return null;
	}

	const withListenersMatch = trimmed.match(/^(.*?)\s*\[(.*)\]\s*$/);
	if (!withListenersMatch) {
		return {
			path: trimmed,
			listeners: null,
			raw: trimmed,
		};
	}

	const watchPath = withListenersMatch[1].trim();
	const listenersRaw = withListenersMatch[2];
	const listeners = listenersRaw
		.split(',')
		.map((item) => item.trim().toLowerCase())
		.filter((item) => VALID_WATCH_LISTENERS.has(item));

	if (!watchPath) {
		return null;
	}

	return {
		path: watchPath,
		listeners,
		raw: trimmed,
	};
}

function parseScriptMetadata(sourceCode) {
	const metadata = {
		schedule: null,
		events: [],
		state: 'DISABLED',
		mutex: false,
		watch: [],
		watchRules: [],
	};

	const scheduleMatch = sourceCode.match(/@schedule\s+(.+)/i);
	if (scheduleMatch) {
		metadata.schedule = scheduleMatch[1].trim();
	}

	const onMatch = sourceCode.match(/@on\s+(.+)/i);
	if (onMatch) {
		metadata.events = onMatch[1]
			.split(/[\s,]+/)
			.map((eventName) => eventName.trim().toUpperCase())
			.filter(Boolean);
	}

	const stateMatch = sourceCode.match(/@state\s+(.+)/i);
	if (stateMatch) {
		const parsedState = stateMatch[1].trim().toUpperCase();
		if (parsedState === 'ENABLED' || parsedState === 'DISABLED') {
			metadata.state = parsedState;
		}
	}

	const mutexMatch = sourceCode.match(/@mutex(?:\s+(ON|OFF))?\b/i);
	if (mutexMatch) {
		const mutexValue = (mutexMatch[1] || 'ON').toUpperCase();
		metadata.mutex = mutexValue !== 'OFF';
	}

	const lines = sourceCode.split(/\r?\n/);
	for (const line of lines) {
		const watchMatch = line.match(/^\s*\/\/\s*@watch\s+(.+)$/i);
		if (!watchMatch) {
			continue;
		}

		const parsedWatch = parseWatchDirective(watchMatch[1]);
		if (!parsedWatch) {
			continue;
		}

		metadata.watch.push(parsedWatch.raw);
		metadata.watchRules.push({
			path: parsedWatch.path,
			listeners: parsedWatch.listeners,
		});
	}

	return metadata;
}

module.exports = { parseScriptMetadata };
