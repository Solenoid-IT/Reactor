const { app, BrowserWindow } = require('electron');
const path = require('path');
const { ReactorRuntime } = require('./src/runtime');
const { createMainWindow } = require('./src/electron/window');
const { setupIpcHandlers } = require('./src/electron/ipcHandlers');

// Constants
const EXTERNAL_SCRIPTS_DIR = path.join(app.getPath('userData'), 'projects');
const EVENT_LOG_PATH = path.join(app.getPath('userData'), 'activity.log');

function shouldShowWindowOnLaunch() {
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

const SHOW_WINDOW = shouldShowWindowOnLaunch();

// Globals
let mainWindow;
let runtime;
let isQuitting = false;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

/**
 * Configures app for background mode: auto-start, hidden dock
 */
function configureBackgroundMode() {
	app.setLoginItemSettings({
		openAtLogin: true,
		openAsHidden: true,
	});

	if (!SHOW_WINDOW && app.dock) {
		app.dock.hide();
	}
}

if (!gotSingleInstanceLock) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!mainWindow || mainWindow.isDestroyed()) {
			mainWindow = createMainWindow();
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
		configureBackgroundMode();

		if (SHOW_WINDOW) {
			mainWindow = createMainWindow();
		}

		runtime = new ReactorRuntime(EXTERNAL_SCRIPTS_DIR, EVENT_LOG_PATH);
		setupIpcHandlers(runtime);

		await runtime.init();
		runtime.log(`Background mode active (window=${SHOW_WINDOW ? 'visible' : 'hidden'})`);
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
		}
	});

	app.on('before-quit', () => {
		isQuitting = true;
	});
}
