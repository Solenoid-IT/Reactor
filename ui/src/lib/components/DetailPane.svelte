<script>
	export let selectedEndpoint = null;
	export let endpointsPath = '';
	export let status = 'Ready';
</script>

<aside class="detail-pane">
	<section class="detail-card">
		<h3><i class="fa-solid fa-folder-tree me-2"></i>Endpoints Path</h3>
		<div class="detail-value">{endpointsPath || '-'}</div>
	</section>

	<section class="detail-card">
		<h3><i class="fa-solid fa-file-code me-2"></i>Selected Endpoint</h3>
		{#if selectedEndpoint}
			<div class="detail-value"><strong>{selectedEndpoint.name}</strong></div>
			<div class="detail-value">{selectedEndpoint.path}</div>
		{:else}
			<div class="detail-value">None</div>
		{/if}
	</section>

	<section class="detail-card status">
		<h3><i class="fa-solid fa-circle-info me-2"></i>Status</h3>
		<div id="statusBox" class="empty">{status}</div>
	</section>
</aside>
