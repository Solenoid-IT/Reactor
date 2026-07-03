const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const path = require('path');
const AdmZip = require('adm-zip');
const { parseDirectiveHeader, rebuildDirectiveHeader } = require('./directiveHeader');
const { buildBackupZip, resolveSafeBackupTarget } = require('./backupArchive');
const { ensureExternalTemplatesDirectory, readEndpointTemplate } = require('./endpointTemplates');
const { readPermissionsState, writePermissionsState } = require('./permissionsState');
const { readUiSettings, writeUiSettings } = require('./uiSettings');

function getCurrentPlatformName() {
	switch (process.platform) {
		case 'darwin':
			return 'Mac';
		case 'win32':
			return 'Windows';
		case 'linux':
			return 'Linux';
		default:
			return 'Mac';
	}
}

async function openWithConfiguredProgramOrDefault(targetPath) {
	const settings = await readUiSettings();
	if (!settings.defaultProgramPath) {
		const shellError = await shell.openPath(targetPath);
		return shellError ? { ok: false, error: shellError } : { ok: true };
	}

	try {
		if (process.platform === 'darwin' && settings.defaultProgramPath.endsWith('.app')) {
			const child = spawn('open', ['-a', settings.defaultProgramPath, targetPath], {
				detached: true,
				stdio: 'ignore',
			});
			child.unref();
			return { ok: true };
		}

		const child = spawn(settings.defaultProgramPath, [targetPath], {
			detached: true,
			stdio: 'ignore',
		});
		child.unref();
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error.message || 'failed to launch default program' };
	}
}

function setupIpcHandlers(runtime, options = {}) {
	const forceQuitApp = typeof options.forceQuitApp === 'function'
		? options.forceQuitApp
		: () => app.exit(0);
	const endpointsRoot = runtime ? path.resolve(runtime.endpointsDir) : '';
	const projectRoot = runtime ? path.resolve(runtime.reactorRootDir || path.dirname(runtime.endpointsDir)) : '';

	ensureExternalTemplatesDirectory(projectRoot).catch((error) => {
		if (runtime && runtime.log) {
			runtime.log(`Template bootstrap skipped: ${error.message}`);
		}
	});

	function isPathInsideRoot(targetPath, rootPath) {
		if (!targetPath || !rootPath) {
			return false;
		}
		const normalizedTarget = path.resolve(targetPath);
		const normalizedRoot = path.resolve(rootPath);
		return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
	}

	function isAllowedEditorPath(targetPath) {
		return isPathInsideRoot(targetPath, endpointsRoot) || isPathInsideRoot(targetPath, projectRoot);
	}

	function isEditableExtension(targetPath) {
		return /\.(ts|js|log)$/i.test(targetPath || '');
	}

	function normalizePermissionNames(permissions) {
		return Array.isArray(permissions)
			? Array.from(new Set(permissions.map((permissionName) => String(permissionName || '').trim()).filter(Boolean)))
			: [];
	}

	async function requestGeolocationPermissionFromRenderer() {
		const activeWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((windowRef) => !windowRef.isDestroyed());
		if (!activeWindow || activeWindow.isDestroyed()) {
			return { granted: false, error: 'no active window for permission request' };
		}

		try {
			const result = await activeWindow.webContents.executeJavaScript(
				`(async () => {
					if (!globalThis.navigator || !navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== 'function') {
						return { granted: false, error: 'geolocation api unavailable in renderer' };
					}

					return await new Promise((resolve) => {
						navigator.geolocation.getCurrentPosition(
							() => resolve({ granted: true }),
							(error) => {
								const message = error && error.message ? String(error.message) : 'geolocation permission denied';
								resolve({ granted: false, error: message });
							},
							{ enableHighAccuracy: false, maximumAge: 0, timeout: 10000 },
						);
					});
				})()`,
				true,
			);

			return result && typeof result === 'object' ? result : { granted: false, error: 'invalid geolocation response' };
		} catch (error) {
			return { granted: false, error: error.message || 'unable to request geolocation permission' };
		}
	}

	async function applyRuntimeStateFromImportedConfig() {
		if (!runtime) {
			return;
		}

		try {
			const settings = await readUiSettings();
			if (runtime.setHttpServerPort && Number(settings.httpServerPort)) {
				await runtime.setHttpServerPort(Number(settings.httpServerPort)).catch(() => {});
			}
			if (runtime.setExchangeConfig) {
				await runtime
					.setExchangeConfig(
						settings.exchangeMode || 'node',
						settings.exchangeHost || '',
						Number(settings.exchangePort) || 7070,
						Boolean(settings.exchangeTls),
						settings.exchangeToken || '',
						Boolean(settings.exchangeDiscovery),
						settings.stun,
						settings.turn,
					)
					.catch(() => {});
			}
		} catch {
			// Ignore partial restore errors.
		}

		try {
			runtime.cachedReactorName = null;
		} catch {
			// ignore
		}

		if (runtime.reloadEndpoints) {
			await runtime.reloadEndpoints('ui-import-backup').catch(() => {});
		}
	}

	readUiSettings()
		.then(async (settings) => {
			if (runtime && runtime.setHttpServerPort && Number(settings.httpServerPort)) {
				await runtime.setHttpServerPort(Number(settings.httpServerPort));
			}
			if (runtime && runtime.setExchangeConfig && settings.exchangeMode) {
				await runtime
					.setExchangeConfig(
						settings.exchangeMode,
						settings.exchangeHost || '',
						Number(settings.exchangePort) || 7070,
						Boolean(settings.exchangeTls),
						settings.exchangeToken || '',
						Boolean(settings.exchangeDiscovery),
						settings.stun,
						settings.turn,
					)
					.catch(() => {});
			}
		})
		.catch(() => {
			// Ignore settings bootstrap failures.
		});

	ipcMain.handle('get-ui-settings', async () => {
		return readUiSettings();
	});

	ipcMain.handle('get-permissions-config', async () => {
		if (!runtime) {
			return { ok: false, error: 'runtime not ready', platform: getCurrentPlatformName(), permissions: {} };
		}

		try {
			const rootDir = runtime.reactorRootDir || path.dirname(runtime.endpointsDir);
			const permissions = await readPermissionsState(rootDir);
			return { ok: true, platform: getCurrentPlatformName(), permissions };
		} catch (error) {
			return { ok: false, error: error.message, platform: getCurrentPlatformName(), permissions: {} };
		}
	});

	ipcMain.handle('save-permissions-config', async (_, permissions) => {
		if (!runtime) {
			return { ok: false, error: 'runtime not ready', platform: getCurrentPlatformName(), permissions: {} };
		}

		try {
			const rootDir = runtime.reactorRootDir || path.dirname(runtime.endpointsDir);
			const nextPermissions = await writePermissionsState(rootDir, permissions);
			return { ok: true, platform: getCurrentPlatformName(), permissions: nextPermissions };
		} catch (error) {
			return { ok: false, error: error.message, platform: getCurrentPlatformName(), permissions: {} };
		}
	});

	ipcMain.handle('request-system-permissions', async (_, permissions) => {
		const normalizedPermissions = normalizePermissionNames(permissions);
		const granted = [];
		const denied = [];

		for (const permissionName of normalizedPermissions) {
			const normalizedName = String(permissionName || '').trim().toLowerCase();
			if (normalizedName === 'system.geolocation') {
				const geolocationResult = await requestGeolocationPermissionFromRenderer();
				if (geolocationResult && geolocationResult.granted) {
					granted.push(permissionName);
				} else {
					denied.push(permissionName);
				}
				continue;
			}

			granted.push(permissionName);
		}

		return {
			ok: true,
			platform: getCurrentPlatformName(),
			granted,
			denied,
		};
	});

	ipcMain.handle('open-system-permission-settings', async (_, permissions) => {
		try {
			const platformName = getCurrentPlatformName();
			const normalizedPermissions = normalizePermissionNames(permissions);
			const hasGeolocation = normalizedPermissions.some((permissionName) => String(permissionName || '').trim().toLowerCase() === 'system.geolocation');
			const hasFilesystem = normalizedPermissions.some((permissionName) => String(permissionName || '').trim().toLowerCase().startsWith('filesystem.'));

			if (process.platform === 'darwin') {
				const targetUrl = hasGeolocation
					? 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices'
					: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
				await shell.openExternal(targetUrl);
				return { ok: true, opened: true, platform: platformName, target: targetUrl, permissions: normalizedPermissions };
			}

			if (process.platform === 'win32') {
				const targetUrl = hasGeolocation
					? 'ms-settings:privacy-location'
					: hasFilesystem
						? 'ms-settings:privacy-broadfilesystemaccess'
						: 'ms-settings:appsfeatures-app';
				await shell.openExternal(targetUrl);
				return { ok: true, opened: true, platform: platformName, target: targetUrl, permissions: normalizedPermissions };
			}

			return { ok: false, opened: false, platform: platformName, error: 'system permission settings deep-link not available on this platform', permissions: normalizedPermissions };
		} catch (error) {
			return { ok: false, opened: false, platform: getCurrentPlatformName(), error: error.message || 'unable to open system permission settings' };
		}
	});

	ipcMain.handle('stop-background-process', async () => {
		try {
			setImmediate(() => {
				forceQuitApp();
			});
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-http-server-config', async () => {
		if (!runtime || !runtime.getHttpServerConfig) {
			return { ok: false, error: 'runtime not ready' };
		}

		return { ok: true, config: runtime.getHttpServerConfig() };
	});

	ipcMain.handle('set-http-server-port', async (_, port) => {
		if (!runtime || !runtime.setHttpServerPort) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			const config = await runtime.setHttpServerPort(port);
			await writeUiSettings({ httpServerPort: config.port });
			return { ok: true, config };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-http-server-logs', async (_, limit) => {
		if (!runtime || !runtime.getHttpServerLogs) {
			return { ok: false, error: 'runtime not ready' };
		}

		return { ok: true, logs: runtime.getHttpServerLogs(limit) };
	});

	ipcMain.handle('get-reactor-name', async () => {
		if (!runtime || !runtime.getReactorName) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			const name = await runtime.getReactorName();
			return { ok: true, name };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('set-reactor-name', async (_, name) => {
		if (!runtime || !runtime.setReactorName) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			const nextName = await runtime.setReactorName(name);
			return { ok: true, name: nextName };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('open-server-status', async () => {
		if (!runtime || !runtime.getHttpServerConfig) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			const config = runtime.getHttpServerConfig();
			const port = Number(config.port) || 7070;
			const targetUrl = `http://localhost:${port}`;
			await shell.openExternal(targetUrl);
			return { ok: true, url: targetUrl };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('pick-default-program', async () => {
		const result = await dialog.showOpenDialog({
			title: 'Select default program for endpoints',
			properties: ['openFile'],
		});

		if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
			return { ok: false, canceled: true };
		}

		const nextSettings = { defaultProgramPath: result.filePaths[0] };
		await writeUiSettings(nextSettings);
		return { ok: true, defaultProgramPath: nextSettings.defaultProgramPath };
	});

	ipcMain.handle('export-backup', async () => {
		if (!runtime) {
			return { ok: false, error: 'runtime not ready' };
		}

		const now = new Date();
		const pad = (value) => String(value).padStart(2, '0');
		const fileName = `reactor-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
		const saveResult = await dialog.showSaveDialog({
			title: 'Export Reactor backup',
			defaultPath: path.join(runtime.reactorRootDir || runtime.endpointsDir, fileName),
			filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
		});

		if (saveResult.canceled || !saveResult.filePath) {
			return { ok: false, canceled: true };
		}

		try {
			const zip = await buildBackupZip(runtime.reactorRootDir || path.dirname(runtime.endpointsDir));
			zip.writeZip(saveResult.filePath);
			return { ok: true, path: saveResult.filePath };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('import-backup', async () => {
		if (!runtime) {
			return { ok: false, error: 'runtime not ready' };
		}

		const openResult = await dialog.showOpenDialog({
			title: 'Import Reactor backup',
			properties: ['openFile'],
			filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
		});

		if (openResult.canceled || !openResult.filePaths || openResult.filePaths.length === 0) {
			return { ok: false, canceled: true };
		}

		const zipPath = openResult.filePaths[0];
		const rootDir = runtime.reactorRootDir || path.dirname(runtime.endpointsDir);

		try {
			const zip = new AdmZip(zipPath);
			const clearedRoots = new Set();
			for (const entry of zip.getEntries()) {
				if (entry.isDirectory) {
					continue;
				}

				const targetPath = resolveSafeBackupTarget(rootDir, entry.entryName);
				if (!targetPath) {
					continue;
				}

				const normalizedEntry = String(entry.entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
				const rootEntry = normalizedEntry.split('/')[0];
				if (rootEntry && rootEntry !== 'backup-meta.json' && !clearedRoots.has(rootEntry)) {
					const rootTargetPath = path.join(rootDir, rootEntry);
					await fs.rm(rootTargetPath, { recursive: true, force: true });
					clearedRoots.add(rootEntry);
				}

				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				await fs.writeFile(targetPath, entry.getData());
			}

			await applyRuntimeStateFromImportedConfig();
			return { ok: true, path: zipPath };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('open-endpoints-folder', async () => {
		if (runtime) {
			await shell.openPath(runtime.endpointsDir);
		}
	});

	ipcMain.handle('open-endpoint-file', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.endpointsDir);
		const normalizedFilePath = path.resolve(filePath);

		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		return openWithConfiguredProgramOrDefault(normalizedFilePath);
	});

	ipcMain.handle('read-endpoint-content', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const normalizedFilePath = path.resolve(filePath);
		if (!isAllowedEditorPath(normalizedFilePath)) {
			return { ok: false, error: 'path not allowed' };
		}

		if (!isEditableExtension(normalizedFilePath)) {
			return { ok: false, error: 'unsupported file type' };
		}

		try {
			const content = await fs.readFile(normalizedFilePath, 'utf8');
			return { ok: true, path: normalizedFilePath, content };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('save-endpoint-content', async (_, filePath, content) => {
		if (!runtime || !filePath || typeof content !== 'string') {
			return { ok: false, error: 'invalid request' };
		}

		const normalizedFilePath = path.resolve(filePath);
		if (!isAllowedEditorPath(normalizedFilePath)) {
			return { ok: false, error: 'path not allowed' };
		}

		if (!isEditableExtension(normalizedFilePath)) {
			return { ok: false, error: 'unsupported file type' };
		}

		try {
			await fs.writeFile(normalizedFilePath, content, 'utf8');
			if (/\.(ts|js)$/i.test(normalizedFilePath)) {
				await runtime.reloadEndpoints('ui-save-endpoint-content');
			}
			return { ok: true, path: normalizedFilePath };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('resolve-endpoint-log-path', async (_, filePath) => {
		if (!runtime) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		const logPath = runtime.resolveEndpointEventLogPath(filePath);
		if (!logPath) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		if (!isAllowedEditorPath(logPath)) {
			return { ok: false, error: 'path not allowed' };
		}

		if (!/\.log$/i.test(logPath)) {
			return { ok: false, error: 'unsupported file type' };
		}

		try {
			await fs.mkdir(path.dirname(logPath), { recursive: true });
			await fs.writeFile(logPath, '', { encoding: 'utf8', flag: 'a' });
			return { ok: true, path: logPath, name: path.basename(logPath) };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('run-endpoint-now', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.endpointsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		const endpoint = runtime.endpoints.find((candidate) => path.resolve(candidate.path) === normalizedFilePath);
		if (!endpoint) {
			return { ok: false, error: 'endpoint not loaded, refresh UI and retry' };
		}

			runtime
				.runEndpoint(endpoint, { trigger: 'MANUAL_TEST', event: 'ON_DEMAND', force: true })
			.catch((error) => {
				runtime.log(`Manual test failed for ${endpoint.name}: ${error.message}`);
			});

		return { ok: true, started: true, endpoint: endpoint.name };
	});

	ipcMain.handle('create-endpoint-file', async (_, templateKey, endpointName) => {
		if (!runtime) {
			return { ok: false, error: 'runtime not ready' };
		}

		await fs.mkdir(runtime.endpointsDir, { recursive: true });
		const allowedPath = path.resolve(runtime.endpointsDir);

		let targetPath = '';
		const requestedName = String(endpointName || '').trim();
		if (requestedName) {
			targetPath = path.resolve(path.join(runtime.endpointsDir, requestedName));
		} else {
			const saveResult = await dialog.showSaveDialog({
				title: 'Create new endpoint',
				defaultPath: path.join(runtime.endpointsDir, 'new-endpoint'),
			});

			if (saveResult.canceled || !saveResult.filePath) {
				return { ok: false, canceled: true };
			}

			targetPath = path.resolve(saveResult.filePath);
		}

		if (!targetPath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'target path outside endpoints directory' };
		}

		const requestedStem = path.basename(targetPath).replace(/\.(ts|js)$/i, '');
		const safeStem = String(requestedStem)
			.trim()
			.replace(/[^a-zA-Z0-9._-]/g, '-');

		if (!safeStem) {
			return { ok: false, error: 'invalid endpoint name' };
		}

		const projectRoot = path.join(path.dirname(targetPath), safeStem);
		if (!path.resolve(projectRoot).startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'project path outside endpoints directory' };
		}

		const appRootDir = path.resolve(runtime.reactorRootDir || path.dirname(runtime.endpointsDir));

		const endpointFileName = 'boot.ts';
		const endpointFilePath = path.join(projectRoot, endpointFileName);
		const projectUuidPath = path.join(projectRoot, 'uuid');
		const contextFilePath = path.join(projectRoot, 'event.ts');
		const packageJsonPath = path.join(projectRoot, 'package.json');
		const eventLogPath = path.join(projectRoot, 'activity.log');

		const npmSafeName = safeStem
			.toLowerCase()
			.replace(/[^a-z0-9._-]/g, '-')
			.replace(/^[._-]+/, '') || 'reactor-endpoint';

		let safeTemplateKey = 'schedule';
		let initialContent = '';
		try {
			const template = await readEndpointTemplate(templateKey, 'schedule', appRootDir);
			safeTemplateKey = template.key;
			initialContent = template.content;
		} catch (error) {
			return { ok: false, error: error.message || 'endpoint template file not found' };
		}
		const contextContent = [
			"export type { Event, ReactorEvent, WatchEvent, MessageEvent, StreamEvent, StreamEndEvent, ScheduleEvent, RuntimeEvent, ManualEvent } from 'core';",
			'',
		].join('\n');
		const packageJson = {
			name: npmSafeName,
			version: '1.0.0',
			private: true,
			type: 'commonjs',
			main: 'boot.ts',
			description: `Reactor endpoint project: ${safeStem}`,
		};

		try {
			const projectUuid = require('crypto').randomUUID().toLowerCase();
			await fs.mkdir(projectRoot);
			await fs.writeFile(projectUuidPath, `${projectUuid}\n`, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(contextFilePath, contextContent, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(endpointFilePath, initialContent, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(eventLogPath, '', { encoding: 'utf8', flag: 'wx' });
		} catch (error) {
			if (error.code === 'EEXIST' || error.code === 'ERR_FS_EISDIR') {
				return { ok: false, error: 'endpoint project already exists' };
			}
			return { ok: false, error: error.message };
		}

		try {
			await runtime.reloadEndpoints('ui-create-endpoint');
		} catch (error) {
			runtime.log(`Immediate reload after create failed: ${error.message}`);
		}

		return {
			ok: true,
			path: endpointFilePath,
			template: safeTemplateKey,
		};
	});

	ipcMain.handle('confirm-delete-endpoint', async (_, endpointName) => {
		const response = await dialog.showMessageBox({
			type: 'warning',
			title: 'Confirm endpoint deletion',
			message: `Are you sure to delete endpoint '${endpointName || 'this endpoint'}'?`,
			detail: 'This action is not reversible',
			buttons: ['Delete', 'Cancel'],
			defaultId: 1,
			cancelId: 1,
			noLink: true,
		});

		return { ok: true, confirmed: response.response === 0 };
	});

	ipcMain.handle('delete-endpoint-file', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.endpointsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		try {
			const endpointDir = path.dirname(normalizedFilePath);
			const isBootProjectEndpoint = path.basename(normalizedFilePath).toLowerCase() === 'boot.ts' && endpointDir !== allowedPath;

			let isProjectFolder = false;
			if (isBootProjectEndpoint && path.resolve(endpointDir).startsWith(allowedPath + path.sep)) {
				try {
					await fs.access(path.join(endpointDir, 'package.json'));
					isProjectFolder = true;
				} catch {
					isProjectFolder = false;
				}
			}

			if (isProjectFolder) {
				const packageJsonPath = path.join(endpointDir, 'package.json');
				try {
					await fs.access(packageJsonPath);
					await fs.rm(endpointDir, { recursive: true, force: true });
				} catch {
					await fs.unlink(normalizedFilePath);
				}
			} else {
				await fs.unlink(normalizedFilePath);
			}

			await runtime.reloadEndpoints('ui-delete-endpoint');
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('rename-endpoint-file', async (_, filePath, nextName) => {
		if (!runtime || !filePath || !nextName) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.endpointsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		const safeName = String(nextName)
			.trim()
			.replace(/[^a-zA-Z0-9._-]/g, '-');

		if (!safeName) {
			return { ok: false, error: 'invalid endpoint name' };
		}

		const originalExt = path.extname(normalizedFilePath) || '.ts';
		const hasKnownExtension = /\.(ts|js)$/i.test(safeName);
		const finalName = hasKnownExtension ? safeName : `${safeName}${originalExt}`;
		const destination = path.join(path.dirname(normalizedFilePath), finalName);

		if (!path.resolve(destination).startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'destination path not allowed' };
		}

		const currentDir = path.dirname(normalizedFilePath);
		const currentDirName = path.basename(currentDir);
		const finalStem = safeName.replace(/\.(ts|js)$/i, '');

		let isProjectFolder = false;
		if (
			path.basename(normalizedFilePath).toLowerCase() === 'boot.ts' &&
			currentDirName &&
			path.resolve(currentDir).startsWith(allowedPath + path.sep)
		) {
			try {
				await fs.access(path.join(currentDir, 'package.json'));
				isProjectFolder = true;
			} catch {
				isProjectFolder = false;
			}
		}

		if (isProjectFolder) {
			const destinationDir = path.join(path.dirname(currentDir), finalStem);
			if (!path.resolve(destinationDir).startsWith(allowedPath + path.sep)) {
				return { ok: false, error: 'destination path not allowed' };
			}

			if (path.resolve(destinationDir) !== path.resolve(currentDir)) {
				try {
					await fs.access(destinationDir);
					return { ok: false, error: 'an endpoint with this name already exists' };
				} catch (error) {
					if (error.code !== 'ENOENT') {
						return { ok: false, error: error.message };
					}
				}
			}

			try {
				if (path.resolve(destinationDir) !== path.resolve(currentDir)) {
					await fs.rename(currentDir, destinationDir);
				}

				const renamedFinalFilePath = path.join(destinationDir, 'boot.ts');

				const packageJsonPath = path.join(destinationDir, 'package.json');
				try {
					const packageRaw = await fs.readFile(packageJsonPath, 'utf8');
					const packageJson = JSON.parse(packageRaw);
					const npmSafeName = finalStem
						.toLowerCase()
						.replace(/[^a-z0-9._-]/g, '-')
						.replace(/^[._-]+/, '') || 'reactor-endpoint';
					packageJson.name = npmSafeName;
					await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
				} catch {
					// Ignore package.json update failures: endpoint file rename already succeeded.
				}

				await runtime.reloadEndpoints('ui-rename-endpoint');
				return { ok: true, path: renamedFinalFilePath, name: finalStem };
			} catch (error) {
				return { ok: false, error: error.message };
			}
		}

		try {
			if (path.resolve(destination) === normalizedFilePath) {
				return { ok: true, path: normalizedFilePath, name: path.basename(normalizedFilePath) };
			}

			await fs.access(destination);
			return { ok: false, error: 'an endpoint with this name already exists' };
		} catch (error) {
			if (error.code !== 'ENOENT') {
				return { ok: false, error: error.message };
			}
		}

		try {
			await fs.rename(normalizedFilePath, destination);
			await runtime.reloadEndpoints('ui-rename-endpoint');
			return { ok: true, path: destination, name: path.basename(destination) };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('reorder-endpoints', async (_, orderedPaths) => {
		if (!runtime || typeof runtime.reorderEndpointsByPaths !== 'function') {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			return await runtime.reorderEndpointsByPaths(orderedPaths);
		} catch (error) {
			return { ok: false, error: error.message || 'unable to reorder endpoints' };
		}
	});

	ipcMain.handle('toggle-endpoint-directive', async (_, filePath, directive) => {
		if (!runtime || !filePath || !directive) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.endpointsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		if (directive !== 'state' && directive !== 'mutex') {
			return { ok: false, error: 'invalid directive' };
		}

		try {
			let source = await fs.readFile(normalizedFilePath, 'utf8');

			if (directive === 'state') {
				const currentValues = parseDirectiveHeader(source);
				const current = currentValues.state || 'DISABLED';
				const next = current === 'ENABLED' ? 'DISABLED' : 'ENABLED';
				source = rebuildDirectiveHeader(source, { state: next });

				await fs.writeFile(normalizedFilePath, source, 'utf8');
				await runtime.reloadEndpoints('ui-toggle-state');
				return { ok: true, directive: 'state', value: next };
			}

			const currentValues = parseDirectiveHeader(source);
			const currentMutex = currentValues.mutex ? currentValues.mutex !== 'FALSE' : false;
			const nextMutex = !currentMutex;
			const nextValue = nextMutex ? 'TRUE' : 'FALSE';
			source = rebuildDirectiveHeader(source, { mutex: nextValue });

			await fs.writeFile(normalizedFilePath, source, 'utf8');
			await runtime.reloadEndpoints('ui-toggle-mutex');
			return { ok: true, directive: 'mutex', value: nextValue };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('open-event-log', async (_, filePath) => {
		if (!runtime) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		const logPath = runtime.resolveEndpointEventLogPath(filePath);
		if (!logPath) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		try {
			await fs.mkdir(path.dirname(logPath), { recursive: true });
			await fs.writeFile(logPath, '', { encoding: 'utf8', flag: 'a' });
			return { ok: true, path: logPath, name: path.basename(logPath) };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('clear-event-log', async (_, filePath) => {
		if (!runtime) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		const logPath = runtime.resolveEndpointEventLogPath(filePath);
		if (!logPath) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		try {
			await fs.writeFile(logPath, '', 'utf8');
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-workflow', async () => {
		if (!runtime) {
			return { ok: false, error: 'runtime not ready', workflow: { version: 1, nodes: [], links: [] } };
		}

		const workflowPath = path.join(runtime.reactorRootDir || path.dirname(runtime.endpointsDir), 'workflow.json');
		try {
			const raw = await fs.readFile(workflowPath, 'utf8');
			const parsed = JSON.parse(raw);
			const workflow = {
				version: Number(parsed?.version || 1),
				nodes: Array.isArray(parsed?.nodes) ? parsed.nodes : [],
				links: Array.isArray(parsed?.links) ? parsed.links : [],
				updatedAt: parsed?.updatedAt || null,
			};
			return { ok: true, workflow, path: workflowPath };
		} catch (error) {
			if (error.code === 'ENOENT') {
				const workflow = {
					version: 1,
					nodes: [],
					links: [],
					updatedAt: new Date().toISOString(),
				};
				return { ok: true, workflow, path: workflowPath };
			}
			return { ok: false, error: error.message, workflow: { version: 1, nodes: [], links: [] } };
		}
	});

	ipcMain.handle('save-workflow', async (_, workflow) => {
		if (!runtime) {
			return { ok: false, error: 'runtime not ready' };
		}

		const workflowPath = path.join(runtime.reactorRootDir || path.dirname(runtime.endpointsDir), 'workflow.json');
		const safeWorkflow = {
			version: Number(workflow?.version || 1),
			nodes: Array.isArray(workflow?.nodes) ? workflow.nodes : [],
			links: Array.isArray(workflow?.links) ? workflow.links : [],
			updatedAt: new Date().toISOString(),
		};

		try {
			await fs.mkdir(path.dirname(workflowPath), { recursive: true });
			await fs.writeFile(workflowPath, `${JSON.stringify(safeWorkflow, null, 2)}\n`, 'utf8');
			return { ok: true, workflow: safeWorkflow, path: workflowPath };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-exchange-config', async () => {
		if (!runtime || !runtime.getExchangeConfig) {
			return { ok: false, error: 'runtime not ready' };
		}
		return { ok: true, config: runtime.getExchangeConfig() };
	});

	ipcMain.handle('set-exchange-config', async (_, { mode, host, port, tls, token, discovery, stun, turn }) => {
		if (!runtime || !runtime.setExchangeConfig) {
			return { ok: false, error: 'runtime not ready' };
		}

		const safeMode = String(mode || 'node');
		const safeHost = String(host || '').trim();
		const safePort = Number(port) > 0 ? Number(port) : 7070;
		const safeTls = Boolean(tls);
		const safeToken = String(token || '').trim();
		const safeDiscovery = Boolean(discovery);
		const safeStun = stun && typeof stun === 'object' ? stun : {};
		const safeTurn = turn && typeof turn === 'object' ? turn : {};

		try {
			await writeUiSettings({ exchangeMode: safeMode, exchangeHost: safeHost, exchangePort: safePort, exchangeTls: safeTls, exchangeToken: safeToken, exchangeDiscovery: safeDiscovery, stun: safeStun, turn: safeTurn });
			await runtime.setExchangeConfig(safeMode, safeHost, safePort, safeTls, safeToken, safeDiscovery, safeStun, safeTurn);
			const connectionTest = runtime.testExchangeClientConnection
				? await runtime.testExchangeClientConnection(5000)
				: { connected: false, skipped: true, reason: 'connection test unavailable', elapsedMs: 0 };
			return { ok: true, config: runtime.getExchangeConfig(), connectionTest };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('save-relay-config', async (_, { kind, config }) => {
		if (!runtime || !runtime.setRelayConfig) {
			return { ok: false, error: 'runtime not ready' };
		}

		const safeKind = String(kind || '').trim().toLowerCase();
		if (!['stun', 'turn'].includes(safeKind)) {
			return { ok: false, error: 'invalid relay type: use stun or turn' };
		}

		const source = config && typeof config === 'object' ? config : {};
		const safeConfig = {
			host: String(source.host || '').trim(),
			port: Number(source.port) > 0 ? Number(source.port) : 3478,
			tls: Boolean(source.tls),
			username: String(source.username || source.user || '').trim(),
			password: String(source.password || '').trim(),
		};

		try {
			const result = await runtime.setRelayConfig(safeKind, safeConfig, true);
			await writeUiSettings(safeKind === 'stun' ? { stun: safeConfig } : { turn: safeConfig });
			return result;
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-exchange-linked-nodes', async () => {
		if (!runtime || !runtime.getExchangeLinkedNodesSnapshot) {
			return { ok: false, error: 'runtime not ready', nodes: [], total: 0 };
		}

		try {
			return await runtime.getExchangeLinkedNodesSnapshot();
		} catch (error) {
			return { ok: false, error: error.message || 'unable to load linked nodes', nodes: [], total: 0 };
		}
	});

	ipcMain.handle('get-p2p-status', async () => {
		if (!runtime || !runtime.getP2PStatus) {
			return { ok: false, error: 'runtime not ready', p2p: { enabled: false, sessions: [] } };
		}

		try {
			return { ok: true, p2p: runtime.getP2PStatus() };
		} catch (error) {
			return { ok: false, error: error.message || 'unable to read p2p status', p2p: { enabled: false, sessions: [] } };
		}
	});

	ipcMain.handle('send-p2p-signal', async (_, { target, signalType, payload, sessionId }) => {
		if (!runtime || !runtime.sendP2PSignal) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			return await runtime.sendP2PSignal(target, signalType, payload, { sessionId });
		} catch (error) {
			return { ok: false, error: error.message || 'unable to send p2p signal' };
		}
	});

	ipcMain.handle('close-p2p-session', async (_, { target, sessionId, payload }) => {
		if (!runtime || !runtime.closeP2PSession) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			return await runtime.closeP2PSession(target, { sessionId, payload });
		} catch (error) {
			return { ok: false, error: error.message || 'unable to close p2p session' };
		}
	});

	ipcMain.handle('request-remote-endpoints-p2p', async (_, { target, timeoutMs }) => {
		if (!runtime || !runtime.requestRemoteEndpointsP2P) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			return await runtime.requestRemoteEndpointsP2P(target, timeoutMs);
		} catch (error) {
			return { ok: false, error: error.message || 'unable to request remote endpoints via p2p' };
		}
	});

	ipcMain.handle('get-exchange-token', async () => {
		if (!runtime || !runtime.getExchangeToken) {
			return { ok: false, error: 'runtime not ready' };
		}
		try {
			const token = await runtime.getExchangeToken();
			return { ok: true, exchangeToken: token };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('generate-exchange-token', async () => {
		if (!runtime || !runtime.generateExchangeToken) {
			return { ok: false, error: 'runtime not ready' };
		}
		try {
			const token = await runtime.generateExchangeToken();
			await writeUiSettings({ exchangeToken: token.token || '' });
			return { ok: true, exchangeToken: token };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-tls-config', async () => {
		if (!runtime || !runtime.getTlsConfig) {
			return { ok: false, error: 'runtime not ready' };
		}
		try {
			const info = await runtime.getTlsConfig();
			return { ok: true, tls: info };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('generate-tls-cert', async () => {
		if (!runtime || !runtime.generateTlsCert) {
			return { ok: false, error: 'runtime not ready' };
		}
		try {
			const info = await runtime.generateTlsCert();
			return { ok: true, tls: info };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('delete-tls-cert', async () => {
		if (!runtime || !runtime.deleteTlsCert) {
			return { ok: false, error: 'runtime not ready' };
		}
		try {
			await runtime.deleteTlsCert();
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-message-queue-status', async () => {
		if (!runtime || !runtime.getMessageQueueStatus) {
			return { ok: false, error: 'runtime not ready' };
		}
		try {
			const status = await runtime.getMessageQueueStatus();
			return { ok: true, queue: status };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('set-message-queue-ttl-days', async (_, ttlDays) => {
		if (!runtime || !runtime.setMessageQueueTtlDays) {
			return { ok: false, error: 'runtime not ready' };
		}
		try {
			const status = await runtime.setMessageQueueTtlDays(ttlDays);
			return { ok: true, queue: status };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('flush-message-queue', async () => {
		if (!runtime || !runtime.flushMessageQueue || !runtime.getMessageQueueStatus) {
			return { ok: false, error: 'runtime not ready' };
		}
		try {
			await runtime.flushMessageQueue();
			const status = await runtime.getMessageQueueStatus();
			return { ok: true, queue: status };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('clear-message-queue', async () => {
		if (!runtime || !runtime.clearMessageQueue) {
			return { ok: false, error: 'runtime not ready' };
		}
		try {
			const status = await runtime.clearMessageQueue();
			return { ok: true, queue: status };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-endpoints-info', async () => {
		if (runtime) {
			const endpoints = runtime.endpoints.map((endpoint) => ({
				name: endpoint.name,
				path: endpoint.path,
				position: Number.isInteger(endpoint.position) ? endpoint.position : null,
				endpointId: endpoint.endpointId || null,
				eventLogPath: endpoint.eventLogPath,
				state: endpoint.state,
				enabled: endpoint.enabled,
				schedule: endpoint.schedule,
				events: endpoint.events,
				messageSenders: endpoint.messageSenders || [],
				messageFromAnySender: Boolean(endpoint.messageFromAnySender),
				mutex: endpoint.mutex,
				watch: endpoint.watch || [],
			}));
			return {
				path: runtime.endpointsDir,
				httpServer: runtime.getHttpServerConfig ? runtime.getHttpServerConfig() : null,
				endpoints,
			};
		}
		return { path: '', endpoints: [] };
	});
}

module.exports = {
	setupIpcHandlers,
};
