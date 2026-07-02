const fs = require('fs/promises');
const path = require('path');

const PERMISSIONS_FILE_NAME = 'permissions.json';

function getPermissionsFilePath(rootDir) {
	return path.join(rootDir, PERMISSIONS_FILE_NAME);
}

function normalizePermissionsState(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return {};
	}

	const normalized = {};
	for (const [platformName, entries] of Object.entries(input)) {
		const safePlatformName = String(platformName || '').trim();
		if (!safePlatformName || !Array.isArray(entries)) {
			continue;
		}

		normalized[safePlatformName] = entries
			.map((entry) => {
				if (!entry || typeof entry !== 'object') {
					return null;
				}

				const name = String(entry.name || '').trim();
				if (!name) {
					return null;
				}

				return {
					name,
					checked: Boolean(entry.checked),
				};
			})
			.filter(Boolean);
	}

	return normalized;
}

async function readPermissionsState(rootDir) {
	const filePath = getPermissionsFilePath(rootDir);
	try {
		const content = await fs.readFile(filePath, 'utf8');
		return normalizePermissionsState(JSON.parse(content));
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return {};
		}
		throw error;
	}
}

async function writePermissionsState(rootDir, nextState) {
	const filePath = getPermissionsFilePath(rootDir);
	const normalized = normalizePermissionsState(nextState);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
	return normalized;
}

module.exports = {
	PERMISSIONS_FILE_NAME,
	getPermissionsFilePath,
	normalizePermissionsState,
	readPermissionsState,
	writePermissionsState,
};