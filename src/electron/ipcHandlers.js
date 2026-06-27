const { dialog, ipcMain, shell } = require('electron');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const path = require('path');
const { parseDirectiveHeader, rebuildDirectiveHeader } = require('./directiveHeader');
const { readUiSettings, writeUiSettings } = require('./uiSettings');

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

function setupIpcHandlers(runtime) {
	const scriptsRoot = runtime ? path.resolve(runtime.scriptsDir) : '';
	const projectRoot = runtime ? path.resolve(runtime.reactorRootDir || path.dirname(runtime.scriptsDir)) : '';

	function isPathInsideRoot(targetPath, rootPath) {
		if (!targetPath || !rootPath) {
			return false;
		}
		const normalizedTarget = path.resolve(targetPath);
		const normalizedRoot = path.resolve(rootPath);
		return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
	}

	function isAllowedEditorPath(targetPath) {
		return isPathInsideRoot(targetPath, scriptsRoot) || isPathInsideRoot(targetPath, projectRoot);
	}

	function isEditableExtension(targetPath) {
		return /\.(ts|js|log)$/i.test(targetPath || '');
	}

	readUiSettings()
		.then(async (settings) => {
			if (runtime && runtime.setHttpServerPort && Number(settings.httpServerPort)) {
				await runtime.setHttpServerPort(Number(settings.httpServerPort));
			}
		})
		.catch(() => {
			// Ignore settings bootstrap failures.
		});

	ipcMain.handle('get-ui-settings', async () => {
		return readUiSettings();
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
			title: 'Select default program for scripts',
			properties: ['openFile'],
		});

		if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
			return { ok: false, canceled: true };
		}

		const nextSettings = { defaultProgramPath: result.filePaths[0] };
		await writeUiSettings(nextSettings);
		return { ok: true, defaultProgramPath: nextSettings.defaultProgramPath };
	});

	ipcMain.handle('open-scripts-folder', async () => {
		if (runtime) {
			await shell.openPath(runtime.scriptsDir);
		}
	});

	ipcMain.handle('open-script-file', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);

		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		return openWithConfiguredProgramOrDefault(normalizedFilePath);
	});

	ipcMain.handle('read-script-content', async (_, filePath) => {
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

	ipcMain.handle('save-script-content', async (_, filePath, content) => {
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
				await runtime.reloadScripts('ui-save-script-content');
			}
			return { ok: true, path: normalizedFilePath };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('resolve-event-log-path', async (_, filePath) => {
		if (!runtime) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		const logPath = runtime.resolveScriptEventLogPath(filePath);
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

	ipcMain.handle('run-script-now', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		const script = runtime.scripts.find((candidate) => path.resolve(candidate.path) === normalizedFilePath);
		if (!script) {
			return { ok: false, error: 'script not loaded, refresh UI and retry' };
		}

		runtime
			.runScript(script, { trigger: 'MANUAL_TEST', event: 'ON_DEMAND', force: true })
			.catch((error) => {
				runtime.log(`Manual test failed for ${script.name}: ${error.message}`);
			});

		return { ok: true, started: true, script: script.name };
	});

	ipcMain.handle('create-script-file', async (_, templateKey) => {
		if (!runtime) {
			return { ok: false, error: 'runtime not ready' };
		}

		await fs.mkdir(runtime.scriptsDir, { recursive: true });
		const saveResult = await dialog.showSaveDialog({
			title: 'Create new script',
			defaultPath: path.join(runtime.scriptsDir, 'new-script'),
		});

		if (saveResult.canceled || !saveResult.filePath) {
			return { ok: false, canceled: true };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const targetPath = path.resolve(saveResult.filePath);
		if (!targetPath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'target path outside scripts directory' };
		}

		const requestedStem = path.basename(targetPath).replace(/\.(ts|js)$/i, '');
		const safeStem = String(requestedStem)
			.trim()
			.replace(/[^a-zA-Z0-9._-]/g, '-');

		if (!safeStem) {
			return { ok: false, error: 'invalid script name' };
		}

		const projectRoot = path.join(path.dirname(targetPath), safeStem);
		if (!path.resolve(projectRoot).startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'project path outside scripts directory' };
		}

		const scriptFileName = 'boot.ts';
		const scriptFilePath = path.join(projectRoot, scriptFileName);
		const contextFilePath = path.join(projectRoot, 'context.ts');
		const packageJsonPath = path.join(projectRoot, 'package.json');
		const eventLogPath = path.join(projectRoot, 'activity.log');

		const npmSafeName = safeStem
			.toLowerCase()
			.replace(/[^a-z0-9._-]/g, '-')
			.replace(/^[._-]+/, '') || 'reactor-script';

		const templateMap = {
			blank: [
				'// @state DISABLED',
				'// @mutex OFF',
				'',
				'',
				'',
				"import { log } from 'core';",
				"import type { Context } from 'core';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait log('new blank script');",
				'}',
				'',
			],
			schedule: [
				'// @state DISABLED',
				'// @mutex OFF',
				'// @schedule EVERY 30 SECOND',
				'',
				'',
				'',
				"import { log } from 'core';",
				"import type { Context } from 'core';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait log('scheduled script tick');",
				'}',
				'',
			],
			event: [
				'// @state DISABLED',
				'// @mutex ON',
				'// @on MESSAGE(sender_1)',
				'',
				'',
				'',
				"import { log } from 'core';",
				"import type { Context } from 'core';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait log('message from ' + (ctx.messageSenderName || ctx.messageSender || 'unknown') + ': ' + (ctx.messageContent || ''));",
				'}',
				'',
			],
			watch: [
				'// @state DISABLED',
				'// @mutex ON',
				'// @watch /Abs/Path/of/Desktop',
				'// @watch /Abs/Path/of/Downloads [file:created]',
				'',
				'',
				'',
				"import { log } from 'core';",
				"import type { Context } from 'core';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait log('watch event: ' + ctx.watchPath + ' (' + ctx.watchType + ')');",
				'}',
				'',
			],
		};

		const safeTemplateKey = templateKey && templateMap[templateKey] ? templateKey : 'schedule';
		const initialContent = templateMap[safeTemplateKey].join('\n');
		const contextContent = [
			"export type { Context } from 'core';",
			'',
		].join('\n');
		const packageJson = {
			name: npmSafeName,
			version: '1.0.0',
			private: true,
			type: 'commonjs',
			main: 'boot.ts',
			description: `Reactor script project: ${safeStem}`,
		};

		try {
			await fs.mkdir(projectRoot);
			await fs.writeFile(contextFilePath, contextContent, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(scriptFilePath, initialContent, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(eventLogPath, '', { encoding: 'utf8', flag: 'wx' });
		} catch (error) {
			if (error.code === 'EEXIST' || error.code === 'ERR_FS_EISDIR') {
				return { ok: false, error: 'script project already exists' };
			}
			return { ok: false, error: error.message };
		}

		const openResult = await openWithConfiguredProgramOrDefault(scriptFilePath);

		try {
			await runtime.reloadScripts('ui-create-script');
		} catch (error) {
			runtime.log(`Immediate reload after create failed: ${error.message}`);
		}

		return {
			ok: true,
			path: scriptFilePath,
			template: safeTemplateKey,
			opened: openResult.ok,
			openError: openResult.ok ? null : openResult.error,
		};
	});

	ipcMain.handle('confirm-delete-script', async (_, scriptName) => {
		const response = await dialog.showMessageBox({
			type: 'warning',
			title: 'Confirm script deletion',
			message: `Are you sure to delete ${scriptName || 'this script'}?`,
			detail: 'This action is not reversible',
			buttons: ['Delete', 'Cancel'],
			defaultId: 1,
			cancelId: 1,
			noLink: true,
		});

		return { ok: true, confirmed: response.response === 0 };
	});

	ipcMain.handle('delete-script-file', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		try {
			const scriptDir = path.dirname(normalizedFilePath);
			const isBootProjectScript = path.basename(normalizedFilePath).toLowerCase() === 'boot.ts' && scriptDir !== allowedPath;

			let isProjectFolder = false;
			if (isBootProjectScript && path.resolve(scriptDir).startsWith(allowedPath + path.sep)) {
				try {
					await fs.access(path.join(scriptDir, 'package.json'));
					isProjectFolder = true;
				} catch {
					isProjectFolder = false;
				}
			}

			if (isProjectFolder) {
				const packageJsonPath = path.join(scriptDir, 'package.json');
				try {
					await fs.access(packageJsonPath);
					await fs.rm(scriptDir, { recursive: true, force: true });
				} catch {
					await fs.unlink(normalizedFilePath);
				}
			} else {
				await fs.unlink(normalizedFilePath);
			}

			await runtime.reloadScripts('ui-delete-script');
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('rename-script-file', async (_, filePath, nextName) => {
		if (!runtime || !filePath || !nextName) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		const safeName = String(nextName)
			.trim()
			.replace(/[^a-zA-Z0-9._-]/g, '-');

		if (!safeName) {
			return { ok: false, error: 'invalid script name' };
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
					return { ok: false, error: 'a script with this name already exists' };
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
						.replace(/^[._-]+/, '') || 'reactor-script';
					packageJson.name = npmSafeName;
					await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
				} catch {
					// Ignore package.json update failures: script file rename already succeeded.
				}

				await runtime.reloadScripts('ui-rename-script');
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
			return { ok: false, error: 'a script with this name already exists' };
		} catch (error) {
			if (error.code !== 'ENOENT') {
				return { ok: false, error: error.message };
			}
		}

		try {
			await fs.rename(normalizedFilePath, destination);
			await runtime.reloadScripts('ui-rename-script');
			return { ok: true, path: destination, name: path.basename(destination) };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('toggle-script-directive', async (_, filePath, directive) => {
		if (!runtime || !filePath || !directive) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
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
				await runtime.reloadScripts('ui-toggle-state');
				return { ok: true, directive: 'state', value: next };
			}

			const currentValues = parseDirectiveHeader(source);
			const currentMutex = currentValues.mutex ? currentValues.mutex !== 'OFF' : false;
			const nextMutex = !currentMutex;
			const nextValue = nextMutex ? 'ON' : 'OFF';
			source = rebuildDirectiveHeader(source, { mutex: nextValue });

			await fs.writeFile(normalizedFilePath, source, 'utf8');
			await runtime.reloadScripts('ui-toggle-mutex');
			return { ok: true, directive: 'mutex', value: nextValue };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('open-event-log', async (_, filePath) => {
		if (!runtime) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		const logPath = runtime.resolveScriptEventLogPath(filePath);
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

		const logPath = runtime.resolveScriptEventLogPath(filePath);
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

		const workflowPath = path.join(runtime.reactorRootDir || path.dirname(runtime.scriptsDir), 'workflow.json');
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

		const workflowPath = path.join(runtime.reactorRootDir || path.dirname(runtime.scriptsDir), 'workflow.json');
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

	ipcMain.handle('get-scripts-info', async () => {
		if (runtime) {
			return {
				path: runtime.scriptsDir,
				httpServer: runtime.getHttpServerConfig ? runtime.getHttpServerConfig() : null,
				scripts: runtime.scripts.map((s) => ({
					name: s.name,
					path: s.path,
					eventLogPath: s.eventLogPath,
					state: s.state,
					enabled: s.enabled,
					schedule: s.schedule,
					events: s.events,
					messageSenders: s.messageSenders || [],
					messageFromAnySender: Boolean(s.messageFromAnySender),
					mutex: s.mutex,
					watch: s.watch || [],
				})),
			};
		}
		return { path: '', scripts: [] };
	});
}

module.exports = {
	setupIpcHandlers,
};
