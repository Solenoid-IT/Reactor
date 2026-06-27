const { BrowserWindow, screen } = require('electron');
const fsNative = require('fs');
const http = require('http');
const path = require('path');

let staticUiServer = null;
let staticUiServerUrl = null;
let staticUiServerReady = null;

function getContentType(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.html') {
		return 'text/html; charset=utf-8';
	}
	if (ext === '.js') {
		return 'application/javascript; charset=utf-8';
	}
	if (ext === '.css') {
		return 'text/css; charset=utf-8';
	}
	if (ext === '.json') {
		return 'application/json; charset=utf-8';
	}
	if (ext === '.svg') {
		return 'image/svg+xml';
	}
	if (ext === '.png') {
		return 'image/png';
	}
	if (ext === '.jpg' || ext === '.jpeg') {
		return 'image/jpeg';
	}
	if (ext === '.woff2') {
		return 'font/woff2';
	}
	return 'application/octet-stream';
}

function ensureStaticUiServer(buildDir) {
	if (staticUiServerUrl) {
		return Promise.resolve(staticUiServerUrl);
	}

	if (staticUiServerReady) {
		return staticUiServerReady;
	}

	staticUiServerReady = new Promise((resolve, reject) => {
		staticUiServer = http.createServer((req, res) => {
			const requestPathRaw = (req.url || '/').split('?')[0];
			const requestPath = requestPathRaw === '/' ? '/index.html' : requestPathRaw;
			const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^\/+/, '');

			if (normalized.includes('..')) {
				res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Forbidden');
				return;
			}

			const filePath = path.join(buildDir, normalized);
			if (!filePath.startsWith(buildDir + path.sep) && filePath !== path.join(buildDir, 'index.html')) {
				res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Forbidden');
				return;
			}

			fsNative.readFile(filePath, (error, content) => {
				if (error) {
					res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end('Not found');
					return;
				}

				res.writeHead(200, { 'Content-Type': getContentType(filePath), 'Cache-Control': 'no-cache' });
				res.end(content);
			});
		});

		staticUiServer.once('error', (error) => {
			staticUiServerReady = null;
			reject(error);
		});

		staticUiServer.listen(0, '127.0.0.1', () => {
			const address = staticUiServer.address();
			const port = address && typeof address === 'object' ? address.port : null;
			if (!port) {
				staticUiServerReady = null;
				reject(new Error('unable to resolve static UI server port'));
				return;
			}

			staticUiServerUrl = `http://127.0.0.1:${port}/`;
			resolve(staticUiServerUrl);
		});
	});

	return staticUiServerReady;
}

function createMainWindow() {
	const preloadPath = path.join(__dirname, '..', '..', 'preload.js');
	const devUiUrl = process.env.REACTOR_UI_DEV_URL ? String(process.env.REACTOR_UI_DEV_URL).trim() : '';
	const builtUiDir = path.join(__dirname, '..', '..', 'ui', 'build');
	const builtUiPath = path.join(__dirname, '..', '..', 'ui', 'build', 'index.html');
	const { width, height } = screen.getPrimaryDisplay().workAreaSize;
	const mainWindow = new BrowserWindow({
		width,
		height,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});

	if (devUiUrl) {
		mainWindow.loadURL(devUiUrl);
	} else if (fsNative.existsSync(builtUiPath)) {
		ensureStaticUiServer(builtUiDir)
			.then((url) => {
				if (!mainWindow.isDestroyed()) {
					mainWindow.loadURL(url);
				}
			})
			.catch(() => {
				if (!mainWindow.isDestroyed()) {
					mainWindow.loadFile(builtUiPath);
				}
			});
	} else {
		mainWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent('<!doctype html><html><body style="font-family:sans-serif;background:#111;color:#fff;padding:24px"><h2>Reactor UI non trovata</h2><p>Esegui: npm run ui:build</p></body></html>'));
	}

	mainWindow.maximize();
	return mainWindow;
}

module.exports = {
	createMainWindow,
};
