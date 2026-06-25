const fs = require('fs/promises');
const path = require('path');
const { FileWriter, HttpClient, PermissionManager } = require('./contracts');

class NodeFileWriter extends FileWriter {
	async appendText(filePath, content, encoding = 'utf8') {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.appendFile(filePath, content, encoding);
	}
}

class NodeHttpClient extends HttpClient {
	async request({ url, method = 'GET', headers = {}, body }) {
		const response = await fetch(url, {
			method,
			headers,
			body,
		});

		const text = await response.text();
		return {
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			body: text,
		};
	}
}

class NodePermissionManager extends PermissionManager {
	async ensurePermissions(_permissions) {
		return { granted: true, denied: [] };
	}
}

function createNodePlatformServices() {
	return {
		fileWriter: new NodeFileWriter(),
		httpClient: new NodeHttpClient(),
		permissionManager: new NodePermissionManager(),
	};
}

module.exports = {
	createNodePlatformServices,
	NodeFileWriter,
	NodeHttpClient,
	NodePermissionManager,
};
