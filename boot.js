const { app, BrowserWindow, session } = require('electron');
const fs = require('fs/promises');
const fsNative = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ReactorRuntime } = require('./src/runtime');
const { createMainWindow } = require('./src/electron/window');
const { setupIpcHandlers } = require('./src/electron/ipcHandlers');

// Constants
const EXTERNAL_ENDPOINTS_DIR = path.join(app.getPath('userData'), 'endpoints');
const EVENT_LOG_PATH = path.join(app.getPath('userData'), 'activity.log');

function parseEnvFileValue(rawValue) {
	const value = String(rawValue || '').trim();
	if (!value) {
		return '';
	}

	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}

	return value;
}

function loadEnvFileIfPresentSync(filePath) {
	if (!filePath) {
		return false;
	}

	try {
		if (!fsNative.existsSync(filePath)) {
			return false;
		}

		const raw = fsNative.readFileSync(filePath, 'utf8');
		for (const rawLine of String(raw || '').split(/\r?\n/)) {
			const line = String(rawLine || '').trim();
			if (!line || line.startsWith('#')) {
				continue;
			}

			const equalIndex = line.indexOf('=');
			if (equalIndex < 1) {
				continue;
			}

			let key = line.slice(0, equalIndex).trim();
			if (key.startsWith('export ')) {
				key = key.slice(7).trim();
			}

			if (!key) {
				continue;
			}

			if (Object.prototype.hasOwnProperty.call(process.env, key) && String(process.env[key] || '').trim()) {
				continue;
			}

			process.env[key] = parseEnvFileValue(line.slice(equalIndex + 1));
		}

		return true;
	} catch {
		return false;
	}
}

loadEnvFileIfPresentSync(process.env.REACTOR_ENV_FILE || path.join(__dirname, '.env'));

function shouldShowWindowOnLaunch() {
	if (process.argv.includes('--reactor-background-startup')) {
		return false;
	}

	if (process.env.REACTOR_SHOW_WINDOW === '1') {
		return true;
	}

	if (process.env.REACTOR_SHOW_WINDOW === '0') {
		return false;
	}

	if (process.platform === 'darwin') {
		const loginItemSettings = app.getLoginItemSettings();
		const openedAtLogin = Boolean(loginItemSettings.wasOpenedAtLogin || loginItemSettings.wasOpenedAsHidden);
		return !openedAtLogin;
	}

	return true;
}

function shouldPersistInBackground() {
	const raw = String(process.env.REACTOR_PERSIST_BACKGROUND || '').trim().toLowerCase();
	if (raw === '0' || raw === 'false' || raw === 'no') {
		return false;
	}

	return true;
}

const SHOW_WINDOW = shouldShowWindowOnLaunch();
const PERSIST_BACKGROUND = shouldPersistInBackground();

// Globals
let mainWindow;
let runtime;
let isQuitting = false;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function getMacLaunchAgentPath() {
	return path.join(os.homedir(), 'Library', 'LaunchAgents', 'it.solenoid.reactor.plist');
}

function unloadMacLaunchAgent() {
	if (process.platform !== 'darwin') {
		return;
	}

	const plistPath = getMacLaunchAgentPath();
	const domainTarget = `gui/${process.getuid()}`;
	spawnSync('launchctl', ['bootout', domainTarget, plistPath], { stdio: 'ignore' });
}

function forceQuitApp() {
	isQuitting = true;
	unloadMacLaunchAgent();

	try {
		if (runtime) {
			runtime.cleanup();
		}
	} catch {
		// Best effort cleanup before forced exit.
	}

	for (const windowRef of BrowserWindow.getAllWindows()) {
		try {
			windowRef.destroy();
		} catch {
			// Ignore window teardown failures during forced exit.
		}
	}

	app.exit(0);
}

function wireBackgroundWindowBehavior(windowRef) {
	if (!windowRef || windowRef.isDestroyed()) {
		return;
	}

	windowRef.on('close', (event) => {
		if (!PERSIST_BACKGROUND || isQuitting) {
			return;
		}

		event.preventDefault();
		windowRef.hide();
		if (app.dock) {
			app.dock.hide();
		}
		if (runtime) {
			runtime.log('Window close intercepted: app is still running in background');
		}
	});

	windowRef.on('show', () => {
		if (app.dock) {
			app.dock.show();
		}
	});
}

/**
 * Configures app for background mode: auto-start, hidden dock
 */
function configureBackgroundMode() {
	if (process.platform === 'darwin' && app.isPackaged) {
		app.setLoginItemSettings({
			openAtLogin: false,
			openAsHidden: false,
			args: [],
		});

		if (!SHOW_WINDOW && app.dock) {
			app.dock.hide();
		}
		return;
	}

	app.setLoginItemSettings({
		openAtLogin: true,
		openAsHidden: true,
		args: ['--reactor-background-startup'],
	});

	if (!SHOW_WINDOW && app.dock) {
		app.dock.hide();
	}
}

function isTrustedRendererOrigin(urlValue) {
	const safeUrl = String(urlValue || '').trim().toLowerCase();
	if (!safeUrl) {
		return false;
	}

	return safeUrl.startsWith('http://127.0.0.1:') || safeUrl.startsWith('http://localhost:');
}

function configureRendererPermissionHandlers() {
	const defaultSession = session.defaultSession;
	if (!defaultSession) {
		return;
	}

	defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
		if (permission !== 'geolocation') {
			callback(false);
			return;
		}

		const webContentsUrl = webContents && typeof webContents.getURL === 'function' ? webContents.getURL() : '';
		const requestingOrigin = details && details.requestingOrigin ? String(details.requestingOrigin) : '';
		callback(isTrustedRendererOrigin(webContentsUrl) || isTrustedRendererOrigin(requestingOrigin));
	});

	defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
		if (permission !== 'geolocation') {
			return false;
		}
		return isTrustedRendererOrigin(requestingOrigin);
	});
}

async function ensureMacLaunchAgentAutostart() {
	if (process.platform !== 'darwin' || !app.isPackaged) {
		return;
	}

	try {
		const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
		const plistPath = getMacLaunchAgentPath();
		const executablePath = app.getPath('exe');

		await fs.mkdir(launchAgentsDir, { recursive: true });

		const plist = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
			'<plist version="1.0">',
			'<dict>',
			'  <key>Label</key>',
			'  <string>it.solenoid.reactor</string>',
			'  <key>ProgramArguments</key>',
			'  <array>',
			`    <string>${executablePath}</string>`,
			'    <string>--reactor-background-startup</string>',
			'  </array>',
			'  <key>RunAtLoad</key>',
			'  <true/>',
			'  <key>ProcessType</key>',
			'  <string>Background</string>',
			'</dict>',
			'</plist>',
		].join('\n');

		await fs.writeFile(plistPath, `${plist}\n`, 'utf8');
	} catch (error) {
		if (runtime) {
			runtime.log(`Autostart LaunchAgent setup failed: ${error.message}`);
		}
	}
}

if (!gotSingleInstanceLock) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!mainWindow || mainWindow.isDestroyed()) {
			mainWindow = createMainWindow();
			wireBackgroundWindowBehavior(mainWindow);
			return;
		}

		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}

		mainWindow.show();
		mainWindow.focus();
	});

	// Main app lifecycle
	app.whenReady().then(async () => {
		configureRendererPermissionHandlers();
		await ensureMacLaunchAgentAutostart();
		configureBackgroundMode();

		runtime = new ReactorRuntime(EXTERNAL_ENDPOINTS_DIR, EVENT_LOG_PATH);
		setupIpcHandlers(runtime, { forceQuitApp });
		runtime.setUiStatusSink((payload) => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send('reactor-runtime-status', payload);
			}
		});

		if (SHOW_WINDOW) {
			mainWindow = createMainWindow();
			wireBackgroundWindowBehavior(mainWindow);
		}

		await runtime.init();
		runtime.log(`Background mode active (window=${SHOW_WINDOW ? 'visible' : 'hidden'}, persist=${PERSIST_BACKGROUND ? 'on' : 'off'})`);
	});

	app.on('window-all-closed', () => {
		if (isQuitting) {
			if (runtime) {
				runtime.cleanup();
			}
			app.quit();
		}
	});

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			mainWindow = createMainWindow();
			wireBackgroundWindowBehavior(mainWindow);
			return;
		}

		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.show();
			mainWindow.focus();
		}
	});

	app.on('before-quit', (event) => {
		if (PERSIST_BACKGROUND && !isQuitting) {
			event.preventDefault();
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.hide();
			}
			if (app.dock) {
				app.dock.hide();
			}
			if (runtime) {
				runtime.log('Quit intercepted: app remains active in background');
			}
			return;
		}

		isQuitting = true;
	});
}
