<script>
	import { onMount, tick } from 'svelte';
	import HeaderActions from '$lib/components/HeaderActions.svelte';
	import ScriptList from '$lib/components/ScriptList.svelte';
	import DetailPane from '$lib/components/DetailPane.svelte';
	import SettingsPane from '$lib/components/SettingsPane.svelte';
	import WorkflowEditor from '$lib/components/WorkflowEditor.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import {
		getScriptsInfo,
		getUiSettings,
		openScriptsFolder,
		openScriptFile,
		readScriptContent,
		saveScriptContent,
		pickDefaultProgram,
		runScriptNow,
		createScriptFile,
		renameScriptFile,
		confirmDeleteScript,
		deleteScriptFile,
		toggleScriptDirective,
		openEventLog,
		clearEventLog,
		getHttpServerConfig,
		setHttpServerPort,
		openServerStatus,
		getReactorName,
		setReactorName,
		getWorkflow,
		saveWorkflow,
		getExchangeConfig,
		setExchangeConfig,
		getExchangeToken,
		generateExchangeToken,
		getTlsConfig,
		generateTlsCert,
		deleteTlsCert,
		exportBackup,
		importBackup,
	} from '$lib/reactorApi';

	let scripts = [];
	let scriptsPath = '';
	let selectedIndex = -1;
	let defaultProgramPath = '';
	let reactorName = '';
	let httpPort = 7070;
	let exchangeMode = 'node';
	let exchangeHost = '';
	let exchangePort = 7070;
	let exchangeTls = false;
	let exchangeToken = '';
	let exchangeActive = false;
	let exchangeClients = [];
	let tlsEnabled = false;
	let tlsSubject = '';
	let tlsNotAfter = '';
	let tlsFingerprint = '';
	let status = 'Ready';
	let settingsOpen = false;
	let renameOpen = false;
	let renameScriptPath = '';
	let renameOriginalName = '';
	let renameValue = '';
	let renameInput;
	let workflowOpen = false;
	let workflowData = { version: 1, nodes: [], links: [] };
	let editorOpen = false;
	let editorFilePath = '';
	let editorFileName = '';
	let editorLanguage = 'typescript';
	let editorContent = '';
	let CodeEditorComponent = null;

	function isBridgeUnavailable(result) {
		return String(result?.error || '').toLowerCase().includes('bridge unavailable');
	}

	async function ensureCodeEditorComponent(silent = false) {
		if (CodeEditorComponent) {
			return true;
		}

		try {
			const module = await import('$lib/components/CodeEditor.svelte');
			CodeEditorComponent = module.default;
			return true;
		} catch {
			if (!silent) {
				status = 'Error: unable to load editor';
			}
			return false;
		}
	}

	async function preloadCodeEditor() {
		await ensureCodeEditorComponent(true);
	}

	$: selectedScript = selectedIndex >= 0 ? scripts[selectedIndex] : null;

	async function refreshAll() {
		const [info, settings, serverConfig, currentReactorName, exchangeConfigResult, exchangeTokenResult, tlsConfigResult] = await Promise.all([
			getScriptsInfo(),
			getUiSettings(),
			getHttpServerConfig(),
			getReactorName(),
			getExchangeConfig(),
			getExchangeToken(),
			getTlsConfig(),
		]);

		if (info?.ok === false) {
			status = `Error scripts list: ${info?.error || 'unknown'}`;
		}

		scripts = Array.isArray(info?.scripts) ? info.scripts : [];
		scriptsPath = info?.path || '';
		defaultProgramPath = settings?.defaultProgramPath || '';
		httpPort = Number(serverConfig?.config?.port || settings?.httpServerPort || 7070);
		reactorName = String(currentReactorName?.name || '');

		if (tlsConfigResult?.ok && tlsConfigResult?.tls) {
			const tls = tlsConfigResult.tls;
			tlsEnabled = Boolean(tls.enabled);
			tlsSubject = tls.subject || '';
			tlsNotAfter = tls.notAfter || '';
			tlsFingerprint = tls.fingerprint || '';
		} else {
			tlsEnabled = false;
			tlsSubject = '';
			tlsNotAfter = '';
			tlsFingerprint = '';
		}

		if (exchangeConfigResult?.ok && exchangeConfigResult?.config) {
			const ec = exchangeConfigResult.config;
			exchangeMode = ec.mode || 'node';
			exchangeHost = ec.host || '';
			exchangePort = Number(ec.port) || 7070;
			exchangeTls = Boolean(ec.tls);
			exchangeToken = ec.token || '';
			exchangeActive = Boolean(ec.active);
			exchangeClients = Array.isArray(ec.connectedClients) ? ec.connectedClients : [];
		}

		if (exchangeTokenResult?.ok && exchangeTokenResult?.exchangeToken?.token) {
			exchangeToken = exchangeTokenResult.exchangeToken.token;
		}

		if (selectedIndex >= scripts.length) {
			selectedIndex = -1;
		}
		status = 'Data refreshed';
	}

	async function createScript(templateKey) {
		let scriptName = '';
		const isMobileRuntime =
			typeof window !== 'undefined' &&
			Boolean(window.Capacitor) &&
			typeof window.prompt === 'function';

		if (isMobileRuntime) {
			try {
				const suggestedName = `new-${templateKey}-script`;
				const enteredName = window.prompt('Script name', suggestedName);
				if (enteredName === null) {
					status = 'Create script cancelled';
					return;
				}
				scriptName = String(enteredName || '').trim();
				if (!scriptName) {
					status = 'Error: invalid script name';
					return;
				}
			} catch {
				// Defensive fallback for environments where prompt exists but is blocked.
				scriptName = '';
			}
		}

		const result = await createScriptFile(templateKey, scriptName);
		if (isBridgeUnavailable(result)) {
			status = 'Create script non disponibile su mobile: bridge nativo non disponibile';
			if (typeof window !== 'undefined' && typeof window.alert === 'function') {
				window.alert('Create script non disponibile su mobile: bridge nativo Capacitor non disponibile per createScriptFile.');
			}
			return;
		}

		status = result?.ok ? `Script created (${scriptName || templateKey})` : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
		await refreshAll();
	}

	async function openScript(index) {
		const script = scripts[index];
		if (!script) {
			return;
		}
		const result = await openScriptFile(script.path);
		status = result?.ok ? `Script opened: ${script.name}` : `Error: ${result?.error || 'unknown'}`;
	}

	async function editScript(index) {
		const script = scripts[index];
		if (!script) {
			return;
		}

		status = `Loading editor: ${script.name}`;
		const ready = await ensureCodeEditorComponent();
		if (!ready) {
			return;
		}

		const result = await readScriptContent(script.path);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to load script'}`;
			return;
		}

		editorFilePath = script.path;
		editorFileName = script.name;
		editorLanguage = 'typescript';
		editorContent = result.content || '';
		editorOpen = true;
		status = `Editing: ${script.name}`;
	}

	function closeCodeEditor() {
		editorOpen = false;
	}

	async function saveCodeEditor(nextContent) {
		const result = await saveScriptContent(editorFilePath, nextContent);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to save script'}`;
			return;
		}

		editorContent = nextContent;
		status = `Saved: ${editorFileName}`;
		await refreshAll();
	}

	async function renameScript(index) {
		const script = scripts[index];
		if (!script) {
			return;
		}

		renameScriptPath = script.path;
		renameOriginalName = script.name;
		renameValue = script.name.replace(/\.(ts|js)$/i, '');
		renameOpen = true;

		await tick();
		if (renameInput && typeof renameInput.focus === 'function') {
			renameInput.focus();
			renameInput.select();
		}
	}

	function closeRenameDialog() {
		renameOpen = false;
		renameScriptPath = '';
		renameOriginalName = '';
		renameValue = '';
	}

	async function confirmRenameDialog() {
		const nextName = String(renameValue || '').trim();
		if (!nextName) {
			status = 'Error: invalid script name';
			return;
		}

		const result = await renameScriptFile(renameScriptPath, nextName);
		status = result?.ok ? `Script renamed: ${nextName}` : `Error: ${result?.error || 'unknown'}`;
		if (result?.ok) {
			closeRenameDialog();
			await refreshAll();
		}
	}

	async function deleteScript(index) {
		const script = scripts[index];
		if (!script) {
			return;
		}
		const confirmResult = await confirmDeleteScript(script.name);
		if (!confirmResult?.confirmed) {
			return;
		}
		const result = await deleteScriptFile(script.path);
		status = result?.ok ? `Script deleted: ${script.name}` : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function toggleDirective(index, directive) {
		const script = scripts[index];
		if (!script) {
			return;
		}
		const result = await toggleScriptDirective(script.path, directive);
		status = result?.ok ? `Updated ${directive} on ${script.name}` : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function runNow(index) {
		const script = scripts[index];
		if (!script) {
			return;
		}
		const result = await runScriptNow(script.path);
		status = result?.ok ? `Test started: ${script.name}` : `Error: ${result?.error || 'unknown'}`;
	}

	async function pickProgram() {
		const result = await pickDefaultProgram();
		if (result?.ok) {
			defaultProgramPath = result.defaultProgramPath || '';
			status = 'Default program updated';
		} else if (!result?.canceled) {
			status = `Error: ${result?.error || 'unable to set default program'}`;
		}
	}

	async function saveReactorNameValue(nextName) {
		const result = await setReactorName(nextName || '');
		status = result?.ok ? `Reactor name updated: ${result.name}` : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function saveHttpPortValue(nextPort) {
		const numericPort = Number(nextPort);
		if (!Number.isFinite(numericPort) || numericPort < 1 || numericPort > 65535) {
			status = 'Error: invalid HTTP port';
			return;
		}
		const result = await setHttpServerPort(numericPort);
		status = result?.ok ? `HTTP port updated: ${result?.config?.port}` : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function openServerStatusPage() {
		const result = await openServerStatus();
		status = result?.ok ? `Server status opened: ${result.url}` : `Error: ${result?.error || 'unknown'}`;
	}

	async function saveExchangeConfigValue(mode, host, port, tls, token) {
		const numericPort = Number(port);
		if (!Number.isFinite(numericPort) || numericPort < 1 || numericPort > 65535) {
			status = 'Error: invalid Exchange port';
			return;
		}
		const result = await setExchangeConfig(mode, host || '', numericPort, Boolean(tls), token || '');
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unknown'}`;
			await refreshAll();
			return;
		}

		const connectionTest = result?.connectionTest || null;
		if (mode === 'node' && connectionTest) {
			status = connectionTest.connected
				? `Exchange config saved and connected (${Boolean(tls) ? 'WSS' : 'WS'})`
				: `Exchange config saved but not connected (${connectionTest.reason || 'connection test failed'})`;
		} else {
			status = `Exchange config saved: mode=${mode}${Boolean(tls) ? ' (TLS)' : ''}`;
		}

		await refreshAll();

		if (mode === 'node' && !exchangeActive) {
			await new Promise((resolve) => setTimeout(resolve, 800));
			await refreshAll();
		}
	}

	async function generateExchangeTokenHandler() {
		status = 'Generating Exchange token...';
		const result = await generateExchangeToken();
		status = result?.ok ? 'Exchange token generated' : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function generateTlsCertHandler() {
		status = 'Generating TLS certificate...';
		const result = await generateTlsCert();
		status = result?.ok
			? `Certificate generated: ${result.tls?.subject || 'OK'}`
			: `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function deleteTlsCertHandler() {
		const confirm = window.confirm('Are you sure you want to delete the TLS certificate?');
		if (!confirm) return;
		status = 'Deleting TLS certificate...';
		const result = await deleteTlsCert();
		status = result?.ok ? 'Certificate deleted' : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function exportBackupHandler() {
		status = 'Exporting backup ZIP...';
		const result = await exportBackup();
		if (result?.canceled) {
			status = 'Backup export cancelled';
			return;
		}
		status = result?.ok ? `Backup exported: ${result.path || 'ZIP created'}` : `Error: ${result?.error || 'unknown'}`;
	}

	async function importBackupHandler() {
		const confirm = window.confirm('Import backup and overwrite current projects/configuration?');
		if (!confirm) {
			status = 'Backup import cancelled';
			return;
		}

		status = 'Importing backup ZIP...';
		const result = await importBackup();
		if (result?.canceled) {
			status = 'Backup import cancelled';
			return;
		}

		if (!result?.ok) {
			status = `Error: ${result?.error || 'unknown'}`;
			return;
		}

		status = `Backup imported: ${result.path || 'OK'}`;
		await refreshAll();
		await refreshAll();
	}

	async function openLog(index) {
		const script = scripts[index];
		if (!script) {
			return;
		}

		status = `Loading log: ${script.name}`;
		const ready = await ensureCodeEditorComponent();
		if (!ready) {
			return;
		}

		const logPathResult = await openEventLog(script.path);
		if (!logPathResult?.ok || !logPathResult?.path) {
			status = `Error: ${logPathResult?.error || 'activity.log path unavailable'}`;
			return;
		}

		const result = await readScriptContent(logPathResult.path);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to load activity.log'}`;
			return;
		}

		editorFilePath = logPathResult.path;
		editorFileName = `${script.name} / activity.log`;
		editorLanguage = 'log';
		editorContent = result.content || '';
		editorOpen = true;
		status = `Editing log: ${script.name}`;
	}

	async function clearLog(index) {
		const script = scripts[index];
		if (!script) {
			return;
		}
		const result = await clearEventLog(script.path);
		status = result?.ok ? `Cleared activity.log for ${script.name}` : `Error: ${result?.error || 'unknown'}`;
	}

	onMount(async () => {
		await refreshAll();
	});

	async function openGlobalLog() {
		status = 'Loading project activity.log';
		const ready = await ensureCodeEditorComponent();
		if (!ready) {
			return;
		}

		const logPathResult = await openEventLog();
		if (!logPathResult?.ok || !logPathResult?.path) {
			status = `Error: ${logPathResult?.error || 'activity.log path unavailable'}`;
			return;
		}

		const result = await readScriptContent(logPathResult.path);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to load activity.log'}`;
			return;
		}

		editorFilePath = logPathResult.path;
		editorFileName = 'project activity.log';
		editorLanguage = 'log';
		editorContent = result.content || '';
		editorOpen = true;
		status = 'Editing project activity.log';
	}

	async function clearGlobalLog() {
		const result = await clearEventLog();
		status = result?.ok ? 'Cleared project activity.log' : `Error: ${result?.error || 'unknown'}`;
	}

	async function openWorkflowEditor() {
		const result = await getWorkflow();
		if (result?.ok) {
			workflowData = result.workflow || { version: 1, nodes: [], links: [] };
			workflowOpen = true;
			status = 'Workflow loaded';
			return;
		}
		status = `Error: ${result?.error || 'unable to load workflow'}`;
	}

	function closeWorkflowEditor() {
		workflowOpen = false;
	}

	async function saveWorkflowGraph(nextWorkflow) {
		const result = await saveWorkflow(nextWorkflow);
		if (result?.ok) {
			workflowData = result.workflow || nextWorkflow;
			status = 'workflow.json saved';
			return;
		}
		status = `Error: ${result?.error || 'unable to save workflow'}`;
	}

	function openSettings() {
		settingsOpen = true;
	}

	function closeSettings() {
		settingsOpen = false;
	}
</script>

<svelte:head>
	<title>Reactor</title>
</svelte:head>

<div class="app-shell">
	<HeaderActions
		onRefresh={refreshAll}
		onOpenFolder={openScriptsFolder}
		onOpenSettings={openSettings}
		onOpenWorkflow={openWorkflowEditor}
		onPickProgram={pickProgram}
		onOpenGlobalLog={openGlobalLog}
		onClearGlobalLog={clearGlobalLog}
		onCreateBlank={() => createScript('blank')}
		onCreateSchedule={() => createScript('schedule')}
		onCreateEvent={() => createScript('event')}
		onCreateWatch={() => createScript('watch')}
	/>
	<main class="content">
		<section class="list-pane">
			<div class="path-box">{scriptsPath || 'Loading path...'}</div>
			<ScriptList
				scripts={scripts}
				selectedIndex={selectedIndex}
				onSelect={(index) => (selectedIndex = index)}
				onOpen={openScript}
				onQuickOpen={editScript}
				onQuickOpenHover={preloadCodeEditor}
				onRename={renameScript}
				onDelete={deleteScript}
				onToggleState={(index) => toggleDirective(index, 'state')}
				onToggleMutex={(index) => toggleDirective(index, 'mutex')}
				onRun={runNow}
				onOpenLog={openLog}
				onClearLog={clearLog}
			/>
		</section>
		<DetailPane
			{selectedScript}
			{scriptsPath}
			{defaultProgramPath}
			onOpenWorkflow={openWorkflowEditor}
			{status}
		/>
	</main>

	<Modal
		open={settingsOpen}
		title="Settings"
		ariaLabel="Reactor settings"
		cardClass="modal-card settings-modal-card"
		onClose={closeSettings}
		showActions={false}
	>
		<SettingsPane
			{reactorName}
			{httpPort}
			{tlsEnabled}
			{tlsSubject}
			{tlsNotAfter}
			{tlsFingerprint}
			{exchangeMode}
			{exchangeHost}
			{exchangePort}
			{exchangeTls}
			{exchangeToken}
			{exchangeActive}
			{exchangeClients}
			onSaveReactorName={saveReactorNameValue}
			onSaveHttpServerData={saveHttpPortValue}
			onOpenServerStatus={openServerStatusPage}
			onGenerateTlsCert={generateTlsCertHandler}
			onDeleteTlsCert={deleteTlsCertHandler}
			onGenerateExchangeToken={generateExchangeTokenHandler}
			onSaveExchangeConfig={saveExchangeConfigValue}
			onExportBackup={exportBackupHandler}
			onImportBackup={importBackupHandler}
		/>
	</Modal>

	<WorkflowEditor
		open={workflowOpen}
		scripts={scripts}
		workflow={workflowData}
		onClose={closeWorkflowEditor}
		onSave={saveWorkflowGraph}
	/>

	{#if editorOpen && CodeEditorComponent}
		<svelte:component
			this={CodeEditorComponent}
			open={editorOpen}
			filePath={editorFilePath}
			fileName={editorFileName}
			language={editorLanguage}
			initialContent={editorContent}
			onClose={closeCodeEditor}
			onSave={saveCodeEditor}
		/>
	{/if}

	<Modal
		open={renameOpen}
		title="Rename Script"
		subtitle={renameOriginalName}
		ariaLabel="Rename script"
		onClose={closeRenameDialog}
	>
		<input
			bind:this={renameInput}
			bind:value={renameValue}
			class="modal-input"
			type="text"
			autocomplete="off"
			on:keydown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					confirmRenameDialog();
				}
			}}
		/>
		<svelte:fragment slot="actions">
			<button type="button" class="btn-secondary" on:click={closeRenameDialog}>Cancel</button>
			<button type="button" class="btn-primary" on:click={confirmRenameDialog}>Save</button>
		</svelte:fragment>
	</Modal>
</div>

<style>
	.app-shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}
</style>
