<script>
	import { onDestroy, onMount, tick } from 'svelte';
	import HeaderActions from '$lib/components/HeaderActions.svelte';
	import EndpointList from '$lib/components/EndpointList.svelte';
	import DetailPane from '$lib/components/DetailPane.svelte';
	import SettingsPane from '$lib/components/SettingsPane.svelte';
	import {
		buildPermissionsEntries,
		getCurrentRuntimePlatform,
		mergePermissionsEntries,
		normalizeSavedPermissionsConfig,
	} from '$lib/systemPermissions';
	import { formatUiDateTime } from '$lib/dateTime';
	import Modal from '$lib/components/Modal.svelte';
	import {
		getEndpointsInfo,
		getUiSettings,
		getPermissionsConfig,
		getEnvConfig,
		savePermissionsConfig,
		saveEnvConfig,
		requestSystemPermissions,
		openSystemPermissionSettings,
		copyTextToClipboard,
		stopBackgroundProcess,
		openEndpointsFolder,
		readEndpointContent,
		saveEndpointContent,
		runEndpointNow,
		createEndpointFile,
		renameEndpointFile,
		reorderEndpoints,
		confirmDeleteEndpoint,
		deleteEndpointFile,
		toggleEndpointDirective,
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
		requestRemoteEndpointsP2P,
		subscribeP2PStatus,
		subscribeExchangeStatus,
	} from '$lib/reactorApi';

	let endpoints = [];
	let endpointsPath = '';
	let selectedIndex = -1;
	let reactorName = '';
	let httpPort = 9063;
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
	let exchangeStatusDebounceTimer = null;
	let exchangePendingStatus = null;
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
	let networkNodeEndpoints = {};
	let networkRequestInFlight = '';
	let networkRequestError = '';
	let networkRuntimeStartedAt = '';
	let networkCurrentNodeGeo = null;
	let networkCopiedKey = '';
	let networkCopiedTimer = null;
	let tlsEnabled = false;
	let tlsSubject = '';
	let tlsNotAfter = '';
	let tlsFingerprint = '';
	let messageQueuePending = 0;
	let messageQueueDirectPending = 0;
	let messageQueueExchangePending = 0;
	let messageQueueTtlDays = 7;
	let permissionsPlatform = '';
	let permissionsConfig = {};
	let permissionsEntries = [];
	let envOpen = false;
	let envLoading = false;
	let envSaving = false;
	let envDirPath = '';
	let envDraftRows = [];
	let envRowIdCounter = 0;
	let status = 'Ready';
	let settingsOpen = false;
	let exportOptionsOpen = false;
	let backupIncludeConnections = true;
	let backupIncludeEndpoints = true;
	let backupEndpointFilter = '';
	let backupSelectedEndpointPaths = [];
	let renameOpen = false;
	let renameEndpointPath = '';
	let renameOriginalEndpointName = '';
	let renameValue = '';
	let renameInput;
	let endpointPermissionsWarningOpen = false;
	let endpointPermissionsWarningFileName = '';
	let endpointPermissionsWarningPlatform = '';
	let endpointPermissionsWarningEntries = [];
	let editorOpen = false;
	let editorFilePath = '';
	let editorFileName = '';
	let editorLanguage = 'typescript';
	let editorContent = '';
	let CodeEditorComponent = null;

	const endpointPermissionRulesByPlatform = {
		Android: [
			{
				permission: 'filesystem.manage',
				matches: (source) => /\/\/\s*@on\s+WATCH\b/i.test(String(source || '')),
			},
			{
				permission: 'system.notification',
				matches: (source) => /\bDevice\s*\.\s*notify\s*\(/i.test(String(source || '')),
			},
		],
	};

	const REMOTE_ENDPOINTS_P2P_TIMEOUT_MS = 12000;
	const DEFAULT_EXCHANGE_STATUS_DOWNGRADE_DEBOUNCE_MS = 550;
	let exchangeStatusDowngradeDebounceMs = DEFAULT_EXCHANGE_STATUS_DOWNGRADE_DEBOUNCE_MS;

	function normalizeExchangeStatusDebounceMs(value, fallback = DEFAULT_EXCHANGE_STATUS_DOWNGRADE_DEBOUNCE_MS) {
		const numeric = Number(value);
		if (!Number.isFinite(numeric) || numeric < 0) {
			return Math.max(0, Math.floor(Number(fallback) || DEFAULT_EXCHANGE_STATUS_DOWNGRADE_DEBOUNCE_MS));
		}

		return Math.floor(numeric);
	}

	function normalizeExchangeStatusPayload(connection, fallbackMode = exchangeMode || 'node') {
		const raw = connection && typeof connection === 'object' ? connection : {};
		const state = String(raw.state || '').trim().toLowerCase() || 'disconnected';
		const connectedByState = state === 'connected' || state === 'active';
		const connected = Boolean(raw.connected || connectedByState);
		return {
			...raw,
			state,
			connected,
			authenticated: raw.authenticated === undefined ? connected : Boolean(raw.authenticated),
			reason: String(raw.reason || ''),
			mode: raw.mode || fallbackMode || 'node',
		};
	}

	function commitExchangeStatus(connection, fallbackMode = exchangeMode || 'node') {
		const normalized = normalizeExchangeStatusPayload(connection, fallbackMode);
		exchangeStatus = normalized;
		exchangeActive = Boolean(normalized.connected);
	}

	function scheduleExchangeStatusUpdate(connection, fallbackMode = exchangeMode || 'node') {
		const nextStatus = normalizeExchangeStatusPayload(connection, fallbackMode);
		const currentState = String(exchangeStatus?.state || '').trim().toLowerCase();
		const currentConnected = Boolean(exchangeStatus?.connected || currentState === 'connected' || currentState === 'active');
		const nextConnected = Boolean(nextStatus.connected);
		const debounceMs = normalizeExchangeStatusDebounceMs(exchangeStatusDowngradeDebounceMs);

		if (nextConnected || !currentConnected) {
			if (exchangeStatusDebounceTimer) {
				clearTimeout(exchangeStatusDebounceTimer);
				exchangeStatusDebounceTimer = null;
			}
			exchangePendingStatus = null;
			commitExchangeStatus(nextStatus, fallbackMode);
			return;
		}

		if (debounceMs === 0) {
			if (exchangeStatusDebounceTimer) {
				clearTimeout(exchangeStatusDebounceTimer);
				exchangeStatusDebounceTimer = null;
			}
			exchangePendingStatus = null;
			commitExchangeStatus(nextStatus, fallbackMode);
			return;
		}

		exchangePendingStatus = nextStatus;
		if (exchangeStatusDebounceTimer) {
			clearTimeout(exchangeStatusDebounceTimer);
		}

		exchangeStatusDebounceTimer = setTimeout(() => {
			exchangeStatusDebounceTimer = null;
			if (!exchangePendingStatus) {
				return;
			}
			commitExchangeStatus(exchangePendingStatus, fallbackMode);
			exchangePendingStatus = null;
		}, debounceMs);
	}

	function isBridgeUnavailable(result) {
		return String(result?.error || '').toLowerCase().includes('bridge unavailable');
	}

	function createEnvRow(name = '', content = '') {
		envRowIdCounter += 1;
		return {
			id: `${Date.now()}-${envRowIdCounter}`,
			name: String(name || ''),
			content: String(content == null ? '' : content),
		};
	}

	function normalizeEnvRows(envConfig) {
		const source = envConfig && typeof envConfig === 'object' && !Array.isArray(envConfig) ? envConfig : {};
		const rows = Object.entries(source)
			.sort(([leftKey], [rightKey]) => String(leftKey || '').localeCompare(String(rightKey || '')))
			.map(([key, value]) => createEnvRow(key, value));
		return rows.length > 0 ? rows : [createEnvRow()];
	}

	function rowsToEnvConfig(rows) {
		const envConfig = {};
		for (const row of Array.isArray(rows) ? rows : []) {
			const name = String(row?.name || '').trim();
			if (!name) {
				continue;
			}
			envConfig[name] = String(row?.content == null ? '' : row.content);
		}
		return envConfig;
	}

	function addEnvRow() {
		envDraftRows = [...envDraftRows, createEnvRow()];
	}

	function removeEnvRow(index) {
		const nextRows = [...envDraftRows];
		nextRows.splice(index, 1);
		envDraftRows = nextRows.length > 0 ? nextRows : [createEnvRow()];
	}

	async function loadEnvConfig() {
		envLoading = true;
		try {
			const result = await getEnvConfig();
			if (!result?.ok) {
				status = `Error: ${result?.error || 'unable to load envs'}`;
				return;
			}

			envDirPath = String(result.path || envDirPath || '');
			envDraftRows = normalizeEnvRows(result.envs || {});
		} finally {
			envLoading = false;
		}
	}

	async function openEnvManager() {
		envOpen = true;
		await loadEnvConfig();
	}

	function closeEnvManager() {
		envOpen = false;
	}

	async function saveEnvManager() {
		envSaving = true;
		try {
			const result = await saveEnvConfig(rowsToEnvConfig(envDraftRows));
			if (!result?.ok) {
				status = `Error: ${result?.error || 'unable to save envs'}`;
				return;
			}

			envDirPath = String(result.path || envDirPath || '');
			envDraftRows = normalizeEnvRows(result.envs || rowsToEnvConfig(envDraftRows));
			status = 'Saved envs';
		} finally {
			envSaving = false;
		}
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

	$: selectedEndpoint = selectedIndex >= 0 ? endpoints[selectedIndex] : null;

	$: backupEndpointCandidates = (Array.isArray(endpoints) ? endpoints : [])
		.map((endpoint) => {
			const safePath = String(endpoint?.path || '').trim();
			if (!safePath) {
				return null;
			}

			return {
				path: safePath,
				name: endpointDisplayName(endpoint?.name, 'unknown'),
			};
		})
		.filter(Boolean)
		.sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));

	$: backupFilteredEndpointCandidates = backupEndpointCandidates.filter((entry) =>
		String(entry?.name || '').toLowerCase().includes(String(backupEndpointFilter || '').trim().toLowerCase()),
	);

	$: {
		const availablePaths = backupEndpointCandidates.map((entry) => entry.path);
		const availablePathSet = new Set(availablePaths);
		const filteredSelection = backupSelectedEndpointPaths.filter((entryPath) => availablePathSet.has(entryPath));
		if (!sameStringArray(filteredSelection, backupSelectedEndpointPaths)) {
			backupSelectedEndpointPaths = filteredSelection;
		}
	}

	$: backupSelectedCount = backupSelectedEndpointPaths.length;

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

	function normalizeNetworkEndpoint(entry) {
		const endpoint = entry && typeof entry === 'object' ? entry : {};
		const rawUuid = endpoint.uuid ?? endpoint.endpointId;
		const rawName = endpoint.name ?? endpoint.endpointName;
		const rawTriggers = Array.isArray(endpoint.triggers)
			? endpoint.triggers
			: Array.isArray(endpoint.events)
				? endpoint.events
				: [];

		const triggers = Array.from(new Set(rawTriggers.map((trigger) => String(trigger || '').trim()).filter(Boolean)));

		return {
			uuid: String(rawUuid || '').trim().toLowerCase(),
			name: endpointDisplayName(rawName, 'unknown'),
			triggers,
			enabled: Boolean(endpoint.enabled),
			mutex: Boolean(endpoint.mutex),
		};
	}

	function resolveNodeGeoValue(node) {
		if (!node || typeof node !== 'object') {
			return null;
		}

		const direct = node.geo
			?? node.location
			?? node.geoLocation
			?? node.coordinates
			?? node.coordinate
			?? node.geoCoordinates
			?? null;
		if (direct) {
			return direct;
		}

		if ((node.lat ?? node.latitude) != null && (node.lon ?? node.lng ?? node.longitude) != null) {
			return {
				lat: node.lat ?? node.latitude,
				lon: node.lon ?? node.lng ?? node.longitude,
			};
		}

		if (Array.isArray(node.coords) && node.coords.length >= 2) {
			return node.coords;
		}

		return null;
	}

	$: localDiscoveryEndpoints = (Array.isArray(endpoints) ? endpoints : [])
		.filter((endpoint) => endpoint && endpoint.endpointId)
		.map((endpoint) => normalizeNetworkEndpoint(endpoint))
		.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

	$: networkNodeNames = (() => {
		const localName = String(reactorName || '').trim().toLowerCase();
		const peers = new Set();

		if (localName) {
			peers.add(localName);
		}

		for (const node of Array.isArray(exchangeLinkedNodes) ? exchangeLinkedNodes : []) {
			const name = String(node?.name || '').trim().toLowerCase();
			if (!name) {
				continue;
			}
			peers.add(name);
		}

		for (const peer of Array.isArray(p2pStatus?.remotePeers) ? p2pStatus.remotePeers : []) {
			const name = String(peer || '').trim().toLowerCase();
			if (!name) {
				continue;
			}
			peers.add(name);
		}

		for (const session of Array.isArray(p2pStatus?.sessions) ? p2pStatus.sessions : []) {
			const name = String(session?.target || '').trim().toLowerCase();
			if (!name) {
				continue;
			}
			peers.add(name);
		}

		return Array.from(peers.values()).sort((a, b) => a.localeCompare(b));
	})();

	$: networkNodes = networkNodeNames.map((peerName) => {
		const linkedNode = Array.isArray(exchangeLinkedNodes)
			? exchangeLinkedNodes.find((node) => String(node?.name || '').trim().toLowerCase() === peerName)
			: null;
		const session = Array.isArray(p2pStatus?.sessions)
			? p2pStatus.sessions.find((item) => String(item?.target || '').trim().toLowerCase() === peerName)
			: null;
		const endpointsEntry = networkNodeEndpoints[peerName] || null;
		const isCurrent = String(reactorName || '').trim().toLowerCase() === peerName;
		const stateInfo = isCurrent ? { key: 'connected', label: 'Current Node', reason: '' } : buildNetworkStateInfo(session);
		const linkedGeoValue = resolveNodeGeoValue(linkedNode);
		const fallbackGeoValue = isCurrent && networkCurrentNodeGeo ? networkCurrentNodeGeo : null;
		const geoValue = linkedGeoValue || fallbackGeoValue;
		const parsedGeo = parseNodeGeoWgs84(geoValue);
		const geoLabel = parsedGeo
			? parsedGeo.label
			: typeof geoValue === 'string'
				? String(geoValue || '').trim() || null
				: null;

		return {
			name: peerName,
			isCurrent,
			linkedNode,
			session,
			endpointsEntry,
			stateInfo,
			connectedAt: linkedNode?.connectedAt || (isCurrent ? networkRuntimeStartedAt : null),
			ip: linkedNode?.ip || null,
			port: Number.isFinite(Number(linkedNode?.port)) ? Number(linkedNode?.port) : Number.isFinite(Number(linkedNode?.httpPort)) ? Number(linkedNode?.httpPort) : null,
			geo: geoLabel,
			geoCoordinates: parsedGeo,
			geoMapsUrl: parsedGeo ? buildGoogleMapsCoordinateUrl(parsedGeo.lat, parsedGeo.lon) : '',
		};
	});

	$: selectedNetworkNodeData = networkSelectedNode
		? networkNodes.find((node) => node.name === networkSelectedNode) || null
		: null;

	$: selectedNetworkEndpoints = (
		selectedNetworkNodeData?.endpointsEntry?.endpoints && Array.isArray(selectedNetworkNodeData.endpointsEntry.endpoints)
			? selectedNetworkNodeData.endpointsEntry.endpoints
			: networkNodeEndpointsFallback(networkSelectedNode, Boolean(selectedNetworkNodeData?.isCurrent))
	)
		.map((endpoint) => normalizeNetworkEndpoint(endpoint))
		.slice()
		.sort((a, b) => {
			const enabledA = Boolean(a?.enabled);
			const enabledB = Boolean(b?.enabled);
			if (enabledA !== enabledB) {
				return enabledA ? -1 : 1;
			}

			return String(a?.name || '').localeCompare(String(b?.name || ''));
		});

	$: selectedNetworkEndpointsSource = selectedNetworkNodeData?.endpointsEntry?.source || (selectedNetworkNodeData?.isCurrent ? 'local' : selectedNetworkEndpoints.length > 0 ? 'exchange-discovery' : 'none');

	$: networkCurrentNodeIndex = networkNodes.findIndex((node) => Boolean(node?.isCurrent));

	$: exchangeIndicator = (() => {
		const state = String(exchangeStatus?.state || '').trim().toLowerCase();
		const connectedAtRaw = String(exchangeStatus?.connectedAt || '').trim();
		const connectedAtLocal = formatUiDateTime(connectedAtRaw, '');
		const connectedSinceTitle = connectedAtLocal ? ` | Connected since (local): ${connectedAtLocal}` : '';
		if (state === 'connected' || state === 'active') {
			return {
				level: 'green',
				label: 'EXCHANGE active',
				title: `Connected to EXCHANGE${connectedSinceTitle}`,
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
		const remotePeers = Array.isArray(p2pStatus?.remotePeers) ? p2pStatus.remotePeers : [];
		const remotePeerCount = remotePeers.length;
		const connectedSessions = sessions.filter((session) => {
			const state = String(session?.state || '').trim().toLowerCase();
			return state === 'connected-p2p' || state === 'connected-turn';
		});
		const connectedSession = connectedSessions[0] || null;
		const connectedTargets = Array.from(new Set(
			connectedSessions
				.map((session) => String(session?.target || '').trim().toLowerCase())
				.filter(Boolean),
		));
		const relayTargets = Array.from(new Set(
			connectedSessions
				.filter((session) => String(session?.state || '').trim().toLowerCase() === 'connected-turn')
				.map((session) => String(session?.target || '').trim().toLowerCase())
				.filter(Boolean),
		));
		const connectedCount = connectedTargets.length;
		const relayCount = relayTargets.length;
		const negotiatingSession = sessions.find((session) => {
			const state = String(session?.state || '').trim().toLowerCase();
			return state === 'signaling' || state === 'connecting';
		});

		if (connectedSession) {
			const countSuffix = connectedCount > 0 ? ` (${connectedCount})` : '';
			const relaySuffix = relayCount > 0 ? `, RELAY ${relayCount}` : '';
			return {
				level: 'green',
				label: `P2P connected${countSuffix}${relaySuffix}`,
				title: `P2P connected nodes: ${connectedCount || 1}${relayCount > 0 ? ` (${relayCount} RELAY)` : ''}`,
			};
		}

		if (remotePeerCount === 0) {
			return {
				level: 'gray',
				label: 'P2P unavailable',
				title: 'No remote peers connected',
			};
		}

		if (negotiatingSession) {
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
			exchangeMode = 'node';
			exchangeHost = ec.host || '';
			exchangePort = Number(ec.port) || 7070;
			exchangeTls = Boolean(ec.tls);
			exchangeToken = ec.token || '';
			exchangeDiscovery = Boolean(ec.discovery ?? ec.exposeDiscoveryEndpoint);
			exchangeStatusDowngradeDebounceMs = normalizeExchangeStatusDebounceMs(
				ec.statusDebounceMs,
				exchangeStatusDowngradeDebounceMs,
			);
			exchangeClients = Array.isArray(ec.connectedClients) ? ec.connectedClients : [];
			exchangeEnabled = Boolean((ec.host || '').trim());
			const nextConnectionStatus = ec.connection && typeof ec.connection === 'object'
				? ec.connection
				: {
					state: Boolean((ec.host || '').trim()) ? 'connecting' : (ec.active ? 'connected' : 'disconnected'),
					connected: Boolean(ec.active),
					authenticated: Boolean(ec.active),
					reason: ec.active ? '' : (Boolean((ec.host || '').trim()) ? 'Connecting to Exchange' : 'Exchange connection unavailable'),
					mode: 'node',
				};
			scheduleExchangeStatusUpdate(nextConnectionStatus, 'node');
			return;
		}

		scheduleExchangeStatusUpdate({
			state: 'disconnected',
			connected: false,
			authenticated: false,
			reason: 'Exchange connection unavailable',
			mode: 'node',
		});
	}

	function formatExchangeConnectionFailure(connectionTest) {
		const reason = String(connectionTest?.reason || '').trim() || 'connection test failed';
		if (String(connectionTest?.errorType || '').trim().toLowerCase() === 'authentication') {
			return `Exchange config saved but authentication failed (${reason})`;
		}
		return `Exchange config saved but connection failed (${reason})`;
	}

	function formatRelayFailure(kind, test) {
		const safeKind = String(kind || '').trim().toUpperCase();
		const reason = String(test?.error || '').trim() || 'unreachable';
		const errorType = String(test?.errorType || '').trim().toLowerCase();
		if (errorType === 'authentication') {
			return `${safeKind} authentication failed: ${reason}`;
		}
		if (errorType === 'configuration') {
			return `${safeKind} configuration invalid: ${reason}`;
		}
		return `${safeKind} connection failed: ${reason}`;
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

	function formatNetworkDateTime(value) {
		return formatUiDateTime(value, '-');
	}

	function networkSourceLabel(source) {
		const key = String(source || '').trim().toLowerCase();
		if (key === 'p2p' || key === 'p2p-datachannel') {
			return 'P2P realtime';
		}
		if (key === 'exchange' || key === 'exchange-discovery' || key === 'discovery') {
			return 'Exchange fallback';
		}
		if (key === 'local') {
			return 'Local snapshot';
		}
		return '-';
	}

	function networkNodeEndpointsFallback(nodeName, isCurrentNode = false) {
		if (isCurrentNode) {
			return Array.isArray(localDiscoveryEndpoints) ? localDiscoveryEndpoints : [];
		}

		const safeName = normalizeNodeName(nodeName);
		if (!safeName) {
			return [];
		}

		const linkedNode = Array.isArray(exchangeLinkedNodes)
			? exchangeLinkedNodes.find((node) => normalizeNodeName(node?.name) === safeName)
			: null;
		return Array.isArray(linkedNode?.endpoints) ? linkedNode.endpoints : [];
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
			return 'Connected RELAY';
		}
		if (key === 'dialing') {
			return 'Dialing';
		}
		if (key === 'fallback') {
			return 'Fallback Exchange';
		}
		return 'Discovered';
	}

	function networkPeerLinkLabel(node) {
		const key = String(node?.stateInfo?.key || '').trim().toLowerCase();
		if (key === 'connected') {
			return 'P2P';
		}
		if (key === 'relay') {
			return 'TURN';
		}
		return '';
	}

	function buildNetworkStateInfo(session) {
		const key = networkStateKeyFromSessionState(session?.state || '');
		return {
			key,
			label: networkStateLabelFromKey(key),
			reason: String(session?.reason || '').trim(),
		};
	}

	function networkHasDirectPeering(node) {
		const key = String(node?.stateInfo?.key || '').trim().toLowerCase();
		return key === 'connected' || key === 'relay';
	}

	function networkHasActiveLinkToCurrentNode(node) {
		if (!node || node.isCurrent || networkCurrentNodeIndex < 0) {
			return false;
		}
		return networkHasDirectPeering(node);
	}

	function networkPeerEdgeStyle(localIndex, remoteIndex, total) {
		const safeTotal = Math.max(1, Number(total || 1));
		const local = networkNodeAnglePoint(localIndex, safeTotal);
		const remote = networkNodeAnglePoint(remoteIndex, safeTotal);
		const dx = remote.x - local.x;
		const dy = remote.y - local.y;
		const length = Math.sqrt((dx * dx) + (dy * dy));
		const angle = Math.atan2(dy, dx);
		const centerX = local.x + (dx / 2);
		const centerY = local.y + (dy / 2);
		return `transform: translate(${centerX}px, ${centerY}px) rotate(${angle}rad); width: ${length}px;`;
	}

	function networkPeerEdgeLabelStyle(localIndex, remoteIndex, total) {
		const safeTotal = Math.max(1, Number(total || 1));
		const local = networkNodeAnglePoint(localIndex, safeTotal);
		const remote = networkNodeAnglePoint(remoteIndex, safeTotal);
		const dx = remote.x - local.x;
		const dy = remote.y - local.y;
		const angle = Math.atan2(dy, dx);
		const labelRatio = 0.62;
		const labelX = local.x + (dx * labelRatio);
		const labelY = local.y + (dy * labelRatio);
		return `transform: translate(${labelX}px, ${labelY}px) rotate(${angle}rad);`;
	}

	function networkNodeAnglePoint(index, total) {
		const safeTotal = Math.max(1, Number(total || 1));
		const radius = safeTotal <= 1 ? 0 : safeTotal <= 4 ? 130 : 170;
		const angle = ((2 * Math.PI) / safeTotal) * index - Math.PI / 2;
		return {
			x: Math.cos(angle) * radius,
			y: Math.sin(angle) * radius,
		};
	}

	function networkNodeAngleStyle(index, total) {
		const { x, y } = networkNodeAnglePoint(index, total);
		return `transform: translate(${x}px, ${y}px);`;
	}

	async function refreshCurrentNodeGeo() {
		try {
			let coordinates = null;

			if (typeof navigator !== 'undefined' && navigator.geolocation && typeof navigator.geolocation.getCurrentPosition === 'function') {
				coordinates = await new Promise((resolve, reject) => {
					navigator.geolocation.getCurrentPosition(
						(position) => resolve(position?.coords || null),
						(error) => reject(error),
						{ enableHighAccuracy: false, maximumAge: 30000, timeout: 8000 },
					);
				});
			}

			if (!coordinates) {
				const geolocationPlugin = typeof window !== 'undefined'
					? window?.Capacitor?.Plugins?.Geolocation
					: null;
				if (geolocationPlugin && typeof geolocationPlugin.getCurrentPosition === 'function') {
					const position = await geolocationPlugin.getCurrentPosition({
						enableHighAccuracy: false,
						timeout: 8000,
						maximumAge: 30000,
					});
					coordinates = position?.coords || null;
				}
			}

			if (!coordinates) {
				return;
			}

			const parsed = normalizeWgs84Coordinates(coordinates.latitude, coordinates.longitude);
			if (!parsed) {
				return;
			}

			networkCurrentNodeGeo = {
				lat: parsed.lat,
				lon: parsed.lon,
			};
		} catch {
			// Best effort: keep previous local geo value when unavailable.
		}
	}

	function toFiniteCoordinate(value) {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) {
			return null;
		}
		return numeric;
	}

	function normalizeWgs84Coordinates(lat, lon) {
		const safeLat = toFiniteCoordinate(lat);
		const safeLon = toFiniteCoordinate(lon);
		if (safeLat === null || safeLon === null) {
			return null;
		}

		if (Math.abs(safeLat) > 90 || Math.abs(safeLon) > 180) {
			return null;
		}

		return {
			lat: safeLat,
			lon: safeLon,
			label: `${safeLat.toFixed(6)}, ${safeLon.toFixed(6)}`,
		};
	}

	function parseNodeGeoWgs84(input) {
		if (!input) {
			return null;
		}

		if (Array.isArray(input)) {
			if (input.length < 2) {
				return null;
			}

			const first = Number(input[0]);
			const second = Number(input[1]);
			const asLatLon = normalizeWgs84Coordinates(first, second);
			if (asLatLon) {
				return asLatLon;
			}

			return normalizeWgs84Coordinates(second, first);
		}

		if (typeof input === 'object') {
			const lat = input.lat ?? input.latitude;
			const lon = input.lon ?? input.lng ?? input.longitude;
			const parsed = normalizeWgs84Coordinates(lat, lon);
			if (parsed) {
				return parsed;
			}

			const nested = input.coords && typeof input.coords === 'object'
				? normalizeWgs84Coordinates(input.coords.lat ?? input.coords.latitude, input.coords.lon ?? input.coords.lng ?? input.coords.longitude)
				: null;
			return nested;
		}

		const raw = String(input || '').trim();
		if (!raw) {
			return null;
		}

		const pointMatch = raw.match(/point\s*\(\s*(-?[0-9]+(?:\.[0-9]+)?)\s+(-?[0-9]+(?:\.[0-9]+)?)\s*\)/i);
		if (pointMatch) {
			const pointLon = Number(pointMatch[1]);
			const pointLat = Number(pointMatch[2]);
			const parsed = normalizeWgs84Coordinates(pointLat, pointLon);
			if (parsed) {
				return parsed;
			}
		}

		const pairMatch = raw.match(/(-?[0-9]+(?:\.[0-9]+)?)\s*[,;\s]\s*(-?[0-9]+(?:\.[0-9]+)?)/);
		if (!pairMatch) {
			return null;
		}

		const first = Number(pairMatch[1]);
		const second = Number(pairMatch[2]);

		const asLatLon = normalizeWgs84Coordinates(first, second);
		if (asLatLon) {
			return asLatLon;
		}

		return normalizeWgs84Coordinates(second, first);
	}

	function buildGoogleMapsCoordinateUrl(lat, lon) {
		const safeLat = Number(lat).toFixed(6);
		const safeLon = Number(lon).toFixed(6);
		return `https://www.google.com/maps?q=${encodeURIComponent(`${safeLat},${safeLon}`)}`;
	}

	async function copyNetworkGeoCoordinates(nodeData) {
		const coordinates = nodeData?.geoCoordinates;
		if (!coordinates) {
			status = 'Error: node geolocation unavailable';
			return;
		}

		const payload = `${coordinates.lat.toFixed(6)}, ${coordinates.lon.toFixed(6)}`;
		const result = await copyTextWithFallback(payload, 'Copy WGS84 coordinates');
		if (result === 'none') {
			status = `WGS84 coordinates: ${payload}`;
			return;
		}

		status = `Copied WGS84 coordinates: ${payload}`;
	}

	function openNetworkView() {
		networkRequestError = '';
		networkViewOpen = true;
		if (!networkSelectedNode && networkNodeNames.length > 0) {
			networkSelectedNode = networkNodeNames[0];
		}

		refreshCurrentNodeGeo().catch(() => {});
		refreshExchangeLinkedNodes(true).catch(() => {});
		refreshP2PStatusOnly().catch(() => {});
	}

	function closeNetworkView() {
		networkViewOpen = false;
		networkRequestInFlight = '';
		networkRequestError = '';
	}

	function showNetworkCopyFeedback(copyKey) {
		networkCopiedKey = String(copyKey || '').trim();
		if (networkCopiedTimer) {
			clearTimeout(networkCopiedTimer);
		}

		networkCopiedTimer = setTimeout(() => {
			networkCopiedKey = '';
			networkCopiedTimer = null;
		}, 1500);
	}

	function networkCopyKeyFor(endpoint, field) {
		const safeField = String(field || '').trim().toLowerCase();
		const safeNode = String(networkSelectedNode || '').trim().toLowerCase();
		const safeUuid = String(endpoint?.uuid || '').trim().toLowerCase();
		const safeName = String(endpoint?.name || '').trim().toLowerCase();
		return `${safeNode}:${safeField}:${safeUuid || safeName}`;
	}

	function networkEndpointTarget(endpoint, field) {
		const safeField = String(field || '').trim().toLowerCase();
		const safeNode = String(networkSelectedNode || '').trim();
		if (!safeNode) {
			return '';
		}

		if (safeField === 'uuid') {
			const safeUuid = String(endpoint?.uuid || '').trim();
			return safeUuid ? `id:${safeUuid}@${safeNode}` : '';
		}

		const safeName = String(endpoint?.name || '').trim();
		return safeName ? `${safeName}@${safeNode}` : '';
	}

	function isNetworkEndpointCopied(endpoint, field) {
		return networkCopiedKey === networkCopyKeyFor(endpoint, field);
	}

	async function copyTextWithFallback(text, promptTitle) {
		const safeText = String(text || '').trim();
		if (!safeText) {
			return 'none';
		}

		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
				await navigator.clipboard.writeText(safeText);
				return 'clipboard';
			}
		} catch {
			// Fallback below.
		}

		try {
			const nativeCopyResult = await copyTextToClipboard(safeText);
			if (nativeCopyResult?.ok) {
				return 'native';
			}
		} catch {
			// Fallback below.
		}

		if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
			window.prompt(promptTitle || 'Copy text', safeText);
			return 'prompt';
		}

		return 'none';
	}

	async function copyNetworkEndpointField(endpoint, field) {
		const safeField = String(field || '').trim().toLowerCase();
		const value = networkEndpointTarget(endpoint, safeField);
		if (!value) {
			status = `Error: endpoint ${safeField || 'value'} target unavailable`;
			return;
		}

		const result = await copyTextWithFallback(value, `Copy endpoint ${safeField || 'value'} target`);
		if (result === 'none') {
			status = `Endpoint ${safeField || 'value'} target: ${value}`;
			return;
		}

		showNetworkCopyFeedback(networkCopyKeyFor(endpoint, safeField));
		status = `Copied endpoint ${safeField || 'value'} target: ${value}`;
	}

	async function requestNetworkNodeEndpoints(nodeName, silent = false) {
		const safeName = normalizeNodeName(nodeName);
		if (!safeName) {
			return;
		}

		if (safeName === normalizeNodeName(reactorName)) {
			networkNodeEndpoints = {
				...networkNodeEndpoints,
				[safeName]: {
					endpoints: Array.isArray(localDiscoveryEndpoints) ? localDiscoveryEndpoints : [],
					updatedAt: new Date().toISOString(),
					error: '',
					source: 'local',
				},
			};
			return;
		}

		networkRequestError = '';
		networkRequestInFlight = safeName;
		try {
			const result = await requestRemoteEndpointsP2P(safeName, REMOTE_ENDPOINTS_P2P_TIMEOUT_MS);
			if (!result?.ok) {
				throw new Error(result?.error || 'p2p endpoints request failed');
			}

			const endpointsPayload = Array.isArray(result.endpoints) ? result.endpoints : [];
			const source = String(result.source || result.via || '').trim().toLowerCase();
			const normalizedSource = source.includes('exchange') ? 'exchange-discovery' : 'p2p-datachannel';

			networkNodeEndpoints = {
				...networkNodeEndpoints,
				[safeName]: {
					endpoints: endpointsPayload,
					updatedAt: new Date().toISOString(),
					error: '',
					source: normalizedSource,
				},
			};

			await refreshP2PStatusOnly();
			if (!silent) {
				status = normalizedSource === 'exchange-discovery'
					? `Exchange fallback endpoints loaded from ${safeName}`
					: `P2P endpoints loaded from ${safeName}`;
			}
		} catch (error) {
			networkNodeEndpoints = {
				...networkNodeEndpoints,
				[safeName]: {
					endpoints: [],
					updatedAt: new Date().toISOString(),
					error: String(error?.message || 'unable to load endpoints via p2p'),
					source: 'p2p',
				},
			};
			networkRequestError = String(error?.message || 'unable to load endpoints via p2p');
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
		if (safeName === normalizeNodeName(reactorName)) {
			requestNetworkNodeEndpoints(safeName, true).catch(() => {});
			return;
		}
		requestNetworkNodeEndpoints(safeName, true).catch(() => {});
	}

	function applyPermissionsConfigResult(result) {
		const nextPlatform = String(result?.platform || permissionsPlatform || getCurrentRuntimePlatform()).trim() || getCurrentRuntimePlatform();
		permissionsPlatform = nextPlatform;
		permissionsConfig = normalizeSavedPermissionsConfig(result?.permissions);
		permissionsEntries = buildPermissionsEntries(permissionsConfig, permissionsPlatform);
	}

	function buildPermissionDeniedMessage(permissionName) {
		const safePermissionName = String(permissionName || '').trim();
		if (safePermissionName.toLowerCase() === 'system.geolocation') {
			return 'Permission denied: system.geolocation. Location remains unavailable until you enable it from this checkbox and allow all the time in Android app settings.';
		}

		return `Permission denied: ${safePermissionName}`;
	}

	async function persistPermissionsEntries(nextEntries, successMessage) {
		const nextConfig = mergePermissionsEntries(permissionsConfig, permissionsPlatform, nextEntries);
		const result = await savePermissionsConfig(nextConfig);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to save permissions'}`;
			return false;
		}

		applyPermissionsConfigResult(result);
		if (successMessage) {
			status = successMessage;
		}
		return true;
	}

	async function requestCheckedPermissionsForCurrentPlatform() {
		const enabledPermissions = permissionsEntries.filter((entry) => entry?.checked).map((entry) => entry.name);
		if (enabledPermissions.length === 0) {
			return { ok: true, granted: [], denied: [] };
		}

		const result = await requestSystemPermissions(enabledPermissions);
		if (!result?.ok) {
			return result;
		}

		const grantedSet = new Set(Array.isArray(result.granted) ? result.granted.map((item) => String(item || '').trim()) : []);
		const deniedSet = new Set(Array.isArray(result.denied) ? result.denied.map((item) => String(item || '').trim()) : []);
		const nextEntries = permissionsEntries.map((entry) => ({
			...entry,
			checked: deniedSet.has(entry.name) ? false : grantedSet.size > 0 ? grantedSet.has(entry.name) : Boolean(entry.checked),
		}));

		await persistPermissionsEntries(
			nextEntries,
			deniedSet.size > 0
				? `Backup imported: ${grantedSet.size} permissions granted, ${deniedSet.size} denied`
				: `Backup imported: ${grantedSet.size || enabledPermissions.length} permissions granted`,
		);
		return result;
	}

	async function togglePermissionHandler(permissionName, checked) {
		const safePermissionName = String(permissionName || '').trim();
		if (!safePermissionName) {
			return;
		}

		const effectivePermissionsPlatform = String(permissionsPlatform || getCurrentRuntimePlatform()).trim().toLowerCase();
		if (effectivePermissionsPlatform === 'android') {
			const settingsResult = await openSystemPermissionSettings([safePermissionName]);
			if (!settingsResult?.ok) {
				status = `Error: ${settingsResult?.error || 'unable to open Android system settings'}`;
				return;
			}
		}

		let nextEntries = permissionsEntries.map((entry) =>
			entry.name === safePermissionName
				? { ...entry, checked: Boolean(checked) }
				: entry,
		);

		if (checked) {
			status = `Requesting permission: ${safePermissionName}`;
			const result = await requestSystemPermissions([safePermissionName]);
			if (!result?.ok) {
				status = `Error: ${result?.error || 'permission request failed'}`;
				return;
			}

			const grantedSet = new Set(Array.isArray(result.granted) ? result.granted.map((item) => String(item || '').trim()) : []);
			const deniedSet = new Set(Array.isArray(result.denied) ? result.denied.map((item) => String(item || '').trim()) : []);
			const isGranted = deniedSet.has(safePermissionName) ? false : grantedSet.size === 0 || grantedSet.has(safePermissionName);
			nextEntries = permissionsEntries.map((entry) =>
				entry.name === safePermissionName
					? { ...entry, checked: isGranted }
					: entry,
			);
			await persistPermissionsEntries(nextEntries, isGranted ? `Permission enabled: ${safePermissionName}` : buildPermissionDeniedMessage(safePermissionName));
			return;
		}

		await persistPermissionsEntries(nextEntries, `Permission disabled: ${safePermissionName}`);
	}

	async function openSystemPermissionSettingsHandler(permissionNames = []) {
		const result = await openSystemPermissionSettings(permissionNames);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to open system permission settings'}`;
			return;
		}

		status = 'System permission settings opened';
	}

	async function refreshAll() {
		try {
			const [info, settings, permissionsConfigResult, serverConfig, currentReactorName, exchangeConfigResult, p2pStatusResult, exchangeTokenResult, tlsConfigResult, queueStatusResult] = await Promise.all([
				getEndpointsInfo(),
				getUiSettings(),
				getPermissionsConfig(),
				getHttpServerConfig(),
				getReactorName(),
				getExchangeConfig(),
				getP2PStatus(),
				getExchangeToken(),
				getTlsConfig(),
				getMessageQueueStatus(),
			]);

			if (info?.ok === false) {
				status = `Error endpoints list: ${info?.error || 'unknown'}`;
			}

			endpoints = Array.isArray(info?.endpoints) ? info.endpoints : [];
			endpointsPath = info?.path || '';
			httpPort = Number(serverConfig?.config?.port || settings?.httpServerPort || 9063);
			reactorName = String(currentReactorName?.name || '');
			applyPermissionsConfigResult(permissionsConfigResult);

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

			if (selectedIndex >= endpoints.length) {
				selectedIndex = -1;
			}

			const canLoadLinkedNodes = exchangeEnabled && exchangeActive;
			if (canLoadLinkedNodes) {
				await refreshExchangeLinkedNodes(true);
			} else {
				exchangeLinkedNodes = [];
				exchangeLinkedNodesTotal = 0;
			}

			status = 'Data refreshed';
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error || 'unknown error');
			status = `Error refreshing UI: ${message}`;
		}
	}

	async function reorderEndpointItems(fromIndex, toIndex) {
		if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
			return;
		}
		if (fromIndex < 0 || toIndex < 0 || fromIndex >= endpoints.length || toIndex >= endpoints.length) {
			return;
		}
		if (fromIndex === toIndex) {
			return;
		}

		const ordered = Array.isArray(endpoints) ? [...endpoints] : [];
		const [moved] = ordered.splice(fromIndex, 1);
		ordered.splice(toIndex, 0, moved);

		const selectedPath = selectedIndex >= 0 && endpoints[selectedIndex]
			? String(endpoints[selectedIndex].path || '')
			: '';

		endpoints = ordered;
		if (selectedPath) {
			selectedIndex = endpoints.findIndex((endpoint) => String(endpoint?.path || '') === selectedPath);
		}

		const result = await reorderEndpoints(ordered.map((endpoint) => String(endpoint?.path || '')).filter(Boolean));
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to reorder endpoints'}`;
			await refreshAll();
			if (selectedPath) {
				selectedIndex = endpoints.findIndex((endpoint) => String(endpoint?.path || '') === selectedPath);
			}
			return;
		}

		await refreshAll();
		if (selectedPath) {
			selectedIndex = endpoints.findIndex((endpoint) => String(endpoint?.path || '') === selectedPath);
		}
		status = 'Endpoints reordered';
	}

	async function refreshExchangeLinkedNodes(silent = false) {
		if (!exchangeEnabled) {
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
			networkRuntimeStartedAt = String(result.runtimeStartedAt || networkRuntimeStartedAt || '').trim();
			if (!silent) {
				status = `Linked nodes refreshed (${exchangeLinkedNodesTotal})`;
			}
		} finally {
			exchangeLinkedNodesLoading = false;
		}
	}

	async function createEndpoint(templateKey) {
		let endpointName = '';
		const isMobileRuntime =
			typeof window !== 'undefined' &&
			Boolean(window.Capacitor) &&
			typeof window.prompt === 'function';

		if (isMobileRuntime) {
			try {
				const suggestedName = `new-${templateKey}-endpoint`;
				const enteredName = window.prompt('Endpoint name', suggestedName);
				if (enteredName === null) {
					status = 'Create endpoint cancelled';
					return;
				}
				endpointName = String(enteredName || '').trim();
				if (!endpointName) {
					status = 'Error: invalid endpoint name';
					return;
				}
			} catch {
				// Defensive fallback for environments where prompt exists but is blocked.
				endpointName = '';
			}
		}

		const result = await createEndpointFile(templateKey, endpointName);
		if (isBridgeUnavailable(result)) {
			status = 'Create endpoint unavailable on mobile: native bridge unavailable';
			if (typeof window !== 'undefined' && typeof window.alert === 'function') {
				window.alert('Create endpoint unavailable on mobile: Capacitor native bridge is unavailable for createEndpointFile.');
			}
			return;
		}

		if (!result?.ok) {
			status = `Error: ${result?.error || 'unknown'}`;
			await refreshAll();
			return;
		}

		await refreshAll();

		if (result?.path) {
			const createdIndex = endpoints.findIndex((endpoint) => endpoint?.path === result.path);
			if (createdIndex >= 0) {
				selectedIndex = createdIndex;
				await editEndpoint(createdIndex);
				return;
			}

			const openedFromPath = await openEndpointInEditorByPath(result.path, result?.name || endpointName || 'boot.ts');
			if (openedFromPath) {
				return;
			}
		}

		status = `Endpoint created (${endpointName || templateKey})`;
	}

	function fileNameFromPath(filePath) {
		const normalized = String(filePath || '').replace(/\\/g, '/');
		const segments = normalized.split('/').filter(Boolean);
		return segments.length > 0 ? segments[segments.length - 1] : 'boot.ts';
	}

	async function openEndpointInEditorByPath(filePath, fallbackName = '') {
		const safePath = String(filePath || '').trim();
		if (!safePath) {
			return false;
		}

		status = `Loading editor: ${endpointDisplayName(fileNameFromPath(safePath), 'boot')}`;
		const ready = await ensureCodeEditorComponent();
		if (!ready) {
			return false;
		}

		const result = await readEndpointContent(safePath);
		if (!result?.ok) {
			status = `Endpoint created but editor open failed: ${result?.error || 'unable to load endpoint'}`;
			return false;
		}

		editorFilePath = safePath;
		editorFileName = endpointDisplayName(fallbackName || fileNameFromPath(safePath), 'boot');
		editorLanguage = 'typescript';
		editorContent = result.content || '';
		editorOpen = true;
		status = `Editing: ${editorFileName}`;
		return true;
	}

	async function editEndpoint(index) {
		const endpoint = endpoints[index];
		if (!endpoint) {
			return;
		}

		status = `Loading editor: ${endpointDisplayName(endpoint.name, 'endpoint')}`;
		const ready = await ensureCodeEditorComponent();
		if (!ready) {
			return;
		}

		const result = await readEndpointContent(endpoint.path);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to load endpoint'}`;
			return;
		}

		editorFilePath = endpoint.path;
		editorFileName = endpointDisplayName(endpoint.name, 'endpoint');
		editorLanguage = 'typescript';
		editorContent = result.content || '';
		editorOpen = true;
		status = `Editing: ${endpointDisplayName(endpoint.name, 'endpoint')}`;
	}

	function closeCodeEditor() {
		editorOpen = false;
	}

	function closeEndpointPermissionsWarning() {
		endpointPermissionsWarningOpen = false;
		endpointPermissionsWarningFileName = '';
		endpointPermissionsWarningPlatform = '';
		endpointPermissionsWarningEntries = [];
	}

	function isEndpointBootFile(filePath, fileName) {
		const normalizedPath = String(filePath || '').replace(/\\/g, '/').toLowerCase();
		const normalizedName = String(fileName || '').trim().toLowerCase();
		return normalizedName === 'boot.ts' || normalizedName === 'boot.js' || normalizedPath.endsWith('/boot.ts') || normalizedPath.endsWith('/boot.js');
	}

	function collectRequiredPermissionsFromSource(source, platformName) {
		const safePlatform = String(platformName || '').trim();
		const rules = Array.isArray(endpointPermissionRulesByPlatform[safePlatform])
			? endpointPermissionRulesByPlatform[safePlatform]
			: [];
		if (rules.length === 0) {
			return [];
		}

		const required = new Set();
		for (const rule of rules) {
			if (!rule || typeof rule.matches !== 'function') {
				continue;
			}
			if (rule.matches(source)) {
				required.add(String(rule.permission || '').trim());
			}
		}

		return Array.from(required).filter(Boolean);
	}

	async function saveCodeEditor(nextContent) {
		const result = await saveEndpointContent(editorFilePath, nextContent);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to save endpoint'}`;
			return;
		}

		editorContent = nextContent;
		status = `Saved: ${editorFileName}`;

		if (editorLanguage === 'typescript' && isEndpointBootFile(editorFilePath, editorFileName)) {
			const permissionsResult = await getPermissionsConfig();
			if (permissionsResult?.ok) {
				applyPermissionsConfigResult(permissionsResult);
			}

			const runtimePlatform = String((permissionsResult?.platform || permissionsPlatform || getCurrentRuntimePlatform()) || '').trim();
			const requiredPermissions = collectRequiredPermissionsFromSource(nextContent, runtimePlatform);
			if (requiredPermissions.length > 0) {
				const checkedMap = new Map((permissionsEntries || []).map((entry) => [String(entry?.name || '').trim(), Boolean(entry?.checked)]));
				const warningEntries = requiredPermissions.map((permissionName) => {
					const safeName = String(permissionName || '').trim();
					return {
						name: safeName,
						granted: Boolean(checkedMap.get(safeName)),
					};
				});
				const missingEntries = warningEntries.filter((entry) => !entry.granted);
				if (missingEntries.length > 0) {
					endpointPermissionsWarningFileName = endpointDisplayName(editorFileName || fileNameFromPath(editorFilePath), 'boot');
					endpointPermissionsWarningPlatform = runtimePlatform;
					endpointPermissionsWarningEntries = warningEntries;
					endpointPermissionsWarningOpen = true;
					status = `Saved: ${editorFileName} (permissions required)`;
				}
			}
		}

		await refreshAll();
	}

	async function renameEndpoint(index) {
		const endpoint = endpoints[index];
		if (!endpoint) {
			return;
		}

		renameEndpointPath = endpoint.path;
		renameOriginalEndpointName = endpointDisplayName(endpoint.name, 'endpoint');
		renameValue = endpoint.name.replace(/\.(ts|js)$/i, '');
		renameOpen = true;

		await tick();
		if (renameInput && typeof renameInput.focus === 'function') {
			renameInput.focus();
			renameInput.select();
		}
	}

	function closeRenameDialog() {
		renameOpen = false;
		renameEndpointPath = '';
		renameOriginalEndpointName = '';
		renameValue = '';
	}

	async function confirmRenameDialog() {
		const nextName = String(renameValue || '').trim();
		if (!nextName) {
			status = 'Error: invalid endpoint name';
			return;
		}

		const result = await renameEndpointFile(renameEndpointPath, nextName);
		status = result?.ok ? `Endpoint renamed: ${nextName}` : `Error: ${result?.error || 'unknown'}`;
		if (result?.ok) {
			closeRenameDialog();
			await refreshAll();
		}
	}

	async function deleteEndpoint(index) {
		const endpoint = endpoints[index];
		if (!endpoint) {
			return;
		}
		const confirmResult = await confirmDeleteEndpoint(endpointDisplayName(endpoint.name, 'endpoint'));
		if (!confirmResult?.confirmed) {
			return;
		}
		const result = await deleteEndpointFile(endpoint.path);
		status = result?.ok ? `Endpoint deleted: ${endpointDisplayName(endpoint.name, 'endpoint')}` : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function toggleDirective(index, directive) {
		const endpoint = endpoints[index];
		if (!endpoint) {
			return;
		}
		const result = await toggleEndpointDirective(endpoint.path, directive);
		status = result?.ok ? `Updated ${directive} on ${endpointDisplayName(endpoint.name, 'endpoint')}` : `Error: ${result?.error || 'unknown'}`;
		await refreshAll();
	}

	async function runNow(index) {
		const endpoint = endpoints[index];
		if (!endpoint) {
			return;
		}
		const result = await runEndpointNow(endpoint.path);
		status = result?.ok ? `Test started: ${endpointDisplayName(endpoint.name, 'endpoint')}` : `Error: ${result?.error || 'unknown'}`;
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

	async function saveExchangeConfigValue(host, port, tls, token, enabled = true, discovery = false, stun = {}, turn = {}) {
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
		const effectiveHost = !safeEnabled ? '' : host || '';
		const safeStun = sanitizeRelay(stun);
		const safeTurn = sanitizeRelay(turn);
		const result = await setExchangeConfig('node', effectiveHost, numericPort, Boolean(tls), token || '', safeDiscovery, safeStun, safeTurn);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unknown'}`;
			await refreshAll();
			return;
		}

		const connectionTest = result?.connectionTest || null;
		if (!safeEnabled) {
			status = 'Exchange client disabled for node mode';
		} else if (connectionTest) {
			status = connectionTest.connected
				? `Exchange config saved and connected (${Boolean(tls) ? 'WSS' : 'WS'})`
				: formatExchangeConnectionFailure(connectionTest);
		} else {
			status = `Exchange config saved${Boolean(tls) ? ' (TLS)' : ''}`;
		}

		await refreshAll();

		if (safeEnabled && connectionTest?.connected) {
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
			stunTestStatus = formatRelayFailure('STUN', test);
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
			status = 'TURN saved and authenticated';
		} else {
			turnTestStatus = formatRelayFailure('TURN', test);
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

	async function exportBackupHandler(options = {}) {
		status = 'Exporting backup ZIP...';
		const result = await exportBackup(options);
		if (result?.canceled) {
			status = 'Backup export cancelled';
			return;
		}
		status = result?.ok ? `Backup exported: ${result.path || 'ZIP created'}` : `Error: ${result?.error || 'unknown'}`;
	}

	function sameStringArray(left, right) {
		if (left === right) {
			return true;
		}

		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
			return false;
		}

		for (let index = 0; index < left.length; index += 1) {
			if (String(left[index]) !== String(right[index])) {
				return false;
			}
		}

		return true;
	}

	function openExportOptionsModal() {
		if (backupSelectedEndpointPaths.length === 0) {
			backupSelectedEndpointPaths = backupEndpointCandidates.map((entry) => entry.path);
		}
		exportOptionsOpen = true;
	}

	function closeExportOptionsModal() {
		exportOptionsOpen = false;
	}

	function toggleBackupEndpointSelection(endpointPath, enabled) {
		const safePath = String(endpointPath || '').trim();
		if (!safePath) {
			return;
		}

		if (enabled) {
			if (!backupSelectedEndpointPaths.includes(safePath)) {
				backupSelectedEndpointPaths = [...backupSelectedEndpointPaths, safePath];
			}
			return;
		}

		backupSelectedEndpointPaths = backupSelectedEndpointPaths.filter((entryPath) => entryPath !== safePath);
	}

	function selectAllFilteredEndpoints() {
		const filteredPaths = backupFilteredEndpointCandidates.map((entry) => entry.path);
		const next = new Set(backupSelectedEndpointPaths);
		for (const endpointPath of filteredPaths) {
			next.add(endpointPath);
		}
		backupSelectedEndpointPaths = Array.from(next.values());
	}

	function deselectAllFilteredEndpoints() {
		const filteredPathSet = new Set(backupFilteredEndpointCandidates.map((entry) => entry.path));
		backupSelectedEndpointPaths = backupSelectedEndpointPaths.filter((entryPath) => !filteredPathSet.has(entryPath));
	}

	async function confirmExportBackupFromModal() {
		await exportBackupHandler({
			includeConnections: backupIncludeConnections,
			includeEndpoints: backupIncludeEndpoints,
			endpointSelectionProvided: backupIncludeEndpoints,
			endpointPaths: backupIncludeEndpoints ? backupSelectedEndpointPaths : [],
		});
		closeExportOptionsModal();
	}

	async function importBackupHandler() {
		const confirm = window.confirm('Import backup and overwrite current endpoints/configuration?');
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
		const permissionRequestResult = await requestCheckedPermissionsForCurrentPlatform();
		if (!permissionRequestResult?.ok) {
			status = `Backup imported, but permission sync failed: ${permissionRequestResult?.error || 'unknown'}`;
		}
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

	async function copyEndpointId(index) {
		const endpoint = endpoints[index];
		const endpointId = String(endpoint?.endpointId || '').trim();
		if (!endpoint || !endpointId) {
			status = 'Error: endpoint ID unavailable';
			return;
		}

		const copyResult = await copyTextWithFallback(endpointId, `Copy endpoint ID for ${endpointDisplayName(endpoint.name, 'endpoint')}`);
		if (copyResult === 'none') {
			status = `Endpoint ID: ${endpointId}`;
			return;
		}

		status = `Copied ID: ${endpointDisplayName(endpoint.name, 'endpoint')}`;
	}

	onDestroy(() => {
		if (networkCopiedTimer) {
			clearTimeout(networkCopiedTimer);
		}
		if (exchangeStatusDebounceTimer) {
			clearTimeout(exchangeStatusDebounceTimer);
			exchangeStatusDebounceTimer = null;
		}
		exchangePendingStatus = null;
	});

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
		const endpoint = endpoints[index];
		if (!endpoint) {
			return;
		}

		status = `Loading log: ${endpointDisplayName(endpoint.name, 'endpoint')}`;
		const ready = await ensureCodeEditorComponent();
		if (!ready) {
			return;
		}

		const logPathResult = await openEventLog(endpoint.path);
		if (!logPathResult?.ok || !logPathResult?.path) {
			status = `Error: ${logPathResult?.error || 'activity.log path unavailable'}`;
			return;
		}

		const result = await readEndpointContent(logPathResult.path);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to load activity.log'}`;
			return;
		}

		editorFilePath = logPathResult.path;
		editorFileName = `${endpointDisplayName(endpoint.name, 'endpoint')} / activity.log`;
		editorLanguage = 'log';
		editorContent = result.content || '';
		editorOpen = true;
		status = `Editing log: ${endpointDisplayName(endpoint.name, 'endpoint')}`;
	}

	async function clearLog(index) {
		const endpoint = endpoints[index];
		if (!endpoint) {
			return;
		}
		const result = await clearEventLog(endpoint.path);
		status = result?.ok ? `Cleared activity.log for ${endpointDisplayName(endpoint.name, 'endpoint')}` : `Error: ${result?.error || 'unknown'}`;
	}

	onMount(() => {
		void refreshAll();
		const unsubscribe = typeof window !== 'undefined' && window.reactor && typeof window.reactor.onRuntimeStatus === 'function'
			? window.reactor.onRuntimeStatus((snapshot) => {
				applyRuntimeStatusSnapshot(snapshot);
			})
			: null;
		const unsubscribeP2PStatus = subscribeP2PStatus((payload) => {
			applyP2PStatusResult(payload);
		});
		const unsubscribeExchangeStatus = subscribeExchangeStatus((payload) => {
			if (payload?.connection && typeof payload.connection === 'object') {
				scheduleExchangeStatusUpdate(payload.connection, 'node');
			}
		});

		return () => {
			if (typeof unsubscribe === 'function') {
				unsubscribe();
			}
			if (typeof unsubscribeP2PStatus === 'function') {
				unsubscribeP2PStatus();
			}
			if (typeof unsubscribeExchangeStatus === 'function') {
				unsubscribeExchangeStatus();
			}
		};
	});

	async function openGlobalLog() {
		status = 'Loading activity.log';
		const ready = await ensureCodeEditorComponent();
		if (!ready) {
			return;
		}

		const logPathResult = await openEventLog();
		if (!logPathResult?.ok || !logPathResult?.path) {
			status = `Error: ${logPathResult?.error || 'activity.log path unavailable'}`;
			return;
		}

		const result = await readEndpointContent(logPathResult.path);
		if (!result?.ok) {
			status = `Error: ${result?.error || 'unable to load activity.log'}`;
			return;
		}

		editorFilePath = logPathResult.path;
		editorFileName = 'activity.log';
		editorLanguage = 'log';
		editorContent = result.content || '';
		editorOpen = true;
		status = 'Editing activity.log';
	}

	async function clearGlobalLog() {
		const result = await clearEventLog();
		status = result?.ok ? 'Cleared activity.log' : `Error: ${result?.error || 'unknown'}`;
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
		onOpenFolder={openEndpointsFolder}
		onOpenSettings={openSettings}
			onOpenEnvManager={openEnvManager}
		onOpenNetworkView={openNetworkView}
		onOpenGlobalLog={openGlobalLog}
		onClearGlobalLog={clearGlobalLog}
		onCreateBlank={() => createEndpoint('blank')}
		onCreateSchedule={() => createEndpoint('schedule')}
		onCreateEvent={() => createEndpoint('event')}
		onCreateWatch={() => createEndpoint('watch')}
		exchangeStatus={exchangeIndicator}
		p2pStatus={p2pConnectionStatus}
	/>
	<main class="content">
		<section class="list-pane">
			<div class="path-box">{endpointsPath || 'Loading path...'}</div>
			<EndpointList
				endpoints={endpoints}
				selectedIndex={selectedIndex}
				onSelect={(index) => (selectedIndex = index)}
				onOpen={editEndpoint}
				onQuickOpenHover={preloadCodeEditor}
				onRename={renameEndpoint}
				onDelete={deleteEndpoint}
				onToggleState={(index) => toggleDirective(index, 'state')}
				onToggleDebug={(index) => toggleDirective(index, 'debug')}
				onToggleMutex={(index) => toggleDirective(index, 'mutex')}
				onRun={runNow}
				onOpenLog={openLog}
				onClearLog={clearLog}
				onCopyId={copyEndpointId}
				onReorder={reorderEndpointItems}
			/>
		</section>
		<DetailPane
			selectedEndpoint={selectedEndpoint}
			endpointsPath={endpointsPath}
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
			{permissionsPlatform}
			{permissionsEntries}
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
			{exchangeStatus}
			onSaveReactorName={saveReactorNameValue}
			onSaveHttpServerData={saveHttpPortValue}
			onOpenServerStatus={openServerStatusPage}
			onGenerateTlsCert={generateTlsCertHandler}
			onDeleteTlsCert={deleteTlsCertHandler}
			onSaveExchangeConfig={saveExchangeConfigValue}
			onSaveStunConfig={saveStunConfigHandler}
			onSaveTurnConfig={saveTurnConfigHandler}
			onExportBackup={openExportOptionsModal}
			onImportBackup={importBackupHandler}
			onTogglePermission={togglePermissionHandler}
			onOpenSystemPermissionSettings={openSystemPermissionSettingsHandler}
			onStopBackgroundProcess={stopBackgroundProcessHandler}
			onSaveMessageQueueTtlDays={saveMessageQueueTtlDaysHandler}
			onFlushMessageQueue={flushMessageQueueHandler}
			onClearMessageQueue={clearMessageQueueHandler}
		/>
	</Modal>

	<Modal
		open={exportOptionsOpen}
		title="Export Backup Options"
		ariaLabel="Backup export options"
		cardClass="modal-card settings-modal-card"
		onClose={closeExportOptionsModal}
	>
		<div class="backup-export-options">
			<label class="backup-toggle-row">
				<input type="checkbox" class="input permission-toggle-input" bind:checked={backupIncludeConnections} />
				<span>Include connections (EXCHANGE / STUN / TURN)</span>
			</label>
			<label class="backup-toggle-row">
				<input type="checkbox" class="input permission-toggle-input" bind:checked={backupIncludeEndpoints} />
				<span>Include endpoints</span>
			</label>

			{#if backupIncludeEndpoints}
				<div class="backup-endpoint-picker">
					<div class="backup-endpoint-picker-toolbar">
						<input
							type="text"
							class="input"
							placeholder="Filter endpoints"
							bind:value={backupEndpointFilter}
						/>
						<div class="settings-backup-actions">
							<button type="button" class="btn-secondary" on:click={selectAllFilteredEndpoints}>Select all</button>
							<button type="button" class="btn-secondary" on:click={deselectAllFilteredEndpoints}>Deselect all</button>
						</div>
					</div>
					<div class="detail-value" style="font-size:0.76em; opacity:0.75;">
						Selected: {backupSelectedCount} / {backupEndpointCandidates.length}
					</div>
					<div class="backup-endpoint-list">
						{#if backupFilteredEndpointCandidates.length === 0}
							<div class="detail-value" style="font-size:0.8em; opacity:0.6;">No endpoints match this filter.</div>
						{:else}
							{#each backupFilteredEndpointCandidates as endpointEntry (endpointEntry.path)}
								<label class="permission-toggle-row d-flex align-items-center">
									<input
										type="checkbox"
										class="input permission-toggle-input me-2"
										checked={backupSelectedEndpointPaths.includes(endpointEntry.path)}
										on:change={(event) => toggleBackupEndpointSelection(endpointEntry.path, event.currentTarget.checked)}
									/>
									<span class="permission-name">{endpointEntry.name}</span>
								</label>
							{/each}
						{/if}
					</div>
				</div>
			{/if}
		</div>

		<svelte:fragment slot="actions">
			<button type="button" class="btn-secondary" on:click={closeExportOptionsModal}>Cancel</button>
			<button type="button" class="btn-primary" on:click={confirmExportBackupFromModal}>
				<i class="fa-solid fa-file-export me-2"></i>Export ZIP
			</button>
		</svelte:fragment>
	</Modal>

	<Modal
		open={envOpen}
		title="Variables"
		subtitle={ "" }
		ariaLabel="Environment variables editor"
		cardClass="modal-card env-modal-card"
		onClose={closeEnvManager}
	>
		<div class="env-toolbar">
			<div class="env-toolbar-actions">
				<!-- svelte-ignore a11y_consider_explicit_label -->
				<button type="button" class="btn-secondary" on:click={addEnvRow} title="add variable">
					<i class="fa-solid fa-plus"></i>
				</button>
				<button type="button" class="btn-secondary" on:click={loadEnvConfig} disabled={envLoading}>
					<i class="fa-solid fa-rotate me-1"></i>{envLoading ? 'Reloading...' : 'Reload'}
				</button>
			</div>
		</div>

		<div class="env-list">
			{#if envDraftRows.length === 0}
				<div class="env-empty">No env files defined</div>
			{:else}
				{#each envDraftRows as row, index (row.id)}
					<div class="env-row">
						<input class="modal-input env-name-input" type="text" bind:value={row.name} autocomplete="off" placeholder="MY_CUSTOM_VAR" />
						<textarea class="modal-input env-content-input" bind:value={row.content} autocomplete="off" placeholder="Any file content" rows="4"></textarea>
						<button type="button" class="btn-secondary env-remove-button" title="Remove file" on:click={() => removeEnvRow(index)}>
							<i class="fa-solid fa-trash"></i>
						</button>
					</div>
				{/each}
			{/if}
		</div>

		<svelte:fragment slot="actions">
			<button type="button" class="btn-secondary" on:click={closeEnvManager}>Close</button>
			<button type="button" class="btn-primary" disabled={envSaving} on:click={saveEnvManager}>
				<i class="fa-solid fa-floppy-disk me-2"></i>{envSaving ? 'Saving...' : 'Save'}
			</button>
		</svelte:fragment>
	</Modal>

	<Modal
		open={networkViewOpen}
		title="Network View"
		subtitle=""
		ariaLabel="Network topology and node endpoints"
		cardClass="modal-card network-view-modal-card"
		onClose={closeNetworkView}
		showActions={false}
	>
		<div class="network-view-shell">
			<div class="network-graph-pane">
				<div class="network-state-legend">
					<span class="legend-item"><i class="legend-dot is-current"></i>Current node</span>
					<span class="legend-item"><i class="legend-dot is-connected"></i>Connected P2P</span>
					<span class="legend-item"><i class="legend-dot is-relay"></i>Connected RELAY</span>
					<span class="legend-item"><i class="legend-dot is-dialing"></i>Dialing</span>
					<span class="legend-item"><i class="legend-dot is-fallback"></i>Fallback</span>
					<span class="legend-item"><i class="legend-dot is-discovered"></i>Discovered</span>
				</div>
				<div class="network-graph-canvas">
					{#if networkNodes.length === 0}
						<div class="network-empty">No nodes available</div>
					{:else}
						<div class="network-hub">
							<div class="network-hub-icon"><i class="fa-solid fa-server"></i></div>
							<div class="network-hub-label">Exchange</div>
						</div>
						{#if networkCurrentNodeIndex >= 0}
							{#each networkNodes as node, index}
								{#if networkHasActiveLinkToCurrentNode(node)}
									<div
										class="network-peer-edge is-{node.stateInfo.key}"
										style={networkPeerEdgeStyle(networkCurrentNodeIndex, index, networkNodes.length)}
									></div>
									<div
										class="network-peer-edge-label is-{node.stateInfo.key}"
										style={networkPeerEdgeLabelStyle(networkCurrentNodeIndex, index, networkNodes.length)}
									>
										{networkPeerLinkLabel(node)}
									</div>
								{/if}
							{/each}
						{/if}
						{#each networkNodes as node, index}
							<div class="network-edge is-{node.stateInfo.key}" style={networkNodeAngleStyle(index, networkNodes.length)}></div>
							<button
								type="button"
								class="network-node is-{node.stateInfo.key} {node.isCurrent ? 'is-current' : ''} {networkSelectedNode === node.name ? 'is-selected' : ''}"
								style={networkNodeAngleStyle(index, networkNodes.length)}
								on:click={() => selectNetworkNode(node.name)}
							>
								<div class="network-node-title">{node.isCurrent ? `${node.name} (current)` : node.name}</div>
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
					<div class="network-empty">Select a node to inspect endpoints</div>
				{:else}
					<div class="network-detail-header">
						<div>
							<div class="network-detail-title">{selectedNetworkNodeData?.isCurrent ? `${networkSelectedNode} (current)` : networkSelectedNode}</div>
							<div class="network-detail-meta">
								Source: {networkSourceLabel(selectedNetworkEndpointsSource)}
							</div>
						</div>
						{#if selectedNetworkNodeData?.isCurrent}
							<button type="button" class="btn-secondary" disabled>
								<i class="fa-solid fa-circle-dot me-1"></i>Current node
							</button>
						{:else}
							<button
								type="button"
								class="btn-secondary"
								disabled={networkRequestInFlight === networkSelectedNode}
								on:click={() => requestNetworkNodeEndpoints(networkSelectedNode)}
							>
								<i class="fa-solid fa-wifi me-1"></i>{networkRequestInFlight === networkSelectedNode ? 'Requesting...' : 'Request endpoints'}
							</button>
						{/if}
					</div>

					<div class="network-node-facts">
						<div class="network-endpoint-meta">Node name: {selectedNetworkNodeData?.name || '-'}</div>
						<div class="network-endpoint-meta">Connection started: {formatNetworkDateTime(selectedNetworkNodeData?.connectedAt)}</div>
						<div class="network-endpoint-meta">IP: {selectedNetworkNodeData?.ip || '-'}</div>
						<div class="network-endpoint-meta">Port: {selectedNetworkNodeData?.port ?? '-'}</div>
						<div class="network-endpoint-meta">
							Geo:
							{#if selectedNetworkNodeData?.geoCoordinates}
								<a
									href={selectedNetworkNodeData.geoMapsUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="network-geo-link"
									title="Open WGS84 coordinates in Google Maps"
								>
									{selectedNetworkNodeData.geoCoordinates.label}
								</a>
								<button
									type="button"
									class="network-geo-copy"
									title="Copy WGS84 coordinates"
									on:click={() => copyNetworkGeoCoordinates(selectedNetworkNodeData)}
								>
									<i class="fa-solid fa-copy"></i>
								</button>
							{:else}
								<span>{selectedNetworkNodeData?.geo || '-'}</span>
							{/if}
						</div>
					</div>

					{#if networkRequestError}
						<div class="network-error">{networkRequestError}</div>
					{/if}

					{#if selectedNetworkEndpoints.length === 0}
						<div class="network-empty">No endpoints available for this node</div>
					{:else}
						<div class="network-endpoint-list">
							{#each selectedNetworkEndpoints as endpoint}
								<div class="network-endpoint-item">
									<button
										type="button"
										class="network-endpoint-copy network-endpoint-name"
										title="Copy endpoint target"
										on:click={() => copyNetworkEndpointField(endpoint, 'name')}
									>
										<span class="network-copy-icon" aria-hidden="true"><i class="fa-solid fa-copy"></i></span>
										<span>{endpoint.name || 'unnamed endpoint'}</span>
										{#if isNetworkEndpointCopied(endpoint, 'name')}
											<span class="network-copy-badge">Copied</span>
										{/if}
									</button>
									<div class="network-endpoint-meta">
										UUID:
										{#if endpoint.uuid}
											<button
												type="button"
												class="network-endpoint-copy network-endpoint-inline"
												title="Copy endpoint UUID target"
												on:click={() => copyNetworkEndpointField(endpoint, 'uuid')}
											>
												<span class="network-copy-icon" aria-hidden="true"><i class="fa-solid fa-copy"></i></span>
												<span>{endpoint.uuid}</span>
												{#if isNetworkEndpointCopied(endpoint, 'uuid')}
													<span class="network-copy-badge">Copied</span>
												{/if}
											</button>
										{:else}
											<span>-</span>
										{/if}
									</div>
									<details class="network-triggers-accordion">
										<summary>
											Triggers
											{#if Array.isArray(endpoint.triggers) && endpoint.triggers.length > 0}
												<span class="network-triggers-count">({endpoint.triggers.length})</span>
											{/if}
										</summary>
										{#if Array.isArray(endpoint.triggers) && endpoint.triggers.length > 0}
											<div class="network-triggers-list">{endpoint.triggers.join(', ')}</div>
										{:else}
											<div class="network-triggers-list">-</div>
										{/if}
									</details>
									<div class="network-endpoint-meta">Enabled: {endpoint.enabled ? 'yes' : 'no'} · Mutex: {endpoint.mutex ? 'yes' : 'no'}</div>
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
		title="Rename Endpoint"
		subtitle={renameOriginalEndpointName}
		ariaLabel="Rename endpoint"
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

	<Modal
		open={endpointPermissionsWarningOpen}
		title="Required Permissions"
		subtitle={`Endpoint ${endpointPermissionsWarningFileName || 'boot'} requires additional permissions on ${endpointPermissionsWarningPlatform || getCurrentRuntimePlatform()}.`}
		ariaLabel="Required permissions warning"
		onClose={closeEndpointPermissionsWarning}
	>
		<div class="permissions-warning-list">
			{#each endpointPermissionsWarningEntries as permissionEntry}
				<div class="permissions-warning-item {permissionEntry.granted ? 'is-granted' : 'is-missing'}">
					<span class="permissions-warning-name">{permissionEntry.name}</span>
					<span class="permissions-warning-state">{permissionEntry.granted ? 'Granted' : 'Missing'}</span>
				</div>
			{/each}
		</div>
		<svelte:fragment slot="actions">
			<button type="button" class="btn-secondary" on:click={closeEndpointPermissionsWarning}>Close</button>
			<button
				type="button"
				class="btn-primary"
				on:click={() => {
					closeEndpointPermissionsWarning();
					openSettings();
				}}
			>
				Open Settings
			</button>
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

	:global(.env-modal-card) {
		width: min(980px, 95vw);
		max-height: 90vh;
		overflow: auto;
	}

	.env-toolbar {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.env-path {
		padding: 8px 12px;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.08);
		font-size: 0.82rem;
		word-break: break-all;
	}

	.env-toolbar-actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}

	.env-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.env-empty {
		padding: 12px 14px;
		border-radius: 12px;
		border: 1px dashed rgba(255, 255, 255, 0.14);
		opacity: 0.72;
	}

	.env-row {
		display: grid;
		grid-template-columns: 0.85fr 1.45fr auto;
		gap: 10px;
		align-items: start;
	}

	.env-name-input,
	.env-content-input {
		width: 100%;
	}

	.env-content-input {
		min-height: 104px;
		resize: vertical;
	}

	.env-remove-button {
		height: 42px;
		min-width: 42px;
		padding: 0 12px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	@media (max-width: 720px) {
		.env-row {
			grid-template-columns: 1fr;
		}

		.env-remove-button {
			width: 100%;
		}
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

	.network-peer-edge {
		position: absolute;
		height: 2px;
		border-radius: 999px;
		background: linear-gradient(90deg, rgba(120, 198, 255, 0.16), rgba(120, 198, 255, 0.72), rgba(120, 198, 255, 0.16));
		transform-origin: center;
		z-index: 2;
	}

	.network-peer-edge.is-connected {
		background: linear-gradient(90deg, rgba(96, 230, 154, 0.16), rgba(96, 230, 154, 0.85), rgba(96, 230, 154, 0.16));
	}

	.network-peer-edge.is-relay {
		background: linear-gradient(90deg, rgba(247, 196, 99, 0.16), rgba(247, 196, 99, 0.85), rgba(247, 196, 99, 0.16));
	}

	.network-peer-edge-label {
		position: absolute;
		padding: 2px 6px;
		border-radius: 999px;
		font-size: 0.64rem;
		font-weight: 700;
		line-height: 1;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		background: rgba(22, 30, 43, 0.96);
		border: 1px solid rgba(120, 198, 255, 0.38);
		color: rgba(193, 228, 255, 0.96);
		transform-origin: center;
		z-index: 5;
		pointer-events: none;
	}

	.network-peer-edge-label.is-connected {
		border-color: rgba(96, 230, 154, 0.55);
		color: rgba(169, 247, 205, 0.98);
	}

	.network-peer-edge-label.is-relay {
		border-color: rgba(247, 196, 99, 0.58);
		color: rgba(255, 227, 161, 0.98);
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

	.network-node.is-current {
		border-color: rgba(120, 198, 255, 0.95);
		box-shadow: 0 0 0 1px rgba(120, 198, 255, 0.3) inset;
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

	.legend-dot.is-current {
		background: rgba(120, 198, 255, 1);
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

	.network-endpoint-list {
		margin-top: 10px;
		max-height: 340px;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.network-node-facts {
		margin-top: 10px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.network-endpoint-item {
		padding: 9px;
		border-radius: 10px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.02);
	}

	.network-endpoint-name {
		font-weight: 600;
		font-size: 0.83rem;
	}

	.network-endpoint-copy {
		appearance: none;
		border: 0;
		background: transparent;
		padding: 0;
		margin: 0;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.network-endpoint-copy:hover {
		opacity: 1;
		text-decoration: underline;
	}

	.network-endpoint-copy:focus-visible {
		outline: 2px solid rgba(120, 198, 255, 0.65);
		outline-offset: 2px;
		border-radius: 6px;
	}

	.network-endpoint-inline {
		font-size: 0.74rem;
		opacity: 0.9;
		word-break: break-all;
		vertical-align: middle;
	}

	.network-copy-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.7rem;
		opacity: 0.78;
		min-width: 0.9rem;
	}

	.network-copy-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.62rem;
		line-height: 1;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 3px 6px;
		border-radius: 999px;
		background: rgba(96, 230, 154, 0.16);
		border: 1px solid rgba(96, 230, 154, 0.5);
		color: rgba(169, 247, 205, 0.96);
	}

	.network-triggers-accordion {
		margin-top: 4px;
	}

	.network-triggers-accordion > summary {
		list-style: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.74rem;
		opacity: 0.86;
		cursor: pointer;
		user-select: none;
	}

	.network-triggers-accordion > summary::-webkit-details-marker {
		display: none;
	}

	.network-triggers-accordion > summary::before {
		content: '\25B8';
		display: inline-block;
		font-size: 0.68rem;
		opacity: 0.9;
		transform: translateY(-1px);
	}

	.network-triggers-accordion[open] > summary::before {
		content: '\25BE';
	}

	.network-triggers-count {
		font-size: 0.68rem;
		opacity: 0.78;
	}

	.network-triggers-list {
		margin-top: 5px;
		padding-left: 16px;
		font-size: 0.72rem;
		opacity: 0.82;
		word-break: break-word;
	}

	.network-endpoint-meta {
		font-size: 0.74rem;
		opacity: 0.75;
	}

	.network-geo-link {
		color: #86efac;
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
		margin-left: 0.35rem;
	}

	.network-geo-link:hover {
		color: #bbf7d0;
	}

	.network-geo-copy {
		margin-left: 0.45rem;
		padding: 0.12rem 0.45rem;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.08);
		color: #d1d5db;
		border-radius: 999px;
		font-size: 0.68rem;
		line-height: 1.3;
		cursor: pointer;
	}

	.network-geo-copy:hover {
		background: rgba(134, 239, 172, 0.16);
		border-color: rgba(134, 239, 172, 0.45);
		color: #bbf7d0;
	}

	.network-empty {
		opacity: 0.68;
		font-size: 0.85rem;
	}

	.backup-export-options {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.backup-toggle-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.85em;
	}

	.backup-endpoint-picker {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 10px;
		background: rgba(255,255,255,0.02);
	}

	.backup-endpoint-picker-toolbar {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.backup-endpoint-list {
		max-height: 200px;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
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

	.permissions-warning-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 6px;
	}

	.permissions-warning-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(255, 255, 255, 0.03);
	}

	.permissions-warning-item.is-missing {
		border-color: rgba(239, 93, 93, 0.56);
		background: rgba(160, 45, 45, 0.22);
	}

	.permissions-warning-item.is-granted {
		border-color: rgba(96, 230, 154, 0.5);
		background: rgba(96, 230, 154, 0.14);
	}

	.permissions-warning-name {
		font-size: 0.86rem;
		font-weight: 600;
	}

	.permissions-warning-state {
		font-size: 0.78rem;
		opacity: 0.9;
	}
</style>
