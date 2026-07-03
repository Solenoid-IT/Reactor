function parseDirectiveHeader(source) {
	const lines = source.split(/\r?\n/);
	let index = 0;

	while (index < lines.length && lines[index].trim() === '') {
		index += 1;
	}

	const values = {
		state: null,
		debug: null,
		schedule: null,
		on: [],
		mutex: null,
		watch: [],
	};

	for (; index < lines.length; index += 1) {
		const line = lines[index];
		const enabledMatch = line.match(/^\s*\/\/\s*@enabled\s+(TRUE|FALSE)\b/i);
		if (enabledMatch) {
			const parsedEnabled = enabledMatch[1].toUpperCase();
			values.state = parsedEnabled === 'TRUE' ? 'ENABLED' : 'DISABLED';
			continue;
		}

		const scheduleMatch = line.match(/^\s*\/\/\s*@schedule\s+(.+)$/i);
		if (scheduleMatch) {
			values.schedule = scheduleMatch[1].trim();
			continue;
		}

		const debugMatch = line.match(/^\s*\/\/\s*@debug\s+(TRUE|FALSE)\b/i);
		if (debugMatch) {
			const parsedDebug = debugMatch[1].toUpperCase();
			values.debug = parsedDebug === 'TRUE' ? 'TRUE' : 'FALSE';
			continue;
		}

		const onMatch = line.match(/^\s*\/\/\s*@on\s+(.+)$/i);
		if (onMatch) {
			const onValue = onMatch[1].trim();
			const scheduleOnMatch = onValue.match(/^SCHEDULE\s+(?:"([^"]+)"|'([^']+)'|(.+))$/i);
			if (scheduleOnMatch) {
				values.schedule = String(scheduleOnMatch[1] || scheduleOnMatch[2] || scheduleOnMatch[3] || '').trim();
				continue;
			}

			const watchOnMatch = onValue.match(/^WATCH\s+(.+)$/i);
			if (watchOnMatch) {
				values.watch.push(watchOnMatch[1].trim());
				continue;
			}

			values.on.push(onValue);
			continue;
		}

		const mutexMatch = line.match(/^\s*\/\/\s*@mutex(?:\s+(TRUE|FALSE))?\b/i);
		if (mutexMatch) {
			const rawMutex = (mutexMatch[1] || 'TRUE').toUpperCase();
			values.mutex = rawMutex === 'TRUE' ? 'TRUE' : 'FALSE';
			continue;
		}

		const watchMatch = line.match(/^\s*\/\/\s*@watch\s+(.+)$/i);
		if (watchMatch) {
			values.watch.push(watchMatch[1].trim());
			continue;
		}

		if (line.trim() === '') {
			continue;
		}

		break;
	}

	return values;
}

function rebuildDirectiveHeader(source, overrides = {}) {
	const currentValues = parseDirectiveHeader(source);
	const nextValues = { ...currentValues, ...overrides };
	const lines = source.split(/\r?\n/);
	let index = 0;

	while (index < lines.length && lines[index].trim() === '') {
		index += 1;
	}

	let bodyStart = index;
	for (; bodyStart < lines.length; bodyStart += 1) {
		const line = lines[bodyStart];
		if (/^\s*\/\/\s*@(enabled|debug|mutex|on|schedule|watch)\b/i.test(line) || line.trim() === '') {
			continue;
		}
		break;
	}

	const body = lines.slice(bodyStart).join('\n').replace(/^\n+/, '');
	const leadingHeaderLines = [];
	const onHeaderLines = [];

	if (nextValues.state) {
		const enabledValue = String(nextValues.state).toUpperCase() === 'ENABLED' ? 'TRUE' : 'FALSE';
		leadingHeaderLines.push(`// @enabled ${enabledValue}`);
	}

	if (nextValues.debug) {
		const debugValue = String(nextValues.debug).toUpperCase();
		leadingHeaderLines.push(`// @debug ${debugValue === 'TRUE' ? 'TRUE' : 'FALSE'}`);
	}

	if (nextValues.mutex) {
		const mutexValue = String(nextValues.mutex).toUpperCase();
		leadingHeaderLines.push(`// @mutex ${mutexValue === 'TRUE' ? 'TRUE' : 'FALSE'}`);
	}

	if (Array.isArray(nextValues.on)) {
		for (const onValue of nextValues.on) {
			if (onValue) {
				onHeaderLines.push(`// @on ${onValue}`);
			}
		}
	} else if (nextValues.on) {
		onHeaderLines.push(`// @on ${nextValues.on}`);
	}

	if (nextValues.schedule) {
		onHeaderLines.push(`// @on SCHEDULE "${nextValues.schedule}"`);
	}

	if (Array.isArray(nextValues.watch)) {
		for (const watchEntry of nextValues.watch) {
			if (watchEntry) {
				onHeaderLines.push(`// @on WATCH ${formatWatchEntryForOnDirective(watchEntry)}`);
			}
		}
	}

	const headerSections = [];
	if (leadingHeaderLines.length) {
		headerSections.push(leadingHeaderLines.join('\n'));
	}
	if (onHeaderLines.length) {
		headerSections.push(onHeaderLines.join('\n'));
	}

	const headerText = headerSections.join('\n\n');

	if (!headerText) {
		return body;
	}

	return `${headerText}\n\n${body}`;
}

function formatWatchEntryForOnDirective(watchEntry) {
	const raw = String(watchEntry || '').trim();
	if (!raw) {
		return '""';
	}

	const recursiveMatch = raw.match(/^(.*?)(?:\s+R)\s*$/i);
	const hasRecursiveFlag = Boolean(recursiveMatch && String(recursiveMatch[1] || '').trim());
	const baseValue = hasRecursiveFlag ? String(recursiveMatch[1] || '').trim() : raw;
	const recursiveSuffix = hasRecursiveFlag ? ' R' : '';

	const match = baseValue.match(/^(.*?)\s*(\[.*\])\s*$/);
	if (match) {
		const pathPart = stripWrappingQuotes(match[1]);
		const listenersPart = match[2].trim();
		return `"${pathPart}" ${listenersPart}${recursiveSuffix}`;
	}

	return `"${stripWrappingQuotes(baseValue)}"${recursiveSuffix}`;
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

module.exports = {
	parseDirectiveHeader,
	rebuildDirectiveHeader,
};
