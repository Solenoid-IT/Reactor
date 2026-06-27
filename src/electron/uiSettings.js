const { app } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const UI_SETTINGS_FILE = 'ui-settings.json';

function getUiSettingsPath() {
	return path.join(app.getPath('userData'), UI_SETTINGS_FILE);
}

async function readUiSettings() {
	try {
		const raw = await fs.readFile(getUiSettingsPath(), 'utf8');
		const parsed = JSON.parse(raw);
		return {
			defaultProgramPath: parsed.defaultProgramPath || '',
			httpServerPort: Number(parsed.httpServerPort) || 7070,
		};
	} catch (error) {
		return { defaultProgramPath: '', httpServerPort: 7070 };
	}
}

async function writeUiSettings(nextSettings) {
	const current = await readUiSettings();
	const merged = {
		...current,
		...nextSettings,
	};
	await fs.writeFile(getUiSettingsPath(), JSON.stringify(merged, null, 2), 'utf8');
}

module.exports = {
	readUiSettings,
	writeUiSettings,
};
