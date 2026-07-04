const fs = require('fs/promises');
const fsNative = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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

function getChunkByteLength(chunk) {
	if (Buffer.isBuffer(chunk)) {
		return chunk.length;
	}

	if (chunk instanceof Uint8Array) {
		return chunk.byteLength;
	}

	if (typeof chunk === 'string') {
		return Buffer.byteLength(chunk);
	}

	if (chunk && typeof chunk === 'object' && Number.isFinite(Number(chunk.byteLength))) {
		return Number(chunk.byteLength) || 0;
	}

	return Buffer.byteLength(String(chunk ?? ''));
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

function createHttpResponseBody(payloadBuffer) {
	const bodyBytes = Buffer.isBuffer(payloadBuffer)
		? payloadBuffer
		: Buffer.from(payloadBuffer || []);

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
		toString: (encoding = 'utf8') => bodyBytes.toString(String(encoding || 'utf8')),
		toJSON: () => bodyBytes.toString('utf8'),
	};
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

class NodeFile extends FileAdapter {
	constructor(filePath) {
		super(filePath);
		this.filePath = filePath;
	}

	async read() {
		try {
			return await fs.readFile(this.filePath, 'utf8');
		} catch {
			return null;
		}
	}

	open(options = {}) {
		return fsNative.createReadStream(this.filePath, options || {});
	}

	async write(content, append = false) {
		try {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });
			if (append) {
				await fs.appendFile(this.filePath, String(content), 'utf8');
			} else {
				await fs.writeFile(this.filePath, String(content), 'utf8');
			}
			return true;
		} catch {
			return false;
		}
	}

	async delete() {
		try {
			await fs.unlink(this.filePath);
			return true;
		} catch {
			return false;
		}
	}

	async getMeta() {
		try {
			const stats = await fs.stat(this.filePath);
			return {
				path: this.filePath,
				size: stats.size,
				mTime: normalizeEpochSeconds(stats.mtimeMs),
				cTime: normalizeEpochSeconds(stats.ctimeMs),
				exists: true,
			};
		} catch {
			return { path: this.filePath, exists: false };
		}
	}
}

class NodeDirectory extends DirectoryAdapter {
	constructor(path) {
		super(path);
	}

	async create(permission = 0o755) {
		try {
			await fs.mkdir(this.path, { recursive: true, mode: permission });
			return true;
		} catch {
			return false;
		}
	}

	async delete() {
		try {
			await fs.rm(this.path, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}

	async calcSize() {
		let totalSize = 0;

		const walk = async (currentDirPath) => {
			const entries = await fs.readdir(currentDirPath, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(currentDirPath, entry.name);

				if (entry.isDirectory()) {
					await walk(fullPath);
					continue;
				}

				if (!entry.isFile()) {
					continue;
				}

				const stream = fsNative.createReadStream(fullPath);
				for await (const chunk of stream) {
					totalSize += getChunkByteLength(chunk);
				}
			}
		};

		try {
			await walk(path.resolve(this.path));
			return totalSize;
		} catch {
			return 0;
		}
	}

	async list(recursive = false) {
		const out = [];
		const baseDir = path.resolve(this.path);
		const walk = async (baseDir) => {
			const entries = await fs.readdir(baseDir, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(baseDir, entry.name);
				const relativePath = path.relative(path.resolve(this.path), full).replace(/\\/g, '/');
				out.push(relativePath);
				if (recursive && entry.isDirectory()) {
					await walk(full);
				}
			}
		};

		try {
			await walk(baseDir);
			return out;
		} catch {
			return [];
		}
	}

	async getMeta() {
		try {
			const stats = await fs.stat(this.path);
			return {
				path: this.path,
				mTime: normalizeEpochSeconds(stats.mtimeMs),
				cTime: normalizeEpochSeconds(stats.ctimeMs),
				exists: true,
			};
		} catch {
			return { path: this.path, exists: false };
		}
	}
}

class NodeHttpRequest extends HttpRequestAdapter {
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

function isStreamLikeBody(body) {
	if (!body || typeof body === 'string') {
		return false;
	}

	if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
		return true;
	}

	return typeof body.pipe === 'function' || typeof body[Symbol.asyncIterator] === 'function';
}

function resolveNodeHttpRequestBody(body) {
	if (body == null || typeof body === 'string') {
		return body;
	}

	if (
		body
		&& typeof body === 'object'
		&& (
			String(body.__type || '') === 'FileHandle'
			|| String(body.__type || '') === 'ReadableStream'
		)
	) {
		const filePath = String(body.__path || '').trim();
		if (!filePath) {
			throw new Error('Invalid ReadableStream body: missing path');
		}
		return fsNative.createReadStream(filePath);
	}

	return body;
}

class NodeNetwork extends NetworkAdapter {
	async getStatus() {
		const interfaces = os.networkInterfaces();
		const online = Object.values(interfaces)
			.flat()
			.filter(Boolean)
			.some((addr) => !addr.internal);
		return { online };
	}
}

class NodeBattery extends BatteryAdapter {
	async exists() {
		return false;
	}
	async getLevel() {
		return -1;
	}
}

class NodePower extends PowerAdapter {
	async isBattery() {
		return false;
	}
}

class NodePosition extends PositionAdapter {
	static async get() {
		return { lat: null, lon: null, available: false };
	}
}

class NodeOS extends OSAdapter {
	getArch() {
		return os.arch();
	}
	isDesktop() {
		return true;
	}
	isMobile() {
		return false;
	}
	getName() {
		return os.platform();
	}
	getFullName() {
		return `${os.platform()} ${os.release()}`;
	}
}

class NodeNotify extends NotifyAdapter {
	resolveDesktopNotificationIconPath() {
		const candidates = [
			path.resolve(__dirname, '../../assets/logo.png'),
			path.resolve(process.cwd(), 'assets/logo.png'),
			process.resourcesPath ? path.resolve(process.resourcesPath, 'assets/logo.png') : '',
		].filter(Boolean);

		for (const candidate of candidates) {
			try {
				if (fsNative.existsSync(candidate)) {
					return candidate;
				}
			} catch {
				// Ignore fs access issues and try next candidate.
			}
		}

		return '';
	}

	buildWindowsToastScript(message, iconPath) {
		const escapedMessage = String(message || '')
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll("'", '&apos;')
			.replaceAll('"', '&quot;');

		let imageBlock = '';
		if (iconPath) {
			const iconUri = `file:///${iconPath.replaceAll('\\', '/').replaceAll(' ', '%20')}`;
			const safeIconUri = iconUri
				.replaceAll('&', '&amp;')
				.replaceAll('<', '&lt;')
				.replaceAll('>', '&gt;')
				.replaceAll("'", '&apos;')
				.replaceAll('"', '&quot;');
			imageBlock = `<image placement='appLogoOverride' src='${safeIconUri}' hint-crop='circle'/>`;
		}

		const xml = `<toast><visual><binding template='ToastGeneric'><text>Reactor</text><text>${escapedMessage}</text>${imageBlock}</binding></visual></toast>`;

		return [
			"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
			"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
			`$xmlText = ${JSON.stringify(xml)}`,
			"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
			"$xml.LoadXml($xmlText)",
			"$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
			"$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Reactor')",
			"$notifier.Show($toast)",
		].join('; ');
	}

	async notify(message) {
		const text = String(message || '').trim();
		if (!text) {
			return false;
		}

		const iconPath = this.resolveDesktopNotificationIconPath();

		try {
			if (process.platform === 'darwin') {
				await new Promise((resolve, reject) => {
					const child = spawn('osascript', ['-e', `display notification ${JSON.stringify(text)} with title "Reactor"`]);
					child.on('error', reject);
					child.on('exit', (code) => {
						if (code === 0) resolve();
						else reject(new Error(`osascript exited with code ${code}`));
					});
				});
				return true;
			}

			if (process.platform === 'linux') {
				await new Promise((resolve, reject) => {
					const args = iconPath ? ['-i', iconPath, 'Reactor', text] : ['Reactor', text];
					const child = spawn('notify-send', args);
					child.on('error', reject);
					child.on('exit', (code) => {
						if (code === 0) resolve();
						else reject(new Error(`notify-send exited with code ${code}`));
					});
				});
				return true;
			}

			if (process.platform === 'win32') {
				await new Promise((resolve, reject) => {
					const toastScript = this.buildWindowsToastScript(text, iconPath);
					const fallbackMessageBoxScript = [
						"[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')",
						`[System.Windows.Forms.MessageBox]::Show(${JSON.stringify(text)}, 'Reactor') | Out-Null`,
					].join('; ');
					const script = `try { ${toastScript} } catch { ${fallbackMessageBoxScript} }`;
					const child = spawn('powershell', ['-NoProfile', '-Command', script]);
					child.on('error', reject);
					child.on('exit', (code) => {
						if (code === 0) resolve();
						else reject(new Error(`powershell exited with code ${code}`));
					});
				});
				return true;
			}
		} catch {
			return false;
		}

		return false;
	}
}

class NodeProcess extends ProcessAdapter {
	constructor(command) {
		super(command);
		this.command = command;
	}

	async spawn() {
		return new Promise((resolve) => {
			const child = spawn(this.command, {
				shell: true,
				stdio: 'ignore',
				detached: true,
			});
			child.on('error', () => resolve(false));
			child.unref();
			resolve(true);
		});
	}
}

function createNodeRuntimeApi() {
	return {
		FileSystem: {
			File: NodeFile,
			Directory: NodeDirectory,
		},
		HttpClient: {
			Request: NodeHttpRequest,
			sendRequest: async (request, timeout = null) => {
				if (!request || typeof request !== 'object') {
					throw new Error('HttpClient.sendRequest requires a request object');
				}

				const controller = new AbortController();
				const timeoutSeconds = timeout == null ? null : Number(timeout);
				const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
					? Math.floor(timeoutSeconds * 1000)
					: null;
				const timer = timeoutMs == null
					? null
					: setTimeout(() => controller.abort(), timeoutMs);

				const body = resolveNodeHttpRequestBody(request.body ?? null);
				const init = {
					method: String(request.method || 'GET').toUpperCase(),
					headers: withDefaultUserAgent(request.headers),
					body,
					signal: controller.signal,
				};

				if (isStreamLikeBody(body)) {
					init.duplex = 'half';
				}

				try {
					const response = await fetch(String(request.url || ''), init);
					const bodyBytes = new Uint8Array(await response.arrayBuffer());
					const body = createHttpResponseBody(Buffer.from(bodyBytes));
					return {
						statusCode: response.status,
						statusText: resolveStatusText(response.status, response.statusText),
						headers: Object.fromEntries(response.headers.entries()),
						body,
					};
				} finally {
					if (timer) {
						clearTimeout(timer);
					}
				}
			},
		},
		Device: {
			Network: NodeNetwork,
			Battery: NodeBattery,
			Power: NodePower,
			Position: NodePosition,
			OS: NodeOS,
			notify: async (message) => new NodeNotify().notify(message),
		},
		System: {
			Process: NodeProcess,
			getHomeDirectory: async () => os.homedir(),
		},
	};
}

module.exports = {
	createNodeRuntimeApi,
	NodeFile,
	NodeDirectory,
	NodeHttpRequest,
	NodeNetwork,
	NodeBattery,
	NodePower,
	NodePosition,
	NodeOS,
	NodeNotify,
	NodeProcess,
};
