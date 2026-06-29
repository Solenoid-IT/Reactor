<script>
	export let selectedScript = null;
	export let scriptsPath = '';
	export let status = 'Ready';
</script>

<aside class="detail-pane">
	<section class="detail-card">
		<h3><i class="fa-solid fa-folder-tree me-2"></i>Scripts Path</h3>
		<div class="detail-value">{scriptsPath || '-'}</div>
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
