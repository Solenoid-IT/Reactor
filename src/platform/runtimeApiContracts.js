class FileMeta {}
class DirectoryMeta {}
class NetworkStatus {}

class FileAdapter {
	constructor(_filePath) {}
	async read() {
		throw new Error('FileAdapter.read not implemented');
	}
	readStream(_options = {}) {
		throw new Error('FileAdapter.readStream not implemented');
	}
	async write(_content, _append = false) {
		throw new Error('FileAdapter.write not implemented');
	}
	async delete() {
		throw new Error('FileAdapter.delete not implemented');
	}
	async getMeta() {
		throw new Error('FileAdapter.getMeta not implemented');
	}
}

class DirectoryAdapter {
	constructor(_dirPath) {}
	async create(_permission = 0o755) {
		throw new Error('DirectoryAdapter.create not implemented');
	}
	async delete() {
		throw new Error('DirectoryAdapter.delete not implemented');
	}
	async list(_recursive = false) {
		throw new Error('DirectoryAdapter.list not implemented');
	}
	async getMeta() {
		throw new Error('DirectoryAdapter.getMeta not implemented');
	}
}

class HttpRequestAdapter {
	constructor(_method, _body, _headers) {}
	async send(_timeout = 30000) {
		throw new Error('HttpRequestAdapter.send not implemented');
	}
}

class NetworkAdapter {
	async getStatus() {
		throw new Error('NetworkAdapter.getStatus not implemented');
	}
}

class BatteryAdapter {
	async exists() {
		throw new Error('BatteryAdapter.exists not implemented');
	}
	async getLevel() {
		throw new Error('BatteryAdapter.getLevel not implemented');
	}
}

class PowerAdapter {
	async isBattery() {
		throw new Error('PowerAdapter.isBattery not implemented');
	}
}

class PositionAdapter {
	static async get() {
		throw new Error('PositionAdapter.get not implemented');
	}
}

class OSAdapter {
	getArch() {
		throw new Error('OSAdapter.getArch not implemented');
	}
	isDesktop() {
		throw new Error('OSAdapter.isDesktop not implemented');
	}
	isMobile() {
		throw new Error('OSAdapter.isMobile not implemented');
	}
	getName() {
		throw new Error('OSAdapter.getName not implemented');
	}
	getFullName() {
		throw new Error('OSAdapter.getFullName not implemented');
	}
}

class NotifyAdapter {
	async notify(_message) {
		throw new Error('NotifyAdapter.notify not implemented');
	}
}

class ProcessAdapter {
	constructor(_command) {}
	async spawn() {
		throw new Error('ProcessAdapter.spawn not implemented');
	}
}

module.exports = {
	FileMeta,
	DirectoryMeta,
	NetworkStatus,
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
};
