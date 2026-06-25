class FileWriter {
	async appendText(_filePath, _content, _encoding = 'utf8') {
		throw new Error('FileWriter.appendText not implemented');
	}
}

class HttpClient {
	async request(_request) {
		throw new Error('HttpClient.request not implemented');
	}
}

class PermissionManager {
	async ensurePermissions(_permissions) {
		throw new Error('PermissionManager.ensurePermissions not implemented');
	}
}

module.exports = {
	FileWriter,
	HttpClient,
	PermissionManager,
};
