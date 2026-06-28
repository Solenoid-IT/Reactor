<script>
	import Form from './Form.svelte';

	export let selectedScript = null;
	export let scriptsPath = '';
	export let defaultProgramPath = '';
	export let reactorName = '';
	export let httpPort = 7070;
	export let tlsEnabled = false;
	export let tlsSubject = '';
	export let tlsNotAfter = '';
	export let tlsFingerprint = '';
	export let exchangeMode = 'node';
	export let exchangeHost = '';
	export let exchangePort = 7070;
	export let exchangeTls = false;
	export let exchangeToken = '';
	export let exchangeActive = false;
	export let exchangeClients = [];
	export let onSaveReactorName = () => {};
	export let onSaveHttpServerData = () => {};
	export let onOpenServerStatus = () => {};
	export let onOpenWorkflow = () => {};
	export let onGenerateTlsCert = () => {};
	export let onDeleteTlsCert = () => {};
	export let onGenerateExchangeToken = () => {};
	export let onSaveExchangeConfig = () => {};
	export let status = 'Ready';

	function onNameSubmit(event) {
		if (!event.detail.valid) {
			return;
		}
		onSaveReactorName(event.detail.values.reactorName ?? reactorName);
	}

	function onHttpServerSubmit(event) {
		if (!event.detail.valid) {
			return;
		}
		onSaveHttpServerData(event.detail.values.httpPort ?? httpPort);
	}

	function onWorkingModeSubmit(event) {
		if (!event.detail.valid) {
			return;
		}

		const values = event.detail.values || {};
		const exchangeValues = values.exchange || {};
		onSaveExchangeConfig(
			values.type ?? exchangeValues.mode ?? exchangeMode,
			exchangeValues.host ?? exchangeHost,
			exchangeValues.port ?? exchangePort,
			exchangeValues.tls ?? exchangeTls,
			exchangeValues.token ?? exchangeToken
		);
	}

	function confirmGenerateExchangeToken() {
		if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
			const confirmed = window.confirm('Generate a new token? Nodes will need to use the new token to authenticate.');
			if (!confirmed) {
				return;
			}
		}

		onGenerateExchangeToken();
	}
</script>

<aside class="detail-pane">
	<section class="detail-card">
		<h3>
			<i class="fa-solid fa-tag me-2"></i>
			Name
		</h3>
		<Form on:submit={onNameSubmit}>
			<div class="row">
				<div class="col">
					<input
						type="text"
						class="input"
						name="reactorName"
						data-required="true"
						data-type="string"
						bind:value={reactorName}
					/>
				</div>
				<div class="col">
					<button type="submit" class="btn-primary">
						<i class="fa-solid fa-floppy-disk me-2"></i>
						Save
					</button>
				</div>
			</div>
		</Form>
	</section>

	<section class="detail-card">
		<h3><i class="fa-solid fa-arrows-left-right me-2"></i>Working Mode</h3>
		<Form on:submit={ onWorkingModeSubmit }>
			<div class="exchange-mode-group mt-2">
				<select class="input" name="type" data-required="true" data-type="string" bind:value={exchangeMode}>
					<option value="node">Node</option>
					<option value="exchange">Exchange</option>
				</select>
			</div>

			{#if exchangeMode === 'exchange'}
				<div class="row mt-3">
					<div class="col">
						<label class="d-block m-0">
							<span class="detail-label">Token</span>
							<div style="display:flex; align-items:stretch; gap:0;">
								<input type="text" class="input" name="exchange.token" data-type="string" bind:value={exchangeToken} readonly style="border-top-right-radius:0; border-bottom-right-radius:0;" />
								<button
									type="button"
									class="btn-secondary"
									on:click={confirmGenerateExchangeToken}
									aria-label="Generate Secure Token"
									style="border-top-left-radius:0; border-bottom-left-radius:0; min-width:42px; padding:0 12px; display:flex; align-items:center; justify-content:center;"
									title="generate"
								>
									<i class="fa-solid fa-dice"></i>
								</button>
							</div>
						</label>
					</div>
				</div>

				{#if exchangeActive}
					<div class="detail-value mt-4" style="color: var(--color-success, #4caf50);">
						<i class="fa-solid fa-circle me-1"></i>Active — {exchangeClients.length} client(s)
					</div>
					{#if exchangeClients.length > 0}
						<div class="detail-value" style="font-size:0.8em; opacity:0.7;">{exchangeClients.join(', ')}</div>
					{/if}
				{:else}
					<div class="detail-value mt-4" style="opacity:0.5;"><i class="fa-solid fa-circle me-1"></i>Not active</div>
				{/if}
			{/if}
			{#if exchangeMode === 'node'}
				<fieldset class="mt-3" style="border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 10px;">
					<legend>Exchange</legend>

					<div class="row">
						<div class="col">
							<label class="d-block m-0">
								<span class="detail-label">Host</span>
								<input type="text" class="input" name="exchange.host" data-required data-type="string" bind:value={exchangeHost} placeholder="192.168.1.10" />
							</label>
						</div>
						<div class="col-2">
							<label class="d-block m-0">
								<span class="detail-label">Port</span>
								<input type="number" class="input" name="exchange.port" data-required data-type="int" min="1" max="65535" bind:value={exchangePort} />
							</label>
						</div>
					</div>

					<div class="row mt-2">
						<div class="col">
							<label class="d-block m-0">
								<span class="detail-label">Token</span>
								<input type="text" class="input" name="exchange.token" data-required data-type="string" bind:value={exchangeToken} />
							</label>
						</div>
					</div>

					<div class="row mt-3">
						<div class="col">
							<label class="d-flex align-items-center m-0">
								<input type="checkbox" class="input me-2" name="exchange.tls" data-type="bool" bind:checked={exchangeTls} />
								TLS
							</label>
						</div>
					</div>

					{#if exchangeActive}
						<div class="detail-value mt-4" style="color: var(--color-success, #4caf50);"><i class="fa-solid fa-plug me-1"></i>Connected{exchangeTls ? ' (WSS)' : ' (WS)'}</div>
					{:else}
						<div class="detail-value mt-4" style="opacity:0.5;"><i class="fa-solid fa-plug-circle-xmark me-1"></i>Not connected</div>
					{/if}
				</fieldset>
			{/if}

			<div class="row mt-3">
				<div class="col text-center">
					<button type="submit" class="btn-primary">
						<i class="fa-solid fa-floppy-disk me-2"></i>
						Save
					</button>
				</div>
			</div>
		</Form>
	</section>

	<section class="detail-card http-server-card">
		<h3>
			<i class="fa-solid fa-network-wired me-2"></i>Server
		</h3>

		<button class="btn-secondary mt-2" on:click={onOpenServerStatus}><i class="fa-solid fa-heart-pulse me-2"></i>View Status</button>

		<Form on:submit={onHttpServerSubmit}>
			<div class="http-port-group mt-2">
				<label>
					<span class="detail-label">Port</span>
					<input
						class="input"
						type="number"
						name="httpPort"
						data-required="true"
						data-type="int"
						min="1"
						max="65535"
						bind:value={httpPort}
					/>
				</label>
			</div>

			<div class="row mt-2">
				<div class="col text-center">
					<button type="submit" class="btn-primary">
						<i class="fa-solid fa-floppy-disk me-2"></i>
						Save
					</button>
				</div>
			</div>
		</Form>
		<!-- TLS -->
		<div class="mt-3" style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px;">
			<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
				<i class="fa-solid fa-lock" style="color: {tlsEnabled ? '#4caf50' : 'rgba(255,255,255,0.4)'}"></i>
				<span style="font-size:0.85em; font-weight:600;">TLS / HTTPS</span>
				{#if tlsEnabled}
					<span style="font-size:0.75em; color:#4caf50; margin-left:auto;">Active</span>
				{:else}
					<span style="font-size:0.75em; opacity:0.4; margin-left:auto;">Disabled</span>
				{/if}
			</div>
			{#if tlsEnabled}
				{#if tlsSubject}<div class="detail-value" style="font-size:0.78em; opacity:0.7;">CN: {tlsSubject}</div>{/if}
				{#if tlsNotAfter}<div class="detail-value" style="font-size:0.78em; opacity:0.7;">Expires: {tlsNotAfter}</div>{/if}
				{#if tlsFingerprint}<div class="detail-value" style="font-size:0.7em; opacity:0.5; word-break:break-all;">SHA256: {tlsFingerprint}</div>{/if}
				<button class="btn-secondary mt-2" style="color:#e57373;" on:click={onDeleteTlsCert}>
					<i class="fa-solid fa-trash me-1"></i>Delete Certificate
				</button>
			{:else}
				<div class="detail-value" style="font-size:0.8em; opacity:0.6; margin-bottom:6px;">Generate a certificate to enable HTTPS and WSS.</div>
				<button class="btn-primary" on:click={onGenerateTlsCert}>
					<i class="fa-solid fa-shield-halved me-2"></i>Generate Certificate
				</button>
			{/if}
		</div>
	</section>

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
