<script>
	import { onMount, tick } from 'svelte';
	import HeaderActions from '$lib/components/HeaderActions.svelte';
	import ScriptList from '$lib/components/ScriptList.svelte';
	import DetailPane from '$lib/components/DetailPane.svelte';
	import SettingsPane from '$lib/components/SettingsPane.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import {
		getScriptsInfo,
		getUiSettings,
		copyTextToClipboard,
		stopBackgroundProcess,
		openScriptsFolder,
		readScriptContent,
		saveScriptContent,
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
		getExchangeConfig,
		getP2PStatus,
		getExchangeLinkedNodes,
		setExchangeConfig,
		saveRelayConfig,
		getExchangeToken,
		generateExchangeToken,
		getTlsConfig,
		generateTlsCert,
		deleteTlsCert,
		exportBackup,
		importBackup,
		getMessageQueueStatus,
		setMessageQueueTtlDays,
		flushMessageQueue,
		clearMessageQueue,
	} from '$lib/reactorApi';

	let scripts = [];
	let scriptsPath = '';
	let selectedIndex = -1;
	let reactorName = '';
	let httpPort = 7070;
	let exchangeMode = 'node';
	let exchangeEnabled = false;
	let exchangeHost = '';
	let exchangePort = 7070;
	let exchangeTls = false;
	let stunHost = '';
	let stunPort = 3478;
	let turnHost = '';
	let turnPort = 3478;
	let turnTls = false;
	let turnUsername = '';
	let turnPassword = '';
	let stunTestConnected = null;
	let turnTestConnected = null;
	let stunTestStatus = '';
	let turnTestStatus = '';
	let exchangeToken = '';
	let exchangeDiscovery = false;
	let exchangeActive = false;
	let exchangeClients = [];
	let exchangeLinkedNodes = [];
	let exchangeLinkedNodesTotal = 0;
	let exchangeLinkedNodesLoading = false;
	let exchangeConfigSaving = false;
	let p2pStatus = { enabled: false, signalingViaExchange: true, sessions: [], iceServersConfigured: false, iceServers: [] };
	let tlsEnabled = false;
	let tlsSubject = '';
	let tlsNotAfter = '';
	let tlsFingerprint = '';
	let messageQueuePending = 0;
	let messageQueueDirectPending = 0;
	let messageQueueExchangePending = 0;
	let messageQueueTtlDays = 7;
	let status = 'Ready';
	let settingsOpen = false;
	let renameOpen = false;
	let renameScriptPath = '';
	let renameOriginalName = '';
	let renameValue = '';
	let renameInput;
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
		const [info, settings, serverConfig, currentReactorName, exchangeConfigResult, p2pStatusResult, exchangeTokenResult, tlsConfigResult, queueStatusResult] = await Promise.all([
			getScriptsInfo(),
			getUiSettings(),
			getHttpServerConfig(),
			getReactorName(),
			getExchangeConfig(),
			getP2PStatus(),
			getExchangeToken(),
			getTlsConfig(),
			getMessageQueueStatus(),
		]);

		if (info?.ok === false) {
			status = `Error scripts list: ${info?.error || 'unknown'}`;
		}

		scripts = Array.isArray(info?.scripts) ? info.scripts : [];
		scriptsPath = info?.path || '';
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
			stunHost = String(ec.stun?.host || '');
			stunPort = Number(ec.stun?.port) || 3478;
			turnHost = String(ec.turn?.host || '');
			turnPort = Number(ec.turn?.port) || 3478;
			turnTls = Boolean(ec.turn?.tls);
			turnUsername = String(ec.turn?.username || '');
			turnPassword = String(ec.turn?.password || '');
			exchangeToken = ec.token || '';
			exchangeDiscovery = Boolean(ec.discovery ?? ec.exposeDiscoveryEndpoint);
			exchangeActive = Boolean(ec.active);
			exchangeClients = Array.isArray(ec.connectedClients) ? ec.connectedClients : [];
			exchangeEnabled = Boolean((ec.host || '').trim());
		}

		if (p2pStatusResult?.ok && p2pStatusResult?.p2p) {
			const nextP2P = p2pStatusResult.p2p;
			p2pStatus = {
				enabled: Boolean(nextP2P.enabled),
				signalingViaExchange: Boolean(nextP2P.signalingViaExchange ?? true),
				sessions: Array.isArray(nextP2P.sessions) ? nextP2P.sessions : [],
				iceServersConfigured: Boolean(nextP2P.iceServersConfigured),
				iceServers: Array.isArray(nextP2P.iceServers) ? nextP2P.iceServers : [],
			};
		} else {
			p2pStatus = { enabled: false, signalingViaExchange: true, sessions: [], iceServersConfigured: false, iceServers: [] };
		}

		if (exchangeTokenResult?.ok && exchangeTokenResult?.exchangeToken?.token) {
			exchangeToken = exchangeTokenResult.exchangeToken.token;
		}

		if (queueStatusResult?.ok && queueStatusResult?.queue) {
			const queue = queueStatusResult.queue;
			messageQueuePending = Number(queue.pending || 0);
			messageQueueDirectPending = Number(queue.directPending || 0);
			messageQueueExchangePending = Number(queue.exchangePending || 0);
			messageQueueTtlDays = Number(queue.ttlDays || 7);
		}

		if (selectedIndex >= scripts.length) {
			selectedIndex = -1;
		}

		const canLoadLinkedNodes = (exchangeMode === 'exchange' && exchangeDiscovery) || (exchangeMode === 'node' && exchangeEnabled && exchangeActive);
		if (canLoadLinkedNodes) {
			await refreshExchangeLinkedNodes(true);
		} else {
			exchangeLinkedNodes = [];
			exchangeLinkedNodesTotal = 0;
		}

		status = 'Data refreshed';
	}

	async function refreshExchangeLinkedNodes(silent = false) {
		const isExchangeServerView = exchangeMode === 'exchange' && exchangeDiscovery;
		const isNodeView = exchangeMode === 'node' && exchangeEnabled;
		if (!isExchangeServerView && !isNodeView) {
			exchangeLinkedNodes = [];
			exchangeLinkedNodesTotal = 0;
			return;
		}

		exchangeLinkedNodesLoading = true;
		try {
			const result = await getExchangeLinkedNodes();
			if (!result?.ok) {
				exchangeLinkedNodes = [];
				exchangeLinkedNodesTotal = 0;
				if (!silent) {
					status = `Error: ${result?.error || 'unable to refresh linked nodes'}`;
				}
				return;
			}

			exchangeLinkedNodes = Array.isArray(result.nodes) ? result.nodes : [];
			exchangeLinkedNodesTotal = Number(result.total || exchangeLinkedNodes.length || 0);
			if (!silent) {
				status = `Linked nodes refreshed (${exchangeLinkedNodesTotal})`;
			}
		} finally {
			exchangeLinkedNodesLoading = false;
		}
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

	async function saveExchangeConfigValue(mode, host, port, tls, token, enabled = true, discovery = false, stun = {}, turn = {}) {
		if (exchangeConfigSaving) {
			return;
		}

		exchangeConfigSaving = true;
		try {
		const numericPort = Number(port);
		if (!Number.isFinite(numericPort) || numericPort < 1 || numericPort > 65535) {
			status = 'Error: invalid Exchange port';
			return;
		}
		const sanitizeRelay = (value) => {
			const source = value && typeof value === 'object' ? value : {};
			const hostValue = String(source.host || '').trim();
			const numericValue = Number(source.port);
			const safePort = Number.isFinite(numericValue) && numericValue > 0 && numericValue <= 65535 ? numericValue : 3478;
			const username = String(source.username || source.user || '').trim();
			const password = String(source.password || '').trim();
			return {
				host: hostValue,
				port: safePort,
				tls: Boolean(source.tls),
				username,
				password,
			};
		};
		const safeEnabled = Boolean(enabled);
		const safeDiscovery = Boolean(discovery);
		const effectiveHost = mode === 'node' && !safeEnabled ? '' : host || '';
		const safeStun = sanitizeRelay(stun);
		const safeTurn = sanitizeRelay(turn);
		const result = await setExchangeConfig(mode, effectiveHost, numericPort, Boolean(tls), token || '', safeDiscovery, safeStun, safeTurn);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unknown'}`;
			await refreshAll();
			return;
		}

		const connectionTest = result?.connectionTest || null;
		if (mode === 'node' && !safeEnabled) {
			status = 'Exchange client disabled for node mode';
		} else if (mode === 'node' && connectionTest) {
			status = connectionTest.connected
				? `Exchange config saved and connected (${Boolean(tls) ? 'WSS' : 'WS'})`
				: `Exchange config saved but not connected (${connectionTest.reason || 'connection test failed'})`;
		} else {
			status = `Exchange config saved: mode=${mode}${Boolean(tls) ? ' (TLS)' : ''}`;
		}

		await refreshAll();

		if (mode === 'node' && safeEnabled && connectionTest?.connected) {
			await refreshExchangeLinkedNodes(true);
		}

		if (mode === 'exchange' && safeDiscovery) {
			await refreshExchangeLinkedNodes(true);
		}
		} finally {
			exchangeConfigSaving = false;
		}
	}

	async function generateExchangeTokenHandler() {
		status = 'Generating Exchange token...';
		const result = await generateExchangeToken();
		status = result?.ok ? 'Exchange token generated' : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function saveStunConfigHandler(config) {
		const safeConfig = {
			host: String(config?.host || '').trim(),
			port: Number(config?.port) > 0 ? Number(config.port) : 3478,
			tls: false,
		};
		stunTestStatus = 'Saving and testing STUN...';
		stunTestConnected = null;
		const result = await saveRelayConfig('stun', safeConfig);
		if (!result?.ok) {
			stunTestStatus = `STUN save failed: ${result?.error || 'unknown error'}`;
			stunTestConnected = false;
			status = stunTestStatus;
			return;
		}

		const test = result.test || {};
		if (test.ok) {
			stunTestStatus = `STUN OK (${test.protocol || 'udp'})`;
			stunTestConnected = true;
			status = 'STUN saved and reachable';
		} else {
			stunTestStatus = `STUN test failed: ${test.error || 'unreachable'}`;
			stunTestConnected = false;
			status = stunTestStatus;
		}

		await refreshAll();
	}

	async function saveTurnConfigHandler(config) {
		const safeConfig = {
			host: String(config?.host || '').trim(),
			port: Number(config?.port) > 0 ? Number(config.port) : 3478,
			tls: Boolean(config?.tls),
			username: String(config?.username || config?.user || '').trim(),
			password: String(config?.password || '').trim(),
		};
		turnTestStatus = 'Saving and testing TURN...';
		turnTestConnected = null;
		const result = await saveRelayConfig('turn', safeConfig);
		if (!result?.ok) {
			turnTestStatus = `TURN save failed: ${result?.error || 'unknown error'}`;
			turnTestConnected = false;
			status = turnTestStatus;
			return;
		}

		const test = result.test || {};
		if (test.ok) {
			turnTestStatus = `TURN OK (${test.protocol || (safeConfig.tls ? 'tls' : 'udp')})`;
			turnTestConnected = true;
			status = 'TURN saved and reachable';
		} else {
			turnTestStatus = `TURN test failed: ${test.error || 'unreachable'}`;
			turnTestConnected = false;
			status = turnTestStatus;
		}

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

	async function saveMessageQueueTtlDaysHandler(nextDays) {
		const ttlDays = Number(nextDays);
		if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
			status = 'Error: invalid queue TTL';
			return;
		}

		status = 'Saving queue TTL...';
		const result = await setMessageQueueTtlDays(ttlDays);
		status = result?.ok ? `Queue TTL updated: ${ttlDays} day(s)` : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function flushMessageQueueHandler() {
		status = 'Flushing queue...';
		const result = await flushMessageQueue();
		status = result?.ok ? 'Queue flush completed' : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function clearMessageQueueHandler() {
		status = 'Clearing queue...';
		const result = await clearMessageQueue();
		status = result?.ok ? 'Queue cleared' : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function copyScriptId(index) {
		const script = scripts[index];
		const scriptId = String(script?.scriptId || '').trim();
		if (!script || !scriptId) {
			status = 'Error: script ID unavailable';
			return;
		}

		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
				await navigator.clipboard.writeText(scriptId);
				status = `Copied ID: ${script.name}`;
				return;
			}
		} catch {
			// Fallback below.
		}

		const nativeCopyResult = await copyTextToClipboard(scriptId);
		if (nativeCopyResult?.ok) {
			status = `Copied ID: ${script.name}`;
			return;
		}

		if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
			window.prompt(`Copy script ID for ${script.name}`, scriptId);
			status = `Script ID ready to copy: ${script.name}`;
			return;
		}

		status = `Script ID: ${scriptId}`;
	}

	async function stopBackgroundProcessHandler() {
		status = 'Stopping background process...';
		const result = await stopBackgroundProcess();
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unknown'}`;
			return;
		}

		status = 'Stopping background process...';
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
				onOpen={editScript}
				onQuickOpenHover={preloadCodeEditor}
				onRename={renameScript}
				onDelete={deleteScript}
				onToggleState={(index) => toggleDirective(index, 'state')}
				onToggleMutex={(index) => toggleDirective(index, 'mutex')}
				onRun={runNow}
				onOpenLog={openLog}
				onClearLog={clearLog}
				onCopyId={copyScriptId}
			/>
		</section>
		<DetailPane
			{selectedScript}
			{scriptsPath}
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
			{messageQueuePending}
			{messageQueueDirectPending}
			{messageQueueExchangePending}
			{messageQueueTtlDays}
			{exchangeMode}
			{exchangeEnabled}
			{exchangeHost}
			{exchangePort}
			{exchangeTls}
			{stunHost}
			{stunPort}
			{turnHost}
			{turnPort}
			{turnTls}
			{turnUsername}
			{turnPassword}
			{stunTestConnected}
			{turnTestConnected}
			{stunTestStatus}
			{turnTestStatus}
			{exchangeToken}
			discovery={exchangeDiscovery}
			{exchangeActive}
			{exchangeClients}
			{p2pStatus}
			linkedNodes={exchangeLinkedNodes}
			linkedNodesTotal={exchangeLinkedNodesTotal}
			linkedNodesLoading={exchangeLinkedNodesLoading}
			onSaveReactorName={saveReactorNameValue}
			onSaveHttpServerData={saveHttpPortValue}
			onOpenServerStatus={openServerStatusPage}
			onGenerateTlsCert={generateTlsCertHandler}
			onDeleteTlsCert={deleteTlsCertHandler}
			onGenerateExchangeToken={generateExchangeTokenHandler}
			onSaveExchangeConfig={saveExchangeConfigValue}
			onSaveStunConfig={saveStunConfigHandler}
			onSaveTurnConfig={saveTurnConfigHandler}
			onRefreshLinkedNodes={() => refreshExchangeLinkedNodes(false)}
			onExportBackup={exportBackupHandler}
			onImportBackup={importBackupHandler}
			onStopBackgroundProcess={stopBackgroundProcessHandler}
			onSaveMessageQueueTtlDays={saveMessageQueueTtlDaysHandler}
			onFlushMessageQueue={flushMessageQueueHandler}
			onClearMessageQueue={clearMessageQueueHandler}
			onCopyText={(text) => copyTextToClipboard(text)}
		/>
	</Modal>

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
