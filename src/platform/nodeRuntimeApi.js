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
	ProcessAdapter,
} = require('./runtimeApiContracts');

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

	readStream(options = {}) {
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
				mtimeMs: stats.mtimeMs,
				ctimeMs: stats.ctimeMs,
				exists: true,
			};
		} catch {
			return { path: this.filePath, exists: false };
		}
	}
}

class NodeDirectory extends DirectoryAdapter {
	constructor(dirPath) {
		super(dirPath);
		this.dirPath = dirPath;
	}

	async create(permission = 0o755) {
		try {
			await fs.mkdir(this.dirPath, { recursive: true, mode: permission });
			return true;
		} catch {
			return false;
		}
	}

	async delete() {
		try {
			await fs.rm(this.dirPath, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}

	async list(recursive = false) {
		const out = [];
		const walk = async (baseDir) => {
			const entries = await fs.readdir(baseDir, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(baseDir, entry.name);
				out.push(full);
				if (recursive && entry.isDirectory()) {
					await walk(full);
				}
			}
		};

		try {
			await walk(this.dirPath);
			return out;
		} catch {
			return [];
		}
	}

	async getMeta() {
		try {
			const stats = await fs.stat(this.dirPath);
			return {
				path: this.dirPath,
				mtimeMs: stats.mtimeMs,
				ctimeMs: stats.ctimeMs,
				exists: true,
			};
		} catch {
			return { path: this.dirPath, exists: false };
		}
	}
}

class NodeHttpRequest extends HttpRequestAdapter {
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
			sendRequest: async (request, timeout = 30000) => {
				if (!request || typeof request !== 'object') {
					throw new Error('HttpClient.sendRequest requires a request object');
				}

				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeout);
				try {
					const response = await fetch(String(request.url || ''), {
						method: String(request.method || 'GET').toUpperCase(),
						headers: request.headers || {},
						body: request.body ?? null,
						signal: controller.signal,
					});
					const body = await response.text();
					return {
						status: response.status,
						headers: Object.fromEntries(response.headers.entries()),
						body,
					};
				} finally {
					clearTimeout(timer);
				}
			},
		},
		Device: {
			Network: NodeNetwork,
			Battery: NodeBattery,
			Power: NodePower,
			Position: NodePosition,
			OS: NodeOS,
		},
		System: {
			Process: NodeProcess,
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
	NodeProcess,
};
