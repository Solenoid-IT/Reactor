import { n as tick } from "../../chunks/index-server.js";
import { a as head, b as attr, i as ensure_array_like, it as fallback, n as bind_props, t as attr_class, x as escape_html } from "../../chunks/server.js";
//#region src/lib/components/HeaderActions.svelte
function HeaderActions($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let templateOpen = false;
		let logOpen = false;
		let onRefresh = fallback($$props["onRefresh"], () => {});
		let onOpenFolder = fallback($$props["onOpenFolder"], () => {});
		let onPickProgram = fallback($$props["onPickProgram"], () => {});
		let onOpenServerStatus = fallback($$props["onOpenServerStatus"], () => {});
		let onOpenGlobalLog = fallback($$props["onOpenGlobalLog"], () => {});
		let onClearGlobalLog = fallback($$props["onClearGlobalLog"], () => {});
		let onCreateBlank = fallback($$props["onCreateBlank"], () => {});
		let onCreateSchedule = fallback($$props["onCreateSchedule"], () => {});
		let onCreateEvent = fallback($$props["onCreateEvent"], () => {});
		let onCreateWatch = fallback($$props["onCreateWatch"], () => {});
		$$renderer.push(`<header class="header"><div class="title"><img class="logo" src="/logo.jpg" alt="Reactor logo"/> <div class="title-copy"><h1>Reactor</h1> <p>Trigger your projects</p></div></div> <div class="actions"><div${attr_class("template-picker", void 0, { "open": templateOpen })}><button type="button" class="btn-primary" title="create new script">+</button> <div class="template-menu"${attr("aria-hidden", true)}><button type="button" class="template-menu-item"><i class="fa-regular fa-file"></i><span>Blank</span></button> <button type="button" class="template-menu-item"><i class="fa-solid fa-clock-rotate-left"></i><span>Schedule</span></button> <button type="button" class="template-menu-item"><i class="fa-solid fa-bolt"></i><span>Event</span></button> <button type="button" class="template-menu-item"><i class="fa-solid fa-eye"></i><span>Watch</span></button></div></div> <button type="button" class="btn-secondary icon-button" title="refresh scripts" aria-label="Refresh scripts"><i class="fa-solid fa-rotate-right"></i></button> <button type="button" class="btn-secondary icon-button" title="open project folder" aria-label="Open project folder"><i class="fa-regular fa-folder-open"></i></button> <button type="button" class="btn-secondary"><i class="fa-solid fa-gear"></i><span class="ms-2">Set Default Program</span></button> <button type="button" class="btn-secondary"><i class="fa-solid fa-heart-pulse"></i><span class="ms-2">Server Status</span></button> <div${attr_class("log-picker", void 0, { "open": logOpen })}><button type="button" class="btn-secondary" title="log actions"><i class="fa-solid fa-list"></i><span class="ms-2">LOG</span></button> <div class="log-menu"${attr("aria-hidden", true)}><button type="button" class="log-menu-item"><i class="fa-solid fa-magnifying-glass"></i><span>View</span></button> <button type="button" class="log-menu-item danger"><i class="fa-solid fa-trash"></i><span>Clear</span></button></div></div></div></header>`);
		bind_props($$props, {
			onRefresh,
			onOpenFolder,
			onPickProgram,
			onOpenServerStatus,
			onOpenGlobalLog,
			onClearGlobalLog,
			onCreateBlank,
			onCreateSchedule,
			onCreateEvent,
			onCreateWatch
		});
	});
}
//#endregion
//#region src/lib/components/ScriptList.svelte
function ScriptList($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let scripts = fallback($$props["scripts"], () => [], true);
		let selectedIndex = fallback($$props["selectedIndex"], () => -1, true);
		let onSelect = fallback($$props["onSelect"], () => {});
		let onToggleState = fallback($$props["onToggleState"], () => {});
		let onToggleMutex = fallback($$props["onToggleMutex"], () => {});
		let onRun = fallback($$props["onRun"], () => {});
		let onOpen = fallback($$props["onOpen"], () => {});
		let onRename = fallback($$props["onRename"], () => {});
		let onDelete = fallback($$props["onDelete"], () => {});
		let onOpenLog = fallback($$props["onOpenLog"], () => {});
		let onClearLog = fallback($$props["onClearLog"], () => {});
		function scriptTags(script) {
			const tags = [];
			tags.push({
				label: script?.enabled ? "enabled" : "disabled",
				cls: script?.enabled ? "ok" : ""
			});
			tags.push({
				label: script?.mutex ? "mutex" : "no mutex",
				cls: script?.mutex ? "mutex" : ""
			});
			tags.push({
				label: script?.schedule || "no schedule",
				cls: script?.schedule ? "warn" : ""
			});
			tags.push({
				label: script?.watch?.length ? `watch (${script.watch.length})` : "no watch",
				cls: script?.watch?.length ? "watch" : ""
			});
			return tags;
		}
		$$renderer.push(`<div class="file-list">`);
		if (scripts.length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="empty">No scripts found</div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--[-->`);
			const each_array = ensure_array_like(scripts);
			for (let index = 0, $$length = each_array.length; index < $$length; index++) {
				let script = each_array[index];
				$$renderer.push(`<div${attr_class("file-item", void 0, { "selected": index === selectedIndex })} role="button" tabindex="0"><div class="file-header"><div class="file-header-main"><div class="file-name"><span class="file-name-label">${escape_html(script.name.replace(/\.(ts|js)$/i, ""))}</span></div> <div class="file-tags"><!--[-->`);
				const each_array_1 = ensure_array_like(scriptTags(script));
				for (let $$index = 0, $$length = each_array_1.length; $$index < $$length; $$index++) {
					let tag = each_array_1[$$index];
					$$renderer.push(`<span${attr_class(`tag ${tag.cls}`)}>${escape_html(tag.label)}</span>`);
				}
				$$renderer.push(`<!--]--></div></div> <div class="toggle-stack"><button${attr_class(`switch-toggle ${script.enabled ? "state-on" : "state-off"}`)}><span class="switch-label">${escape_html(script.enabled ? "Enabled" : "Disabled")}</span> <span class="switch-knob" aria-hidden="true"></span></button> <button${attr_class(`switch-toggle ${script.mutex ? "mutex-on" : "mutex-off"}`)}><span class="switch-label">Mutex</span> <span class="switch-knob" aria-hidden="true"></span></button></div></div> <div class="item-actions"><button class="item-action-btn"><i class="fa-solid fa-code"></i><span class="item-action-label">Open</span></button> <button class="item-action-btn"><i class="fa-solid fa-pen"></i><span class="item-action-label">Rename</span></button> <button class="item-action-btn delete"><i class="fa-solid fa-trash"></i><span class="item-action-label">Delete</span></button> <button class="item-action-btn test"><i class="fa-solid fa-play"></i><span class="item-action-label">Test</span></button> <button class="item-action-btn"><i class="fa-solid fa-magnifying-glass"></i><span class="item-action-label">View Log</span></button> <button class="item-action-btn"><i class="fa-solid fa-list"></i><span class="item-action-label">Clear Log</span></button></div></div>`);
			}
			$$renderer.push(`<!--]-->`);
		}
		$$renderer.push(`<!--]--></div>`);
		bind_props($$props, {
			scripts,
			selectedIndex,
			onSelect,
			onToggleState,
			onToggleMutex,
			onRun,
			onOpen,
			onRename,
			onDelete,
			onOpenLog,
			onClearLog
		});
	});
}
//#endregion
//#region src/lib/components/DetailPane.svelte
function DetailPane($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let selectedScript = fallback($$props["selectedScript"], null);
		let scriptsPath = fallback($$props["scriptsPath"], "");
		let defaultProgramPath = fallback($$props["defaultProgramPath"], "");
		let reactorName = fallback($$props["reactorName"], "");
		let httpPort = fallback($$props["httpPort"], 7070);
		let onSaveReactorName = fallback($$props["onSaveReactorName"], () => {});
		let onSaveHttpPort = fallback($$props["onSaveHttpPort"], () => {});
		let status = fallback($$props["status"], "Ready");
		$$renderer.push(`<aside class="detail-pane"><section class="detail-card"><h3><i class="fa-solid fa-folder-tree me-2"></i>Scripts Path</h3> <div class="detail-value">${escape_html(scriptsPath || "-")}</div></section> <section class="detail-card"><h3><i class="fa-solid fa-desktop me-2"></i>Default Program</h3> <div class="detail-value">${escape_html(defaultProgramPath || "System default (not set)")}</div></section> <section class="detail-card"><h3><i class="fa-solid fa-tag me-2"></i>Reactor Name</h3> <input type="text"${attr("value", reactorName)} placeholder="sender_1"/> <button><i class="fa-solid fa-floppy-disk me-2"></i>Save Name</button></section> <section class="detail-card"><h3><i class="fa-solid fa-network-wired me-2"></i>HTTP Server Port</h3> <input type="number" min="1" max="65535"${attr("value", httpPort)}/> <button><i class="fa-solid fa-floppy-disk me-2"></i>Save Port</button></section> <section class="detail-card"><h3><i class="fa-solid fa-file-code me-2"></i>Selected Script</h3> `);
		if (selectedScript) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="detail-value"><strong>${escape_html(selectedScript.name)}</strong></div> <div class="detail-value">${escape_html(selectedScript.path)}</div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="detail-value">None</div>`);
		}
		$$renderer.push(`<!--]--></section> <section class="detail-card status"><h3><i class="fa-solid fa-circle-info me-2"></i>Status</h3> <div id="statusBox" class="empty">${escape_html(status)}</div></section></aside>`);
		bind_props($$props, {
			selectedScript,
			scriptsPath,
			defaultProgramPath,
			reactorName,
			httpPort,
			onSaveReactorName,
			onSaveHttpPort,
			status
		});
	});
}
//#endregion
//#region src/lib/reactorApi.js
function getBridge() {
	if (typeof window === "undefined") return null;
	return window.reactor || null;
}
async function getScriptsInfo() {
	const bridge = getBridge();
	if (!bridge || !bridge.getScriptsInfo) return {
		path: "",
		scripts: []
	};
	return bridge.getScriptsInfo();
}
async function getUiSettings() {
	const bridge = getBridge();
	if (!bridge || !bridge.getUiSettings) return {
		defaultProgramPath: "",
		httpServerPort: 7070
	};
	return bridge.getUiSettings();
}
async function openScriptsFolder() {
	const bridge = getBridge();
	if (bridge && bridge.openScriptsFolder) return bridge.openScriptsFolder();
}
async function openScriptFile(filePath) {
	const bridge = getBridge();
	if (!bridge || !bridge.openScriptFile) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.openScriptFile(filePath);
}
async function pickDefaultProgram() {
	const bridge = getBridge();
	if (!bridge || !bridge.pickDefaultProgram) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.pickDefaultProgram();
}
async function runScriptNow(filePath) {
	const bridge = getBridge();
	if (!bridge || !bridge.runScriptNow) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.runScriptNow(filePath);
}
async function createScriptFile(templateKey) {
	const bridge = getBridge();
	if (!bridge || !bridge.createScriptFile) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.createScriptFile(templateKey);
}
async function confirmDeleteScript(scriptName) {
	const bridge = getBridge();
	if (!bridge || !bridge.confirmDeleteScript) return {
		ok: false,
		confirmed: false
	};
	return bridge.confirmDeleteScript(scriptName);
}
async function deleteScriptFile(filePath) {
	const bridge = getBridge();
	if (!bridge || !bridge.deleteScriptFile) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.deleteScriptFile(filePath);
}
async function toggleScriptDirective(filePath, directive) {
	const bridge = getBridge();
	if (!bridge || !bridge.toggleScriptDirective) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.toggleScriptDirective(filePath, directive);
}
async function openEventLog(filePath) {
	const bridge = getBridge();
	if (!bridge || !bridge.openEventLog) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.openEventLog(filePath);
}
async function clearEventLog(filePath) {
	const bridge = getBridge();
	if (!bridge || !bridge.clearEventLog) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.clearEventLog(filePath);
}
async function getHttpServerConfig() {
	const bridge = getBridge();
	if (!bridge || !bridge.getHttpServerConfig) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.getHttpServerConfig();
}
async function setHttpServerPort(port) {
	const bridge = getBridge();
	if (!bridge || !bridge.setHttpServerPort) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.setHttpServerPort(port);
}
async function getReactorName() {
	const bridge = getBridge();
	if (!bridge || !bridge.getReactorName) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.getReactorName();
}
async function setReactorName(name) {
	const bridge = getBridge();
	if (!bridge || !bridge.setReactorName) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.setReactorName(name);
}
async function openServerStatus() {
	const bridge = getBridge();
	if (!bridge || !bridge.openServerStatus) return {
		ok: false,
		error: "bridge unavailable"
	};
	return bridge.openServerStatus();
}
//#endregion
//#region src/routes/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let selectedScript;
		let scripts = [];
		let scriptsPath = "";
		let selectedIndex = -1;
		let defaultProgramPath = "";
		let reactorName = "";
		let httpPort = 7070;
		let status = "Ready";
		let renameOpen = false;
		let renameOriginalName = "";
		let renameValue = "";
		async function refreshAll() {
			const [info, settings, serverConfig, currentReactorName] = await Promise.all([
				getScriptsInfo(),
				getUiSettings(),
				getHttpServerConfig(),
				getReactorName()
			]);
			scripts = Array.isArray(info?.scripts) ? info.scripts : [];
			scriptsPath = info?.path || "";
			defaultProgramPath = settings?.defaultProgramPath || "";
			httpPort = Number(serverConfig?.config?.port || settings?.httpServerPort || 7070);
			reactorName = String(currentReactorName?.name || "");
			if (selectedIndex >= scripts.length) selectedIndex = -1;
			status = "Data refreshed";
		}
		async function createScript(templateKey) {
			const result = await createScriptFile(templateKey);
			status = result?.ok ? `Script created (${templateKey})` : `Error: ${result?.error || "unknown"}`;
			await refreshAll();
		}
		async function openScript(index) {
			const script = scripts[index];
			if (!script) return;
			const result = await openScriptFile(script.path);
			status = result?.ok ? `Script opened: ${script.name}` : `Error: ${result?.error || "unknown"}`;
		}
		async function renameScript(index) {
			const script = scripts[index];
			if (!script) return;
			script.path;
			renameOriginalName = script.name;
			renameValue = script.name.replace(/\.(ts|js)$/i, "");
			renameOpen = true;
			await tick();
		}
		async function deleteScript(index) {
			const script = scripts[index];
			if (!script) return;
			if (!(await confirmDeleteScript(script.name))?.confirmed) return;
			const result = await deleteScriptFile(script.path);
			status = result?.ok ? `Script deleted: ${script.name}` : `Error: ${result?.error || "unknown"}`;
			await refreshAll();
		}
		async function toggleDirective(index, directive) {
			const script = scripts[index];
			if (!script) return;
			const result = await toggleScriptDirective(script.path, directive);
			status = result?.ok ? `Updated ${directive} on ${script.name}` : `Error: ${result?.error || "unknown"}`;
			await refreshAll();
		}
		async function runNow(index) {
			const script = scripts[index];
			if (!script) return;
			const result = await runScriptNow(script.path);
			status = result?.ok ? `Test started: ${script.name}` : `Error: ${result?.error || "unknown"}`;
		}
		async function pickProgram() {
			const result = await pickDefaultProgram();
			if (result?.ok) {
				defaultProgramPath = result.defaultProgramPath || "";
				status = "Default program updated";
			} else if (!result?.canceled) status = `Error: ${result?.error || "unable to set default program"}`;
		}
		async function saveReactorNameValue(nextName) {
			const result = await setReactorName(nextName || "");
			status = result?.ok ? `Reactor name updated: ${result.name}` : `Error: ${result?.error || "unknown"}`;
			await refreshAll();
		}
		async function saveHttpPortValue(nextPort) {
			const numericPort = Number(nextPort);
			if (!Number.isFinite(numericPort) || numericPort < 1 || numericPort > 65535) {
				status = "Error: invalid HTTP port";
				return;
			}
			const result = await setHttpServerPort(numericPort);
			status = result?.ok ? `HTTP port updated: ${result?.config?.port}` : `Error: ${result?.error || "unknown"}`;
			await refreshAll();
		}
		async function openServerStatusPage() {
			const result = await openServerStatus();
			status = result?.ok ? `Server status opened: ${result.url}` : `Error: ${result?.error || "unknown"}`;
		}
		async function openLog(index) {
			const script = scripts[index];
			if (!script) return;
			const result = await openEventLog(script.path);
			status = result?.ok ? `Opened activity.log for ${script.name}` : `Error: ${result?.error || "unknown"}`;
		}
		async function clearLog(index) {
			const script = scripts[index];
			if (!script) return;
			const result = await clearEventLog(script.path);
			status = result?.ok ? `Cleared activity.log for ${script.name}` : `Error: ${result?.error || "unknown"}`;
		}
		async function openGlobalLog() {
			const result = await openEventLog();
			status = result?.ok ? "Opened project activity.log" : `Error: ${result?.error || "unknown"}`;
		}
		async function clearGlobalLog() {
			const result = await clearEventLog();
			status = result?.ok ? "Cleared project activity.log" : `Error: ${result?.error || "unknown"}`;
		}
		$: selectedScript = selectedIndex >= 0 ? scripts[selectedIndex] : null;
		head("1uha8ag", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Reactor</title>`);
			});
		});
		$$renderer.push(`<div class="app-shell svelte-1uha8ag">`);
		HeaderActions($$renderer, {
			onRefresh: refreshAll,
			onOpenFolder: openScriptsFolder,
			onPickProgram: pickProgram,
			onOpenServerStatus: openServerStatusPage,
			onOpenGlobalLog: openGlobalLog,
			onClearGlobalLog: clearGlobalLog,
			onCreateBlank: () => createScript("blank"),
			onCreateSchedule: () => createScript("schedule"),
			onCreateEvent: () => createScript("event"),
			onCreateWatch: () => createScript("watch")
		});
		$$renderer.push(`<!----> <main class="content"><section class="list-pane"><div class="path-box">${escape_html(scriptsPath || "Loading path...")}</div> `);
		ScriptList($$renderer, {
			scripts,
			selectedIndex,
			onSelect: (index) => selectedIndex = index,
			onOpen: openScript,
			onRename: renameScript,
			onDelete: deleteScript,
			onToggleState: (index) => toggleDirective(index, "state"),
			onToggleMutex: (index) => toggleDirective(index, "mutex"),
			onRun: runNow,
			onOpenLog: openLog,
			onClearLog: clearLog
		});
		$$renderer.push(`<!----></section> `);
		DetailPane($$renderer, {
			selectedScript,
			scriptsPath,
			defaultProgramPath,
			reactorName,
			httpPort,
			onSaveReactorName: saveReactorNameValue,
			onSaveHttpPort: saveHttpPortValue,
			status
		});
		$$renderer.push(`<!----></main> `);
		if (renameOpen) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="modal-backdrop" role="button" tabindex="0"><div class="modal-card" role="dialog" aria-modal="true" aria-label="Rename script" tabindex="-1"><h3>Rename Script</h3> <p class="modal-subtitle">${escape_html(renameOriginalName)}</p> <input${attr("value", renameValue)} class="modal-input" type="text" autocomplete="off"/> <div class="modal-actions"><button type="button" class="btn-secondary">Cancel</button> <button type="button" class="btn-primary">Save</button></div></div></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
export { _page as default };
