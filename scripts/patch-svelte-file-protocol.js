const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'ui', 'build', 'index.html');

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
