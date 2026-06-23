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
		};
	} catch (error) {
		return { defaultProgramPath: '' };
	}
}

async function writeUiSettings(nextSettings) {
	await fs.writeFile(getUiSettingsPath(), JSON.stringify(nextSettings, null, 2), 'utf8');
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
				<button class="btn-secondary" onclick="chooseDefaultProgram()" title="set default program"><i class="fa-solid fa-cog" style="margin-right: 8px;"></i>Set Default Program</button>
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

	<script>
		let scriptsState = [];
		let selectedIndex = -1;
		let templateMenuOpen = false;
		let logMenuOpen = false;
		let openItemLogIndex = -1;

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
				picker.classList.toggle('open', pickerIndex === openItemLogIndex);
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
			document.getElementById('selectedName').textContent = script.name;
			document.getElementById('selectedPath').textContent = script.path;
			document.getElementById('selectedMeta').textContent =
				'State: ' + script.state +
				' | Schedule: ' + (script.schedule || 'none') +
				' | Events: ' + (script.events.join(', ') || 'none') +
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
	ipcMain.handle('get-ui-settings', async () => {
		return readUiSettings();
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
				"import type { Context } from './context.ts';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait ctx.log('new blank script');",
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
				"import type { Context } from './context.ts';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait ctx.log('scheduled script tick');",
				'}',
				'',
			],
			event: [
				'// @state DISABLED',
				'// @mutex ON',
				'// @on BOOT',
				'',
				'',
				'',
				"import type { Context } from './context.ts';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait ctx.log('event script: ' + (ctx.event || ctx.trigger));",
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
				"import type { Context } from './context.ts';",
				'',
				'',
				'',
				'export async function run (ctx : Context)',
				'{',
				"\tawait ctx.log('watch event: ' + ctx.watchPath + ' (' + ctx.watchType + ')');",
				'}',
				'',
			],
		};

		const safeTemplateKey = templateKey && templateMap[templateKey] ? templateKey : 'schedule';
		const initialContent = templateMap[safeTemplateKey].join('\n');
		const contextContent = [
			'export interface Context {',
			'\ttrigger?: string;',
			'\tevent?: string | null;',
			'\texpression?: string | null;',
			'\twatchPath?: string;',
			'\twatchType?: \'file:created\' | \'file:deleted\' | \'file:moved\' | \'dir:created\' | \'dir:deleted\' | \'dir:moved\' | \'file:changed\';',
			'\tlog: (message: string, type?: \'E\' | \'W\' | \'I\' | \'D\') => Promise<void> | void;',
			'}',
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
				scripts: runtime.scripts.map((s) => ({
					name: s.name,
					path: s.path,
					eventLogPath: s.eventLogPath,
					state: s.state,
					enabled: s.enabled,
					schedule: s.schedule,
					events: s.events,
					mutex: s.mutex,
					watch: s.watch || [],
				})),
			};
		}
		return { path: '', scripts: [] };
	});
}

module.exports = { buildHtmlContent, createMainWindow, setupIpcHandlers };
