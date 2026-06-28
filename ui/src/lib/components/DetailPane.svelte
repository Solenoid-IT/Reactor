<script>
	export let selectedScript = null;
	export let scriptsPath = '';
	export let defaultProgramPath = '';
	export let reactorName = '';
	export let httpPort = 7070;
	export let tlsEnabled = false;
	export let tlsSubject = '';
	export let tlsNotAfter = '';
	export let tlsFingerprint = '';
	export let exchangeMode = 'disabled';
	export let exchangeHost = '';
	export let exchangePort = 7070;
	export let exchangeTls = false;
	export let exchangeActive = false;
	export let exchangeClients = [];
	export let onSaveReactorName = () => {};
	export let onSaveHttpServerData = () => {};
	export let onOpenServerStatus = () => {};
	export let onOpenWorkflow = () => {};
	export let onGenerateTlsCert = () => {};
	export let onDeleteTlsCert = () => {};
	export let onSaveExchangeConfig = () => {};
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
		<!-- TLS -->
		<div class="mt-3" style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px;">
			<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
				<i class="fa-solid fa-lock" style="color: {tlsEnabled ? '#4caf50' : 'rgba(255,255,255,0.4)'}"></i>
				<span style="font-size:0.85em; font-weight:600;">TLS / HTTPS</span>
				{#if tlsEnabled}
					<span style="font-size:0.75em; color:#4caf50; margin-left:auto;">Attivo</span>
				{:else}
					<span style="font-size:0.75em; opacity:0.4; margin-left:auto;">Disabilitato</span>
				{/if}
			</div>
			{#if tlsEnabled}
				{#if tlsSubject}<div class="detail-value" style="font-size:0.78em; opacity:0.7;">CN: {tlsSubject}</div>{/if}
				{#if tlsNotAfter}<div class="detail-value" style="font-size:0.78em; opacity:0.7;">Scade: {tlsNotAfter}</div>{/if}
				{#if tlsFingerprint}<div class="detail-value" style="font-size:0.7em; opacity:0.5; word-break:break-all;">SHA256: {tlsFingerprint}</div>{/if}
				<button class="btn-secondary mt-2" style="color:#e57373;" on:click={onDeleteTlsCert}>
					<i class="fa-solid fa-trash me-1"></i>Elimina certificato
				</button>
			{:else}
				<div class="detail-value" style="font-size:0.8em; opacity:0.6; margin-bottom:6px;">Genera un certificato per abilitare HTTPS e WSS.</div>
				<button class="btn-primary" on:click={onGenerateTlsCert}>
					<i class="fa-solid fa-shield-halved me-2"></i>Genera certificato
				</button>
			{/if}
		</div>
	</section>
	<section class="detail-card">
		<h3><i class="fa-solid fa-arrows-left-right me-2"></i>Exchange</h3>
		<div class="exchange-mode-group mt-2">
			<label class="detail-label" for="exchangeModeSelect">Mode</label>
			<select id="exchangeModeSelect" bind:value={exchangeMode}>
				<option value="disabled">Disabled</option>
				<option value="exchange">Exchange (server)</option>
				<option value="client">Client</option>
			</select>
		</div>
		{#if exchangeMode === 'exchange'}
			<div class="detail-value mt-2" style="font-size:0.85em; opacity:0.7;">
				<i class="fa-solid fa-info-circle me-1"></i>WebSocket attivo sulla porta HTTP ({httpPort}{tlsEnabled ? ' · WSS' : ''})
			</div>
			{#if exchangeActive}
				<div class="detail-value mt-1" style="color: var(--color-success, #4caf50);">
					<i class="fa-solid fa-circle me-1"></i>Active — {exchangeClients.length} client(s)
				</div>
				{#if exchangeClients.length > 0}
					<div class="detail-value" style="font-size:0.8em; opacity:0.7;">{exchangeClients.join(', ')}</div>
				{/if}
			{:else}
				<div class="detail-value mt-1" style="opacity:0.5;"><i class="fa-solid fa-circle me-1"></i>Not active</div>
			{/if}
		{/if}
		{#if exchangeMode === 'client'}
			<div class="mt-2">
				<label class="detail-label" for="exchangeHostInput">Exchange Host</label>
				<input id="exchangeHostInput" type="text" bind:value={exchangeHost} placeholder="192.168.1.10" />
			</div>
			<div class="http-port-group mt-1">
				<label class="detail-label" for="exchangePortInput">Exchange Port</label>
				<input id="exchangePortInput" type="number" min="1" max="65535" bind:value={exchangePort} />
			</div>
			<div class="detail-value mt-1" style="font-size:0.8em; opacity:0.6;">
				Porta HTTP del nodo Exchange (default 7070)
			</div>
			<label class="detail-label mt-2" style="display:flex; align-items:center; gap:6px; cursor:pointer;">
				<input type="checkbox" bind:checked={exchangeTls} />
				<span>Exchange usa TLS (WSS)</span>
			</label>
			{#if exchangeActive}
				<div class="detail-value mt-1" style="color: var(--color-success, #4caf50);"><i class="fa-solid fa-plug me-1"></i>Connected{exchangeTls ? ' (WSS)' : ''}</div>
			{:else}
				<div class="detail-value mt-1" style="opacity:0.5;"><i class="fa-solid fa-plug-circle-xmark me-1"></i>Not connected</div>
			{/if}
		{/if}
		{#if exchangeMode !== 'disabled'}
			<div class="http-server-actions mt-2">
				<button class="btn-primary" on:click={() => onSaveExchangeConfig(exchangeMode, exchangeHost, exchangePort, exchangeTls)}>
					<i class="fa-solid fa-floppy-disk me-2"></i>Save
				</button>
			</div>
		{:else}
			<div class="http-server-actions mt-2">
				<button class="btn-secondary" on:click={() => onSaveExchangeConfig('disabled', '', 7070, false)}>
					<i class="fa-solid fa-floppy-disk me-2"></i>Save
				</button>
			</div>
		{/if}
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
