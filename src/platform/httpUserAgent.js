const { version } = require('../../package.json');

const DEFAULT_APP_VERSION = String(version || '').trim() || '0.0.0';

function createDefaultUserAgent(appVersion = DEFAULT_APP_VERSION) {
	const safeVersion = String(appVersion || '').trim() || DEFAULT_APP_VERSION;
	return `ReactorClient/${safeVersion}`;
}

function withDefaultUserAgent(headers, appVersion = DEFAULT_APP_VERSION) {
	const nextHeaders = headers && typeof headers === 'object' && !Array.isArray(headers)
		? { ...headers }
		: {};

	for (const headerName of Object.keys(nextHeaders)) {
		if (String(headerName).trim().toLowerCase() === 'user-agent') {
			return nextHeaders;
		}
	}

	nextHeaders['User-Agent'] = createDefaultUserAgent(appVersion);
	return nextHeaders;
}

module.exports = {
	DEFAULT_APP_VERSION,
	createDefaultUserAgent,
	withDefaultUserAgent,
};