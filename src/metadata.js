/**
 * Parses TypeScript script metadata from source code comments
 * Extracts: @state, @schedule, @on, @watch, @route
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

function parseRouteDirective(rawMethod, rawPath) {
	const method = String(rawMethod || '').trim().toUpperCase();
	const routePath = String(rawPath || '').trim();

	if (!method || !routePath) {
		return null;
	}

	return {
		method,
		path: routePath.startsWith('/') ? routePath : `/${routePath}`,
		raw: `${method} ${routePath.startsWith('/') ? routePath : `/${routePath}`}`,
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
		routes: [],
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

		continue;
	}

	for (const line of lines) {
		const routeMatch = line.match(/^\s*\/\/\s*@route\s+([^\s]+)\s+(.+)$/i);
		if (!routeMatch) {
			continue;
		}

		const parsedRoute = parseRouteDirective(routeMatch[1], routeMatch[2]);
		if (!parsedRoute) {
			continue;
		}

		metadata.routes.push({
			method: parsedRoute.method,
			path: parsedRoute.path,
			raw: parsedRoute.raw,
		});
	}

	return metadata;
}

module.exports = { parseScriptMetadata };
