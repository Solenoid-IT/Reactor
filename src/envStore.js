const fs = require('fs/promises');
const path = require('path');

const ENV_DIR_NAME = 'envs';

function getEnvDirPath(rootDir) {
	return path.join(rootDir, ENV_DIR_NAME);
}

function normalizeEnvName(name) {
	const safeName = String(name || '').trim();
	if (!safeName || safeName.includes('/') || safeName.includes('\\') || safeName === '.' || safeName === '..') {
		return '';
	}

	return safeName;
}

async function readEnvEntries(rootDir) {
	const envDirPath = getEnvDirPath(rootDir);
	let entries = [];

	try {
		entries = await fs.readdir(envDirPath, { withFileTypes: true });
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}

	const result = [];
	for (const entry of entries) {
		if (!entry || !entry.isFile()) {
			continue;
		}

		const safeName = normalizeEnvName(entry.name);
		if (!safeName) {
			continue;
		}

		const filePath = path.join(envDirPath, entry.name);
		const content = await fs.readFile(filePath, 'utf8');
		result.push({ name: safeName, content });
	}

	result.sort((left, right) => String(left.name).localeCompare(String(right.name)));
	return result;
}

async function readEnvConfig(rootDir) {
	const entries = await readEnvEntries(rootDir);
	const envConfig = {};
	for (const entry of entries) {
		envConfig[entry.name] = String(entry.content == null ? '' : entry.content);
	}
	return envConfig;
}

async function writeEnvConfig(rootDir, nextConfig) {
	const envDirPath = getEnvDirPath(rootDir);
	const normalized = nextConfig && typeof nextConfig === 'object' && !Array.isArray(nextConfig) ? nextConfig : {};
	const nextEntries = new Map();

	for (const [key, value] of Object.entries(normalized)) {
		const safeName = normalizeEnvName(key);
		if (!safeName) {
			continue;
		}

		nextEntries.set(safeName, String(value == null ? '' : value));
	}

	await fs.mkdir(envDirPath, { recursive: true });
	const existingEntries = await fs.readdir(envDirPath, { withFileTypes: true }).catch(() => []);
	const staleNames = new Set();

	for (const entry of existingEntries) {
		if (entry && entry.isFile()) {
			staleNames.add(entry.name);
		}
	}

	for (const [name, content] of nextEntries.entries()) {
		await fs.writeFile(path.join(envDirPath, name), content, 'utf8');
		staleNames.delete(name);
	}

	for (const staleName of staleNames) {
		await fs.rm(path.join(envDirPath, staleName), { force: true });
	}

	return Object.fromEntries(nextEntries.entries());
}

module.exports = {
	ENV_DIR_NAME,
	getEnvDirPath,
	normalizeEnvName,
	readEnvEntries,
	readEnvConfig,
	writeEnvConfig,
};