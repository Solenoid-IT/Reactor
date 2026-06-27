function parseDirectiveHeader(source) {
	const lines = source.split(/\r?\n/);
	let index = 0;

	while (index < lines.length && lines[index].trim() === '') {
		index += 1;
	}

	const values = {
		state: null,
		schedule: null,
		on: null,
		mutex: null,
		watch: [],
	};

	for (; index < lines.length; index += 1) {
		const line = lines[index];
		const stateMatch = line.match(/^\s*\/\/\s*@state\s+(ENABLED|DISABLED)\b/i);
		if (stateMatch) {
			values.state = stateMatch[1].toUpperCase();
			continue;
		}

		const scheduleMatch = line.match(/^\s*\/\/\s*@schedule\s+(.+)$/i);
		if (scheduleMatch) {
			values.schedule = scheduleMatch[1].trim();
			continue;
		}

		const onMatch = line.match(/^\s*\/\/\s*@on\s+(.+)$/i);
		if (onMatch) {
			values.on = onMatch[1].trim();
			continue;
		}

		const mutexMatch = line.match(/^\s*\/\/\s*@mutex(?:\s+(ON|OFF))?\b/i);
		if (mutexMatch) {
			values.mutex = (mutexMatch[1] || 'ON').toUpperCase();
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
		if (/^\s*\/\/\s*@(state|mutex|on|schedule|watch)\b/i.test(line) || line.trim() === '') {
			continue;
		}
		break;
	}

	const body = lines.slice(bodyStart).join('\n').replace(/^\n+/, '');
	const headerLines = [];

	if (nextValues.state) {
		headerLines.push(`// @state ${nextValues.state}`);
	}

	if (nextValues.mutex) {
		headerLines.push(`// @mutex ${nextValues.mutex}`);
	}

	if (nextValues.on) {
		headerLines.push(`// @on ${nextValues.on}`);
	}

	if (nextValues.schedule) {
		headerLines.push(`// @schedule ${nextValues.schedule}`);
	}

	if (Array.isArray(nextValues.watch)) {
		for (const watchEntry of nextValues.watch) {
			if (watchEntry) {
				headerLines.push(`// @watch ${watchEntry}`);
			}
		}
	}

	if (!headerLines.length) {
		return body;
	}

	return `${headerLines.join('\n')}\n\n${body}`;
}

module.exports = {
	parseDirectiveHeader,
	rebuildDirectiveHeader,
};
