const fs = require('fs/promises');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { FileWriter, HttpClient, PermissionManager } = require('./contracts');

class NodeFileWriter extends FileWriter {
	async appendText(filePath, content, encoding = 'utf8') {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.appendFile(filePath, content, encoding);
	}
}

class NodeHttpClient extends HttpClient {
	async request({ url, method = 'GET', headers = {}, body, insecureTls = false }) {
		if (insecureTls && String(url || '').toLowerCase().startsWith('https://')) {
			return this.requestWithInsecureTls({ url, method, headers, body });
		}

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

	requestWithInsecureTls({ url, method = 'GET', headers = {}, body }) {
		return new Promise((resolve, reject) => {
			let parsedUrl;
			try {
				parsedUrl = new URL(url);
			} catch (error) {
				reject(error);
				return;
			}

			const request = https.request(
				{
					protocol: parsedUrl.protocol,
					hostname: parsedUrl.hostname,
					port: parsedUrl.port || 443,
					path: `${parsedUrl.pathname}${parsedUrl.search}`,
					method,
					headers,
					rejectUnauthorized: false,
				},
				(response) => {
					const chunks = [];
					response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
					response.on('end', () => {
						const responseBody = Buffer.concat(chunks).toString('utf8');
						const normalizedHeaders = Object.fromEntries(
							Object.entries(response.headers || {}).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')]),
						);
						resolve({
							status: Number(response.statusCode || 0),
							headers: normalizedHeaders,
							body: responseBody,
						});
					});
				},
			);

			request.on('error', reject);

			if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
				request.write(body);
			}

			request.end();
		});
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
