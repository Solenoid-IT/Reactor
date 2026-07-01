const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'ui', 'build', 'index.html');
const templatesSourceDir = path.join(__dirname, '..', 'templates');
const templatesTargetDir = path.join(__dirname, '..', 'ui', 'build', 'templates');

function copyTemplatesToBuild() {
	if (!fs.existsSync(templatesSourceDir)) {
		console.warn('[patch-svelte-file-protocol] templates source not found, skipping copy');
		return;
	}

	fs.mkdirSync(templatesTargetDir, { recursive: true });
	const entries = fs.readdirSync(templatesSourceDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		const sourcePath = path.join(templatesSourceDir, entry.name);
		const targetPath = path.join(templatesTargetDir, entry.name);
		fs.copyFileSync(sourcePath, targetPath);
	}

	console.log('[patch-svelte-file-protocol] copied endpoint templates to ui/build/templates');
}

if (!fs.existsSync(indexPath)) {
	console.warn('[patch-svelte-file-protocol] index.html not found, skipping');
	process.exit(0);
}

const original = fs.readFileSync(indexPath, 'utf8');
const patched = original
	.replaceAll('"/_app/', '"./_app/')
	.replaceAll("'/_app/", "'./_app/");

if (patched !== original) {
	fs.writeFileSync(indexPath, patched, 'utf8');
	console.log('[patch-svelte-file-protocol] patched absolute /_app/ paths to relative ./_app/');
} else {
	console.log('[patch-svelte-file-protocol] no changes needed');
}

copyTemplatesToBuild();
