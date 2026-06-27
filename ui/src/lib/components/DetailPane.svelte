<script>
	export let selectedScript = null;
	export let scriptsPath = '';
	export let defaultProgramPath = '';
	export let reactorName = '';
	export let httpPort = 7070;
	export let onSaveReactorName = () => {};
	export let onSaveHttpServerData = () => {};
	export let onOpenServerStatus = () => {};
	export let onOpenWorkflow = () => {};
	export let status = 'Ready';
</script>

<aside class="detail-pane">
	<section class="detail-card">
		<h3><i class="fa-solid fa-folder-tree me-2"></i>Scripts Path</h3>
		<div class="detail-value">{scriptsPath || '-'}</div>
		<button class="btn-secondary mt-2" on:click={onOpenWorkflow}><i class="fa-solid fa-diagram-project me-2"></i>Open Workflow</button>
	</section>
	<section class="detail-card">
		<h3><i class="fa-solid fa-desktop me-2"></i>Default Program</h3>
		<div class="detail-value">{defaultProgramPath || 'System default (not set)'}</div>
	</section>
	<section class="detail-card">
		<h3><i class="fa-solid fa-tag me-2"></i>Name</h3>
		<input type="text" bind:value={reactorName} placeholder="sender_1" />
		<button class="btn-primary" on:click={() => onSaveReactorName(reactorName)}><i class="fa-solid fa-floppy-disk me-2"></i>Save Name</button>
	</section>
	<section class="detail-card http-server-card">
		<h3><i class="fa-solid fa-network-wired me-2"></i>Server</h3>
        <button class="btn-secondary mt-2" on:click={onOpenServerStatus}><i class="fa-solid fa-heart-pulse me-2"></i>View Status</button>
		<div class="http-port-group mt-2">
			<label class="detail-label" for="httpServerPortInput">Port</label>
			<input id="httpServerPortInput" type="number" min="1" max="65535" bind:value={httpPort} />
		</div>
		<div class="http-server-actions">
			<button class="btn-primary" on:click={() => onSaveHttpServerData(httpPort)}><i class="fa-solid fa-floppy-disk me-2"></i>Save</button>
		</div>
	</section>
	<section class="detail-card">
		<h3><i class="fa-solid fa-file-code me-2"></i>Selected Script</h3>
		{#if selectedScript}
			<div class="detail-value"><strong>{selectedScript.name}</strong></div>
			<div class="detail-value">{selectedScript.path}</div>
		{:else}
			<div class="detail-value">None</div>
		{/if}
	</section>
	<section class="detail-card status">
		<h3><i class="fa-solid fa-circle-info me-2"></i>Status</h3>
		<div id="statusBox" class="empty">{status}</div>
	</section>
</aside>
