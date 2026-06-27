<script>
	import { onMount, tick } from 'svelte';
	import HeaderActions from '$lib/components/HeaderActions.svelte';
	import ScriptList from '$lib/components/ScriptList.svelte';
	import DetailPane from '$lib/components/DetailPane.svelte';
	import {
		getScriptsInfo,
		getUiSettings,
		openScriptsFolder,
		openScriptFile,
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
	} from '$lib/reactorApi';

	let scripts = [];
	let scriptsPath = '';
	let selectedIndex = -1;
	let defaultProgramPath = '';
	let reactorName = '';
	let httpPort = 7070;
	let status = 'Ready';
	let renameOpen = false;
	let renameScriptPath = '';
	let renameOriginalName = '';
	let renameValue = '';
	let renameInput;

	$: selectedScript = selectedIndex >= 0 ? scripts[selectedIndex] : null;

	async function refreshAll() {
		const [info, settings, serverConfig, currentReactorName] = await Promise.all([
			getScriptsInfo(),
			getUiSettings(),
			getHttpServerConfig(),
			getReactorName(),
		]);
		scripts = Array.isArray(info?.scripts) ? info.scripts : [];
		scriptsPath = info?.path || '';
		defaultProgramPath = settings?.defaultProgramPath || '';
		httpPort = Number(serverConfig?.config?.port || settings?.httpServerPort || 7070);
		reactorName = String(currentReactorName?.name || '');
		if (selectedIndex >= scripts.length) {
			selectedIndex = -1;
		}
		status = 'Data refreshed';
	}

	async function createScript(templateKey) {
		const result = await createScriptFile(templateKey);
		status = result?.ok ? `Script created (${templateKey})` : `Error: ${result?.error || 'unknown'}`;
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

	async function openLog(index) {
		const script = scripts[index];
		if (!script) {
			return;
		}
		const result = await openEventLog(script.path);
		status = result?.ok ? `Opened activity.log for ${script.name}` : `Error: ${result?.error || 'unknown'}`;
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
		const result = await openEventLog();
		status = result?.ok ? 'Opened project activity.log' : `Error: ${result?.error || 'unknown'}`;
	}

	async function clearGlobalLog() {
		const result = await clearEventLog();
		status = result?.ok ? 'Cleared project activity.log' : `Error: ${result?.error || 'unknown'}`;
	}
</script>

<svelte:head>
	<title>Reactor</title>
</svelte:head>

<div class="app-shell">
	<HeaderActions
		onRefresh={refreshAll}
		onOpenFolder={openScriptsFolder}
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
			{reactorName}
			{httpPort}
			onSaveReactorName={saveReactorNameValue}
			onSaveHttpPort={saveHttpPortValue}
			onOpenServerStatus={openServerStatusPage}
			{status}
		/>
	</main>

	{#if renameOpen}
		<div
			class="modal-backdrop"
			role="button"
			tabindex="0"
			on:click={closeRenameDialog}
			on:keydown={(event) => {
				if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					closeRenameDialog();
				}
			}}
		>
			<div
				class="modal-card"
				role="dialog"
				aria-modal="true"
				aria-label="Rename script"
				tabindex="-1"
				on:click|stopPropagation
				on:keydown={(event) => {
					if (event.key === 'Escape') {
						closeRenameDialog();
					}
				}}
			>
				<h3>Rename Script</h3>
				<p class="modal-subtitle">{renameOriginalName}</p>
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
				<div class="modal-actions">
					<button type="button" class="btn-secondary" on:click={closeRenameDialog}>Cancel</button>
					<button type="button" class="btn-primary" on:click={confirmRenameDialog}>Save</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.app-shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}
</style>
