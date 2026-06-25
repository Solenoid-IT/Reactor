const {
	FileAdapter,
	DirectoryAdapter,
	HttpRequestAdapter,
	NetworkAdapter,
	BatteryAdapter,
	PowerAdapter,
	PositionAdapter,
	OSAdapter,
	ProcessAdapter,
} = require('./runtimeApiContracts');

function getCapacitorPlugins() {
	const capacitor = globalThis && globalThis.Capacitor ? globalThis.Capacitor : null;
	return capacitor && capacitor.Plugins ? capacitor.Plugins : null;
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
		try {
			const out = await plugins.Filesystem.readdir({ path: this.dirPath });
			return Array.isArray(out.files) ? out.files : [];
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
	constructor(method = 'GET', body = null, headers = {}, url = '') {
		super(method, body, headers);
		this.method = String(method || 'GET').toUpperCase();
		this.body = body;
		this.headers = headers || {};
		this.url = url;
	}

	async send(_timeout = 30000) {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Http) {
			throw new Error('Capacitor Http plugin unavailable');
		}
		const response = await plugins.Http.request({
			url: this.url,
			method: this.method,
			headers: this.headers,
			data: this.body,
		});
		return {
			status: response.status,
			headers: response.headers || {},
			body: typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {}),
		};
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
		},
		Device: {
			Network: AndroidNetwork,
			Battery: AndroidBattery,
			Power: AndroidPower,
			Position: AndroidPosition,
			OS: AndroidOS,
		},
		System: {
			Process: AndroidProcess,
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
	AndroidProcess,
};
