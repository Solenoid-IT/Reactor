const fs = require('fs/promises');
const path = require('path');

async function ensureDir(dirPath) {
	await fs.mkdir(dirPath, { recursive: true });
}

async function main() {
	const rootDir = path.resolve(__dirname, '..');
	const distMobileDir = path.join(rootDir, 'dist', 'mobile');
	const webDir = path.join(distMobileDir, 'web');
	const artifactsDir = path.join(distMobileDir, 'artifacts');

	await ensureDir(distMobileDir);
	await ensureDir(webDir);
	await ensureDir(artifactsDir);

	const readmePath = path.join(distMobileDir, 'README.txt');
	const now = new Date().toISOString();
	const content = [
		'Reactor mobile build output',
		`Generated at: ${now}`,
		'',
		'This folder is reserved for Capacitor builds.',
		'Expected structure:',
		'- web/: shared web UI bundle',
		'- artifacts/: generated mobile artifacts',
		'',
		'Next step:',
		'1) Add Capacitor config and native projects',
		'2) Run: npx cap sync',
		'3) Run: npx cap build android/ios',
	].join('\n');

	await fs.writeFile(readmePath, `${content}\n`, 'utf8');
	console.log(`[Reactor] Mobile build scaffold ready in ${distMobileDir}`);
}

main().catch((error) => {
	console.error(`[Reactor] build:mobile failed: ${error.message}`);
	process.exit(1);
});
