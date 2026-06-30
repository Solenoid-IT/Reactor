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
		requestRemoteScriptsP2P,
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
	let exchangeStatus = { state: 'disconnected', connected: false, authenticated: false, reason: '', mode: 'node' };
	let exchangeClients = [];
	let exchangeLinkedNodes = [];
	let exchangeLinkedNodesTotal = 0;
	let exchangeLinkedNodesLoading = false;
	let exchangeConfigSaving = false;
	let p2pStatus = {
		enabled: false,
		signalingViaExchange: true,
		connectedToExchange: false,
		dataChannelSupported: false,
		dataChannelSessions: 0,
		sessions: [],
		remotePeers: [],
		iceServersConfigured: false,
		iceServers: [],
	};
	let networkViewOpen = false;
	let networkSelectedNode = '';
	let networkNodeScripts = {};
	let networkRequestInFlight = '';
	let networkRequestError = '';
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

	$: networkPeerNames = (() => {
		const localName = String(reactorName || '').trim().toLowerCase();
		const peers = new Set();

		for (const node of Array.isArray(exchangeLinkedNodes) ? exchangeLinkedNodes : []) {
			const name = String(node?.name || '').trim().toLowerCase();
			if (!name || (localName && name === localName)) {
				continue;
			}
			peers.add(name);
		}

		for (const peer of Array.isArray(p2pStatus?.remotePeers) ? p2pStatus.remotePeers : []) {
			const name = String(peer || '').trim().toLowerCase();
			if (!name || (localName && name === localName)) {
				continue;
			}
			peers.add(name);
		}

		for (const session of Array.isArray(p2pStatus?.sessions) ? p2pStatus.sessions : []) {
			const name = String(session?.target || '').trim().toLowerCase();
			if (!name || (localName && name === localName)) {
				continue;
			}
			peers.add(name);
		}

		return Array.from(peers.values()).sort((a, b) => a.localeCompare(b));
	})();

	$: networkNodes = networkPeerNames.map((peerName) => {
		const linkedNode = Array.isArray(exchangeLinkedNodes)
			? exchangeLinkedNodes.find((node) => String(node?.name || '').trim().toLowerCase() === peerName)
			: null;
		const session = Array.isArray(p2pStatus?.sessions)
			? p2pStatus.sessions.find((item) => String(item?.target || '').trim().toLowerCase() === peerName)
			: null;
		const scriptsEntry = networkNodeScripts[peerName] || null;
		const stateInfo = buildNetworkStateInfo(session);

		return {
			name: peerName,
			linkedNode,
			session,
			scriptsEntry,
			stateInfo,
		};
	});

	$: selectedNetworkNodeData = networkSelectedNode
		? networkNodes.find((node) => node.name === networkSelectedNode) || null
		: null;

	$: selectedNetworkScripts = selectedNetworkNodeData?.scriptsEntry?.scripts && Array.isArray(selectedNetworkNodeData.scriptsEntry.scripts)
		? selectedNetworkNodeData.scriptsEntry.scripts
		: networkNodeScriptsFallback(networkSelectedNode);

	$: selectedNetworkScriptsSource = selectedNetworkNodeData?.scriptsEntry?.source || (selectedNetworkScripts.length > 0 ? 'discovery' : 'none');

	$: exchangeIndicator = (() => {
		const state = String(exchangeStatus?.state || '').trim().toLowerCase();
		if (state === 'connected' || state === 'active') {
			return {
				level: 'green',
				label: 'EXCHANGE active',
				title: exchangeStatus?.mode === 'exchange' ? 'EXCHANGE server active' : 'Connected to EXCHANGE',
			};
		}

		if (state === 'connecting') {
			return {
				level: 'yellow',
				label: 'EXCHANGE connecting',
				title: exchangeStatus?.reason || 'Waiting for EXCHANGE connection to be established',
			};
		}

		if (!exchangeEnabled) {
			return {
				level: 'red',
				label: 'EXCHANGE inactive',
				title: 'EXCHANGE is not configured',
			};
		}

		return {
			level: 'red',
			label: 'EXCHANGE inactive',
			title: exchangeStatus?.reason || 'EXCHANGE connection lost or unavailable',
		};
	})();

	$: p2pConnectionStatus = (() => {
		const sessions = Array.isArray(p2pStatus?.sessions) ? p2pStatus.sessions : [];
		const connectedSession = sessions.find((session) => {
			const state = String(session?.state || '').trim().toLowerCase();
			return state === 'connected-p2p' || state === 'connected-turn';
		});
		const negotiatingSession = sessions.find((session) => {
			const state = String(session?.state || '').trim().toLowerCase();
			return state === 'signaling' || state === 'connecting';
		});

		if (connectedSession) {
			return {
				level: 'green',
				label: 'P2P active',
				title: `P2P connected to ${connectedSession.target || 'a peer'}`,
			};
		}

		if (negotiatingSession || (Array.isArray(p2pStatus?.remotePeers) && p2pStatus.remotePeers.length > 0)) {
			return {
				level: 'yellow',
				label: 'P2P negotiating',
				title: 'P2P negotiation is in progress',
			};
		}

		return {
			level: 'red',
			label: p2pStatus?.dataChannelSupported ? 'P2P inactive' : 'P2P unavailable',
			title: p2pStatus?.dataChannelSupported ? 'No active P2P session' : 'P2P transport is unavailable',
		};
	})();

	function applyP2PStatusResult(result) {
		if (result?.ok && result?.p2p) {
			const nextP2P = result.p2p;
			p2pStatus = {
				enabled: Boolean(nextP2P.enabled),
				signalingViaExchange: Boolean(nextP2P.signalingViaExchange ?? true),
				connectedToExchange: Boolean(nextP2P.connectedToExchange),
				dataChannelSupported: Boolean(nextP2P.dataChannelSupported),
				dataChannelSessions: Number(nextP2P.dataChannelSessions || 0),
				sessions: Array.isArray(nextP2P.sessions) ? nextP2P.sessions : [],
				remotePeers: Array.isArray(nextP2P.remotePeers) ? nextP2P.remotePeers : [],
				iceServersConfigured: Boolean(nextP2P.iceServersConfigured),
				iceServers: Array.isArray(nextP2P.iceServers) ? nextP2P.iceServers : [],
			};
			return;
		}

		p2pStatus = {
			enabled: false,
			signalingViaExchange: true,
			connectedToExchange: false,
			dataChannelSupported: false,
			dataChannelSessions: 0,
			sessions: [],
			remotePeers: [],
			iceServersConfigured: false,
			iceServers: [],
		};
	}

	function applyExchangeConfigResult(result) {
		if (result?.ok && result?.config) {
			const ec = result.config;
			exchangeMode = ec.mode || 'node';
			exchangeHost = ec.host || '';
			exchangePort = Number(ec.port) || 7070;
			exchangeTls = Boolean(ec.tls);
			exchangeToken = ec.token || '';
			exchangeDiscovery = Boolean(ec.discovery ?? ec.exposeDiscoveryEndpoint);
			exchangeActive = Boolean(ec.active || ec.connection?.connected);
			exchangeClients = Array.isArray(ec.connectedClients) ? ec.connectedClients : [];
			exchangeEnabled = Boolean((ec.host || '').trim());
			exchangeStatus = ec.connection && typeof ec.connection === 'object'
				? ec.connection
				: {
					state: ec.mode === 'node' && Boolean((ec.host || '').trim()) ? 'connecting' : (ec.active ? 'connected' : 'disconnected'),
					connected: Boolean(ec.active),
					authenticated: Boolean(ec.active),
					reason: ec.active ? '' : (ec.mode === 'node' && Boolean((ec.host || '').trim()) ? 'Connecting to Exchange' : 'Exchange connection unavailable'),
					mode: ec.mode || 'node',
				};
			return;
		}

		exchangeActive = false;
		exchangeStatus = { state: 'disconnected', connected: false, authenticated: false, reason: 'Exchange connection unavailable', mode: 'node' };
	}

	function applyRuntimeStatusSnapshot(snapshot) {
		if (!snapshot || typeof snapshot !== 'object') {
			return;
		}

		if (snapshot.exchangeConfig) {
			applyExchangeConfigResult({ ok: true, config: snapshot.exchangeConfig });
			if (snapshot.exchangeConfig.p2p) {
				applyP2PStatusResult({ ok: true, p2p: snapshot.exchangeConfig.p2p });
			}
		}
	}

	async function refreshP2PStatusOnly() {
		const result = await getP2PStatus();
		applyP2PStatusResult(result);
	}

	function normalizeNodeName(value) {
		return String(value || '').trim().toLowerCase();
	}

	function networkNodeScriptsFallback(nodeName) {
		const safeName = normalizeNodeName(nodeName);
		if (!safeName) {
			return [];
		}

		const linkedNode = Array.isArray(exchangeLinkedNodes)
			? exchangeLinkedNodes.find((node) => normalizeNodeName(node?.name) === safeName)
			: null;
		return Array.isArray(linkedNode?.scripts) ? linkedNode.scripts : [];
	}

	function networkStateKeyFromSessionState(rawState) {
		const state = String(rawState || '').trim().toLowerCase();
		if (state === 'connected-p2p') {
			return 'connected';
		}
		if (state === 'connected-turn') {
			return 'relay';
		}
		if (state === 'connecting' || state === 'signaling') {
			return 'dialing';
		}
		if (state === 'fallback-exchange' || state === 'failed') {
			return 'fallback';
		}
		return 'discovered';
	}

	function networkStateLabelFromKey(key) {
		if (key === 'connected') {
			return 'Connected P2P';
		}
		if (key === 'relay') {
			return 'Connected TURN';
		}
		if (key === 'dialing') {
			return 'Dialing';
		}
		if (key === 'fallback') {
			return 'Fallback Exchange';
		}
		return 'Discovered';
	}

	function buildNetworkStateInfo(session) {
		const key = networkStateKeyFromSessionState(session?.state || '');
		return {
			key,
			label: networkStateLabelFromKey(key),
			reason: String(session?.reason || '').trim(),
		};
	}

	function networkNodeAngleStyle(index, total) {
		const safeTotal = Math.max(1, Number(total || 1));
		const radius = safeTotal <= 1 ? 0 : safeTotal <= 4 ? 130 : 170;
		const angle = ((2 * Math.PI) / safeTotal) * index - Math.PI / 2;
		const x = Math.cos(angle) * radius;
		const y = Math.sin(angle) * radius;
		return `transform: translate(${x}px, ${y}px);`;
	}

	function openNetworkView() {
		networkRequestError = '';
		networkViewOpen = true;
		if (!networkSelectedNode && networkPeerNames.length > 0) {
			networkSelectedNode = networkPeerNames[0];
		}

		refreshExchangeLinkedNodes(true).catch(() => {});
		refreshP2PStatusOnly().catch(() => {});
	}

	function closeNetworkView() {
		networkViewOpen = false;
		networkRequestInFlight = '';
		networkRequestError = '';
	}

	async function requestNetworkNodeScripts(nodeName, silent = false) {
		const safeName = normalizeNodeName(nodeName);
		if (!safeName) {
			return;
		}

		networkRequestError = '';
		networkRequestInFlight = safeName;
		try {
			const result = await requestRemoteScriptsP2P(safeName, 10000);
			if (!result?.ok) {
				throw new Error(result?.error || 'p2p scripts request failed');
			}

			networkNodeScripts = {
				...networkNodeScripts,
				[safeName]: {
					scripts: Array.isArray(result.scripts) ? result.scripts : [],
					updatedAt: new Date().toISOString(),
					error: '',
					source: 'p2p',
				},
			};

			await refreshP2PStatusOnly();
			if (!silent) {
				status = `P2P scripts loaded from ${safeName}`;
			}
		} catch (error) {
			networkNodeScripts = {
				...networkNodeScripts,
				[safeName]: {
					scripts: [],
					updatedAt: new Date().toISOString(),
					error: String(error?.message || 'unable to load scripts via p2p'),
					source: 'p2p',
				},
			};
			networkRequestError = String(error?.message || 'unable to load scripts via p2p');
			if (!silent) {
				status = `Error: ${networkRequestError}`;
			}
		} finally {
			networkRequestInFlight = '';
		}
	}

	function selectNetworkNode(nodeName) {
		const safeName = normalizeNodeName(nodeName);
		if (!safeName) {
			return;
		}
		networkSelectedNode = safeName;
		requestNetworkNodeScripts(safeName, true).catch(() => {});
	}

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
			stunHost = String(ec.stun?.host || '');
			stunPort = Number(ec.stun?.port) || 3478;
			turnHost = String(ec.turn?.host || '');
			turnPort = Number(ec.turn?.port) || 3478;
			turnTls = Boolean(ec.turn?.tls);
			turnUsername = String(ec.turn?.username || '');
			turnPassword = String(ec.turn?.password || '');
		}

		applyExchangeConfigResult(exchangeConfigResult);

		applyP2PStatusResult(p2pStatusResult);

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

	onMount(() => {
		void refreshAll();
		const unsubscribe = typeof window !== 'undefined' && window.reactor && typeof window.reactor.onRuntimeStatus === 'function'
			? window.reactor.onRuntimeStatus((snapshot) => {
				applyRuntimeStatusSnapshot(snapshot);
			})
			: null;

		return () => {
			if (typeof unsubscribe === 'function') {
				unsubscribe();
			}
		};
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
		onOpenNetworkView={openNetworkView}
		onOpenGlobalLog={openGlobalLog}
		onClearGlobalLog={clearGlobalLog}
		onCreateBlank={() => createScript('blank')}
		onCreateSchedule={() => createScript('schedule')}
		onCreateEvent={() => createScript('event')}
		onCreateWatch={() => createScript('watch')}
		exchangeStatus={exchangeIndicator}
		p2pStatus={p2pConnectionStatus}
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

	<Modal
		open={networkViewOpen}
		title="Network View"
		subtitle="Click a node to request remote scripts over P2P DataChannel"
		ariaLabel="Network topology and node scripts"
		cardClass="modal-card network-view-modal-card"
		onClose={closeNetworkView}
		showActions={false}
	>
		<div class="network-view-shell">
			<div class="network-graph-pane">
				<div class="network-state-legend">
					<span class="legend-item"><i class="legend-dot is-connected"></i>Connected P2P</span>
					<span class="legend-item"><i class="legend-dot is-relay"></i>Connected TURN</span>
					<span class="legend-item"><i class="legend-dot is-dialing"></i>Dialing</span>
					<span class="legend-item"><i class="legend-dot is-fallback"></i>Fallback</span>
					<span class="legend-item"><i class="legend-dot is-discovered"></i>Discovered</span>
				</div>
				<div class="network-graph-canvas">
					{#if networkNodes.length === 0}
						<div class="network-empty">No remote nodes available</div>
					{:else}
						<div class="network-hub">
							<div class="network-hub-icon"><i class="fa-solid fa-server"></i></div>
							<div class="network-hub-label">Exchange</div>
						</div>
						{#each networkNodes as node, index}
							<div class="network-edge is-{node.stateInfo.key}" style={networkNodeAngleStyle(index, networkNodes.length)}></div>
							<button
								type="button"
								class="network-node is-{node.stateInfo.key} {networkSelectedNode === node.name ? 'is-selected' : ''}"
								style={networkNodeAngleStyle(index, networkNodes.length)}
								on:click={() => selectNetworkNode(node.name)}
							>
								<div class="network-node-title">{node.name}</div>
								<div class="network-node-state">{node.stateInfo.label}</div>
								{#if node.stateInfo.reason}
									<div class="network-node-reason">{node.stateInfo.reason}</div>
								{/if}
							</button>
						{/each}
					{/if}
				</div>
			</div>

			<div class="network-detail-pane">
				{#if !networkSelectedNode}
					<div class="network-empty">Select a node to inspect scripts</div>
				{:else}
					<div class="network-detail-header">
						<div>
							<div class="network-detail-title">{networkSelectedNode}</div>
							<div class="network-detail-meta">
								Source: {selectedNetworkScriptsSource === 'p2p' ? 'P2P realtime' : selectedNetworkScriptsSource === 'discovery' ? 'Exchange discovery' : '-'}
							</div>
						</div>
						<button
							type="button"
							class="btn-secondary"
							disabled={networkRequestInFlight === networkSelectedNode}
							on:click={() => requestNetworkNodeScripts(networkSelectedNode)}
						>
							<i class="fa-solid fa-wifi me-1"></i>{networkRequestInFlight === networkSelectedNode ? 'Requesting...' : 'Request via P2P'}
						</button>
					</div>

					{#if networkRequestError}
						<div class="network-error">{networkRequestError}</div>
					{/if}

					{#if selectedNetworkScripts.length === 0}
						<div class="network-empty">No scripts returned for this node</div>
					{:else}
						<div class="network-script-list">
							{#each selectedNetworkScripts as script}
								<div class="network-script-item">
									<div class="network-script-name">{script.name || 'unnamed'}</div>
									<div class="network-script-meta">UUID: {script.uuid || '-'}</div>
									<div class="network-script-meta">Triggers: {Array.isArray(script.triggers) && script.triggers.length > 0 ? script.triggers.join(', ') : '-'}</div>
									<div class="network-script-meta">Enabled: {script.enabled ? 'yes' : 'no'} · Mutex: {script.mutex ? 'yes' : 'no'}</div>
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		</div>
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

	:global(.network-view-modal-card) {
		width: min(1080px, 95vw);
		max-height: 90vh;
		overflow: auto;
	}

	.network-view-shell {
		display: grid;
		grid-template-columns: 1.1fr 1fr;
		gap: 14px;
	}

	.network-state-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-bottom: 8px;
		font-size: 0.72rem;
		opacity: 0.9;
	}

	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}

	.network-graph-pane,
	.network-detail-pane {
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 12px;
		padding: 12px;
		background: rgba(17, 24, 33, 0.52);
	}

	.network-graph-canvas {
		position: relative;
		height: 420px;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}

	.network-hub {
		position: absolute;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		width: 120px;
		height: 120px;
		border-radius: 50%;
		border: 1px solid rgba(102, 176, 255, 0.4);
		background: radial-gradient(circle at 30% 30%, rgba(57, 102, 160, 0.9), rgba(24, 45, 80, 0.9));
		z-index: 3;
	}

	.network-hub-icon {
		font-size: 1.2rem;
	}

	.network-hub-label {
		font-size: 0.84rem;
		opacity: 0.86;
	}

	.network-edge {
		position: absolute;
		width: 2px;
		height: 120px;
		background: linear-gradient(180deg, rgba(137, 186, 255, 0.72), rgba(137, 186, 255, 0.08));
		transform-origin: center -60px;
		z-index: 1;
	}

	.network-edge.is-connected {
		background: linear-gradient(180deg, rgba(96, 230, 154, 0.9), rgba(96, 230, 154, 0.12));
	}

	.network-edge.is-relay {
		background: linear-gradient(180deg, rgba(247, 196, 99, 0.9), rgba(247, 196, 99, 0.12));
	}

	.network-edge.is-dialing {
		background: linear-gradient(180deg, rgba(111, 183, 255, 0.95), rgba(111, 183, 255, 0.1));
	}

	.network-edge.is-fallback {
		background: linear-gradient(180deg, rgba(238, 110, 110, 0.95), rgba(238, 110, 110, 0.12));
	}

	.network-edge.is-discovered {
		background: linear-gradient(180deg, rgba(178, 190, 204, 0.8), rgba(178, 190, 204, 0.1));
	}

	.network-node {
		position: absolute;
		width: 138px;
		min-height: 70px;
		padding: 8px;
		border-radius: 12px;
		border: 1px solid rgba(123, 149, 177, 0.46);
		background: rgba(22, 30, 43, 0.95);
		color: #eef4ff;
		text-align: left;
		cursor: pointer;
		z-index: 4;
	}

	.network-node.is-selected {
		border-color: rgba(111, 231, 170, 0.9);
		box-shadow: 0 0 0 2px rgba(111, 231, 170, 0.25);
	}

	.network-node.is-connected {
		border-color: rgba(96, 230, 154, 0.75);
	}

	.network-node.is-relay {
		border-color: rgba(247, 196, 99, 0.75);
	}

	.network-node.is-dialing {
		border-color: rgba(111, 183, 255, 0.75);
	}

	.network-node.is-fallback {
		border-color: rgba(238, 110, 110, 0.78);
	}

	.network-node.is-discovered {
		border-color: rgba(178, 190, 204, 0.6);
	}

	.network-node-title {
		font-weight: 700;
		font-size: 0.82rem;
		word-break: break-word;
	}

	.network-node-state {
		margin-top: 5px;
		font-size: 0.74rem;
		opacity: 0.8;
	}

	.network-node-reason {
		margin-top: 4px;
		font-size: 0.68rem;
		opacity: 0.66;
		line-height: 1.2;
		max-height: 2.4em;
		overflow: hidden;
	}

	.legend-dot.is-connected {
		background: rgba(96, 230, 154, 1);
	}

	.legend-dot.is-relay {
		background: rgba(247, 196, 99, 1);
	}

	.legend-dot.is-dialing {
		background: rgba(111, 183, 255, 1);
	}

	.legend-dot.is-fallback {
		background: rgba(238, 110, 110, 1);
	}

	.legend-dot.is-discovered {
		background: rgba(178, 190, 204, 1);
	}

	.network-detail-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding-bottom: 8px;
		border-bottom: 1px dashed rgba(255, 255, 255, 0.14);
	}

	.network-detail-title {
		font-size: 1rem;
		font-weight: 700;
	}

	.network-detail-meta {
		font-size: 0.76rem;
		opacity: 0.78;
	}

	.network-script-list {
		margin-top: 10px;
		max-height: 340px;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.network-script-item {
		padding: 9px;
		border-radius: 10px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.02);
	}

	.network-script-name {
		font-weight: 600;
		font-size: 0.83rem;
	}

	.network-script-meta {
		font-size: 0.74rem;
		opacity: 0.75;
	}

	.network-empty {
		opacity: 0.68;
		font-size: 0.85rem;
	}

	.network-error {
		margin-top: 10px;
		padding: 8px;
		border-radius: 8px;
		background: rgba(160, 45, 45, 0.35);
		border: 1px solid rgba(239, 93, 93, 0.48);
		font-size: 0.78rem;
	}

	@media (max-width: 980px) {
		.network-view-shell {
			grid-template-columns: 1fr;
		}

		.network-graph-canvas {
			height: 360px;
		}
	}
</style>
