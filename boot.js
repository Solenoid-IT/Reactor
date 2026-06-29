const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ReactorRuntime } = require('./src/runtime');
const { createMainWindow } = require('./src/electron/window');
const { setupIpcHandlers } = require('./src/electron/ipcHandlers');

// Constants
const EXTERNAL_SCRIPTS_DIR = path.join(app.getPath('userData'), 'projects');
const EVENT_LOG_PATH = path.join(app.getPath('userData'), 'activity.log');

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
		await ensureMacLaunchAgentAutostart();
		configureBackgroundMode();

		runtime = new ReactorRuntime(EXTERNAL_SCRIPTS_DIR, EVENT_LOG_PATH);
		setupIpcHandlers(runtime, { forceQuitApp });

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
