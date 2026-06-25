const { FileWriter, HttpClient, PermissionManager } = require('./contracts');

function getCapacitorPlugins() {
	const capacitor = globalThis && globalThis.Capacitor ? globalThis.Capacitor : null;
	return capacitor && capacitor.Plugins ? capacitor.Plugins : null;
}

class CapacitorFileWriter extends FileWriter {
	async appendText(filePath, content, encoding = 'utf8') {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			throw new Error('Capacitor Filesystem plugin unavailable');
		}

		const filesystem = plugins.Filesystem;
		const existing = await filesystem.readFile({ path: filePath }).catch(() => ({ data: '' }));
		const nextData = String(existing.data || '') + String(content || '');
		await filesystem.writeFile({
			path: filePath,
			data: nextData,
			encoding,
			recursive: true,
		});
	}
}

class CapacitorHttpClient extends HttpClient {
	async request({ url, method = 'GET', headers = {}, body }) {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Http) {
			throw new Error('Capacitor Http plugin unavailable');
		}

		const response = await plugins.Http.request({
			url,
			method,
			headers,
			data: body,
		});

		return {
			status: response.status,
			headers: response.headers || {},
			body: typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {}),
		};
	}
}

class CapacitorPermissionManager extends PermissionManager {
	constructor(permissionPluginName = 'ReactorPermissions') {
		super();
		this.permissionPluginName = permissionPluginName;
	}

	async ensurePermissions(permissions) {
		const plugins = getCapacitorPlugins();
		const plugin = plugins ? plugins[this.permissionPluginName] : null;
		if (!plugin || !plugin.ensurePermissions) {
			return { granted: false, denied: Array.isArray(permissions) ? permissions : [] };
		}

		return plugin.ensurePermissions({ permissions: Array.isArray(permissions) ? permissions : [] });
	}
}

function createCapacitorPlatformServices() {
	return {
		fileWriter: new CapacitorFileWriter(),
		httpClient: new CapacitorHttpClient(),
		permissionManager: new CapacitorPermissionManager(),
	};
}

module.exports = {
	createCapacitorPlatformServices,
	CapacitorFileWriter,
	CapacitorHttpClient,
	CapacitorPermissionManager,
};
