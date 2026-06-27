const { app, BrowserWindow, dialog, ipcMain, shell, screen } = require('electron');
const fsNative = require('fs');
const fs = require('fs/promises');
const { spawn } = require('child_process');
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

function parseDirectiveHeader(source) {
	const lines = source.split(/\r?\n/);
	let index = 0;

	while (index < lines.length && lines[index].trim() === '') {
		index += 1;
	}

	const values = {
		state: null,
		schedule: null,
		on: null,
		mutex: null,
		watch: [],
	};

	for (; index < lines.length; index += 1) {
		const line = lines[index];
		const stateMatch = line.match(/^\s*\/\/\s*@state\s+(ENABLED|DISABLED)\b/i);
		if (stateMatch) {
			values.state = stateMatch[1].toUpperCase();
			continue;
		}

		const scheduleMatch = line.match(/^\s*\/\/\s*@schedule\s+(.+)$/i);
		if (scheduleMatch) {
			values.schedule = scheduleMatch[1].trim();
			continue;
		}

		const onMatch = line.match(/^\s*\/\/\s*@on\s+(.+)$/i);
		if (onMatch) {
			values.on = onMatch[1].trim();
			continue;
		}

		const mutexMatch = line.match(/^\s*\/\/\s*@mutex(?:\s+(ON|OFF))?\b/i);
		if (mutexMatch) {
			values.mutex = (mutexMatch[1] || 'ON').toUpperCase();
			continue;
		}

		const watchMatch = line.match(/^\s*\/\/\s*@watch\s+(.+)$/i);
		if (watchMatch) {
			values.watch.push(watchMatch[1].trim());
			continue;
		}

		if (line.trim() === '') {
			continue;
		}

		break;
	}

	return values;
}

function rebuildDirectiveHeader(source, overrides = {}) {
	const currentValues = parseDirectiveHeader(source);
	const nextValues = { ...currentValues, ...overrides };
	const lines = source.split(/\r?\n/);
	let index = 0;

	while (index < lines.length && lines[index].trim() === '') {
		index += 1;
	}

	let bodyStart = index;
	for (; bodyStart < lines.length; bodyStart += 1) {
		const line = lines[bodyStart];
		if (/^\s*\/\/\s*@(state|mutex|on|schedule|watch)\b/i.test(line) || line.trim() === '') {
			continue;
		}
		break;
	}

	const body = lines.slice(bodyStart).join('\n').replace(/^\n+/, '');
	const headerLines = [];

	if (nextValues.state) {
		headerLines.push(`// @state ${nextValues.state}`);
	}

	if (nextValues.mutex) {
		headerLines.push(`// @mutex ${nextValues.mutex}`);
	}

	if (nextValues.on) {
		headerLines.push(`// @on ${nextValues.on}`);
	}

	if (nextValues.schedule) {
		headerLines.push(`// @schedule ${nextValues.schedule}`);
	}

	if (Array.isArray(nextValues.watch)) {
		for (const watchEntry of nextValues.watch) {
			if (watchEntry) {
				headerLines.push(`// @watch ${watchEntry}`);
			}
		}
	}

	if (!headerLines.length) {
		return body;
	}

	return `${headerLines.join('\n')}\n\n${body}`;
}

async function openWithConfiguredProgramOrDefault(targetPath) {
	const settings = await readUiSettings();
	if (!settings.defaultProgramPath) {
		const shellError = await shell.openPath(targetPath);
		return shellError ? { ok: false, error: shellError } : { ok: true };
	}

	try {
		if (process.platform === 'darwin' && settings.defaultProgramPath.endsWith('.app')) {
			const child = spawn('open', ['-a', settings.defaultProgramPath, targetPath], {
				detached: true,
				stdio: 'ignore',
			});
			child.unref();
			return { ok: true };
		}

		const child = spawn(settings.defaultProgramPath, [targetPath], {
			detached: true,
			stdio: 'ignore',
		});
		child.unref();
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error.message || 'failed to launch default program' };
	}
}

function getLogoDataUri() {
	try {
		const logoPath = path.join(__dirname, '..', 'assets', 'logo.jpg');
		const data = fsNative.readFileSync(logoPath);
		return `data:image/jpeg;base64,${data.toString('base64')}`;
	} catch (error) {
		return '';
	}
}

/**
 * Builds the HTML content for the Reactor UI
 */
function buildHtmlContent() {
	const logoDataUri = getLogoDataUri();
	return `<!DOCTYPE html>
<html>
<head>
	<title>Reactor</title>
	<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
	<style>
		:root {
			--bg: #0d0f12;
			--bg-2: #12161c;
			--panel: #181d24;
			--panel-2: #1e242d;
			--panel-3: #232b35;
			--text: #eef2fb;
			--muted: #909db2;
			--accent: #1f6a4a;
			--accent-2: #2e8a61;
			--danger: #ff7c8f;
			--ok: #76c793;
			--border: #313a46;
			--shadow: 0 16px 42px rgba(0, 0, 0, 0.42);
		}

		* { margin: 0; padding: 0; box-sizing: border-box; }

		html,
		body {
			width: 100%;
			min-height: 100%;
		}

		body {
			font-family: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
			background:
				radial-gradient(1200px 480px at 85% -12%, rgba(67, 209, 143, 0.17), transparent 58%),
				radial-gradient(900px 420px at 0% 100%, rgba(111, 144, 255, 0.12), transparent 62%),
				linear-gradient(175deg, var(--bg-2) 0%, var(--bg) 58%);
			color: var(--text);
			padding: clamp(10px, 1.7vw, 22px);
		}

		.app {
			width: 100%;
			max-width: none;
			margin: 0;
			min-height: calc(100vh - clamp(20px, 3vw, 44px));
			background: transparent;
			border: 0;
			border-radius: 0;
			overflow: hidden;
			box-shadow: none;
			backdrop-filter: none;
			display: flex;
			flex-direction: column;
		}

		.header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 14px;
			padding: 18px 22px;
			border-bottom: 1px solid var(--border);
			background: linear-gradient(180deg, rgba(29, 37, 49, 0.96), rgba(24, 31, 42, 0.9));
			position: sticky;
			top: 0;
			z-index: 30;
			backdrop-filter: blur(6px);
		}

		.title {
			display: flex;
			align-items: center;
			gap: 11px;
		}

		.title-copy {
			display: flex;
			flex-direction: column;
		}

		.title h1 {
			font-size: 20px;
			font-weight: 700;
			letter-spacing: 0.4px;
		}

		.logo {
			height: 40px;
			border-radius: 8px;
			/*
			object-fit: cover;
			box-shadow: 0 0 0 1px #48566a;
			*/
		}

		.title p {
			font-size: 12px;
			color: var(--muted);
			margin-top: 3px;
			letter-spacing: 0.2px;
		}

		.actions {
			display: flex;
			gap: 8px;
			align-items: center;
			align-self: center;
			justify-content: flex-end;
			flex-wrap: wrap;
			max-width: min(70%, 980px);
		}

		.template-picker {
			position: relative;
			display: inline-flex;
			align-items: center;
		}

		.log-picker {
			position: relative;
			display: inline-flex;
			align-items: center;
		}

		button {
			border: 1px solid transparent;
			border-radius: 11px;
			padding: 9px 12px;
			font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.15px;
			cursor: pointer;
			transition: 0.2s ease;
		}

		.icon-button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 0;
			min-width: 42px;
			padding: 9px 12px;
			line-height: 1;
		}

		.icon-button i {
			font-size: 14px;
			line-height: 1;
		}

		.btn-secondary {
			background: linear-gradient(160deg, #2a3342, #262f3d);
			border-color: #435063;
			color: var(--text);
		}

		.btn-secondary:hover {
			background: linear-gradient(160deg, #344153, #2e3948);
			border-color: #57657a;
		}

		.btn-primary {
			background: linear-gradient(135deg, var(--accent), var(--accent-2));
			border-color: rgba(74, 153, 117, 0.62);
			color: #eaf9f1;
		}

		.btn-primary:hover {
			filter: brightness(1.06);
			transform: translateY(-1px);
		}

		.btn-danger {
			background: linear-gradient(160deg, #452932, #37232a);
			border-color: #734350;
			color: #ffd8df;
		}

		.btn-danger:hover {
			background: linear-gradient(160deg, #55333e, #432931);
			border-color: #875060;
		}

		.template-menu {
			position: absolute;
			top: calc(100% + 8px);
			right: 0;
			min-width: 180px;
			padding: 8px;
			border: 1px solid #435063;
			border-radius: 12px;
			background: linear-gradient(180deg, rgba(30, 38, 50, 0.98), rgba(22, 28, 38, 0.98));
			box-shadow: 0 18px 28px rgba(0, 0, 0, 0.3);
			opacity: 0;
			pointer-events: none;
			transform: translateY(-6px) scale(0.98);
			transition: 0.16s ease;
			z-index: 40;
		}

		.template-picker.open .template-menu {
			opacity: 1;
			pointer-events: auto;
			transform: translateY(0) scale(1);
		}

		.template-menu-title {
			padding: 6px 8px 10px;
			font-size: 10px;
			font-weight: 800;
			letter-spacing: 0.45px;
			text-transform: uppercase;
			color: var(--muted);
		}

		.template-menu-item {
			display: flex;
			align-items: center;
			gap: 8px;
			width: 100%;
			padding: 9px 10px;
			border-radius: 10px;
			border: 1px solid transparent;
			background: transparent;
			color: var(--text);
			font-size: 12px;
			font-weight: 700;
			text-align: left;
		}

		.template-menu-item:hover {
			background: rgba(255, 255, 255, 0.06);
			border-color: #4a5668;
		}

		.template-menu-item i {
			width: 14px;
			text-align: center;
			font-size: 13px;
			color: #c8d4e6;
			flex-shrink: 0;
		}

		.log-menu {
			position: absolute;
			top: calc(100% + 8px);
			right: 0;
			min-width: 170px;
			padding: 8px;
			border: 1px solid #435063;
			border-radius: 12px;
			background: linear-gradient(180deg, rgba(30, 38, 50, 0.98), rgba(22, 28, 38, 0.98));
			box-shadow: 0 18px 28px rgba(0, 0, 0, 0.3);
			opacity: 0;
			pointer-events: none;
			transform: translateY(-6px) scale(0.98);
			transition: 0.16s ease;
			z-index: 40;
		}

		.log-picker.open .log-menu {
			opacity: 1;
			pointer-events: auto;
			transform: translateY(0) scale(1);
		}

		.log-menu-title {
			padding: 6px 8px 10px;
			font-size: 10px;
			font-weight: 800;
			letter-spacing: 0.45px;
			text-transform: uppercase;
			color: var(--muted);
		}

		.log-menu-item {
			display: flex;
			align-items: center;
			gap: 8px;
			width: 100%;
			padding: 9px 10px;
			border-radius: 10px;
			border: 1px solid transparent;
			background: transparent;
			color: var(--text);
			font-size: 12px;
			font-weight: 700;
			text-align: left;
		}

		.log-menu-item:hover {
			background: rgba(255, 255, 255, 0.06);
			border-color: #4a5668;
		}

		.log-menu-item i {
			width: 14px;
			text-align: center;
			font-size: 13px;
			color: #c8d4e6;
			flex-shrink: 0;
		}

		.log-menu-item.danger {
			color: #ffdce3;
			border-color: #7a4c59;
			background: rgba(122, 76, 89, 0.16);
		}

		.log-menu-item.danger:hover {
			background: rgba(122, 76, 89, 0.28);
			border-color: #9b6071;
		}

		.log-menu-item.danger i {
			color: #ffb8c5;
		}

		.item-log-picker {
			position: relative;
			display: inline-flex;
			align-items: center;
		}

		.item-log-menu {
			position: absolute;
			top: calc(100% + 6px);
			right: 0;
			min-width: 150px;
			padding: 8px;
			border: 1px solid #435063;
			border-radius: 12px;
			background: linear-gradient(180deg, rgba(30, 38, 50, 0.98), rgba(22, 28, 38, 0.98));
			box-shadow: 0 18px 28px rgba(0, 0, 0, 0.3);
			opacity: 0;
			pointer-events: none;
			transform: translateY(-6px) scale(0.98);
			transition: 0.16s ease;
			z-index: 45;
		}

		.item-log-picker.open .item-log-menu {
			opacity: 1;
			pointer-events: auto;
			transform: translateY(0) scale(1);
		}

		.item-log-menu-item {
			display: flex;
			align-items: center;
			gap: 8px;
			width: 100%;
			padding: 9px 10px;
			border-radius: 10px;
			border: 1px solid transparent;
			background: transparent;
			color: var(--text);
			font-size: 12px;
			font-weight: 700;
			text-align: left;
		}

		.item-log-menu-item:hover {
			background: rgba(255, 255, 255, 0.06);
			border-color: #4a5668;
		}

		.item-log-menu-item.danger {
			color: #ffdce3;
			border-color: #7a4c59;
			background: rgba(122, 76, 89, 0.16);
		}

		.item-log-menu-item.danger:hover {
			background: rgba(122, 76, 89, 0.28);
			border-color: #9b6071;
		}

		.item-log-menu-item i {
			width: 14px;
			text-align: center;
			font-size: 13px;
			color: #c8d4e6;
			flex-shrink: 0;
		}

		.item-log-menu-item.danger i {
			color: #ffb8c5;
		}

		.btn-danger:disabled,
		.btn-primary:disabled {
			opacity: 0.55;
			cursor: not-allowed;
			filter: grayscale(0.2);
		}

		.content {
			display: grid;
			grid-template-columns: minmax(420px, 1.35fr) minmax(320px, 0.9fr);
			min-height: calc(100vh - 150px);
			background: transparent;
			align-items: stretch;
		}

		.list-pane {
			border-right: 1px solid var(--border);
			padding: 18px;
			background: rgba(20, 27, 37, 0.42);
			display: flex;
			flex-direction: column;
			min-height: 0;
		}

		.path-box {
			margin-bottom: 14px;
			padding: 11px 12px;
			background: #1d2530;
			border: 1px solid var(--border);
			border-radius: 11px;
			font-size: 12px;
			color: var(--muted);
			word-break: break-all;
		}

		.file-list {
			display: flex;
			flex-direction: column;
			gap: 8px;
			height: 100%;
			max-height: none;
			min-height: 0;
			overflow: auto;
			padding-right: 4px;
			flex: 1 1 auto;
		}

		.file-list::-webkit-scrollbar {
			width: 10px;
		}

		.file-list::-webkit-scrollbar-thumb {
			background: #2f3b4d;
			border-radius: 10px;
		}

		.file-item {
			position: relative;
			z-index: 1;
			padding: 12px 13px;
			border-radius: 11px;
			background: linear-gradient(160deg, #212a36, #1d2632);
			border: 1px solid #384456;
			cursor: pointer;
			transition: 0.16s ease;
			opacity: 0;
			transform: translateY(5px);
			animation: fileIn 0.24s ease forwards;
		}

		.file-item:hover {
			background: linear-gradient(160deg, #293545, #232f3e);
			border-color: #526077;
			transform: translateY(-1px);
		}

		.file-item.selected {
			background: linear-gradient(145deg, #273444, #23403b);
			border-color: var(--accent);
			box-shadow: 0 0 0 1px rgba(60, 170, 122, 0.24) inset;
			z-index: 2;
		}

		.file-item.menu-open {
			z-index: 70;
		}

		.file-name {
			font-size: 14px;
			font-weight: 700;
			margin-bottom: 4px;
		}

		.file-name-label {
			cursor: text;
			border-radius: 4px;
			padding: 1px 4px;
			margin: -1px -4px;
			transition: background 0.14s ease;
			display: inline-block;
		}

		.file-name-label:hover {
			background: rgba(255, 255, 255, 0.07);
		}

		.file-name-input {
			background: #18222f;
			border: 1px solid var(--accent);
			border-radius: 6px;
			color: var(--text);
			font-size: 14px;
			font-weight: 700;
			font-family: inherit;
			padding: 2px 7px;
			width: 100%;
			box-sizing: border-box;
			outline: none;
			box-shadow: 0 0 0 2px rgba(31, 106, 74, 0.28);
		}

		.file-tags {
			display: flex;
			gap: 6px;
			flex-wrap: wrap;
		}

		.tag {
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.55px;
			text-transform: uppercase;
			font-family: "SF Mono", "Fira Code", "Consolas", monospace;
			padding: 3px 7px;
			border-radius: 5px;
			background: #1f2a36;
			color: var(--muted);
			border: 1px solid #3a4859;
		}

		.tag.ok { color: #c8f5d9; background: #1a3d2b; border-color: #2a6045; }
		.tag.warn { color: #f5e1a4; background: #3a2e10; border-color: #7a6030; }
		.tag.mutex { color: #a8d8f0; background: #122035; border-color: #2a5070; }

		.detail-pane {
			padding: 18px;
			display: flex;
			flex-direction: column;
			gap: 12px;
			background: rgba(19, 25, 34, 0.36);
		}

		.detail-card {
			background: linear-gradient(170deg, var(--panel-2), var(--panel-3));
			border: 1px solid var(--border);
			border-radius: 13px;
			padding: 14px 15px;
		}

		.detail-card h3 {
			font-size: 13px;
			color: var(--muted);
			margin-bottom: 8px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}

		.detail-value {
			font-size: 13px;
			line-height: 1.5;
			word-break: break-all;
		}

		.file-header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 10px;
			margin-bottom: 4px;
		}

		.file-header-main {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.toggle-stack {
			display: flex;
			flex-direction: column;
			align-items: flex-end;
			gap: 6px;
			flex-shrink: 0;
		}

		.file-open-btn {
			padding: 5px 8px;
			font-size: 11px;
			font-weight: 700;
			border-radius: 8px;
			background: #314051;
			border: 1px solid #53637b;
			color: #dce9fb;
		}

		.file-open-btn:hover {
			background: #3b4c62;
		}

		.item-actions {
			display: flex;
			align-items: center;
			gap: 6px;
			margin-top: 8px;
			padding-top: 8px;
			border-top: 1px solid #364151;
		}

		.item-action-btn {
			width: auto;
			height: 30px;
			padding: 0 8px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
			border-radius: 8px;
			border: 1px solid #4a596e;
			background: #2d3745;
			color: #dfe7f5;
		}

		.item-action-label {
			display: inline;
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.2px;
			text-transform: uppercase;
		}

		.item-action-btn:hover {
			background: #364456;
			border-color: #637590;
		}

		.item-action-btn.test {
			background: #264433;
			border-color: #3a7b5b;
			color: #ddfbe8;
		}

		.item-action-btn.test:hover {
			background: #2c523d;
		}

		.item-action-btn.delete {
			background: #442a32;
			border-color: #7a4c59;
			color: #ffdce3;
		}

		.item-action-btn.delete:hover {
			background: #57333f;
		}

		.switch-toggle {
			display: inline-flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			min-width: 108px;
			padding: 5px 8px;
			border-radius: 999px;
			border: 1px solid #4d596b;
			background: linear-gradient(165deg, #2c3441, #28313f);
			color: #dce9fb;
			font-size: 10px;
			font-weight: 800;
			letter-spacing: 0.28px;
			text-transform: uppercase;
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
		}

		.switch-toggle::after {
			content: '';
			width: 13px;
			height: 13px;
			border-radius: 999px;
			background: #7c8798;
			box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
			transition: 0.18s ease;
		}

		.switch-toggle.state-on,
		.switch-toggle.mutex-on {
			background: linear-gradient(135deg, #204e3a, #236045);
			border-color: #2f7f5a;
			color: #e8fff0;
		}

		.switch-toggle.state-on::after,
		.switch-toggle.mutex-on::after {
			background: #7ac799;
		}

		.switch-toggle.state-off,
		.switch-toggle.mutex-off {
			background: linear-gradient(165deg, #313742, #2d3440);
			border-color: #505b6d;
			color: #c2c9d4;
		}

		.switch-toggle:hover {
			filter: brightness(1.06);
		}

		@keyframes fileIn {
			to {
				opacity: 1;
				transform: translateY(0);
			}
		}

		.toast-stack {
			position: fixed;
			right: 18px;
			bottom: 18px;
			display: flex;
			flex-direction: column;
			gap: 10px;
			z-index: 1000;
			pointer-events: none;
		}

		.toast {
			min-width: 250px;
			max-width: 360px;
			padding: 11px 12px;
			border-radius: 10px;
			border: 1px solid #4b5b70;
			background: #233041;
			color: #e7edf3;
			font-size: 12px;
			line-height: 1.4;
			box-shadow: 0 8px 20px rgba(0,0,0,0.35);
			opacity: 0;
			transform: translateY(8px);
			animation: toastIn 0.18s ease forwards;
		}

		.toast.success {
			border-color: #4f7f63;
			background: #25352c;
		}

		.toast.error {
			border-color: #81525b;
			background: #3a2a2f;
		}

		@keyframes toastIn {
			to {
				opacity: 1;
				transform: translateY(0);
			}
		}

		@keyframes toastOut {
			to {
				opacity: 0;
				transform: translateY(8px);
			}
		}

		.empty {
			color: var(--muted);
			font-size: 13px;
			padding: 12px 13px;
			border: 1px dashed #4b596d;
			border-radius: 11px;
			background: rgba(26, 35, 48, 0.46);
		}

		#statusBox {
			margin-top: auto;
		}

		.flow-modal {
			position: fixed;
			inset: 0;
			background: rgba(8, 12, 18, 0.72);
			backdrop-filter: blur(3px);
			display: none;
			align-items: stretch;
			justify-content: center;
			padding: 22px;
			z-index: 900;
		}

		.flow-modal.open {
			display: flex;
		}

		.flow-shell {
			width: min(1400px, 100%);
			height: min(900px, 100%);
			background: linear-gradient(180deg, #1a2230, #151c28);
			border: 1px solid #3c4a5e;
			border-radius: 14px;
			overflow: hidden;
			box-shadow: 0 24px 46px rgba(0, 0, 0, 0.42);
			display: flex;
			flex-direction: column;
		}

		.flow-head {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 12px;
			padding: 12px 14px;
			border-bottom: 1px solid #39475b;
			background: linear-gradient(180deg, rgba(33, 42, 57, 0.96), rgba(26, 34, 47, 0.92));
		}

		.flow-title-wrap {
			display: flex;
			flex-direction: column;
			gap: 4px;
		}

		.flow-title-wrap h3 {
			font-size: 14px;
			letter-spacing: 0.3px;
		}

		.flow-title-wrap p {
			font-size: 11px;
			color: var(--muted);
		}

		.flow-head-actions {
			display: flex;
			gap: 8px;
			flex-wrap: wrap;
		}

		.flow-body {
			flex: 1;
			min-height: 0;
			display: grid;
			grid-template-columns: 1fr 300px;
		}

		.flow-canvas {
			position: relative;
			overflow: auto;
			background:
				radial-gradient(circle at 1px 1px, rgba(139, 156, 180, 0.22) 1px, transparent 0),
				linear-gradient(180deg, #131926, #111723);
			background-size: 22px 22px, 100% 100%;
		}

		.flow-edges {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			pointer-events: none;
		}

		.flow-edge {
			stroke: #6da2ff;
			stroke-width: 2;
			fill: none;
			opacity: 0.9;
		}

		.flow-nodes {
			position: relative;
			min-width: 1200px;
			min-height: 760px;
		}

		.flow-node {
			position: absolute;
			width: 220px;
			background: linear-gradient(165deg, #223042, #1d2837);
			border: 1px solid #4f6078;
			border-radius: 11px;
			padding: 9px;
			box-shadow: 0 10px 22px rgba(0, 0, 0, 0.32);
			cursor: grab;
			user-select: none;
		}

		.flow-node.selected {
			border-color: #6da2ff;
			box-shadow: 0 0 0 1px rgba(109, 162, 255, 0.28) inset, 0 12px 24px rgba(0, 0, 0, 0.35);
		}

		.flow-node-title {
			font-size: 12px;
			font-weight: 800;
			margin-bottom: 4px;
		}

		.flow-node-meta {
			font-size: 10px;
			color: #a8b6cb;
			line-height: 1.3;
			margin-bottom: 7px;
		}

		.flow-node-ports {
			display: flex;
			justify-content: space-between;
			gap: 8px;
		}

		.flow-port {
			font-size: 10px;
			font-weight: 800;
			letter-spacing: 0.3px;
			text-transform: uppercase;
			padding: 4px 8px;
			border-radius: 999px;
			border: 1px solid #5b6f8a;
			background: #273649;
			color: #deebff;
		}

		.flow-port.output {
			cursor: pointer;
			background: #1f3a2f;
			border-color: #4e8a67;
		}

		.flow-side {
			padding: 12px;
			border-left: 1px solid #39475b;
			overflow: auto;
			display: flex;
			flex-direction: column;
			gap: 10px;
		}

		.flow-input {
			width: 100%;
			background: #121a27;
			color: var(--text);
			border: 1px solid #39495e;
			border-radius: 8px;
			padding: 8px;
			font-size: 12px;
			margin-top: 6px;
		}

		.flow-side-actions {
			margin-top: 10px;
			display: flex;
			gap: 8px;
		}

		@media (max-width: 1180px) {
			.header {
				flex-direction: column;
				align-items: stretch;
			}

			.actions {
				max-width: 100%;
				justify-content: flex-start;
			}

			.content {
				grid-template-columns: 1fr;
				min-height: auto;
			}

			.list-pane {
				border-right: 0;
				border-bottom: 1px solid var(--border);
			}

			.file-list {
				max-height: min(46vh, 460px);
				height: auto;
			}

			.flow-body {
				grid-template-columns: 1fr;
			}

			.flow-side {
				border-left: 0;
				border-top: 1px solid #39475b;
			}
		}

		@media (max-width: 860px) {
			body {
				padding: 10px;
			}

			.app {
				min-height: calc(100vh - 20px);
			}

			.actions {
				gap: 7px;
			}

			button {
				flex: 1 1 calc(50% - 7px);
				min-width: 148px;
			}

			.icon-button {
				flex: 0 0 auto;
				min-width: 42px;
				padding: 9px 12px;
			}

			.template-picker {
				flex: 1 1 calc(50% - 7px);
				min-width: 148px;
			}

			.template-picker .btn-primary {
				width: 100%;
			}

			.template-menu {
				left: 0;
				right: auto;
				min-width: min(100%, 220px);
			}

			.title h1 {
				font-size: 18px;
			}

			.file-header {
				align-items: stretch;
				gap: 8px;
			}

			.file-name {
				width: 100%;
			}

			.toggle-stack {
				align-items: flex-end;
			}

			.switch-toggle {
				min-width: 104px;
			}

			.item-action-btn {
				width: 30px;
				padding: 0;
				gap: 0;
			}

			.item-action-label {
				display: none;
			}
		}

		@media (prefers-reduced-motion: reduce) {
			.file-item,
			.toast {
				animation: none !important;
				transition: none !important;
				opacity: 1;
				transform: none;
			}
		}
	</style>
</head>
<body>
	<div class="toast-stack" id="toastStack"></div>
	<div class="app">
		<div class="header">
			<div class="title">
				${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="Reactor logo" />` : ''}
				<div class="title-copy">
					<h1>Reactor</h1>
					<p>Trigger your projects</p>
				</div>
			</div>
			<div class="actions">
				<div class="template-picker" id="templatePicker">
					<button class="btn-primary" onclick="toggleTemplateMenu(event)" title="create new script">+</button>
					<div class="template-menu" id="templateMenu" aria-hidden="true">
						<div class="template-menu-title" style="display: none;">Templates</div>
						<button class="template-menu-item" onclick="createNewScript('blank')"><i class="fa-regular fa-file"></i><span>Blank</span></button>
						<button class="template-menu-item" onclick="createNewScript('schedule')"><i class="fa-solid fa-clock-rotate-left"></i><span>Schedule</span></button>
						<button class="template-menu-item" onclick="createNewScript('event')"><i class="fa-solid fa-bolt"></i><span>Event</span></button>
						<button class="template-menu-item" onclick="createNewScript('watch')"><i class="fa-solid fa-eye"></i><span>Watch</span></button>
					</div>
				</div>
				<button class="btn-secondary icon-button" onclick="refreshScripts()" title="refresh scripts" aria-label="Refresh scripts"><i class="fa-solid fa-rotate-right"></i></button>
				<button class="btn-secondary icon-button" onclick="openScriptsFolder()" title="open project folder" aria-label="Open project folder"><i class="fa-regular fa-folder-open"></i></button>
				<button class="btn-secondary" onclick="openFlowEditor()" title="open flow editor"><i class="fa-solid fa-diagram-project" style="margin-right: 8px;"></i>Open Flow</button>
				<button class="btn-secondary" onclick="chooseDefaultProgram()" title="set default program"><i class="fa-solid fa-cog" style="margin-right: 8px;"></i>Set Default Program</button>
				<button class="btn-secondary" onclick="openServerStatus()" title="open server status"><i class="fa-solid fa-heart-pulse" style="margin-right: 8px;"></i>Server Status</button>
				<div class="log-picker" id="logPicker">
					<button class="btn-secondary" onclick="toggleLogMenu(event)" title="log actions"><i class="fa-solid fa-list" style="margin-right: 8px;"></i>LOG</button>
					<div class="log-menu" id="logMenu" aria-hidden="true">
						<button class="log-menu-item" onclick="openEventLog()"><i class="fa-solid fa-magnifying-glass"></i><span>View</span></button>
						<button class="log-menu-item danger" onclick="clearEventLog()"><i class="fa-solid fa-trash"></i><span>Clear</span></button>
					</div>
				</div>
			</div>
		</div>

		<div class="content">
			<div class="list-pane">
				<div class="path-box" id="scriptsPath">Loading path...</div>
				<div class="file-list" id="scriptList"></div>
			</div>
			<div class="detail-pane">
				<div class="detail-card">
					<h3>Default Program</h3>
					<div class="detail-value" id="defaultProgramPath">System default (not set)</div>
				</div>
				<div class="detail-card">
					<h3>HTTP Server Port</h3>
					<div class="detail-value" id="httpServerPortValue">7070</div>
					<div style="margin-top:10px; display:flex; gap:8px; align-items:center;">
						<input id="httpServerPortInput" type="number" min="1" max="65535" placeholder="7070" style="width:120px; background:#12161c; color:#eef2fb; border:1px solid #313a46; border-radius:8px; padding:8px;" />
						<button class="btn-secondary" onclick="saveHttpServerPort()" title="save HTTP port">Save Port</button>
					</div>
				</div>
				<div class="detail-card">
					<h3>Reactor Name</h3>
					<div class="detail-value" id="reactorNameValue">(not set)</div>
					<div style="margin-top:10px; display:flex; gap:8px; align-items:center;">
						<input id="reactorNameInput" type="text" maxlength="120" placeholder="sender_1" style="width:220px; background:#12161c; color:#eef2fb; border:1px solid #313a46; border-radius:8px; padding:8px;" />
						<button class="btn-secondary" onclick="saveReactorName()" title="save Reactor name">Save Name</button>
					</div>
				</div>
				<div class="detail-card">
					<h3>Selected Script</h3>
					<div class="detail-value" id="selectedName">None</div>
				</div>
				<div class="detail-card">
					<h3>Path</h3>
					<div class="detail-value" id="selectedPath">-</div>
				</div>
				<div class="detail-card">
					<h3>Metadata</h3>
					<div class="detail-value" id="selectedMeta">Select a script from the list.</div>
				</div>
				<div id="statusBox" class="empty">Ready</div>
			</div>
		</div>
	</div>

	<div class="flow-modal" id="flowModal" aria-hidden="true">
		<div class="flow-shell" role="dialog" aria-modal="true" aria-label="Flow editor">
			<div class="flow-head">
				<div class="flow-title-wrap">
					<h3>Flow Editor</h3>
					<p id="flowPathHint">flow.json</p>
				</div>
				<div class="flow-head-actions">
					<button class="btn-secondary" onclick="saveFlowEditor()"><i class="fa-solid fa-floppy-disk" style="margin-right: 8px;"></i>Save Flow</button>
					<button class="btn-secondary" onclick="closeFlowEditor()"><i class="fa-solid fa-xmark" style="margin-right: 8px;"></i>Close</button>
				</div>
			</div>
			<div class="flow-body">
				<div class="flow-canvas" id="flowCanvas">
					<svg class="flow-edges" id="flowEdges"></svg>
					<div class="flow-nodes" id="flowNodes"></div>
				</div>
				<div class="flow-side">
					<div class="detail-card">
						<h3>Selected Node</h3>
						<div class="detail-value" id="flowSelectedNode">None</div>
					</div>
					<div class="detail-card">
						<h3>Trigger</h3>
						<select id="flowTriggerType" class="flow-input" onchange="onFlowTriggerTypeChange()">
							<option value="NONE">None</option>
							<option value="EVENT">Event (@on)</option>
							<option value="MESSAGE">Message (@on MESSAGE)</option>
							<option value="SCHEDULE">Schedule (@schedule)</option>
							<option value="WATCH">Watch (@watch)</option>
						</select>
						<input id="flowTriggerValue" class="flow-input" type="text" placeholder="Value" />
						<div class="detail-value" id="flowTriggerHint">Select a node to edit trigger.</div>
						<div class="flow-side-actions">
							<button class="btn-secondary" onclick="applyFlowTriggerToScript()"><i class="fa-solid fa-wand-magic-sparkles" style="margin-right: 8px;"></i>Apply Trigger</button>
						</div>
					</div>
					<div class="detail-card">
						<h3>Links</h3>
						<div class="detail-value" id="flowLinkHint">Click OUT on a node, then click another node to connect.</div>
						<div class="flow-side-actions">
							<button class="btn-secondary" onclick="clearSelectedNodeLinks()"><i class="fa-solid fa-link-slash" style="margin-right: 8px;"></i>Clear Links</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>

	<script>
		let scriptsState = [];
		let selectedIndex = -1;
		let templateMenuOpen = false;
		let logMenuOpen = false;
		let openItemLogIndex = -1;
		let flowState = { version: 1, nodes: [], edges: [] };
		let flowModalOpen = false;
		let selectedFlowNodeId = null;
		let pendingFlowLinkFromId = null;

		function setTemplateMenuOpen(nextOpen) {
			templateMenuOpen = nextOpen;
			const picker = document.getElementById('templatePicker');
			const menu = document.getElementById('templateMenu');
			if (!picker || !menu) {
				return;
			}

			picker.classList.toggle('open', templateMenuOpen);
			menu.setAttribute('aria-hidden', templateMenuOpen ? 'false' : 'true');
		}

		function toggleTemplateMenu(event) {
			if (event) {
				event.stopPropagation();
			}

			setTemplateMenuOpen(!templateMenuOpen);
		}

		function closeTemplateMenu() {
			setTemplateMenuOpen(false);
		}

		function setLogMenuOpen(nextOpen) {
			logMenuOpen = nextOpen;
			const picker = document.getElementById('logPicker');
			const menu = document.getElementById('logMenu');
			if (!picker || !menu) {
				return;
			}

			picker.classList.toggle('open', logMenuOpen);
			menu.setAttribute('aria-hidden', logMenuOpen ? 'false' : 'true');
		}

		function toggleLogMenu(event) {
			if (event) {
				event.stopPropagation();
			}

			setLogMenuOpen(!logMenuOpen);
		}

		function closeLogMenu() {
			setLogMenuOpen(false);
		}

		function setItemLogMenuOpen(index) {
			openItemLogIndex = index;
			document.querySelectorAll('.item-log-picker').forEach((picker) => {
				const pickerIndex = Number(picker.getAttribute('data-item-log-idx'));
				const menu = picker.querySelector('.item-log-menu');
				const card = picker.closest('.file-item');
				picker.classList.toggle('open', pickerIndex === openItemLogIndex);
				if (card) {
					card.classList.toggle('menu-open', pickerIndex === openItemLogIndex);
				}
				if (pickerIndex === openItemLogIndex) {
					picker.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'smooth' });
				}
				if (menu) {
					menu.setAttribute('aria-hidden', pickerIndex === openItemLogIndex ? 'false' : 'true');
				}
			});
		}

		function toggleItemLogMenu(index, event) {
			if (event) {
				event.stopPropagation();
			}

			setItemLogMenuOpen(openItemLogIndex === index ? -1 : index);
		}

		function closeItemLogMenu() {
			setItemLogMenuOpen(-1);
		}

		function makeFlowNodeId(scriptPath) {
			const base = String(scriptPath || 'script');
			let hash = 0;
			for (let index = 0; index < base.length; index += 1) {
				hash = ((hash << 5) - hash + base.charCodeAt(index)) | 0;
			}
			return 'node_' + String(Math.abs(hash));
		}

		function inferTriggerFromScript(script) {
			if (!script) {
				return { type: 'NONE', value: '' };
			}

			if (script.schedule) {
				return { type: 'SCHEDULE', value: String(script.schedule) };
			}

			if (Array.isArray(script.watch) && script.watch.length > 0) {
				const firstWatch = String(script.watch[0] || '').trim();
				const watchPath = firstWatch.split('[')[0].trim();
				return { type: 'WATCH', value: watchPath };
			}

			if (Array.isArray(script.events) && script.events.includes('MESSAGE')) {
				const sender = Array.isArray(script.messageSenders) && script.messageSenders.length > 0 ? script.messageSenders[0] : '';
				return { type: 'MESSAGE', value: sender || '' };
			}

			if (Array.isArray(script.events) && script.events.length > 0) {
				return { type: 'EVENT', value: String(script.events[0]) };
			}

			return { type: 'NONE', value: '' };
		}

		function normalizeFlowState(rawFlow) {
			const incoming = rawFlow && typeof rawFlow === 'object' ? rawFlow : {};
			const incomingNodes = Array.isArray(incoming.nodes) ? incoming.nodes : [];
			const nodeByPath = new Map();

			for (const node of incomingNodes) {
				if (!node || !node.scriptPath) {
					continue;
				}
				nodeByPath.set(node.scriptPath, node);
			}

			const nodes = scriptsState.map((script, index) => {
				const existing = nodeByPath.get(script.path);
				const fallbackTrigger = inferTriggerFromScript(script);
				return {
					id: existing && existing.id ? String(existing.id) : makeFlowNodeId(script.path),
					scriptPath: script.path,
					name: script.name,
					x: Number(existing && existing.x),
					y: Number(existing && existing.y),
					trigger: existing && existing.trigger ? existing.trigger : fallbackTrigger,
				};
			}).map((node, index) => ({
				...node,
				x: Number.isFinite(node.x) ? node.x : 80 + (index % 4) * 260,
				y: Number.isFinite(node.y) ? node.y : 70 + Math.floor(index / 4) * 170,
				trigger: {
					type: String(node.trigger && node.trigger.type ? node.trigger.type : 'NONE').toUpperCase(),
					value: String(node.trigger && node.trigger.value ? node.trigger.value : ''),
				},
			}));

			const nodeIds = new Set(nodes.map((node) => node.id));
			const edges = (Array.isArray(incoming.edges) ? incoming.edges : [])
				.filter((edge) => edge && nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to)
				.map((edge, index) => ({
					id: edge.id ? String(edge.id) : ('edge_' + index + '_' + Date.now()),
					from: String(edge.from),
					to: String(edge.to),
				}));

			return {
				version: Number(incoming.version) || 1,
				nodes,
				edges,
			};
		}

		function getFlowNodeById(nodeId) {
			return flowState.nodes.find((node) => node.id === nodeId) || null;
		}

		function getFlowNodeUi(nodeId) {
			return document.querySelector('.flow-node[data-flow-node-id="' + nodeId + '"]');
		}

		function drawFlowEdges() {
			const svg = document.getElementById('flowEdges');
			const nodesLayer = document.getElementById('flowNodes');
			if (!svg || !nodesLayer) {
				return;
			}

			const width = Math.max(nodesLayer.scrollWidth, nodesLayer.clientWidth, 1200);
			const height = Math.max(nodesLayer.scrollHeight, nodesLayer.clientHeight, 760);
			svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
			svg.setAttribute('width', String(width));
			svg.setAttribute('height', String(height));

			svg.innerHTML = flowState.edges.map((edge) => {
				const from = getFlowNodeById(edge.from);
				const to = getFlowNodeById(edge.to);
				if (!from || !to) {
					return '';
				}

				const startX = from.x + 220;
				const startY = from.y + 52;
				const endX = to.x;
				const endY = to.y + 52;
				const controlOffset = Math.max(54, Math.abs(endX - startX) * 0.45);
				const d = 'M ' + startX + ' ' + startY + ' C ' + (startX + controlOffset) + ' ' + startY + ', ' + (endX - controlOffset) + ' ' + endY + ', ' + endX + ' ' + endY;
				return '<path class="flow-edge" d="' + d + '" />';
			}).join('');
		}

		function getTriggerLabel(trigger) {
			const type = String(trigger && trigger.type ? trigger.type : 'NONE').toUpperCase();
			const value = String(trigger && trigger.value ? trigger.value : '');
			if (!value) {
				return type;
			}
			return type + ': ' + value;
		}

		function onFlowTriggerTypeChange() {
			const typeInput = document.getElementById('flowTriggerType');
			const valueInput = document.getElementById('flowTriggerValue');
			const hint = document.getElementById('flowTriggerHint');
			if (!typeInput || !valueInput || !hint) {
				return;
			}

			const type = String(typeInput.value || 'NONE').toUpperCase();
			if (type === 'EVENT') {
				valueInput.placeholder = 'BOOT, NET_UP, WIFI_OFF, ...';
				hint.textContent = 'Use one event name supported by @on.';
			} else if (type === 'MESSAGE') {
				valueInput.placeholder = 'sender_1 or 127.0.0.1[:port]';
				hint.textContent = 'Leave empty to accept messages from any sender.';
			} else if (type === 'SCHEDULE') {
				valueInput.placeholder = 'EVERY 30 SECOND';
				hint.textContent = 'Schedule expression used in @schedule.';
			} else if (type === 'WATCH') {
				valueInput.placeholder = '/path/to/folder';
				hint.textContent = 'Watch path used in @watch.';
			} else {
				valueInput.placeholder = 'Value';
				hint.textContent = 'Trigger disabled for this node.';
			}
		}

		function syncFlowSidePanel() {
			const selected = getFlowNodeById(selectedFlowNodeId);
			const selectedLabel = document.getElementById('flowSelectedNode');
			const typeInput = document.getElementById('flowTriggerType');
			const valueInput = document.getElementById('flowTriggerValue');
			if (!selectedLabel || !typeInput || !valueInput) {
				return;
			}

			if (!selected) {
				selectedLabel.textContent = 'None';
				typeInput.value = 'NONE';
				valueInput.value = '';
				onFlowTriggerTypeChange();
				return;
			}

			selectedLabel.textContent = selected.name + ' (' + selected.id + ')';
			typeInput.value = String(selected.trigger && selected.trigger.type ? selected.trigger.type : 'NONE').toUpperCase();
			valueInput.value = String(selected.trigger && selected.trigger.value ? selected.trigger.value : '');
			onFlowTriggerTypeChange();
		}

		function selectFlowNode(nodeId) {
			selectedFlowNodeId = nodeId;
			renderFlowEditor();
		}

		function startFlowLink(nodeId, event) {
			if (event) {
				event.stopPropagation();
			}
			pendingFlowLinkFromId = nodeId;
			const hint = document.getElementById('flowLinkHint');
			if (hint) {
				const fromNode = getFlowNodeById(nodeId);
				hint.textContent = 'Select target node for link from ' + ((fromNode && fromNode.name) ? fromNode.name : nodeId) + '.';
			}
		}

		function handleFlowNodeClick(nodeId, event) {
			if (event) {
				event.stopPropagation();
			}

			if (pendingFlowLinkFromId && pendingFlowLinkFromId !== nodeId) {
				const exists = flowState.edges.some((edge) => edge.from === pendingFlowLinkFromId && edge.to === nodeId);
				if (!exists) {
					flowState.edges.push({
						id: 'edge_' + Date.now() + '_' + Math.floor(Math.random() * 999),
						from: pendingFlowLinkFromId,
						to: nodeId,
					});
					showToast('Flow link added');
				}
				pendingFlowLinkFromId = null;
				const hint = document.getElementById('flowLinkHint');
				if (hint) {
					hint.textContent = 'Click OUT on a node, then click another node to connect.';
				}
			}

			selectFlowNode(nodeId);
		}

		function attachFlowNodeDragHandlers() {
			const nodesLayer = document.getElementById('flowNodes');
			if (!nodesLayer) {
				return;
			}

			document.querySelectorAll('.flow-node').forEach((nodeEl) => {
				nodeEl.addEventListener('mousedown', (event) => {
					if (event.button !== 0) {
						return;
					}
					if (event.target && event.target.closest('.flow-port.output')) {
						return;
					}

					const nodeId = nodeEl.getAttribute('data-flow-node-id');
					const node = getFlowNodeById(nodeId);
					if (!node) {
						return;
					}

					selectFlowNode(nodeId);
					event.preventDefault();

					const startX = event.clientX;
					const startY = event.clientY;
					const originX = node.x;
					const originY = node.y;

					const onMove = (moveEvent) => {
						const deltaX = moveEvent.clientX - startX;
						const deltaY = moveEvent.clientY - startY;
						node.x = Math.max(10, originX + deltaX + nodesLayer.scrollLeft);
						node.y = Math.max(10, originY + deltaY + nodesLayer.scrollTop);
						nodeEl.style.left = node.x + 'px';
						nodeEl.style.top = node.y + 'px';
						drawFlowEdges();
					};

					const onUp = () => {
						document.removeEventListener('mousemove', onMove);
						document.removeEventListener('mouseup', onUp);
					};

					document.addEventListener('mousemove', onMove);
					document.addEventListener('mouseup', onUp);
				});
			});
		}

		function renderFlowEditor() {
			const nodesLayer = document.getElementById('flowNodes');
			if (!nodesLayer) {
				return;
			}

			nodesLayer.innerHTML = flowState.nodes.map((node) => {
				const selected = node.id === selectedFlowNodeId ? ' selected' : '';
				const triggerLabel = getTriggerLabel(node.trigger);
				return '<div class="flow-node' + selected + '" data-flow-node-id="' + node.id + '" style="left:' + node.x + 'px; top:' + node.y + 'px;" onclick="handleFlowNodeClick(\'' + node.id + '\', event)">' +
					'<div class="flow-node-title">' + node.name.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
					'<div class="flow-node-meta">' + triggerLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
					'<div class="flow-node-ports">' +
						'<span class="flow-port">IN</span>' +
						'<button class="flow-port output" onclick="startFlowLink(\'' + node.id + '\', event)">OUT</button>' +
					'</div>' +
				'</div>';
			}).join('');

			attachFlowNodeDragHandlers();
			drawFlowEdges();
			syncFlowSidePanel();
		}

		function setFlowModalOpen(nextOpen) {
			flowModalOpen = Boolean(nextOpen);
			const modal = document.getElementById('flowModal');
			if (!modal) {
				return;
			}
			modal.classList.toggle('open', flowModalOpen);
			modal.setAttribute('aria-hidden', flowModalOpen ? 'false' : 'true');
		}

		async function openFlowEditor() {
			closeTemplateMenu();
			closeLogMenu();
			closeItemLogMenu();

			await refreshScripts();
			const result = await window.reactor.getFlowData();
			if (!result || !result.ok) {
				showToast('Flow load failed: ' + ((result && result.error) || 'unknown error'), 'error');
				return;
			}

			flowState = normalizeFlowState(result.flow || {});
			selectedFlowNodeId = flowState.nodes.length > 0 ? flowState.nodes[0].id : null;
			pendingFlowLinkFromId = null;
			const pathHint = document.getElementById('flowPathHint');
			if (pathHint) {
				pathHint.textContent = result.path || 'flow.json';
			}

			setFlowModalOpen(true);
			renderFlowEditor();
		}

		function closeFlowEditor() {
			setFlowModalOpen(false);
			pendingFlowLinkFromId = null;
			selectedFlowNodeId = null;
		}

		async function saveFlowEditor() {
			const result = await window.reactor.saveFlowData(flowState);
			if (!result || !result.ok) {
				showToast('Flow save failed: ' + ((result && result.error) || 'unknown error'), 'error');
				return;
			}

			document.getElementById('statusBox').textContent = 'Flow saved: ' + (result.path || 'flow.json');
			showToast('Flow saved');
		}

		async function applyFlowTriggerToScript() {
			const selected = getFlowNodeById(selectedFlowNodeId);
			if (!selected) {
				showToast('Select a flow node first', 'error');
				return;
			}

			const typeInput = document.getElementById('flowTriggerType');
			const valueInput = document.getElementById('flowTriggerValue');
			if (!typeInput || !valueInput) {
				return;
			}

			const trigger = {
				type: String(typeInput.value || 'NONE').toUpperCase(),
				value: String(valueInput.value || '').trim(),
			};

			const result = await window.reactor.setScriptTrigger(selected.scriptPath, trigger);
			if (!result || !result.ok) {
				showToast('Trigger apply failed: ' + ((result && result.error) || 'unknown error'), 'error');
				return;
			}

			selected.trigger = trigger;
			renderFlowEditor();
			await refreshScripts();
			document.getElementById('statusBox').textContent = 'Trigger updated on ' + selected.name;
			showToast('Trigger updated');
		}

		function clearSelectedNodeLinks() {
			if (!selectedFlowNodeId) {
				return;
			}
			flowState.edges = flowState.edges.filter((edge) => edge.from !== selectedFlowNodeId && edge.to !== selectedFlowNodeId);
			renderFlowEditor();
			showToast('Links cleared');
		}

		window.openFlowEditor = openFlowEditor;
		window.closeFlowEditor = closeFlowEditor;
		window.saveFlowEditor = saveFlowEditor;
		window.onFlowTriggerTypeChange = onFlowTriggerTypeChange;
		window.applyFlowTriggerToScript = applyFlowTriggerToScript;
		window.clearSelectedNodeLinks = clearSelectedNodeLinks;
		window.startFlowLink = startFlowLink;
		window.handleFlowNodeClick = handleFlowNodeClick;

		window.addEventListener('click', (event) => {
			const picker = document.getElementById('templatePicker');
			if (!picker || !picker.contains(event.target)) {
				closeTemplateMenu();
			}

			const logPicker = document.getElementById('logPicker');
			if (!logPicker || !logPicker.contains(event.target)) {
				closeLogMenu();
			}

			const openItemPicker = document.querySelector('.item-log-picker.open');
			if (openItemPicker && !openItemPicker.contains(event.target)) {
				closeItemLogMenu();
			}

			const flowModal = document.getElementById('flowModal');
			if (flowModalOpen && flowModal && event.target === flowModal) {
				closeFlowEditor();
			}
		});

		window.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && flowModalOpen) {
				closeFlowEditor();
			}
		});

		function showToast(message, type = 'success') {
			const stack = document.getElementById('toastStack');
			if (!stack) {
				return;
			}

			const toast = document.createElement('div');
			toast.className = 'toast ' + type;
			toast.textContent = message;
			stack.appendChild(toast);

			setTimeout(() => {
				toast.style.animation = 'toastOut 0.2s ease forwards';
				setTimeout(() => toast.remove(), 220);
			}, 2300);
		}

		function updateListSelectionUi() {
			document.querySelectorAll('.file-item').forEach((el) => {
				const idx = Number(el.getAttribute('data-idx'));
				el.classList.toggle('selected', idx === selectedIndex);
			});
		}

		function selectScript(index) {
			if (index < 0 || !scriptsState[index]) {
				return false;
			}

			if (selectedIndex === index) {
				renderDetails();
				return true;
			}

			selectedIndex = index;
			updateListSelectionUi();
			renderDetails();
			return true;
		}

		function buildScriptTagsHtml(script) {
			const enabledTag = script.enabled ? '<span class="tag ok">enabled</span>' : '<span class="tag">disabled</span>';
			const mutexTag = script.mutex ? '<span class="tag mutex">mutex</span>' : '<span class="tag">no mutex</span>';
			const scheduleTag = script.schedule ? '<span class="tag warn">' + script.schedule + '</span>' : '<span class="tag">no schedule</span>';
			const watchTag = script.watch && script.watch.length > 0 ? '<span class="tag watch">👁 watch (' + script.watch.length + ')</span>' : '<span class="tag">no watch</span>';
			return enabledTag + mutexTag + scheduleTag + watchTag;
		}

		function updateScriptCardUi(index) {
			const script = scriptsState[index];
			if (!script) {
				return;
			}

			const card = document.querySelector('.file-item[data-idx="' + index + '"]');
			if (!card) {
				return;
			}

			const tags = card.querySelector('.file-tags');
			if (tags) {
				tags.innerHTML = buildScriptTagsHtml(script);
			}

			const stateBtn = card.querySelector('[data-toggle-state-idx="' + index + '"]');
			if (stateBtn) {
				stateBtn.classList.remove('state-on', 'state-off');
				stateBtn.classList.add(script.enabled ? 'state-on' : 'state-off');
				stateBtn.textContent = script.enabled ? 'Enabled' : 'Disabled';
			}

			const mutexBtn = card.querySelector('[data-toggle-mutex-idx="' + index + '"]');
			if (mutexBtn) {
				mutexBtn.classList.remove('mutex-on', 'mutex-off');
				mutexBtn.classList.add(script.mutex ? 'mutex-on' : 'mutex-off');
				mutexBtn.textContent = script.mutex ? 'Mutex' : 'Mutex';
			}
		}

		function renderList() {
			const list = document.getElementById('scriptList');
			if (!scriptsState.length) {
				list.innerHTML = '<div class="empty">No scripts found in external folder.</div>';
				return;
			}

			list.innerHTML = scriptsState.map((script, idx) => {
				const selected = idx === selectedIndex ? 'selected' : '';
				const delayMs = Math.min(idx * 28, 220);
				const tagsHtml = buildScriptTagsHtml(script);
				const stateToggleClass = script.enabled ? 'state-on' : 'state-off';
				const stateToggleLabel = script.enabled ? 'Enabled' : 'Disabled';
				const mutexToggleClass = script.mutex ? 'mutex-on' : 'mutex-off';
				const mutexToggleLabel = script.mutex ? 'Mutex' : 'Mutex';
				return '<div class="file-item ' + selected + '" data-idx="' + idx + '" style="animation-delay:' + delayMs + 'ms">' +
					'<div class="file-header">' +
						'<div class="file-header-main">' +
							'<div class="file-name"><span class="file-name-label" data-name-idx="' + idx + '">' + script.name.replace(/\.(ts|js)$/i, '') + '</span></div>' +
							'<div class="file-tags">' + tagsHtml + '</div>' +
						'</div>' +
						'<div class="toggle-stack">' +
							'<button class="switch-toggle ' + stateToggleClass + '" data-toggle-state-idx="' + idx + '" title="Toggle state">' + stateToggleLabel + '</button>' +
							'<button class="switch-toggle ' + mutexToggleClass + '" data-toggle-mutex-idx="' + idx + '" title="Toggle mutex">' + mutexToggleLabel + '</button>' +
						'</div>' +
					'</div>' +
					'<div class="item-actions">' +
						'<button class="item-action-btn" data-open-idx="' + idx + '" title="Open"><i class="fa-solid fa-code"></i><span class="item-action-label">Open</span></button>' +
						'<button class="item-action-btn" data-rename-idx="' + idx + '" title="Rename"><i class="fa-solid fa-pen"></i><span class="item-action-label">Rename</span></button>' +
						'<button class="item-action-btn delete" data-delete-idx="' + idx + '" title="Delete"><i class="fa-solid fa-trash"></i><span class="item-action-label">Delete</span></button>' +
						'<button class="item-action-btn test" data-test-idx="' + idx + '" title="Test"><i class="fa-solid fa-play"></i><span class="item-action-label">Test</span></button>' +
						'<div class="item-log-picker" data-item-log-idx="' + idx + '">' +
							'<button class="item-action-btn" data-log-toggle-idx="' + idx + '" title="LOG"><i class="fa-solid fa-list"></i><span class="item-action-label">LOG</span></button>' +
							'<div class="item-log-menu" aria-hidden="true">' +
								'<button class="item-log-menu-item" data-log-view-idx="' + idx + '"><i class="fa-solid fa-magnifying-glass"></i><span>View</span></button>' +
								'<button class="item-log-menu-item danger" data-log-clear-idx="' + idx + '"><i class="fa-solid fa-trash"></i><span>Clear</span></button>' +
							'</div>' +
						'</div>' +
					'</div>' +
				'</div>';
			}).join('');

			document.querySelectorAll('.file-item').forEach((el) => {
				el.addEventListener('click', () => {
					const idx = Number(el.getAttribute('data-idx'));
					selectScript(idx);
				});
			});

			document.querySelectorAll('[data-open-idx]').forEach((btn) => {
				btn.addEventListener('click', (event) => {
					event.stopPropagation();
					const idx = Number(btn.getAttribute('data-open-idx'));
					if (Number.isNaN(idx)) {
						return;
					}
					openScriptAtIndex(idx);
				});
			});

			document.querySelectorAll('[data-rename-idx]').forEach((btn) => {
				btn.addEventListener('click', async (event) => {
					event.stopPropagation();
					const idx = Number(btn.getAttribute('data-rename-idx'));
					if (Number.isNaN(idx)) {
						return;
					}
					await renameScriptAtIndex(idx);
				});
			});

			document.querySelectorAll('[data-delete-idx]').forEach((btn) => {
				btn.addEventListener('click', async (event) => {
					event.stopPropagation();
					const idx = Number(btn.getAttribute('data-delete-idx'));
					if (Number.isNaN(idx)) {
						return;
					}
					await deleteSelectedScript(idx);
				});
			});

			document.querySelectorAll('[data-test-idx]').forEach((btn) => {
				btn.addEventListener('click', async (event) => {
					event.stopPropagation();
					const idx = Number(btn.getAttribute('data-test-idx'));
					if (Number.isNaN(idx)) {
						return;
					}
					await runSelectedScriptTest(idx);
				});
			});

			document.querySelectorAll('[data-log-toggle-idx]').forEach((btn) => {
				btn.addEventListener('click', (event) => {
					const idx = Number(btn.getAttribute('data-log-toggle-idx'));
					if (Number.isNaN(idx)) {
						return;
					}
					toggleItemLogMenu(idx, event);
				});
			});

			document.querySelectorAll('[data-log-view-idx]').forEach((btn) => {
				btn.addEventListener('click', async (event) => {
					event.stopPropagation();
					const idx = Number(btn.getAttribute('data-log-view-idx'));
					if (Number.isNaN(idx)) {
						return;
					}
					await openScriptActivityLog(idx);
				});
			});

			document.querySelectorAll('[data-log-clear-idx]').forEach((btn) => {
				btn.addEventListener('click', async (event) => {
					event.stopPropagation();
					const idx = Number(btn.getAttribute('data-log-clear-idx'));
					if (Number.isNaN(idx)) {
						return;
					}
					await clearScriptActivityLog(idx);
				});
			});

			document.querySelectorAll('[data-toggle-state-idx]').forEach((btn) => {
				btn.addEventListener('click', async (event) => {
					event.stopPropagation();
					const idx = Number(btn.getAttribute('data-toggle-state-idx'));
					await toggleDirectiveForScript(idx, 'state');
				});
			});

			document.querySelectorAll('[data-toggle-mutex-idx]').forEach((btn) => {
				btn.addEventListener('click', async (event) => {
					event.stopPropagation();
					const idx = Number(btn.getAttribute('data-toggle-mutex-idx'));
					await toggleDirectiveForScript(idx, 'mutex');
				});
			});

			document.querySelectorAll('[data-name-idx]').forEach((label) => {
				label.addEventListener('click', (event) => {
					event.stopPropagation();
					const idx = Number(label.getAttribute('data-name-idx'));
					if (Number.isNaN(idx)) {
						return;
					}
					selectScript(idx);
					triggerInlineRename(idx);
				});
			});
		}

		async function toggleDirectiveForScript(index, directive) {
			if (index < 0 || !scriptsState[index]) {
				return;
			}

			const script = scriptsState[index];
			const result = await window.reactor.toggleScriptDirective(script.path, directive);
			if (!result || !result.ok) {
				showToast('Failed to toggle ' + directive, 'error');
				return;
			}

			if (directive === 'state') {
				const isEnabled = String(result.value || '').toUpperCase() === 'ENABLED';
				script.enabled = isEnabled;
				script.state = isEnabled ? 'ENABLED' : 'DISABLED';
			} else {
				script.mutex = String(result.value || '').toUpperCase() === 'ON';
			}

			updateScriptCardUi(index);
			if (selectedIndex === index) {
				renderDetails();
			}

			showToast('Updated ' + directive + ' on ' + script.name);
		}

		function renderDetails() {
			if (selectedIndex < 0 || !scriptsState[selectedIndex]) {
				document.getElementById('selectedName').textContent = 'None';
				document.getElementById('selectedPath').textContent = '-';
				document.getElementById('selectedMeta').textContent = 'Select a script from the list.';
				return;
			}

			const script = scriptsState[selectedIndex];
			const messageMeta = script.events && script.events.includes('MESSAGE')
				? (script.messageFromAnySender ? '*' : ((script.messageSenders || []).join(', ') || '*'))
				: 'none';
			document.getElementById('selectedName').textContent = script.name;
			document.getElementById('selectedPath').textContent = script.path;
			document.getElementById('selectedMeta').textContent =
				'State: ' + script.state +
				' | Schedule: ' + (script.schedule || 'none') +
				' | Events: ' + (script.events.join(', ') || 'none') +
				' | Message From: ' + messageMeta +
				' | Watch: ' + (script.watch && script.watch.length > 0 ? script.watch.join(', ') : 'none') +
				' | Mutex: ' + (script.mutex ? 'on' : 'off');
		}

		async function openScriptAtIndex(index) {
			if (!selectScript(index)) {
				return;
			}
			await openWith();
		}

		async function runSelectedScriptTest(index = selectedIndex) {
			if (!selectScript(index)) {
				return;
			}

			const script = scriptsState[index];
			const result = await window.reactor.runScriptNow(script.path);
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'Test failed: ' + ((result && result.error) || 'unknown error');
				showToast('Test start failed', 'error');
				return;
			}

			document.getElementById('statusBox').textContent = 'Test started: ' + script.name;
			showToast('Test started for ' + script.name);
		}

		async function createNewScript(template = 'schedule') {
			closeTemplateMenu();
			const result = await window.reactor.createScriptFile(template);
			if (!result || result.canceled) {
				showToast('Script creation canceled', 'error');
				return;
			}

			if (!result.ok) {
				showToast('Script creation failed: ' + (result.error || 'unknown error'), 'error');
				return;
			}

			await refreshScripts();
			const createdIndex = scriptsState.findIndex((script) => script.path === result.path);
			if (createdIndex >= 0) {
				selectedIndex = createdIndex;
				renderList();
				renderDetails();
			}

			document.getElementById('statusBox').textContent = 'Script created: ' + result.path;
			showToast('New script created: ' + result.path);

			if (result.opened === false) {
				showToast('Script created but failed to open: ' + (result.openError || 'unknown error'), 'error');
			}
		}

		function triggerInlineRename(index) {
			const card = document.querySelector('.file-item[data-idx="' + index + '"]');
			if (!card) {
				return;
			}

			const label = card.querySelector('.file-name-label[data-name-idx="' + index + '"]');
			if (!label || card.querySelector('.file-name-input')) {
				return;
			}

			const originalName = label.textContent;
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'file-name-input';
			input.value = originalName;

			label.style.display = 'none';
			label.parentNode.appendChild(input);
			input.focus();
			input.select();

			let committed = false;

			const restore = () => {
				input.remove();
				label.style.display = '';
			};

			const commit = async () => {
				if (committed) {
					return;
				}
				committed = true;
				const nextName = input.value.trim();
				restore();
				if (!nextName || nextName === originalName) {
					return;
				}
				await applyRename(index, nextName);
			};

			const cancel = () => {
				if (committed) {
					return;
				}
				committed = true;
				restore();
			};

			input.addEventListener('blur', commit);
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					input.blur();
				} else if (e.key === 'Escape') {
					input.removeEventListener('blur', commit);
					input.addEventListener('blur', cancel);
					input.blur();
				}
			});
		}

		async function applyRename(index, nextName) {
			if (index < 0 || !scriptsState[index]) {
				return;
			}

			const script = scriptsState[index];
			const result = await window.reactor.renameScriptFile(script.path, nextName);
			if (!result || !result.ok) {
				showToast('Rename failed: ' + ((result && result.error) || 'unknown error'), 'error');
				const card = document.querySelector('.file-item[data-idx="' + index + '"]');
				const lbl = card && card.querySelector('.file-name-label[data-name-idx="' + index + '"]');
				if (lbl) {
					lbl.textContent = script.name.replace(/\.(ts|js)$/i, '');
				}
				return;
			}

			script.name = result.name;
			script.path = result.path;

			const card = document.querySelector('.file-item[data-idx="' + index + '"]');
			const lbl = card && card.querySelector('.file-name-label[data-name-idx="' + index + '"]');
			if (lbl) {
				lbl.textContent = result.name.replace(/\.(ts|js)$/i, '');
			}

			if (selectedIndex === index) {
				renderDetails();
			}

			document.getElementById('statusBox').textContent = 'Renamed: ' + result.name;
			showToast('Script has been renamed');
		}

		async function renameScriptAtIndex(index) {
			if (index < 0 || !scriptsState[index]) {
				return;
			}
			triggerInlineRename(index);
		}

		async function deleteSelectedScript(index = selectedIndex) {
			if (index < 0 || !scriptsState[index]) {
				return;
			}

			const script = scriptsState[index];
			const confirmation = await window.reactor.confirmDeleteScript(script.name);
			if (!confirmation || !confirmation.ok || !confirmation.confirmed) {
				return;
			}

			const result = await window.reactor.deleteScriptFile(script.path);
			if (!result || !result.ok) {
				showToast('Deletion failed: ' + ((result && result.error) || 'unknown error'), 'error');
				return;
			}

			selectedIndex = -1;
			await refreshScripts();
			document.getElementById('statusBox').textContent = 'Script deleted: ' + script.name;
			showToast('Script deleted');
		}

		async function refreshScripts() {
			const info = await window.reactor.getScriptsInfo();
			document.getElementById('scriptsPath').textContent = info.path;
			scriptsState = info.scripts || [];

			if (selectedIndex >= scriptsState.length) {
				selectedIndex = scriptsState.length ? 0 : -1;
			}

			if (selectedIndex === -1 && scriptsState.length) {
				selectedIndex = 0;
			}

			renderList();
			renderDetails();
			document.getElementById('statusBox').textContent = 'Loaded ' + scriptsState.length + ' script(s)';
		}

		async function refreshDefaultProgram() {
			const settings = await window.reactor.getUiSettings();
			const value = settings.defaultProgramPath || 'System default (not set)';
			document.getElementById('defaultProgramPath').textContent = value;
		}

		async function refreshHttpServerPort() {
			const result = await window.reactor.getHttpServerConfig();
			if (!result || !result.ok || !result.config) {
				document.getElementById('httpServerPortValue').textContent = 'Unavailable';
				return;
			}

			const port = Number(result.config.port) || 7070;
			document.getElementById('httpServerPortValue').textContent = String(port);
			const input = document.getElementById('httpServerPortInput');
			if (input && !input.value) {
				input.value = String(port);
			}
		}

		async function refreshReactorName() {
			const result = await window.reactor.getReactorName();
			if (!result || !result.ok) {
				document.getElementById('reactorNameValue').textContent = '(unavailable)';
				return;
			}

			const value = String(result.name || '').trim();
			document.getElementById('reactorNameValue').textContent = value || '(not set)';
			const input = document.getElementById('reactorNameInput');
			if (input && !input.value) {
				input.value = value;
			}
		}

		async function saveHttpServerPort() {
			const input = document.getElementById('httpServerPortInput');
			if (!input) {
				return;
			}

			const port = Number(input.value);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				document.getElementById('statusBox').textContent = 'Invalid HTTP port';
				showToast('Invalid HTTP port', 'error');
				return;
			}

			const result = await window.reactor.setHttpServerPort(port);
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'HTTP port update failed: ' + ((result && result.error) || 'unknown error');
				showToast('HTTP port update failed', 'error');
				return;
			}

			document.getElementById('httpServerPortValue').textContent = String(result.config.port);
			document.getElementById('statusBox').textContent = 'HTTP server port set to ' + result.config.port;
			showToast('HTTP server port updated');
		}

		async function saveReactorName() {
			const input = document.getElementById('reactorNameInput');
			if (!input) {
				return;
			}

			const nextName = String(input.value || '').trim();
			const result = await window.reactor.setReactorName(nextName);
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'Reactor name update failed: ' + ((result && result.error) || 'unknown error');
				showToast('Reactor name update failed', 'error');
				return;
			}

			document.getElementById('reactorNameValue').textContent = result.name || '(not set)';
			document.getElementById('statusBox').textContent = result.name ? ('Reactor name set to ' + result.name) : 'Reactor name cleared';
			showToast('Reactor name saved');
		}

		async function openServerStatus() {
			const result = await window.reactor.openServerStatus();
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'Open server status failed: ' + ((result && result.error) || 'unknown error');
				showToast('Failed to open server status', 'error');
				return;
			}

			document.getElementById('statusBox').textContent = 'Opened server status: ' + result.url;
			showToast('Server status opened');
		}

		async function openScriptsFolder() {
			await window.reactor.openScriptsFolder();
			document.getElementById('statusBox').textContent = 'Opened scripts folder';
			showToast('External folder opened');
		}

		async function openWith() {
			if (selectedIndex < 0 || !scriptsState[selectedIndex]) {
				return;
			}
			const script = scriptsState[selectedIndex];
			const result = await window.reactor.openScriptFile(script.path);
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'Open failed: ' + ((result && result.error) || 'unknown error');
				showToast('Failed to open script', 'error');
				return;
			}
			document.getElementById('statusBox').textContent = 'Opened with default app: ' + script.name;
			showToast('Script opened: ' + script.name);
		}

		async function chooseDefaultProgram() {
			const result = await window.reactor.pickDefaultProgram();
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'Default program unchanged';
				showToast('Default program not changed', 'error');
				return;
			}
			await refreshDefaultProgram();
			document.getElementById('statusBox').textContent = 'Default program saved';
			showToast('Default program saved');
		}

		async function openEventLog() {
			closeLogMenu();
			const result = await window.reactor.openEventLog();
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'Open activity.log failed: ' + ((result && result.error) || 'unknown error');
				showToast('Failed to open activity.log', 'error');
				return;
			}
			document.getElementById('statusBox').textContent = 'Opened activity.log';
			showToast('activity.log opened');
		}

		async function clearEventLog() {
			closeLogMenu();
			const result = await window.reactor.clearEventLog();
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'Clear activity.log failed: ' + ((result && result.error) || 'unknown error');
				showToast('Failed to clear activity.log', 'error');
				return;
			}
			document.getElementById('statusBox').textContent = 'activity.log cleared';
			showToast('activity.log cleared');
		}

		async function openScriptActivityLog(index) {
			if (index < 0 || !scriptsState[index]) {
				return;
			}

			closeItemLogMenu();
			const script = scriptsState[index];
			const result = await window.reactor.openEventLog(script.path);
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'Open activity.log failed: ' + ((result && result.error) || 'unknown error');
				showToast('Failed to open activity.log', 'error');
				return;
			}

			document.getElementById('statusBox').textContent = 'Opened activity.log for ' + script.name;
			showToast('activity.log opened for ' + script.name);
		}

		async function clearScriptActivityLog(index) {
			if (index < 0 || !scriptsState[index]) {
				return;
			}

			closeItemLogMenu();
			const script = scriptsState[index];
			const result = await window.reactor.clearEventLog(script.path);
			if (!result || !result.ok) {
				document.getElementById('statusBox').textContent = 'Clear activity.log failed: ' + ((result && result.error) || 'unknown error');
				showToast('Failed to clear activity.log', 'error');
				return;
			}

			document.getElementById('statusBox').textContent = 'activity.log cleared for ' + script.name;
			showToast('activity.log cleared for ' + script.name);
		}

		async function initialLoad() {
			await refreshDefaultProgram();
			await refreshHttpServerPort();
			await refreshReactorName();
			await refreshScripts();
		}

		initialLoad();
	</script>
</body>
</html>`;
}

/**
 * Creates the main Electron window with UI
 */
function createMainWindow() {
	const preloadPath = path.join(__dirname, '..', 'preload.js');
	const { width, height } = screen.getPrimaryDisplay().workAreaSize;
	const mainWindow = new BrowserWindow({
		width,
		height,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});

	const htmlContent = buildHtmlContent();
	mainWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(htmlContent));
	mainWindow.maximize();
	return mainWindow;
}

/**
 * Sets up IPC handlers for UI communication
 */
function setupIpcHandlers(runtime) {
	readUiSettings()
		.then(async (settings) => {
			if (runtime && runtime.setHttpServerPort && Number(settings.httpServerPort)) {
				await runtime.setHttpServerPort(Number(settings.httpServerPort));
			}
		})
		.catch(() => {
			// Ignore settings bootstrap failures.
		});

	ipcMain.handle('get-ui-settings', async () => {
		return readUiSettings();
	});

	ipcMain.handle('get-http-server-config', async () => {
		if (!runtime || !runtime.getHttpServerConfig) {
			return { ok: false, error: 'runtime not ready' };
		}

		return { ok: true, config: runtime.getHttpServerConfig() };
	});

	ipcMain.handle('set-http-server-port', async (_, port) => {
		if (!runtime || !runtime.setHttpServerPort) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			const config = await runtime.setHttpServerPort(port);
			await writeUiSettings({ httpServerPort: config.port });
			return { ok: true, config };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-http-server-logs', async (_, limit) => {
		if (!runtime || !runtime.getHttpServerLogs) {
			return { ok: false, error: 'runtime not ready' };
		}

		return { ok: true, logs: runtime.getHttpServerLogs(limit) };
	});

	ipcMain.handle('get-reactor-name', async () => {
		if (!runtime || !runtime.getReactorName) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			const name = await runtime.getReactorName();
			return { ok: true, name };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('set-reactor-name', async (_, name) => {
		if (!runtime || !runtime.setReactorName) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			const nextName = await runtime.setReactorName(name);
			return { ok: true, name: nextName };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('open-server-status', async () => {
		if (!runtime || !runtime.getHttpServerConfig) {
			return { ok: false, error: 'runtime not ready' };
		}

		try {
			const config = runtime.getHttpServerConfig();
			const port = Number(config.port) || 7070;
			const targetUrl = `http://localhost:${port}`;
			await shell.openExternal(targetUrl);
			return { ok: true, url: targetUrl };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('pick-default-program', async () => {
		const result = await dialog.showOpenDialog({
			title: 'Select default program for scripts',
			properties: ['openFile'],
		});

		if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
			return { ok: false, canceled: true };
		}

		const nextSettings = { defaultProgramPath: result.filePaths[0] };
		await writeUiSettings(nextSettings);
		return { ok: true, defaultProgramPath: nextSettings.defaultProgramPath };
	});

	ipcMain.handle('open-scripts-folder', async () => {
		if (runtime) {
			await shell.openPath(runtime.scriptsDir);
		}
	});

	ipcMain.handle('open-script-file', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);

		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		return openWithConfiguredProgramOrDefault(normalizedFilePath);
	});

	ipcMain.handle('run-script-now', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		const script = runtime.scripts.find((candidate) => path.resolve(candidate.path) === normalizedFilePath);
		if (!script) {
			return { ok: false, error: 'script not loaded, refresh UI and retry' };
		}

		runtime
			.runScript(script, { trigger: 'MANUAL_TEST', event: 'ON_DEMAND', force: true })
			.catch((error) => {
				runtime.log(`Manual test failed for ${script.name}: ${error.message}`);
			});

		return { ok: true, started: true, script: script.name };
	});

	ipcMain.handle('create-script-file', async (_, templateKey) => {
		if (!runtime) {
			return { ok: false, error: 'runtime not ready' };
		}

		await fs.mkdir(runtime.scriptsDir, { recursive: true });
		const saveResult = await dialog.showSaveDialog({
			title: 'Create new script',
			defaultPath: path.join(runtime.scriptsDir, 'new-script'),
		});

		if (saveResult.canceled || !saveResult.filePath) {
			return { ok: false, canceled: true };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const targetPath = path.resolve(saveResult.filePath);
		if (!targetPath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'target path outside scripts directory' };
		}

		const requestedStem = path.basename(targetPath).replace(/\.(ts|js)$/i, '');
		const safeStem = String(requestedStem)
			.trim()
			.replace(/[^a-zA-Z0-9._-]/g, '-');

		if (!safeStem) {
			return { ok: false, error: 'invalid script name' };
		}

		const projectRoot = path.join(path.dirname(targetPath), safeStem);
		if (!path.resolve(projectRoot).startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'project path outside scripts directory' };
		}

		const scriptFileName = 'boot.ts';
		const scriptFilePath = path.join(projectRoot, scriptFileName);
		const contextFilePath = path.join(projectRoot, 'context.ts');
		const packageJsonPath = path.join(projectRoot, 'package.json');
		const eventLogPath = path.join(projectRoot, 'activity.log');

		const npmSafeName = safeStem
			.toLowerCase()
			.replace(/[^a-z0-9._-]/g, '-')
			.replace(/^[._-]+/, '') || 'reactor-script';

		const templateMap = {
			blank: [
				'// @state DISABLED',
				'// @mutex OFF',
				'',
				'',
				'',
				"import { log } from 'core';",
				"import type { Context } from 'core';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait log('new blank script');",
				'}',
				'',
			],
			schedule: [
				'// @state DISABLED',
				'// @mutex OFF',
				'// @schedule EVERY 30 SECOND',
				'',
				'',
				'',
				"import { log } from 'core';",
				"import type { Context } from 'core';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait log('scheduled script tick');",
				'}',
				'',
			],
			event: [
				'// @state DISABLED',
				'// @mutex ON',
				'// @on MESSAGE(sender_1)',
				'',
				'',
				'',
				"import { log } from 'core';",
				"import type { Context } from 'core';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait log('message from ' + (ctx.messageSenderName || ctx.messageSender || 'unknown') + ': ' + (ctx.messageContent || ''));",
				'}',
				'',
			],
			watch: [
				'// @state DISABLED',
				'// @mutex ON',
				'// @watch /Abs/Path/of/Desktop',
				'// @watch /Abs/Path/of/Downloads [file:created]',
				'',
				'',
				'',
				"import { log } from 'core';",
				"import type { Context } from 'core';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait log('watch event: ' + ctx.watchPath + ' (' + ctx.watchType + ')');",
				'}',
				'',
			],
		};

		const safeTemplateKey = templateKey && templateMap[templateKey] ? templateKey : 'schedule';
		const initialContent = templateMap[safeTemplateKey].join('\n');
		const contextContent = [
			"export type { Context } from 'core';",
			'',
		].join('\n');
		const packageJson = {
			name: npmSafeName,
			version: '1.0.0',
			private: true,
			type: 'commonjs',
			main: 'boot.ts',
			description: `Reactor script project: ${safeStem}`,
		};

		try {
			await fs.mkdir(projectRoot);
			await fs.writeFile(contextFilePath, contextContent, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(scriptFilePath, initialContent, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
			await fs.writeFile(eventLogPath, '', { encoding: 'utf8', flag: 'wx' });
		} catch (error) {
			if (error.code === 'EEXIST' || error.code === 'ERR_FS_EISDIR') {
				return { ok: false, error: 'script project already exists' };
			}
			return { ok: false, error: error.message };
		}

		const openResult = await openWithConfiguredProgramOrDefault(scriptFilePath);

		try {
			await runtime.reloadScripts('ui-create-script');
		} catch (error) {
			runtime.log(`Immediate reload after create failed: ${error.message}`);
		}

		return {
			ok: true,
			path: scriptFilePath,
			template: safeTemplateKey,
			opened: openResult.ok,
			openError: openResult.ok ? null : openResult.error,
		};
	});

	ipcMain.handle('confirm-delete-script', async (_, scriptName) => {
		const response = await dialog.showMessageBox({
			type: 'warning',
			title: 'Confirm script deletion',
			message: `Are you sure to delete ${scriptName || 'this script'}?`,
			detail: 'This action is not reversible',
			buttons: ['Delete', 'Cancel'],
			defaultId: 1,
			cancelId: 1,
			noLink: true,
		});

		return { ok: true, confirmed: response.response === 0 };
	});

	ipcMain.handle('delete-script-file', async (_, filePath) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		try {
			const scriptDir = path.dirname(normalizedFilePath);
			const isBootProjectScript = path.basename(normalizedFilePath).toLowerCase() === 'boot.ts' && scriptDir !== allowedPath;

			let isProjectFolder = false;
			if (isBootProjectScript && path.resolve(scriptDir).startsWith(allowedPath + path.sep)) {
				try {
					await fs.access(path.join(scriptDir, 'package.json'));
					isProjectFolder = true;
				} catch {
					isProjectFolder = false;
				}
			}

			if (isProjectFolder) {
				const packageJsonPath = path.join(scriptDir, 'package.json');
				try {
					await fs.access(packageJsonPath);
					await fs.rm(scriptDir, { recursive: true, force: true });
				} catch {
					await fs.unlink(normalizedFilePath);
				}
			} else {
				await fs.unlink(normalizedFilePath);
			}

			await runtime.reloadScripts('ui-delete-script');
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('rename-script-file', async (_, filePath, nextName) => {
		if (!runtime || !filePath || !nextName) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		const safeName = String(nextName)
			.trim()
			.replace(/[^a-zA-Z0-9._-]/g, '-');

		if (!safeName) {
			return { ok: false, error: 'invalid script name' };
		}

		const originalExt = path.extname(normalizedFilePath) || '.ts';
		const hasKnownExtension = /\.(ts|js)$/i.test(safeName);
		const finalName = hasKnownExtension ? safeName : `${safeName}${originalExt}`;
		const destination = path.join(path.dirname(normalizedFilePath), finalName);

		if (!path.resolve(destination).startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'destination path not allowed' };
		}

		const currentDir = path.dirname(normalizedFilePath);
		const currentDirName = path.basename(currentDir);
		const finalStem = safeName.replace(/\.(ts|js)$/i, '');

		let isProjectFolder = false;
		if (
			path.basename(normalizedFilePath).toLowerCase() === 'boot.ts' &&
			currentDirName &&
			path.resolve(currentDir).startsWith(allowedPath + path.sep)
		) {
			try {
				await fs.access(path.join(currentDir, 'package.json'));
				isProjectFolder = true;
			} catch {
				isProjectFolder = false;
			}
		}

		if (isProjectFolder) {
			const destinationDir = path.join(path.dirname(currentDir), finalStem);
			if (!path.resolve(destinationDir).startsWith(allowedPath + path.sep)) {
				return { ok: false, error: 'destination path not allowed' };
			}

			if (path.resolve(destinationDir) !== path.resolve(currentDir)) {
				try {
					await fs.access(destinationDir);
					return { ok: false, error: 'a script with this name already exists' };
				} catch (error) {
					if (error.code !== 'ENOENT') {
						return { ok: false, error: error.message };
					}
				}
			}

			try {
				if (path.resolve(destinationDir) !== path.resolve(currentDir)) {
					await fs.rename(currentDir, destinationDir);
				}

				const renamedFinalFilePath = path.join(destinationDir, 'boot.ts');

				const packageJsonPath = path.join(destinationDir, 'package.json');
				try {
					const packageRaw = await fs.readFile(packageJsonPath, 'utf8');
					const packageJson = JSON.parse(packageRaw);
					const npmSafeName = finalStem
						.toLowerCase()
						.replace(/[^a-z0-9._-]/g, '-')
						.replace(/^[._-]+/, '') || 'reactor-script';
					packageJson.name = npmSafeName;
					await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
				} catch {
					// Ignore package.json update failures: script file rename already succeeded.
				}

				await runtime.reloadScripts('ui-rename-script');
				return { ok: true, path: renamedFinalFilePath, name: finalStem };
			} catch (error) {
				return { ok: false, error: error.message };
			}
		}

		try {
			if (path.resolve(destination) === normalizedFilePath) {
				return { ok: true, path: normalizedFilePath, name: path.basename(normalizedFilePath) };
			}

			await fs.access(destination);
			return { ok: false, error: 'a script with this name already exists' };
		} catch (error) {
			if (error.code !== 'ENOENT') {
				return { ok: false, error: error.message };
			}
		}

		try {
			await fs.rename(normalizedFilePath, destination);
			await runtime.reloadScripts('ui-rename-script');
			return { ok: true, path: destination, name: path.basename(destination) };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('toggle-script-directive', async (_, filePath, directive) => {
		if (!runtime || !filePath || !directive) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		if (directive !== 'state' && directive !== 'mutex') {
			return { ok: false, error: 'invalid directive' };
		}

		try {
			let source = await fs.readFile(normalizedFilePath, 'utf8');

			if (directive === 'state') {
				const currentValues = parseDirectiveHeader(source);
				const current = currentValues.state || 'DISABLED';
				const next = current === 'ENABLED' ? 'DISABLED' : 'ENABLED';
				source = rebuildDirectiveHeader(source, { state: next });

				await fs.writeFile(normalizedFilePath, source, 'utf8');
				return { ok: true, directive: 'state', value: next };
			}

			const currentValues = parseDirectiveHeader(source);
			const currentMutex = currentValues.mutex ? currentValues.mutex !== 'OFF' : false;
			const nextMutex = !currentMutex;
			const nextValue = nextMutex ? 'ON' : 'OFF';
			source = rebuildDirectiveHeader(source, { mutex: nextValue });

			await fs.writeFile(normalizedFilePath, source, 'utf8');
			return { ok: true, directive: 'mutex', value: nextValue };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-flow-data', async () => {
		if (!runtime) {
			return { ok: false, error: 'runtime unavailable' };
		}

		const reactorRoot = path.resolve(runtime.reactorRootDir || path.dirname(runtime.scriptsDir));
		const flowPath = path.join(reactorRoot, 'flow.json');

		try {
			const raw = await fs.readFile(flowPath, 'utf8');
			const parsed = JSON.parse(raw);
			const nodes = Array.isArray(parsed && parsed.nodes) ? parsed.nodes : [];
			const edges = Array.isArray(parsed && parsed.edges) ? parsed.edges : [];
			return {
				ok: true,
				path: flowPath,
				flow: {
					version: Number(parsed && parsed.version) || 1,
					nodes,
					edges,
					updatedAt: parsed && parsed.updatedAt ? parsed.updatedAt : null,
				},
			};
		} catch (error) {
			if (error && error.code !== 'ENOENT') {
				return { ok: false, error: error.message };
			}

			return {
				ok: true,
				path: flowPath,
				flow: {
					version: 1,
					nodes: [],
					edges: [],
					updatedAt: null,
				},
			};
		}
	});

	ipcMain.handle('save-flow-data', async (_, flow) => {
		if (!runtime) {
			return { ok: false, error: 'runtime unavailable' };
		}

		const reactorRoot = path.resolve(runtime.reactorRootDir || path.dirname(runtime.scriptsDir));
		const flowPath = path.join(reactorRoot, 'flow.json');
		const incoming = flow && typeof flow === 'object' ? flow : {};
		const safeFlow = {
			version: Number(incoming.version) || 1,
			nodes: Array.isArray(incoming.nodes) ? incoming.nodes : [],
			edges: Array.isArray(incoming.edges) ? incoming.edges : [],
			updatedAt: new Date().toISOString(),
		};

		try {
			await fs.mkdir(path.dirname(flowPath), { recursive: true });
			await fs.writeFile(flowPath, `${JSON.stringify(safeFlow, null, 2)}\n`, 'utf8');
			return { ok: true, path: flowPath };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('set-script-trigger', async (_, filePath, trigger) => {
		if (!runtime || !filePath) {
			return { ok: false, error: 'invalid request' };
		}

		const allowedPath = path.resolve(runtime.scriptsDir);
		const normalizedFilePath = path.resolve(filePath);
		if (!normalizedFilePath.startsWith(allowedPath + path.sep)) {
			return { ok: false, error: 'path not allowed' };
		}

		const triggerObj = trigger && typeof trigger === 'object' ? trigger : {};
		const type = String(triggerObj.type || 'NONE').trim().toUpperCase();
		const value = String(triggerObj.value || '').trim();
		const overrides = {};

		if (type === 'MESSAGE') {
			overrides.on = value ? `MESSAGE(${value})` : 'MESSAGE';
			overrides.schedule = null;
			overrides.watch = [];
		} else if (type === 'EVENT') {
			if (!value) {
				return { ok: false, error: 'event value required' };
			}
			overrides.on = value.toUpperCase();
			overrides.schedule = null;
			overrides.watch = [];
		} else if (type === 'SCHEDULE') {
			if (!value) {
				return { ok: false, error: 'schedule expression required' };
			}
			overrides.on = null;
			overrides.schedule = value;
			overrides.watch = [];
		} else if (type === 'WATCH') {
			if (!value) {
				return { ok: false, error: 'watch path required' };
			}
			overrides.on = null;
			overrides.schedule = null;
			overrides.watch = [value];
		} else {
			overrides.on = null;
			overrides.schedule = null;
			overrides.watch = [];
		}

		try {
			const source = await fs.readFile(normalizedFilePath, 'utf8');
			const rebuilt = rebuildDirectiveHeader(source, overrides);
			await fs.writeFile(normalizedFilePath, rebuilt, 'utf8');
			await runtime.reloadScripts('ui-set-script-trigger');
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('open-event-log', async (_, filePath) => {
		if (!runtime) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		const logPath = runtime.resolveScriptEventLogPath(filePath);
		if (!logPath) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		try {
			await fs.mkdir(path.dirname(logPath), { recursive: true });
			await fs.writeFile(logPath, '', { encoding: 'utf8', flag: 'a' });
		} catch (error) {
			return { ok: false, error: error.message };
		}

		return openWithConfiguredProgramOrDefault(logPath);
	});

	ipcMain.handle('clear-event-log', async (_, filePath) => {
		if (!runtime) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		const logPath = runtime.resolveScriptEventLogPath(filePath);
		if (!logPath) {
			return { ok: false, error: 'activity.log path unavailable' };
		}

		try {
			await fs.writeFile(logPath, '', 'utf8');
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error.message };
		}
	});

	ipcMain.handle('get-scripts-info', async () => {
		if (runtime) {
			return {
				path: runtime.scriptsDir,
				httpServer: runtime.getHttpServerConfig ? runtime.getHttpServerConfig() : null,
				scripts: runtime.scripts.map((s) => ({
					name: s.name,
					path: s.path,
					eventLogPath: s.eventLogPath,
					state: s.state,
					enabled: s.enabled,
					schedule: s.schedule,
					events: s.events,
					messageSenders: s.messageSenders || [],
					messageFromAnySender: Boolean(s.messageFromAnySender),
					mutex: s.mutex,
					watch: s.watch || [],
				})),
			};
		}
		return { path: '', scripts: [] };
	});
}

module.exports = { buildHtmlContent, createMainWindow, setupIpcHandlers };
