<script>
	import { onDestroy } from 'svelte';
	import { formatUiDateTime } from '$lib/dateTime';
	import Form from './Form.svelte';
	import Helper from './Helper.svelte';
	import PasswordField from './PasswordField.svelte';

	export let reactorName = '';
	export let httpPort = 7070;
	export let tlsEnabled = false;
	export let tlsSubject = '';
	export let tlsNotAfter = '';
	export let tlsFingerprint = '';
	export let exchangeMode = 'node';
	export let exchangeEnabled = false;
	export let exchangeHost = '';
	export let exchangePort = 7070;
	export let exchangeTls = false;
	export let stunHost = '';
	export let stunPort = 3478;
	export let turnHost = '';
	export let turnPort = 3478;
	export let turnTls = false;
	export let turnUsername = '';
	export let turnPassword = '';
	export let stunTestConnected = null;
	export let turnTestConnected = null;
	export let stunTestStatus = '';
	export let turnTestStatus = '';
	export let exchangeToken = '';
	export let discovery = false;
	export let exchangeActive = false;
	export let exchangeStatus = { state: 'disconnected', connected: false, authenticated: false, reason: '', errorType: '' };
	export let exchangeClients = [];
	export let p2pStatus = { enabled: false, signalingViaExchange: true, sessions: [], remotePeers: [], iceServersConfigured: false, iceServers: [] };
	export let linkedNodes = [];
	export let linkedNodesTotal = 0;
	export let linkedNodesLoading = false;
	export let onSaveReactorName = () => {};
	export let onSaveHttpServerData = () => {};
	export let onOpenServerStatus = () => {};
	export let onGenerateTlsCert = () => {};
	export let onDeleteTlsCert = () => {};
	export let onGenerateExchangeToken = () => {};
	export let onSaveExchangeConfig = () => {};
	export let onSaveStunConfig = () => {};
	export let onSaveTurnConfig = () => {};
	export let onRefreshLinkedNodes = () => {};
	export let onExportBackup = () => {};
	export let onImportBackup = () => {};
	export let permissionsPlatform = '';
	export let permissionsEntries = [];
	export let onTogglePermission = () => {};
	export let onOpenSystemPermissionSettings = () => {};
	export let onStopBackgroundProcess = () => {};
	export let messageQueuePending = 0;
	export let messageQueueDirectPending = 0;
	export let messageQueueExchangePending = 0;
	export let messageQueueTtlDays = 7;
	export let onSaveMessageQueueTtlDays = () => {};
	export let onFlushMessageQueue = () => {};
	export let onClearMessageQueue = () => {};
	export let onCopyText = async () => ({ ok: false, error: 'copy handler unavailable' });

	let copiedEndpointUuid = '';
	let copiedEndpointTimer = null;

	$: p2pRemotePeers = (() => {
		const fromStatus = Array.isArray(p2pStatus?.remotePeers)
			? p2pStatus.remotePeers.map((peer) => String(peer || '').trim().toLowerCase()).filter(Boolean)
			: [];
		const fromLinkedNodes = Array.isArray(linkedNodes)
			? linkedNodes
				.map((node) => String(node?.name || '').trim().toLowerCase())
				.filter(Boolean)
			: [];
		return Array.from(new Set([...fromStatus, ...fromLinkedNodes])).sort((a, b) => a.localeCompare(b));
	})();

	function showCopiedFeedback(endpointUuid) {
		copiedEndpointUuid = String(endpointUuid || '').trim();
		if (copiedEndpointTimer) {
			clearTimeout(copiedEndpointTimer);
		}

		copiedEndpointTimer = setTimeout(() => {
			copiedEndpointUuid = '';
			copiedEndpointTimer = null;
		}, 1500);
	}

	async function copyNodeEndpointUuid(endpointUuid) {
		const safeUuid = String(endpointUuid || '').trim();
		if (!safeUuid) {
			return;
		}

		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
				await navigator.clipboard.writeText(safeUuid);
				showCopiedFeedback(safeUuid);
				return;
			}
		} catch {
			// Fallback below.
		}

		try {
			const result = await onCopyText(safeUuid);
			if (result && result.ok) {
				showCopiedFeedback(safeUuid);
				return;
			}
		} catch {
			// Fallback below.
		}

		if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
			window.prompt('Copy endpoint UUID', safeUuid);
			showCopiedFeedback(safeUuid);
		}
	}

	function endpointDisplayName(name, fallback = 'unknown') {
		const rawName = String(name || '').trim();
		const stripped = rawName.replace(/\.(ts|js)$/i, '').trim();
		if (stripped) {
			return stripped;
		}
		if (rawName) {
			return rawName;
		}
		return fallback;
	}

	onDestroy(() => {
		if (copiedEndpointTimer) {
			clearTimeout(copiedEndpointTimer);
		}
	});

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
			values.type ?? exchangeMode,
			exchangeValues.host ?? exchangeHost,
			exchangeValues.port ?? exchangePort,
			exchangeValues.tls ?? exchangeTls,
			exchangeValues.token ?? exchangeToken,
			exchangeValues.enabled ?? exchangeEnabled,
			exchangeValues.discovery ?? discovery,
			exchangeValues.stun || {
				host: stunHost,
				port: stunPort,
				tls: false,
			},
			exchangeValues.turn || {
				host: turnHost,
				port: turnPort,
				tls: turnTls,
				username: turnUsername,
				password: turnPassword,
			},
		);
	}

	function onTurnTlsChange() {
		turnPort = turnTls ? 5349 : 3478;
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

	function onQueuePolicySubmit(event) {
		if (!event.detail.valid) {
			return;
		}
		onSaveMessageQueueTtlDays(event.detail.values.queueTtlDays ?? messageQueueTtlDays);
	}

	function confirmClearQueue() {
		if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
			const confirmed = window.confirm('Clear queued messages? This cannot be undone.');
			if (!confirmed) {
				return;
			}
		}
		onClearMessageQueue();
	}

	function confirmStopBackgroundProcess() {
		if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
			const confirmed = window.confirm('Stop Reactor background process now? The app will terminate immediately until you launch it again.');
			if (!confirmed) {
				return;
			}
		}

		onStopBackgroundProcess();
	}

	function saveStunConfig() {
		onSaveStunConfig({
			host: stunHost,
			port: stunPort,
			tls: false,
		});
	}

	function saveTurnConfig() {
		onSaveTurnConfig({
			host: turnHost,
			port: turnPort,
			tls: turnTls,
			username: turnUsername,
			password: turnPassword,
		});
	}

	function p2pStateLabel(state) {
		const safeState = String(state || '').trim().toLowerCase();
		if (safeState === 'connected-p2p') {
			return 'Direct P2P';
		}
		if (safeState === 'connected-turn') {
			return 'TURN Relay';
		}
		if (safeState === 'fallback-exchange') {
			return 'Fallback Exchange';
		}
		if (safeState === 'connecting' || safeState === 'signaling') {
			return 'Signaling';
		}
		return 'Idle';
	}

	function p2pStateColor(state) {
		const safeState = String(state || '').trim().toLowerCase();
		if (safeState === 'connected-p2p') {
			return 'var(--color-success, #4caf50)';
		}
		if (safeState === 'connected-turn') {
			return '#f6c453';
		}
		if (safeState === 'fallback-exchange') {
			return '#ff8f8f';
		}
		return 'rgba(255,255,255,0.65)';
	}
</script>

<div class="settings-pane">
	<section class="detail-card settings-name-card">
		<h3 class="d-flex align-items-center">
			<i class="fa-solid fa-tag me-2"></i>
			<span>Name</span>
			<Helper ariaLabel="Reactor Name Help">
				<div>The name uniquely identifies this Reactor as a node in the network.</div>
				<div class="mt-1">An endpoint can send messages to other nodes using this identifier.</div>
			</Helper>
		</h3>
		<Form on:submit={onNameSubmit}>
			<div class="row settings-inline-row">
				<div class="col">
					<input type="text" class="input" name="reactorName" data-required="true" data-type="string" bind:value={reactorName} />
				</div>
				<div class="col settings-submit-col">
					<button type="submit" class="btn-primary">
						<i class="fa-solid fa-floppy-disk me-2"></i>
						Save
					</button>
				</div>
			</div>
		</Form>
	</section>

	<section class="detail-card settings-mode-card">
		<h3 class="d-flex align-items-center">
			<i class="fa-solid fa-arrows-left-right me-2"></i>
			<span>Working Mode</span>
			<Helper ariaLabel="Working Mode Help">
				<div><strong>Node</strong>: run local endpoints and can use <code>Node.sendMessage</code> to communicate with other nodes.</div>
				<div class="mt-1"><strong>Use EXCHANGE</strong>: connect this node to a remote EXCHANGE for message routing.</div>
				<div class="mt-1"><strong>Exchange</strong>: run this Reactor as a central hub (like a router).</div>
				<div class="mt-1">Exchange is used when nodes are on different networks, not on the same LAN.</div>
			</Helper>
		</h3>
		<Form on:submit={onWorkingModeSubmit}>
			<div class="exchange-mode-group mt-2">
				<select class="input" name="type" data-required="true" data-type="string" bind:value={exchangeMode}>
					<option value="node">Node</option>
					<option value="exchange">Exchange</option>
				</select>
			</div>

			{#if exchangeMode === 'exchange'}
				<div class="row mt-3 settings-inline-row">
					<div class="col">
						<label class="d-block m-0">
							<span class="detail-label">Token</span>
							<div class="settings-token-row">
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

				<div class="row mt-2">
					<div class="col">
						<label class="d-flex align-items-center m-0">
							<input type="checkbox" class="input me-2" name="exchange.discovery" data-type="bool" bind:checked={discovery} />
							Enable discovery
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

				{#if discovery}
					<div class="mt-3" style="border-top:1px solid rgba(255,255,255,0.1); padding-top:10px;">
						<div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
							<span class="detail-label">Linked Nodes ({linkedNodesTotal})</span>
							<div style="display:flex; align-items:center; gap:8px;">
								<button type="button" class="btn-secondary" on:click={onRefreshLinkedNodes} disabled={linkedNodesLoading}>
									<i class="fa-solid fa-rotate-right me-1"></i>{linkedNodesLoading ? 'Refreshing...' : 'Refresh'}
								</button>
							</div>
						</div>
						{#if linkedNodes.length === 0}
							<div class="detail-value mt-2" style="opacity:0.65;">No linked nodes</div>
						{:else}
							<div class="detail-value mt-2" style="max-height:220px; overflow:auto; font-size:0.78em;">
								{#each linkedNodes as node}
									<div style="padding:6px 0; border-bottom:1px dashed rgba(255,255,255,0.08);">
										<details class="node-accordion-details">
											<summary class="node-accordion-toggle">
												<span class="node-accordion-title">
													<strong>{node.name || 'unknown'}</strong>
													{node.ip ? ` (${node.ip}${node.port ? `:${node.port}` : ''})` : ''}
												</span>
												<i class="fa-solid fa-chevron-down node-accordion-icon"></i>
											</summary>
											<div style="opacity:0.7; margin-top:6px;">Connected: {formatUiDateTime(node.connectedAt, '-')}</div>
											<div style="opacity:0.7;">Last seen: {formatUiDateTime(node.lastSeenAt, '-')}</div>
											{#if Array.isArray(node.endpoints) && node.endpoints.length > 0}
												<div style="margin-top:6px; padding-left:8px; border-left:2px solid rgba(255,255,255,0.14);">
													{#each node.endpoints as endpoint}
														<div style="padding:4px 0; border-bottom:1px dashed rgba(255,255,255,0.06);">
															<div><strong>{endpointDisplayName(endpoint.name, 'unnamed')}</strong></div>
															<div style="display:flex; align-items:center; gap:6px; opacity:0.78;">
																<span>{endpoint.uuid || '-'}</span>
																<button type="button" class="btn-secondary" style="padding:1px 6px; font-size:0.9em;" on:click={() => copyNodeEndpointUuid(endpoint.uuid)}>{copiedEndpointUuid && copiedEndpointUuid === String(endpoint.uuid || '').trim() ? 'Copied' : 'Copy'}</button>
															</div>
															<div style="opacity:0.68;">Triggers: {Array.isArray(endpoint.triggers) && endpoint.triggers.length > 0 ? endpoint.triggers.join(', ') : '-'}</div>
															<div style="opacity:0.68;">Enabled: {endpoint.enabled ? 'yes' : 'no'} · Mutex: {endpoint.mutex ? 'yes' : 'no'}</div>
														</div>
													{/each}
												</div>
											{:else}
												<div style="margin-top:6px; opacity:0.65;">No endpoints exposed by this node</div>
											{/if}
										</details>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			{/if}

			{#if exchangeMode === 'node'}
				<fieldset class="mt-3 settings-exchange-fieldset" style="border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 10px;">
					<legend>EXCHANGE</legend>

					<div class="row mt-1">
						<div class="col">
							<label class="d-flex align-items-center m-0">
								<input type="checkbox" class="input me-2" name="exchange.enabled" data-type="bool" bind:checked={exchangeEnabled} />
								Use EXCHANGE
							</label>
						</div>
					</div>

					<div class="row settings-host-port-row mt-2">
						<div class="col">
							<label class="d-block m-0">
								<span class="detail-label">Host</span>
								<input type="text" class="input" name="exchange.host" data-required={exchangeEnabled ? 'true' : 'false'} data-type="string" bind:value={exchangeHost} placeholder="192.168.1.10" disabled={!exchangeEnabled} />
							</label>
						</div>
						<div class="col-2 settings-port-col">
							<label class="d-block m-0">
								<span class="detail-label">Port</span>
								<input type="number" class="input" name="exchange.port" data-required={exchangeEnabled ? 'true' : 'false'} data-type="int" min="1" max="65535" bind:value={exchangePort} disabled={!exchangeEnabled} />
							</label>
						</div>
					</div>

					<div class="row mt-2">
						<div class="col">
							<label class="d-block m-0">
								<span class="detail-label">Token</span>
								<input type="text" class="input" name="exchange.token" data-required={exchangeEnabled ? 'true' : 'false'} data-type="string" bind:value={exchangeToken} disabled={!exchangeEnabled} />
							</label>
						</div>
					</div>

					<div class="row mt-3">
						<div class="col">
							<label class="d-flex align-items-center m-0">
								<input type="checkbox" class="input me-2" name="exchange.tls" data-type="bool" bind:checked={exchangeTls} disabled={!exchangeEnabled} />
								TLS
							</label>
						</div>
					</div>

					{#if exchangeEnabled}
						<div class="mt-3" style="border-top:1px solid rgba(255,255,255,0.1); padding-top:10px;">
							<div class="detail-label" style="margin-bottom:8px;">
								STUN (optional)

								<Helper ariaLabel="STUN Help">
									STUN is used to discover the public IP address of this node when behind a NAT. It is required for P2P connections to work across different networks.
								</Helper>
							</div>
							{#if stunTestConnected === true}
								<div class="detail-value" style="color: var(--color-success, #4caf50);"><i class="fa-solid fa-circle-check me-1"></i>Connected</div>
							{:else if stunTestConnected === false}
								<div class="detail-value" style="color: var(--color-danger, #ff6b6b);"><i class="fa-solid fa-circle-xmark me-1"></i>Not connected</div>
							{/if}
							<div class="row settings-host-port-row">
								<div class="col">
									<label class="d-block m-0">
										<span class="detail-label">Server</span>
										<input type="text" class="input" name="exchange.stun.host" data-type="string" bind:value={stunHost} placeholder="stun.example.com" />
									</label>
								</div>
								<div class="col-2 settings-port-col">
									<label class="d-block m-0">
										<span class="detail-label">Port</span>
										<input type="number" class="input" name="exchange.stun.port" data-type="int" min="1" max="65535" bind:value={stunPort} />
									</label>
								</div>
							</div>
							<div class="row mt-2">
								<div class="col">
									<div class="detail-value" style="opacity:0.75;">Transport: UDP</div>
								</div>
							</div>
							<div class="row mt-2 settings-submit-row">
								<div class="col text-center">
									<button type="button" class="btn-primary" on:click={saveStunConfig}>
										<i class="fa-solid fa-floppy-disk me-2"></i>
										Save
									</button>
								</div>
							</div>
							{#if stunTestStatus}
								<div class="detail-value mt-2" style="opacity:0.85;">{stunTestStatus}</div>
							{/if}
						</div>

						<div class="mt-3" style="border-top:1px solid rgba(255,255,255,0.1); padding-top:10px;">
							<div class="detail-label" style="margin-bottom:8px;">
								TURN (optional)

								<Helper ariaLabel="TURN Help">
									TURN is used to relay data when direct peer-to-peer connections are not possible. It is optional but recommended for better connectivity across different networks.
								</Helper>
							</div>
							{#if turnTestConnected === true}
								<div class="detail-value" style="color: var(--color-success, #4caf50);"><i class="fa-solid fa-circle-check me-1"></i>Connected</div>
							{:else if turnTestConnected === false}
								<div class="detail-value" style="color: var(--color-danger, #ff6b6b);"><i class="fa-solid fa-circle-xmark me-1"></i>Not connected</div>
							{/if}
							<div class="row settings-host-port-row">
								<div class="col">
									<label class="d-block m-0">
										<span class="detail-label">Server</span>
										<input type="text" class="input" name="exchange.turn.host" data-type="string" bind:value={turnHost} placeholder="turn.example.com" />
									</label>
								</div>
								<div class="col-2 settings-port-col">
									<label class="d-block m-0">
										<span class="detail-label">Port</span>
										<input type="number" class="input" name="exchange.turn.port" data-type="int" min="1" max="65535" bind:value={turnPort} />
									</label>
								</div>
							</div>
							<div class="row settings-host-port-row settings-credentials-row mt-2">
								<div class="col">
									<label class="d-block m-0">
										<span class="detail-label">User</span>
										<input type="text" class="input" name="exchange.turn.username" data-type="string" bind:value={turnUsername} placeholder="turn-user" />
									</label>
								</div>
								<div class="col">
									<label class="d-block m-0">
										<span class="detail-label">Password</span>
										<PasswordField name="exchange.turn.password" dataType="string" bind:value={turnPassword} placeholder="turn-password" />
									</label>
								</div>
							</div>
							<div class="row mt-2">
								<div class="col">
									<label class="d-flex align-items-center m-0">
										<input type="checkbox" class="input me-2" name="exchange.turn.tls" data-type="bool" bind:checked={turnTls} on:change={onTurnTlsChange} />
										TLS
									</label>
								</div>
							</div>
							<div class="row mt-2 settings-submit-row">
								<div class="col text-center">
									<button type="button" class="btn-primary" on:click={saveTurnConfig}>
										<i class="fa-solid fa-floppy-disk me-2"></i>
										Save
									</button>
								</div>
							</div>
							{#if turnTestStatus}
								<div class="detail-value mt-2" style="opacity:0.85;">{turnTestStatus}</div>
							{/if}
						</div>
					{/if}

					{#if !exchangeEnabled}
						<div class="detail-value mt-4" style="opacity:0.6;"><i class="fa-solid fa-pause me-1"></i>Disabled</div>
					{:else if exchangeActive}
						<div class="detail-value mt-4" style="color: var(--color-success, #4caf50);"><i class="fa-solid fa-plug me-1"></i>Connected{exchangeTls ? ' (WSS)' : ' (WS)'}</div>
					{:else}
						<div class="detail-value mt-4" style="opacity:0.5;"><i class="fa-solid fa-plug-circle-xmark me-1"></i>Not connected</div>
						{#if exchangeStatus?.reason}
							<div class="detail-value mt-1" style="font-size:0.8em; opacity:0.75; color: {exchangeStatus?.errorType === 'authentication' || exchangeStatus?.state === 'auth-failed' ? 'var(--color-danger, #ff6b6b)' : 'inherit'};">{exchangeStatus.reason}</div>
						{/if}
					{/if}
				</fieldset>
			{/if}

			<div class="row mt-3 settings-submit-row">
				<div class="col text-center">
					<button type="submit" class="btn-primary">
						<i class="fa-solid fa-floppy-disk me-2"></i>
						Save
					</button>
				</div>
			</div>
		</Form>
	</section>

	<section class="detail-card http-server-card settings-server-card">
		<h3>
			<i class="fa-solid fa-network-wired me-2"></i>Local Server
		</h3>

		<button class="btn-secondary mt-2" on:click={onOpenServerStatus}><i class="fa-solid fa-heart-pulse me-2"></i>View Status</button>

		<Form on:submit={onHttpServerSubmit}>
			<div class="http-port-group mt-2">
				<label>
					<span class="detail-label">Port</span>
					<input class="input" type="number" name="httpPort" data-required="true" data-type="int" min="1" max="65535" bind:value={httpPort} />
				</label>
			</div>

			<div class="row mt-2 settings-submit-row">
				<div class="col text-center">
					<button type="submit" class="btn-primary">
						<i class="fa-solid fa-floppy-disk me-2"></i>
						Save
					</button>
				</div>
			</div>
		</Form>

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
				{#if tlsNotAfter}<div class="detail-value" style="font-size:0.78em; opacity:0.7;">Expires: {formatUiDateTime(tlsNotAfter, tlsNotAfter)}</div>{/if}
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

	<section class="detail-card settings-backup-card">
		<h3><i class="fa-solid fa-user-shield me-2"></i>System Permissions</h3>
		<div class="detail-value" style="font-size:0.82em; opacity:0.75; margin-bottom:10px;">
			Available permissions for {permissionsPlatform || 'this device'} are loaded from the shared app model and saved to permissions.json.
		</div>
		<div class="settings-backup-actions" style="margin-bottom:10px;">
			<button type="button" class="btn-secondary" on:click={() => onOpenSystemPermissionSettings([])}>
				<i class="fa-solid fa-gear me-2"></i>
				Open System Settings
			</button>
		</div>
		{#if Array.isArray(permissionsEntries) && permissionsEntries.length > 0}
			<div class="permissions-list">
				{#each permissionsEntries as permission (permission.name)}
					<label class="permission-toggle-row">
						<div>
							<div class="permission-name">{permission.name}</div>
							<div class="permission-caption">Saved for {permissionsPlatform || 'current platform'}</div>
						</div>
						<input
							type="checkbox"
							class="permission-toggle-input"
							checked={Boolean(permission.checked)}
							on:change={(event) => onTogglePermission(permission.name, event.currentTarget.checked)}
						/>
					</label>
				{/each}
			</div>
		{:else}
			<div class="detail-value" style="font-size:0.8em; opacity:0.6;">No permissions defined for this platform in available-permissions.json.</div>
		{/if}
	</section>

	<section class="detail-card settings-backup-card">
		<h3><i class="fa-solid fa-box-archive me-2"></i>Backup</h3>
		<div class="detail-value" style="font-size:0.82em; opacity:0.75; margin-bottom:10px;">
			Export and import a full ZIP backup with endpoints, runtime configuration, and permissions.json.
		</div>
		<div class="settings-backup-actions">
			<button type="button" class="btn-secondary" on:click={onExportBackup}>
				<i class="fa-solid fa-file-export me-2"></i>
				Export ZIP
			</button>
			<button type="button" class="btn-primary" on:click={onImportBackup}>
				<i class="fa-solid fa-file-import me-2"></i>
				Import ZIP
			</button>
		</div>
	</section>

	<section class="detail-card settings-backup-card">
		<h3><i class="fa-solid fa-power-off me-2"></i>Background Process</h3>
		<div class="detail-value" style="font-size:0.82em; opacity:0.75; margin-bottom:10px;">
			Force-stop Reactor even when the window is hidden and the app is still running in background.
		</div>
		<div class="settings-backup-actions">
			<button type="button" class="btn-secondary" style="color:#e57373;" on:click={confirmStopBackgroundProcess}>
				<i class="fa-solid fa-stop me-2"></i>
				Stop Background Process
			</button>
		</div>
	</section>

	<section class="detail-card settings-queue-card">
		<h3 class="d-flex align-items-center">
			<i class="fa-solid fa-list-check me-2"></i>
			<span>Message Queue</span>
			<Helper ariaLabel="Message Queue Help">
				<div><code>Node.sendMessage(target, content, enqueueOnFail)</code> can queue payloads on delivery failure.</div>
				<div class="mt-1">Queue fallback is enabled only when <code>enqueueOnFail</code> is set to <code>true</code>.</div>
			</Helper>
		</h3>
		<div class="detail-value" style="font-size:0.82em; opacity:0.75; margin-bottom:10px;">
			Queued messages are retried automatically when connectivity is restored.
		</div>
		<div class="detail-value" style="font-size:0.82em; margin-bottom:10px;">
			Pending: {messageQueuePending} (Direct: {messageQueueDirectPending}, Exchange: {messageQueueExchangePending})
		</div>

		<Form on:submit={onQueuePolicySubmit}>
			<div class="row settings-inline-row">
				<div class="col">
					<label class="d-block m-0">
						<span class="detail-label">TTL (days)</span>
						<input
							type="number"
							class="input"
							name="queueTtlDays"
							data-required="true"
							data-type="float"
							min="0.01"
							step="0.25"
							bind:value={messageQueueTtlDays}
						/>
					</label>
				</div>
				<div class="col settings-submit-col">
					<button type="submit" class="btn-primary">
						<i class="fa-solid fa-floppy-disk me-2"></i>
						Save
					</button>
				</div>
			</div>
		</Form>

		<div class="settings-backup-actions mt-2">
			<button type="button" class="btn-secondary" on:click={onFlushMessageQueue}>
				<i class="fa-solid fa-rotate me-2"></i>
				Flush Now
			</button>
			<button type="button" class="btn-secondary" style="color:#e57373;" on:click={confirmClearQueue}>
				<i class="fa-solid fa-trash me-2"></i>
				Clear Queue
			</button>
		</div>
	</section>
</div>

<style>
	.settings-pane {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 14px;
	}

	.settings-pane :global(.detail-card) {
		width: 100%;
		min-width: 0;
	}

	.settings-inline-row,
	.settings-host-port-row,
	.settings-submit-row {
		align-items: end;
	}

	.settings-submit-col {
		display: flex;
		align-items: end;
	}

	.settings-submit-col :global(button),
	.settings-submit-row :global(button) {
		width: 100%;
	}

	.settings-token-row {
		display: flex;
		align-items: stretch;
		gap: 0;
	}

	.settings-token-row :global(.input) {
		min-width: 0;
	}

	.settings-token-row :global(button) {
		flex-shrink: 0;
	}

	.settings-port-col {
		min-width: 110px;
	}

	.settings-exchange-fieldset {
		min-width: 0;
	}

	.settings-backup-actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}

	.permissions-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.permission-toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 12px;
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 10px;
		background: rgba(255,255,255,0.03);
	}

	.permission-name {
		font-size: 0.9em;
		font-weight: 600;
		word-break: break-word;
	}

	.permission-caption {
		font-size: 0.76em;
		opacity: 0.6;
		margin-top: 2px;
	}

	.permission-toggle-input {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		accent-color: #4caf50;
	}

	.settings-backup-actions :global(button) {
		flex: 1 1 180px;
	}

	.node-accordion-toggle {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 10px;
		border: 1px solid #435063;
		border-radius: 10px;
		background: linear-gradient(160deg, #2a3342, #262f3d);
		color: var(--text);
		cursor: pointer;
		user-select: none;
		text-align: left;
		transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
	}

	.node-accordion-toggle:hover {
		border-color: #5e6f88;
		background: linear-gradient(160deg, #324052, #2b3747);
		transform: translateY(-1px);
	}

	.node-accordion-toggle:focus-visible {
		outline: 2px solid rgba(76, 175, 80, 0.45);
		outline-offset: 1px;
	}

	.node-accordion-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.node-accordion-icon {
		opacity: 0.85;
		font-size: 0.9em;
		flex-shrink: 0;
		transition: transform 0.16s ease;
	}

	.node-accordion-details > summary {
		list-style: none;
	}

	.node-accordion-details > summary::-webkit-details-marker {
		display: none;
	}

	.node-accordion-details[open] .node-accordion-icon {
		transform: rotate(180deg);
	}

	@media (max-width: 760px) {
		.settings-pane {
			grid-template-columns: 1fr;
			gap: 12px;
		}

		.settings-pane :global(.detail-card) {
			padding: 12px;
		}

		.settings-inline-row,
		.settings-host-port-row,
		.settings-submit-row {
			gap: 10px;
		}

		.settings-submit-col,
		.settings-port-col {
			min-width: 0;
		}

		.settings-token-row {
			flex-wrap: nowrap;
		}

		.settings-backup-actions {
			flex-direction: column;
		}

		.settings-backup-actions :global(button) {
			width: 100%;
		}

		.settings-credentials-row {
			display: flex;
			flex-direction: column;
			align-items: stretch;
		}

		.settings-credentials-row :global(.col) {
			width: 100%;
		}
	}

	@media (max-width: 560px) {
		.settings-inline-row,
		.settings-host-port-row {
			display: flex;
			flex-direction: column;
			align-items: stretch;
		}

		.settings-submit-col,
		.settings-submit-row :global(.col),
		.settings-port-col {
			width: 100%;
		}

		.settings-submit-col :global(button),
		.settings-submit-row :global(button) {
			width: 100%;
		}

		.settings-server-card > :global(button),
		.settings-server-card :global(.btn-primary),
		.settings-server-card :global(.btn-secondary) {
			width: 100%;
		}

		.settings-server-card .detail-value,
		.settings-mode-card .detail-value {
			word-break: break-word;
		}
	}
</style>