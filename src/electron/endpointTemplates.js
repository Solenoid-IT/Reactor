const { app } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const ALLOWED_ENDPOINT_TEMPLATE_KEYS = new Set(['blank', 'schedule', 'event', 'watch']);

function resolveEndpointTemplateCandidates(appRootDir, templateKey) {
	const candidates = [
		path.resolve(appRootDir, 'templates', templateKey),
		path.resolve(__dirname, '..', '..', 'templates', templateKey),
		path.resolve(process.cwd(), 'templates', templateKey),
		path.resolve(app.getAppPath(), 'templates', templateKey),
		path.resolve(app.getAppPath(), 'ui', 'build', 'templates', templateKey),
	];

	if (process.resourcesPath) {
		candidates.push(path.resolve(process.resourcesPath, 'templates', templateKey));
		candidates.push(path.resolve(process.resourcesPath, 'app.asar.unpacked', 'templates', templateKey));
	}

	return Array.from(new Set(candidates));
}

async function readEndpointTemplate(templateKey, fallbackTemplateKey, appRootDir) {
	const requestedTemplate = String(templateKey || '').trim().toLowerCase();
	const safeTemplateKey = ALLOWED_ENDPOINT_TEMPLATE_KEYS.has(requestedTemplate)
		? requestedTemplate
		: fallbackTemplateKey;

	let lastReadError = '';
	for (const candidatePath of resolveEndpointTemplateCandidates(appRootDir, safeTemplateKey)) {
		try {
			const content = await fs.readFile(candidatePath, 'utf8');
			return { key: safeTemplateKey, content };
		} catch (error) {
			if (error && error.code !== 'ENOENT') {
				lastReadError = error.message || String(error);
			}
		}
	}

	throw new Error(lastReadError || `endpoint template file not found at ./templates/${safeTemplateKey}`);
}

async function ensureExternalTemplatesDirectory(appRootDir) {
	if (!appRootDir) {
		return;
	}

	const externalTemplatesDir = path.resolve(appRootDir, 'templates');
	await fs.mkdir(externalTemplatesDir, { recursive: true });

	const bootstrapSources = [
		path.resolve(__dirname, '..', '..', 'templates'),
		path.resolve(process.cwd(), 'templates'),
		path.resolve(app.getAppPath(), 'templates'),
		path.resolve(app.getAppPath(), 'ui', 'build', 'templates'),
	];

	if (process.resourcesPath) {
		bootstrapSources.push(path.resolve(process.resourcesPath, 'templates'));
		bootstrapSources.push(path.resolve(process.resourcesPath, 'app.asar.unpacked', 'templates'));
	}

	const uniqueBootstrapSources = Array.from(new Set(bootstrapSources));
	for (const templateKey of ALLOWED_ENDPOINT_TEMPLATE_KEYS) {
		let templateContent = '';
		let loaded = false;
		let lastReadError = '';

		for (const sourceDir of uniqueBootstrapSources) {
			const candidatePath = path.join(sourceDir, templateKey);
			try {
				templateContent = await fs.readFile(candidatePath, 'utf8');
				loaded = true;
				break;
			} catch (error) {
				if (error && error.code !== 'ENOENT') {
					lastReadError = error.message || String(error);
				}
			}
		}

		if (!loaded) {
			throw new Error(lastReadError || `endpoint template file not found at ./templates/${templateKey}`);
		}

		const targetPath = path.join(externalTemplatesDir, templateKey);
		await fs.writeFile(targetPath, templateContent, { encoding: 'utf8' });
	}
}

module.exports = {
	ALLOWED_ENDPOINT_TEMPLATE_KEYS,
	ensureExternalTemplatesDirectory,
	readEndpointTemplate,
	resolveEndpointTemplateCandidates,
};