const fs = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');

function normalizeBackupExportOptions(rawOptions = {}) {
	const source = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
	const includeConnections = source.includeConnections !== false;
	const includeEndpoints = source.includeEndpoints !== false;
	const endpointPaths = Array.isArray(source.endpointPaths)
		? Array.from(new Set(source.endpointPaths.map((value) => String(value || '').trim()).filter(Boolean)))
		: [];
	const endpointSelectionProvided = source.endpointSelectionProvided === true;

	return {
		includeConnections,
		includeEndpoints,
		endpointPaths,
		endpointSelectionProvided,
	};
}

function getBackupEntries(rootDir) {
	return [
		{ sourcePath: path.join(rootDir, 'endpoints'), archiveName: 'endpoints' },
		{ sourcePath: path.join(rootDir, 'working-mode.json'), archiveName: 'working-mode.json' },
		{ sourcePath: path.join(rootDir, 'name'), archiveName: 'name' },
		{ sourcePath: path.join(rootDir, 'permissions.json'), archiveName: 'permissions.json' },
		{ sourcePath: path.join(rootDir, 'envs'), archiveName: 'envs' },
		{ sourcePath: path.join(rootDir, 'ui-settings.json'), archiveName: 'ui-settings.json' },
		{ sourcePath: path.join(rootDir, 'workflow.json'), archiveName: 'workflow.json' },
		{ sourcePath: path.join(rootDir, 'activity.log'), archiveName: 'activity.log' },
		{ sourcePath: path.join(rootDir, 'tls'), archiveName: 'tls' },
	];
}

async function addPathToZip(zip, sourcePath, archiveName) {
	let stats;
	try {
		stats = await fs.stat(sourcePath);
	} catch {
		return;
	}

	if (stats.isDirectory()) {
		const entries = await fs.readdir(sourcePath, { withFileTypes: true });
		if (entries.length === 0) {
			zip.addFile(`${archiveName.replace(/\\/g, '/')}/.keep`, Buffer.from('', 'utf8'));
			return;
		}

		for (const entry of entries) {
			const childSource = path.join(sourcePath, entry.name);
			const childArchive = `${archiveName.replace(/\\/g, '/')}/${entry.name}`;
			await addPathToZip(zip, childSource, childArchive);
		}
		return;
	}

	const data = await fs.readFile(sourcePath);
	zip.addFile(archiveName.replace(/\\/g, '/'), data);
}

function resolveSelectableEndpointDirs(rootDir, endpointPaths = []) {
	const endpointsRoot = path.resolve(path.join(rootDir, 'endpoints'));
	const selectedDirs = new Set();

	for (const endpointPath of endpointPaths) {
		const normalizedPath = path.resolve(String(endpointPath || '').trim());
		if (!normalizedPath.startsWith(endpointsRoot + path.sep)) {
			continue;
		}

		const relative = path.relative(endpointsRoot, normalizedPath);
		if (!relative || relative.startsWith('..')) {
			continue;
		}

		const [firstSegment] = relative.split(path.sep);
		if (!firstSegment) {
			continue;
		}

		selectedDirs.add(path.join(endpointsRoot, firstSegment));
	}

	return Array.from(selectedDirs.values());
}

async function buildBackupZip(rootDir, rawOptions = {}) {
	const options = normalizeBackupExportOptions(rawOptions);
	const zip = new AdmZip();
	for (const entry of getBackupEntries(rootDir)) {
		if (entry.archiveName === 'working-mode.json' && !options.includeConnections) {
			continue;
		}

		if (entry.archiveName === 'endpoints') {
			if (!options.includeEndpoints) {
				continue;
			}

			const selectedEndpointDirs = resolveSelectableEndpointDirs(rootDir, options.endpointPaths);
			if (options.endpointSelectionProvided) {
				if (selectedEndpointDirs.length === 0) {
					continue;
				}

				for (const endpointDir of selectedEndpointDirs) {
					const archiveName = path.join('endpoints', path.basename(endpointDir));
					await addPathToZip(zip, endpointDir, archiveName);
				}
				continue;
			}

			if (selectedEndpointDirs.length > 0) {
				for (const endpointDir of selectedEndpointDirs) {
					const archiveName = path.join('endpoints', path.basename(endpointDir));
					await addPathToZip(zip, endpointDir, archiveName);
				}
				continue;
			}
		}

		await addPathToZip(zip, entry.sourcePath, entry.archiveName);
	}

	const metadata = {
		createdAt: new Date().toISOString(),
		format: 'reactor-backup-v1',
	};
	zip.addFile('backup-meta.json', Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'));
	return zip;
}

function resolveSafeBackupTarget(rootDir, rawEntryName) {
	const normalized = String(rawEntryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
	if (!normalized || normalized.includes('..')) {
		return null;
	}

	const firstSegment = normalized.split('/')[0];
	const allowedRoots = new Set(['endpoints', 'working-mode.json', 'name', 'permissions.json', 'envs', 'ui-settings.json', 'workflow.json', 'activity.log', 'tls', 'backup-meta.json']);
	if (!allowedRoots.has(firstSegment)) {
		return null;
	}

	const targetPath = path.resolve(path.join(rootDir, normalized));
	if (!targetPath.startsWith(path.resolve(rootDir) + path.sep) && targetPath !== path.resolve(rootDir, normalized)) {
		return null;
	}

	return targetPath;
}

module.exports = {
	buildBackupZip,
	resolveSafeBackupTarget,
};