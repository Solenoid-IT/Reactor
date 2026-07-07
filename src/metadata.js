/**
 * Parses TypeScript endpoint metadata from source code comments.
 * Extracts: @enabled, @debug, @schedule, @on, @watch
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

	const { value: normalizedDirective, recursive } = consumeWatchRecursiveSuffix(trimmed);

	const withListenersMatch = normalizedDirective.match(/^(.*?)\s*\[(.*)\]\s*$/);
	if (!withListenersMatch) {
		const plainPath = stripWrappingQuotes(normalizedDirective);
		if (!plainPath) {
			return null;
		}

		return {
			path: plainPath,
			listeners: null,
			raw: trimmed,
			recursive,
		};
	}

	const watchPath = stripWrappingQuotes(withListenersMatch[1]);
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
		recursive,
	};
}

function consumeWatchRecursiveSuffix(rawDirective) {
	const trimmed = String(rawDirective || '').trim();
	if (!trimmed) {
		return { value: '', recursive: false };
	}

	const recursiveMatch = trimmed.match(/^(.*?)(?:\s+R)\s*$/i);
	if (!recursiveMatch) {
		return { value: trimmed, recursive: false };
	}

	const value = String(recursiveMatch[1] || '').trim();
	if (!value) {
		return { value: trimmed, recursive: false };
	}

	return { value, recursive: true };
}

function stripWrappingQuotes(value) {
	const trimmed = String(value || '').trim();
	if (!trimmed) {
		return '';
	}

	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}

	return trimmed;
}

function splitDirectiveTokens(rawValue) {
	const out = [];
	let token = '';
	let parenDepth = 0;
	let bracketDepth = 0;
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

		if (char === '[') {
			bracketDepth += 1;
			token += char;
			continue;
		}

		if (char === ']') {
			bracketDepth = Math.max(0, bracketDepth - 1);
			token += char;
			continue;
		}

		if ((char === ',' || /\s/.test(char)) && parenDepth === 0 && bracketDepth === 0) {
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

function parseSenderFilterFromToken(token, type) {
	const trimmed = String(token || '').trim();
	if (!trimmed) {
		return null;
	}

	const listMatch = trimmed.match(new RegExp(`^${type}(?:\\s+\\[(.*)\\])?$`, 'i'));
	if (listMatch) {
		const rawSenders = String(listMatch[1] || '').trim();
		if (!rawSenders) {
			return [];
		}

		return rawSenders.split(',').map((sender) => sender.trim());
	}

	const legacyMatch = trimmed.match(new RegExp(`^${type}(?:\\((.*)\\))?$`, 'i'));
	if (legacyMatch) {
		const rawSenders = String(legacyMatch[1] || '').trim();
		if (!rawSenders) {
			return [];
		}

		return rawSenders.split(',').map((sender) => sender.trim());
	}

	return null;
}

function addWatchRule(metadata, parsedWatch) {
	if (!parsedWatch) {
		return;
	}

	const rawEntry = parsedWatch.raw;
	if (rawEntry && !metadata.watch.includes(rawEntry)) {
		metadata.watch.push(rawEntry);
	}

	metadata.watchRules.push({
		path: parsedWatch.path,
		listeners: parsedWatch.listeners,
		recursive: Boolean(parsedWatch.recursive),
	});
}

function applyOnDirective(rawValue, metadata) {
	const trimmed = String(rawValue || '').trim();
	if (!trimmed) {
		return;
	}

	const scheduleMatch = trimmed.match(/^SCHEDULE\s+(?:"([^"]+)"|'([^']+)'|(.+))$/i);
	if (scheduleMatch) {
		const expression = String(scheduleMatch[1] || scheduleMatch[2] || scheduleMatch[3] || '').trim();
		if (expression) {
			metadata.schedule = expression;
		}
		return;
	}

	const watchMatch = trimmed.match(/^WATCH\s+(.+)$/i);
	if (watchMatch) {
		const parsedWatch = parseWatchDirective(watchMatch[1]);
		addWatchRule(metadata, parsedWatch);
		return;
	}

	const messageSendersRaw = parseSenderFilterFromToken(trimmed, 'MESSAGE');
	if (messageSendersRaw !== null) {
		if (!metadata.events.includes('MESSAGE')) {
			metadata.events.push('MESSAGE');
		}

		if (messageSendersRaw.length === 0) {
			metadata.messageFromAnySender = true;
			return;
		}

		for (const senderRaw of messageSendersRaw) {
			const normalized = normalizeMessageSender(senderRaw);
			if (normalized && !metadata.messageSenders.includes(normalized)) {
				metadata.messageSenders.push(normalized);
			}
		}
		return;
	}

	const streamSendersRaw = parseSenderFilterFromToken(trimmed, 'STREAM');
	if (streamSendersRaw !== null) {
		if (!metadata.events.includes('STREAM')) {
			metadata.events.push('STREAM');
		}

		if (streamSendersRaw.length === 0) {
			metadata.streamFromAnySender = true;
			return;
		}

		for (const senderRaw of streamSendersRaw) {
			const normalized = normalizeMessageSender(senderRaw);
			if (normalized && !metadata.streamSenders.includes(normalized)) {
				metadata.streamSenders.push(normalized);
			}
		}
		return;
	}

	const streamEndSendersRaw = parseSenderFilterFromToken(trimmed, 'STREAMEND');
	if (streamEndSendersRaw !== null) {
		if (!metadata.events.includes('STREAMEND')) {
			metadata.events.push('STREAMEND');
		}

		if (streamEndSendersRaw.length === 0) {
			metadata.streamEndFromAnySender = true;
			return;
		}

		for (const senderRaw of streamEndSendersRaw) {
			const normalized = normalizeMessageSender(senderRaw);
			if (normalized && !metadata.streamEndSenders.includes(normalized)) {
				metadata.streamEndSenders.push(normalized);
			}
		}
		return;
	}

	for (const token of splitDirectiveTokens(trimmed)) {
		const messageSendersRaw = parseSenderFilterFromToken(token, 'MESSAGE');
		if (messageSendersRaw !== null) {
			if (!metadata.events.includes('MESSAGE')) {
				metadata.events.push('MESSAGE');
			}

			if (messageSendersRaw.length === 0) {
				metadata.messageFromAnySender = true;
				continue;
			}

			for (const senderRaw of messageSendersRaw) {
				const normalized = normalizeMessageSender(senderRaw);
				if (normalized && !metadata.messageSenders.includes(normalized)) {
					metadata.messageSenders.push(normalized);
				}
			}
			continue;
		}

		const streamSendersRaw = parseSenderFilterFromToken(token, 'STREAM');
		if (streamSendersRaw !== null) {
			if (!metadata.events.includes('STREAM')) {
				metadata.events.push('STREAM');
			}

			if (streamSendersRaw.length === 0) {
				metadata.streamFromAnySender = true;
				continue;
			}

			for (const senderRaw of streamSendersRaw) {
				const normalized = normalizeMessageSender(senderRaw);
				if (normalized && !metadata.streamSenders.includes(normalized)) {
					metadata.streamSenders.push(normalized);
				}
			}
			continue;
		}

		const streamEndSendersRaw = parseSenderFilterFromToken(token, 'STREAMEND');
		if (streamEndSendersRaw !== null) {
			if (!metadata.events.includes('STREAMEND')) {
				metadata.events.push('STREAMEND');
			}

			if (streamEndSendersRaw.length === 0) {
				metadata.streamEndFromAnySender = true;
				continue;
			}

			for (const senderRaw of streamEndSendersRaw) {
				const normalized = normalizeMessageSender(senderRaw);
				if (normalized && !metadata.streamEndSenders.includes(normalized)) {
					metadata.streamEndSenders.push(normalized);
				}
			}
			continue;
		}

		const normalizedEvent = token.trim().toUpperCase();
		if (normalizedEvent && !metadata.events.includes(normalizedEvent)) {
			metadata.events.push(normalizedEvent);
		}
	}
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

function normalizeMessageSender(rawSender, defaultPort = 9063) {
	const sender = String(rawSender || '').trim();
	if (!sender) {
		return null;
	}

	const lower = sender.toLowerCase();
	if (lower.startsWith('net:')) {
		const networkRaw = lower.slice(4).trim();
		if (!networkRaw) {
			return null;
		}

		if (/^https?:\/\//i.test(networkRaw)) {
			try {
				const parsed = new URL(networkRaw);
				const host = String(parsed.hostname || '').toLowerCase();
				const hasExplicitPort = Boolean(parsed.port);
				const port = hasExplicitPort ? Number(parsed.port) : defaultPort;
				if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
					return null;
				}
				return hasExplicitPort ? `net:${host}:${port}` : `net:${host}`;
			} catch {
				return null;
			}
		}

		const hostPortMatch = networkRaw.match(/^([^:]+):(\d{1,5})$/);
		if (hostPortMatch) {
			const host = hostPortMatch[1].trim();
			const port = Number(hostPortMatch[2]);
			if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
				return null;
			}
			return `net:${host}:${port}`;
		}

		if (networkRaw.includes(':')) {
			return null;
		}

		return `net:${networkRaw}`;
	}

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

function parseEndpointMetadata(sourceCode) {
	const metadata = {
		schedule: null,
		events: [],
		messageSenders: [],
		messageFromAnySender: false,
		streamSenders: [],
		streamFromAnySender: false,
		streamEndSenders: [],
		streamEndFromAnySender: false,
		state: 'DISABLED',
		debug: false,
		mutex: false,
		watch: [],
		watchRules: [],
	};

	const lines = sourceCode.split(/\r?\n/);
	for (const line of lines) {
		const enabledMatch = line.match(/^\s*\/\/\s*@enabled\s+(.+)$/i);
		if (enabledMatch) {
			const parsedEnabled = enabledMatch[1].trim().toUpperCase();
			if (parsedEnabled === 'TRUE') {
				metadata.state = 'ENABLED';
			} else if (parsedEnabled === 'FALSE') {
				metadata.state = 'DISABLED';
			}
			continue;
		}

		const mutexMatch = line.match(/^\s*\/\/\s*@mutex(?:\s+(TRUE|FALSE))?\b/i);
		if (mutexMatch) {
			const mutexValue = (mutexMatch[1] || 'TRUE').toUpperCase();
			metadata.mutex = mutexValue !== 'FALSE';
			continue;
		}

		const debugMatch = line.match(/^\s*\/\/\s*@debug\s+(TRUE|FALSE)\b/i);
		if (debugMatch) {
			const debugValue = debugMatch[1].trim().toUpperCase();
			metadata.debug = debugValue === 'TRUE';
			continue;
		}

		const scheduleMatch = line.match(/^\s*\/\/\s*@schedule\s+(.+)$/i);
		if (scheduleMatch) {
			metadata.schedule = scheduleMatch[1].trim();
			continue;
		}

		const onMatch = line.match(/^\s*\/\/\s*@on\s+(.+)$/i);
		if (onMatch) {
			applyOnDirective(onMatch[1], metadata);
			continue;
		}

		const watchMatch = line.match(/^\s*\/\/\s*@watch\s+(.+)$/i);
		if (!watchMatch) {
			continue;
		}

		const parsedWatch = parseWatchDirective(watchMatch[1]);
		addWatchRule(metadata, parsedWatch);
	}

	return metadata;
}

module.exports = {
	parseEndpointMetadata,
};
