const {
	FileAdapter,
	DirectoryAdapter,
	HttpRequestAdapter,
	NetworkAdapter,
	BatteryAdapter,
	PowerAdapter,
	PositionAdapter,
	OSAdapter,
	NotifyAdapter,
	ProcessAdapter,
} = require('./runtimeApiContracts');

function getCapacitorPlugins() {
	const capacitor = globalThis && globalThis.Capacitor ? globalThis.Capacitor : null;
	return capacitor && capacitor.Plugins ? capacitor.Plugins : null;
}

function joinAndroidPath(basePath, childName) {
	const normalizedBase = String(basePath || '').replace(/\\/g, '/').replace(/\/+$/g, '');
	const normalizedChild = String(childName || '').replace(/\\/g, '/').replace(/^\/+/, '');
	if (!normalizedBase) {
		return normalizedChild;
	}
	if (!normalizedChild) {
		return normalizedBase;
	}
	return `${normalizedBase}/${normalizedChild}`;
}

function getAndroidDirEntryName(entry) {
	if (typeof entry === 'string') {
		return String(entry).trim();
	}
	if (!entry || typeof entry !== 'object') {
		return '';
	}
	return String(entry.name || entry.path || entry.uri || '').trim();
}

function isAndroidDirectoryEntry(entry) {
	if (!entry || typeof entry !== 'object') {
		return false;
	}

	const typeValue = String(entry.type || '').trim().toLowerCase();
	return typeValue === 'directory' || typeValue === 'dir';
}

class AndroidFile extends FileAdapter {
	constructor(filePath) {
		super(filePath);
		this.filePath = filePath;
	}

	async read() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return null;
		}
		try {
			const out = await plugins.Filesystem.readFile({ path: this.filePath });
			return out && typeof out.data === 'string' ? out.data : null;
		} catch {
			return null;
		}
	}

	async *open(options = {}) {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			throw new Error('Filesystem plugin unavailable');
		}

		const chunkSize = Math.max(1024, Math.min(1024 * 1024, Number(options.chunkSize) || 64 * 1024));
		const encoding = String(options.encoding || 'utf8').toLowerCase();

		const out = await plugins.Filesystem.readFile({ path: this.filePath });
		if (!out || typeof out.data !== 'string') {
			return;
		}

		let bytes;
		if (encoding === 'base64') {
			const binary = typeof atob === 'function' ? atob(out.data) : '';
			bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index += 1) {
				bytes[index] = binary.charCodeAt(index);
			}
		} else {
			bytes = new TextEncoder().encode(out.data);
		}

		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
		}
	}

	async write(content, append = false) {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return false;
		}
		try {
			let data = String(content || '');
			if (append) {
				const current = await this.read();
				data = `${current || ''}${data}`;
			}
			await plugins.Filesystem.writeFile({ path: this.filePath, data, recursive: true });
			return true;
		} catch {
			return false;
		}
	}

	async delete() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return false;
		}
		try {
			await plugins.Filesystem.deleteFile({ path: this.filePath });
			return true;
		} catch {
			return false;
		}
	}

	async getMeta() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return { path: this.filePath, exists: false };
		}
		try {
			const out = await plugins.Filesystem.stat({ path: this.filePath });
			return { path: this.filePath, exists: true, ...out };
		} catch {
			return { path: this.filePath, exists: false };
		}
	}
}

class AndroidDirectory extends DirectoryAdapter {
	constructor(dirPath) {
		super(dirPath);
		this.dirPath = dirPath;
	}

	async create(_permission = 0o755) {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return false;
		}
		try {
			await plugins.Filesystem.mkdir({ path: this.dirPath, recursive: true });
			return true;
		} catch {
			return false;
		}
	}

	async delete() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return false;
		}
		try {
			await plugins.Filesystem.rmdir({ path: this.dirPath, recursive: true });
			return true;
		} catch {
			return false;
		}
	}

	async list(_recursive = false) {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return [];
		}

		const walk = async (dirPath, recursive, output) => {
			const out = await plugins.Filesystem.readdir({ path: dirPath });
			const entries = Array.isArray(out?.files) ? out.files : [];

			for (const entry of entries) {
				const name = getAndroidDirEntryName(entry);
				if (!name) {
					continue;
				}

				const childPath = joinAndroidPath(dirPath, name);
				output.push(childPath);

				if (!recursive) {
					continue;
				}

				let shouldTraverse = isAndroidDirectoryEntry(entry);
				if (!shouldTraverse) {
					try {
						const meta = await plugins.Filesystem.stat({ path: childPath });
						const metaType = String(meta?.type || '').trim().toLowerCase();
						shouldTraverse = metaType === 'directory' || metaType === 'dir';
					} catch {
						shouldTraverse = false;
					}
				}

				if (shouldTraverse) {
					await walk(childPath, true, output);
				}
			}
		};

		try {
			const output = [];
			await walk(this.dirPath, Boolean(_recursive), output);
			return output;
		} catch {
			return [];
		}
	}

	async getMeta() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return { path: this.dirPath, exists: false };
		}
		try {
			const out = await plugins.Filesystem.stat({ path: this.dirPath });
			return { path: this.dirPath, exists: true, ...out };
		} catch {
			return { path: this.dirPath, exists: false };
		}
	}
}

class AndroidHttpRequest extends HttpRequestAdapter {
	constructor(arg1 = 'GET', arg2 = null, arg3 = {}, arg4 = '') {
		let method = 'GET';
		let body = null;
		let headers = {};
		let url = '';

		if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
			method = String(arg1.method || 'GET').toUpperCase();
			body = arg1.body ?? null;
			headers = arg1.headers || {};
			url = String(arg1.url || '');
		} else {
			method = String(arg1 || 'GET').toUpperCase();
			body = arg2;
			headers = arg3 || {};
			url = String(arg4 || '');
		}

		super(method, body, headers);
		this.method = method;
		this.body = body;
		this.headers = headers;
		this.url = url;
	}
}

class AndroidNetwork extends NetworkAdapter {
	async getStatus() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Network) {
			return { connected: false };
		}
		const status = await plugins.Network.getStatus();
		return status || { connected: false };
	}
}

class AndroidBattery extends BatteryAdapter {
	async exists() {
		const plugins = getCapacitorPlugins();
		return Boolean(plugins && plugins.Device && plugins.Device.getBatteryInfo);
	}

	async getLevel() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Device || !plugins.Device.getBatteryInfo) {
			return -1;
		}
		const info = await plugins.Device.getBatteryInfo();
		return typeof info.batteryLevel === 'number' ? info.batteryLevel : -1;
	}
}

class AndroidPower extends PowerAdapter {
	async isBattery() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Device || !plugins.Device.getBatteryInfo) {
			return true;
		}
		const info = await plugins.Device.getBatteryInfo();
		return Boolean(info.isCharging === false);
	}
}

class AndroidPosition extends PositionAdapter {
	static async get() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Geolocation) {
			return { lat: null, lon: null, available: false };
		}
		try {
			const out = await plugins.Geolocation.getCurrentPosition();
			return {
				lat: out.coords.latitude,
				lon: out.coords.longitude,
				available: true,
			};
		} catch {
			return { lat: null, lon: null, available: false };
		}
	}
}

class AndroidOS extends OSAdapter {
	getArch() {
		return 'arm';
	}
	isDesktop() {
		return false;
	}
	isMobile() {
		return true;
	}
	getName() {
		return 'android';
	}
	getFullName() {
		return 'Android (Capacitor)';
	}
}

class AndroidNotify extends NotifyAdapter {
	async notify(message) {
		const text = String(message || '').trim();
		if (!text) {
			return false;
		}

		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.LocalNotifications || typeof plugins.LocalNotifications.schedule !== 'function') {
			return false;
		}

		try {
			if (typeof plugins.LocalNotifications.checkPermissions === 'function') {
				const status = await plugins.LocalNotifications.checkPermissions();
				const display = String(status && status.display ? status.display : '').toLowerCase();
				if (display !== 'granted' && typeof plugins.LocalNotifications.requestPermissions === 'function') {
					const requested = await plugins.LocalNotifications.requestPermissions();
					const requestedDisplay = String(requested && requested.display ? requested.display : '').toLowerCase();
					if (requestedDisplay !== 'granted') {
						return false;
					}
				}
			}

			await plugins.LocalNotifications.schedule({
				notifications: [
					{
						title: 'Reactor',
						body: text,
						id: Date.now() % 2147483647,
					},
				],
			});
			return true;
		} catch {
			return false;
		}

		return false;
	}
}

class AndroidProcess extends ProcessAdapter {
	constructor(command) {
		super(command);
		this.command = command;
	}

	async spawn() {
		const plugins = getCapacitorPlugins();
		const proc = plugins ? plugins.ReactorProcess : null;
		if (!proc || !proc.spawn) {
			return false;
		}
		try {
			await proc.spawn({ command: this.command });
			return true;
		} catch {
			return false;
		}
	}
}

function createAndroidRuntimeApi() {
	return {
		FileSystem: {
			File: AndroidFile,
			Directory: AndroidDirectory,
		},
		HttpClient: {
			Request: AndroidHttpRequest,
			sendRequest: async (request, timeout = 30000) => {
			if (!request || typeof request !== 'object') {
				throw new Error('HttpClient.sendRequest requires a request object');
				}

			const plugins = getCapacitorPlugins();
			if (!plugins || !plugins.Http) {
				throw new Error('Capacitor Http plugin unavailable');
			}

			const response = await plugins.Http.request({
				url: String(request.url || ''),
				method: String(request.method || 'GET').toUpperCase(),
				headers: request.headers || {},
				data: request.body ?? null,
				connectTimeout: timeout,
				readTimeout: timeout,
			});

			return {
				status: response.status,
				headers: response.headers || {},
				body: typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {}),
			};
			},
		},
		Device: {
			Network: AndroidNetwork,
			Battery: AndroidBattery,
			Power: AndroidPower,
			Position: AndroidPosition,
			OS: AndroidOS,
			notify: async (message) => new AndroidNotify().notify(message),
		},
		System: {
			Process: AndroidProcess,
			getHomeDirectory: async () => {
				const plugins = getCapacitorPlugins();
				const mobile = plugins ? plugins.ReactorMobile : null;
				if (!mobile || typeof mobile.getHomeDirectory !== 'function') {
					throw new Error('ReactorMobile.getHomeDirectory unavailable');
				}

				const result = await mobile.getHomeDirectory();
				if (!result || result.ok === false) {
					throw new Error((result && result.error) || 'unable to resolve Android home directory');
				}

				return String(result.path || '').trim();
			},
		},
	};
}

module.exports = {
	createAndroidRuntimeApi,
	AndroidFile,
	AndroidDirectory,
	AndroidHttpRequest,
	AndroidNetwork,
	AndroidBattery,
	AndroidPower,
	AndroidPosition,
	AndroidOS,
	AndroidNotify,
	AndroidProcess,
};
