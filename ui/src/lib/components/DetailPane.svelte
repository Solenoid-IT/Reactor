<script>
	export let selectedScript = null;
	export let scriptsPath = '';
	export let defaultProgramPath = '';
	export let reactorName = '';
	export let httpPort = 7070;
	export let onSaveReactorName = () => {};
	export let onSaveHttpPort = () => {};
	export let status = 'Ready';
</script>

<aside class="detail-pane">
	<section class="detail-card">
		<h3><i class="fa-solid fa-folder-tree me-2"></i>Scripts Path</h3>
		<div class="detail-value">{scriptsPath || '-'}</div>
	</section>
	<section class="detail-card">
		<h3><i class="fa-solid fa-desktop me-2"></i>Default Program</h3>
		<div class="detail-value">{defaultProgramPath || 'System default (not set)'}</div>
	</section>
	<section class="detail-card">
		<h3><i class="fa-solid fa-tag me-2"></i>Reactor Name</h3>
		<input type="text" bind:value={reactorName} placeholder="sender_1" />
		<button on:click={() => onSaveReactorName(reactorName)}><i class="fa-solid fa-floppy-disk me-2"></i>Save Name</button>
	</section>
	<section class="detail-card">
		<h3><i class="fa-solid fa-network-wired me-2"></i>HTTP Server Port</h3>
		<input type="number" min="1" max="65535" bind:value={httpPort} />
		<button on:click={() => onSaveHttpPort(httpPort)}><i class="fa-solid fa-floppy-disk me-2"></i>Save Port</button>
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
