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

function splitDirectiveTokens(rawValue) {
	const out = [];
	let token = '';
	let parenDepth = 0;
	const value = String(rawValue || '');

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];

		if (char === '(') {
			parenDepth += 1;
			token += char;
			continue;
		}

		if (char === ')') {
			parenDepth = Math.max(0, parenDepth - 1);
			token += char;
			continue;
		}

		if ((char === ',' || /\s/.test(char)) && parenDepth === 0) {
			const trimmed = token.trim();
			if (trimmed) {
				out.push(trimmed);
			}
			token = '';
			continue;
		}

		token += char;
	}

	const tail = token.trim();
	if (tail) {
		out.push(tail);
	}

	return out;
}

function isLikelyHostSender(value) {
	if (!value) {
		return false;
	}

	if (value.includes(':')) {
		return true;
	}

	if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
		return true;
	}

	if (value.includes('.') || value.toLowerCase().endsWith('.local')) {
		return true;
	}

	return false;
}

function normalizeMessageSender(rawSender, defaultPort = 7070) {
	const sender = String(rawSender || '').trim();
	if (!sender) {
		return null;
	}

	const lower = sender.toLowerCase();
	if (!isLikelyHostSender(lower)) {
		return lower;
	}

	if (/^https?:\/\//i.test(lower)) {
		try {
			const parsed = new URL(lower);
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

	const hostPortMatch = lower.match(/^([^:]+):(\d{1,5})$/);
	if (hostPortMatch) {
		const host = hostPortMatch[1].trim();
		const port = Number(hostPortMatch[2]);
		if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
			return null;
		}
		return `${host}:${port}`;
	}

	return `${lower}:${defaultPort}`;
}

function parseOnDirective(rawValue) {
	const parsed = {
		events: [],
		messageSenders: [],
		messageFromAnySender: false,
	};

	for (const token of splitDirectiveTokens(rawValue)) {
		const messageMatch = token.match(/^MESSAGE(?:\((.*)\))?$/i);
		if (messageMatch) {
			if (!parsed.events.includes('MESSAGE')) {
				parsed.events.push('MESSAGE');
			}

			const rawSenders = String(messageMatch[1] || '').trim();
			if (!rawSenders) {
				parsed.messageFromAnySender = true;
				continue;
			}

			for (const senderRaw of rawSenders.split(',')) {
				const normalized = normalizeMessageSender(senderRaw);
				if (normalized && !parsed.messageSenders.includes(normalized)) {
					parsed.messageSenders.push(normalized);
				}
			}
			continue;
		}

		const normalizedEvent = token.trim().toUpperCase();
		if (normalizedEvent && !parsed.events.includes(normalizedEvent)) {
			parsed.events.push(normalizedEvent);
		}
	}

	return parsed;
}

function parseScriptMetadata(sourceCode) {
	const metadata = {
		schedule: null,
		events: [],
		messageSenders: [],
		messageFromAnySender: false,
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
		const parsedOn = parseOnDirective(onMatch[1]);
		metadata.events = parsedOn.events;
		metadata.messageSenders = parsedOn.messageSenders;
		metadata.messageFromAnySender = parsedOn.messageFromAnySender;
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

		continue;
	}

	return metadata;
}

module.exports = { parseScriptMetadata };
