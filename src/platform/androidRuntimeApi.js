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
const { withDefaultUserAgent } = require('./httpUserAgent');

let androidAppInfoPromise = null;

function getCapacitorPlugins() {
	const capacitor = globalThis && globalThis.Capacitor ? globalThis.Capacitor : null;
	return capacitor && capacitor.Plugins ? capacitor.Plugins : null;
}

async function getAndroidAppVersion() {
	if (!androidAppInfoPromise) {
		androidAppInfoPromise = (async () => {
			const plugins = getCapacitorPlugins();
			const mobile = plugins ? plugins.ReactorMobile : null;
			if (!mobile || typeof mobile.getAppInfo !== 'function') {
				return null;
			}

			const result = await mobile.getAppInfo();
			const appVersion = String(result && result.version ? result.version : '').trim();
			return appVersion || null;
		})().catch(() => null);
	}

	return androidAppInfoPromise;
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

function toRelativeAndroidPath(basePath, childPath) {
	const normalizedBase = String(basePath || '').replace(/\\/g, '/').replace(/\/+$/g, '');
	const normalizedChild = String(childPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
	if (!normalizedBase) {
		return normalizedChild;
	}

	if (normalizedChild === normalizedBase) {
		return '';
	}

	const prefix = `${normalizedBase}/`;
	if (normalizedChild.startsWith(prefix)) {
		return normalizedChild.slice(prefix.length);
	}

	return normalizedChild;
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

function getChunkByteLength(chunk) {
	if (typeof chunk === 'string') {
		return new TextEncoder().encode(chunk).length;
	}

	if (chunk instanceof Uint8Array) {
		return chunk.byteLength;
	}

	if (chunk && typeof chunk === 'object' && Number.isFinite(Number(chunk.byteLength))) {
		return Number(chunk.byteLength) || 0;
	}

	return new TextEncoder().encode(String(chunk ?? '')).length;
}

function normalizeEpochSeconds(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) {
		return undefined;
	}

	if (numeric > 1e10) {
		return Math.floor(numeric / 1000);
	}

	return Math.floor(numeric);
}

function resolveMetaTimeSeconds(out, type) {
	const source = out && typeof out === 'object' ? out : {};
	const keys = type === 'mTime'
		? ['mTime', 'mtime', 'mtimeMs', 'modified', 'lastModified', 'modificationTime']
		: ['cTime', 'ctime', 'ctimeMs', 'created', 'creationTime'];

	for (const key of keys) {
		const value = normalizeEpochSeconds(source[key]);
		if (value !== undefined) {
			return value;
		}
	}

	return undefined;
}

function resolveStatusText(statusCode, fallback = '') {
	const code = Number(statusCode);
	const text = String(fallback || '').trim();
	if (text) {
		return text;
	}

	if (code >= 200 && code < 300) {
		return 'OK';
	}

	if (code >= 400 && code < 500) {
		return 'Client Error';
	}

	if (code >= 500 && code < 600) {
		return 'Server Error';
	}

	return 'Unknown';
}

function toUtf8Bytes(value) {
	return new TextEncoder().encode(String(value ?? ''));
}

function toHttpResponseBytes(data) {
	if (data instanceof Uint8Array) {
		return data;
	}

	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}

	if (typeof data === 'string') {
		return toUtf8Bytes(data);
	}

	if (data == null) {
		return new Uint8Array(0);
	}

	try {
		return toUtf8Bytes(JSON.stringify(data));
	} catch {
		return toUtf8Bytes(data);
	}
}

function encodeBase64FromBytes(bytes) {
	if (typeof btoa === 'function') {
		let binary = '';
		for (let i = 0; i < bytes.length; i += 1) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i];
		const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
		const c = i + 2 < bytes.length ? bytes[i + 2] : 0;

		const triple = (a << 16) | (b << 8) | c;
		out += alphabet[(triple >> 18) & 63];
		out += alphabet[(triple >> 12) & 63];
		out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : '=';
		out += i + 2 < bytes.length ? alphabet[triple & 63] : '=';
	}

	return out;
}

function createHttpResponseBody(responseData) {
	const bodyBytes = toHttpResponseBytes(responseData);
	const createReader = () => {
		let done = false;
		return {
			read: async () => {
				if (done) {
					return { value: undefined, done: true };
				}
				done = true;
				return { value: bodyBytes, done: false };
			},
			releaseLock: () => {},
		};
	};

	return {
		__type: 'ReadableStream',
		getReader: () => createReader(),
		[Symbol.asyncIterator]: async function* () {
			yield bodyBytes;
		},
		toString: (encoding = 'utf8') => {
			const safeEncoding = String(encoding || 'utf8').toLowerCase();
			if (safeEncoding === 'base64') {
				return encodeBase64FromBytes(bodyBytes);
			}

			if (safeEncoding !== 'utf8' && safeEncoding !== 'utf-8') {
				throw new Error(`Unsupported response.body.toString encoding: ${safeEncoding}`);
			}

			return new TextDecoder().decode(bodyBytes);
		},
		toJSON: () => new TextDecoder().decode(bodyBytes),
	};
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
			const size = Number(out && out.size);
			return {
				path: this.filePath,
				exists: true,
				size: Number.isFinite(size) && size >= 0 ? size : undefined,
				mTime: resolveMetaTimeSeconds(out, 'mTime'),
				cTime: resolveMetaTimeSeconds(out, 'cTime'),
			};
		} catch {
			return { path: this.filePath, exists: false };
		}
	}
}

class AndroidDirectory extends DirectoryAdapter {
	constructor(path) {
		super(path);
	}

	async create(_permission = 0o755) {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return false;
		}
		try {
			await plugins.Filesystem.mkdir({ path: this.path, recursive: true });
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
			await plugins.Filesystem.rmdir({ path: this.path, recursive: true });
			return true;
		} catch {
			return false;
		}
	}

	async calcSize() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return 0;
		}

		let totalSize = 0;

		const walk = async (dirPath) => {
			const out = await plugins.Filesystem.readdir({ path: dirPath });
			const entries = Array.isArray(out?.files) ? out.files : [];

			for (const entry of entries) {
				const name = getAndroidDirEntryName(entry);
				if (!name) {
					continue;
				}

				const childPath = joinAndroidPath(dirPath, name);
				let traversed = false;

				if (isAndroidDirectoryEntry(entry)) {
					await walk(childPath);
					traversed = true;
				} else if (entry && typeof entry === 'object' && !String(entry.type || '').trim()) {
					try {
						await walk(childPath);
						traversed = true;
					} catch {
						traversed = false;
					}
				}

				if (traversed) {
					continue;
				}

				try {
					const file = new AndroidFile(childPath);
					for await (const chunk of file.open()) {
						totalSize += getChunkByteLength(chunk);
					}
				} catch {
					// Ignore unreadable entries while keeping traversal best-effort.
				}
			}
		};

		try {
			await walk(this.path);
			return totalSize;
		} catch {
			return 0;
		}
	}

	async list(_recursive = false) {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return [];
		}

		const baseDirPath = String(this.path || '').replace(/\\/g, '/').replace(/\/+$/g, '');

		const walk = async (dirPath, recursive, output) => {
			const out = await plugins.Filesystem.readdir({ path: dirPath });
			const entries = Array.isArray(out?.files) ? out.files : [];

			for (const entry of entries) {
				const name = getAndroidDirEntryName(entry);
				if (!name) {
					continue;
				}

				const childPath = joinAndroidPath(dirPath, name);
				const relativePath = toRelativeAndroidPath(baseDirPath, childPath);
				if (relativePath) {
					output.push(relativePath);
				}

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
			await walk(this.path, Boolean(_recursive), output);
			return output;
		} catch {
			return [];
		}
	}

	async getMeta() {
		const plugins = getCapacitorPlugins();
		if (!plugins || !plugins.Filesystem) {
			return { path: this.path, exists: false };
		}
		try {
			const out = await plugins.Filesystem.stat({ path: this.path });
			return {
				path: this.path,
				exists: true,
				mTime: resolveMetaTimeSeconds(out, 'mTime'),
				cTime: resolveMetaTimeSeconds(out, 'cTime'),
			};
		} catch {
			return { path: this.path, exists: false };
		}
	}
}

class AndroidHttpRequest extends HttpRequestAdapter {
	constructor(method = 'GET', url = '', body = null, headers = {}) {
		if (method && typeof method === 'object' && !Array.isArray(method)) {
			const legacy = method;
			method = legacy.method || 'GET';
			url = legacy.url || '';
			body = legacy.body ?? null;
			headers = legacy.headers || {};
		}

		const safeMethod = String(method || 'GET').trim().toUpperCase() || 'GET';
		const safeUrl = String(url || '').trim();
		const safeHeaders = headers && typeof headers === 'object' ? headers : {};
		const safeBody = body == null ? null : body;

		super(safeMethod, safeBody, safeHeaders);
		this.method = safeMethod;
		this.body = safeBody;
		this.headers = safeHeaders;
		this.url = safeUrl;
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
			if (typeof plugins.Geolocation.checkPermissions === 'function') {
				const permissionStatus = await plugins.Geolocation.checkPermissions();
				const locationStatus = String(permissionStatus?.location || '').trim().toLowerCase();
				const coarseStatus = String(permissionStatus?.coarseLocation || '').trim().toLowerCase();

				if (locationStatus !== 'granted' && coarseStatus !== 'granted') {
					return { lat: null, lon: null, available: false };
				}
			}

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
			sendRequest: async (request, timeout = null) => {
				if (!request || typeof request !== 'object') {
					throw new Error('HttpClient.sendRequest requires a request object');
				}

				const plugins = getCapacitorPlugins();
				if (!plugins || !plugins.Http) {
					throw new Error('Capacitor Http plugin unavailable');
				}

				const timeoutSeconds = timeout == null ? null : Number(timeout);
				const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
					? Math.floor(timeoutSeconds * 1000)
					: undefined;
				const appVersion = await getAndroidAppVersion();

				let data = null;
				if (
					request.body
					&& typeof request.body === 'object'
					&& (
						String(request.body.__type || '') === 'FileHandle'
						|| String(request.body.__type || '') === 'ReadableStream'
					)
				) {
					data = `@file:${String(request.body.__path || '')}`;
				} else {
					data = request.body ?? null;
				}

				const response = await plugins.Http.request({
					url: String(request.url || ''),
					method: String(request.method || 'GET').toUpperCase(),
					headers: withDefaultUserAgent(request.headers, appVersion),
					data,
					connectTimeout: timeoutMs,
					readTimeout: timeoutMs,
				});

				const body = createHttpResponseBody(response.data);

				return {
					statusCode: Number(response.status || 0),
					statusText: resolveStatusText(response.status, response.statusText),
					headers: response.headers || {},
					body,
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
