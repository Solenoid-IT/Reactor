const crypto = require('crypto');

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30000;

let webrtc = null;
try {
	webrtc = require('@roamhq/wrtc');
} catch {
	try {
		webrtc = require('wrtc');
	} catch {
		webrtc = null;
	}
}

function waitFor(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback) {
	const parsed = Number(value);
	if (Number.isInteger(parsed) && parsed > 0) {
		return parsed;
	}
	return fallback;
}

function decodeSdpFromPayload(payload = {}) {
	if (!payload || typeof payload !== 'object') {
		return '';
	}

	const rawBase64 = String(payload.sdpBase64 || '').trim();
	if (rawBase64) {
		try {
			const decoded = Buffer.from(rawBase64, 'base64').toString('utf8');
			if (decoded.trim()) {
				return decoded;
			}
		} catch {
			// Fallback to plain sdp when base64 decoding fails.
		}
	}

	return String(payload.sdp || '');
}

function isReliableDataChannel(channel) {
	if (!channel) {
		return false;
	}

	const isUnsetOrDefaultLimit = (value) => {
		if (value === null || value === undefined) {
			return true;
		}

		const numeric = Number(value);
		if (!Number.isFinite(numeric)) {
			return false;
		}

		// Some WebRTC implementations expose 65535 as default "not limited" sentinel.
		return numeric === 65535;
	};

	const ordered = channel.ordered !== false;
	const hasUnlimitedRetransmits = isUnsetOrDefaultLimit(channel.maxRetransmits);
	const hasNoPacketLifetimeLimit = isUnsetOrDefaultLimit(channel.maxPacketLifeTime);

	return ordered && hasUnlimitedRetransmits && hasNoPacketLifetimeLimit;
}

function buildControlEnvelope(action, extras = {}) {
	const payload = {
		__reactorP2PControl: true,
		action,
		timestamp: new Date().toISOString(),
		...extras,
	};

	return JSON.stringify({
		kind: 'message',
		payloadType: 'json',
		payload: JSON.stringify(payload),
		contentType: 'application/json; charset=utf-8',
		messageHeaders: {
			'content-type': 'application/json; charset=utf-8',
			'x-reactor-p2p-control': action,
		},
	});
}

function extractControlPayload(rawPayload) {
	if (typeof rawPayload !== 'string' || !rawPayload.trim()) {
		return null;
	}

	try {
		const envelope = JSON.parse(rawPayload);
		if (!envelope || typeof envelope !== 'object') {
			return null;
		}

		const payloadType = String(envelope.payloadType || '').trim().toLowerCase();
		const headers = envelope.messageHeaders && typeof envelope.messageHeaders === 'object'
			? envelope.messageHeaders
			: {};
		const controlHeader = String(headers['x-reactor-p2p-control'] || headers['X-Reactor-P2P-Control'] || '').trim();
		const contentType = String(envelope.contentType || headers['content-type'] || headers['Content-Type'] || '').trim().toLowerCase();
		const shouldParseJson = payloadType === 'json' || contentType.includes('application/json') || controlHeader;
		if (!shouldParseJson) {
			return envelope.__reactorP2PControl === true ? envelope : null;
		}

		const payload = payloadType === 'json' || typeof envelope.payload === 'string'
			? JSON.parse(String(envelope.payload || '{}'))
			: envelope.payload;
		return payload && typeof payload === 'object' && payload.__reactorP2PControl === true ? payload : null;
	} catch {
		return null;
	}
}

class P2PDataChannelManager {
	constructor(runtime) {
		this.runtime = runtime;
		this.supported = Boolean(webrtc && webrtc.RTCPeerConnection && webrtc.RTCSessionDescription && webrtc.RTCIceCandidate);
		this.sessions = new Map();
		this.connecting = new Map();
		this.signalChains = new Map();
		this.connectTimeoutMs = Number(process.env.REACTOR_P2P_CONNECT_TIMEOUT_MS) > 0 ? Number(process.env.REACTOR_P2P_CONNECT_TIMEOUT_MS) : 25000;
		this.dataChannelBufferedHighWatermarkBytes = parsePositiveInt(process.env.REACTOR_P2P_DATA_CHANNEL_BUFFER_HIGH_WATERMARK_BYTES, 4 * 1024 * 1024);
		this.dataChannelBufferedWaitTimeoutMs = parsePositiveInt(process.env.REACTOR_P2P_DATA_CHANNEL_BUFFER_WAIT_TIMEOUT_MS, 15000);
		this.heartbeatIntervalMs = parsePositiveInt(process.env.REACTOR_P2P_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS);
		this.heartbeatTimeoutMs = parsePositiveInt(process.env.REACTOR_P2P_HEARTBEAT_TIMEOUT_MS, Math.max(DEFAULT_HEARTBEAT_TIMEOUT_MS, this.heartbeatIntervalMs * 3));
	}

	isAvailable() {
		return this.supported;
	}

	getStatusSummary() {
		return {
			supported: this.supported,
			activeSessions: this.sessions.size,
		};
	}

	getSession(target) {
		return this.sessions.get(String(target || '').trim().toLowerCase()) || null;
	}

	createSession(target, initiator = false) {
		if (!this.supported) {
			throw new Error('WebRTC DataChannel support unavailable: install @roamhq/wrtc (or wrtc)');
		}

		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget) {
			throw new Error('invalid p2p target');
		}

		const existing = this.sessions.get(safeTarget);
		if (existing) {
			return existing;
		}

		const connection = new webrtc.RTCPeerConnection({
			iceServers: this.runtime.getIceServersForP2P(),
		});

		let openResolve;
		let openReject;
		const openPromise = new Promise((resolve, reject) => {
			openResolve = resolve;
			openReject = reject;
		});

		const session = {
			target: safeTarget,
			sessionId: crypto.randomUUID(),
			connection,
			initiator: Boolean(initiator),
			makingOffer: false,
			localOfferAborted: false,
			dataChannel: null,
			heartbeatTimer: null,
			lastHeartbeatAt: Date.now(),
			isOpen: false,
			closed: false,
			openPromise,
			openResolve,
			openReject,
			remoteDescriptionSet: false,
			remoteDescriptionPending: false,
			queuedCandidates: [],
		};

		const isCurrentSession = () => !session.closed && this.sessions.get(safeTarget) === session;

		connection.onicecandidate = (event) => {
			if (!isCurrentSession()) {
				return;
			}

			if (!event || !event.candidate) {
				return;
			}

			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `local ICE candidate generated for ${safeTarget}`).catch(() => {});

			this.runtime.sendP2PSignal(safeTarget, 'candidate', {
				candidate: event.candidate.candidate,
				sdpMid: event.candidate.sdpMid,
				sdpMLineIndex: event.candidate.sdpMLineIndex,
			}, { sessionId: session.sessionId }).catch(() => {});
		};

		connection.onconnectionstatechange = () => {
			if (!isCurrentSession()) {
				return;
			}

			const state = String(connection.connectionState || '').toLowerCase();
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `peerconnection state=${state} target=${safeTarget}`).catch(() => {});
			if (state === 'connected') {
				this.runtime.upsertP2PSession(safeTarget, {
					sessionId: session.sessionId,
					state: 'connected-p2p',
					lastSignalType: 'connected',
					usingRelay: false,
				});
			}
			if (state === 'failed' || state === 'disconnected') {
				this.runtime.upsertP2PSession(safeTarget, {
					sessionId: session.sessionId,
					state: 'fallback-exchange',
					lastSignalType: 'failed',
					usingRelay: true,
					reason: `ice ${state}`,
				});
			}
		};

		connection.ondatachannel = (event) => {
			if (!isCurrentSession()) {
				return;
			}

			if (!event || !event.channel) {
				return;
			}
			this.attachDataChannel(session, event.channel);
		};

		this.sessions.set(safeTarget, session);

		if (session.initiator) {
			const channel = connection.createDataChannel('reactor-data', {
				ordered: true,
			});
			this.attachDataChannel(session, channel);
		}

		return session;
	}

	attachDataChannel(session, channel) {
		const isCurrentSession = () => !session.closed && this.sessions.get(session.target) === session;

		if (!isCurrentSession()) {
			try {
				channel.close();
			} catch {
				// ignore
			}
			return;
		}

		if (!isReliableDataChannel(channel)) {
			this.runtime.logGlobalEvent(
				'P2P_NEGOTIATION',
				`datachannel rejected (unreliable settings) target=${session.target} ordered=${String(channel?.ordered)} maxRetransmits=${String(channel?.maxRetransmits)} maxPacketLifeTime=${String(channel?.maxPacketLifeTime)}`,
			).catch(() => {});

			this.runtime.upsertP2PSession(session.target, {
				sessionId: session.sessionId,
				state: 'fallback-exchange',
				lastSignalType: 'failed',
				usingRelay: true,
				reason: 'unreliable datachannel',
			});

			try {
				channel.close();
			} catch {
				// ignore
			}

			return;
		}

		session.dataChannel = channel;

		channel.onopen = () => {
			if (!isCurrentSession()) {
				return;
			}

			session.isOpen = true;
			session.lastHeartbeatAt = Date.now();
			this.startHeartbeat(session);
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `datachannel state=open target=${session.target}`).catch(() => {});
			session.openResolve(true);
		};

		channel.onclose = () => {
			if (!isCurrentSession()) {
				return;
			}

			session.isOpen = false;
			this.stopHeartbeat(session);
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `datachannel state=closed target=${session.target}`).catch(() => {});
			this.runtime.upsertP2PSession(session.target, {
				sessionId: session.sessionId,
				state: 'fallback-exchange',
				lastSignalType: 'failed',
				usingRelay: true,
				reason: 'p2p datachannel closed',
			});
		};

		channel.onerror = () => {
			if (!isCurrentSession()) {
				return;
			}

			session.isOpen = false;
			this.stopHeartbeat(session);
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `datachannel state=error target=${session.target}`).catch(() => {});
			this.runtime.upsertP2PSession(session.target, {
				sessionId: session.sessionId,
				state: 'fallback-exchange',
				lastSignalType: 'failed',
				usingRelay: true,
				reason: 'p2p datachannel error',
			});
		};

		channel.onmessage = (event) => {
			if (!isCurrentSession()) {
				return;
			}

			const payload = event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : '';
			if (this.handleHeartbeatPayload(session, payload)) {
				return;
			}

			this.runtime.handleIncomingP2PEnvelope(session.target, payload).catch((error) => {
				this.runtime.log(`[P2P] incoming envelope error from ${session.target}: ${error.message}`);
			});
		};
	}

	handleHeartbeatPayload(session, rawPayload) {
		const control = extractControlPayload(rawPayload);
		if (!control) {
			return false;
		}

		const action = String(control.action || '').trim().toLowerCase();
		if (action !== 'heartbeat-ping' && action !== 'heartbeat-pong') {
			return false;
		}

		session.lastHeartbeatAt = Date.now();
		if (action === 'heartbeat-ping') {
			this.sendHeartbeat(session, 'heartbeat-pong');
		}
		return true;
	}

	sendHeartbeat(session, action) {
		if (!session || !session.dataChannel || session.dataChannel.readyState !== 'open') {
			return false;
		}

		try {
			session.dataChannel.send(buildControlEnvelope(action, { sessionId: session.sessionId }));
			return true;
		} catch {
			return false;
		}
	}

	startHeartbeat(session) {
		this.stopHeartbeat(session);
		session.heartbeatTimer = setInterval(() => {
			if (this.sessions.get(session.target) !== session || session.closed) {
				this.stopHeartbeat(session);
				return;
			}

			if (!session.dataChannel || session.dataChannel.readyState !== 'open') {
				this.stopHeartbeat(session);
				return;
			}

			const lastHeartbeatAt = Number(session.lastHeartbeatAt || 0);
			if (lastHeartbeatAt > 0 && Date.now() - lastHeartbeatAt > this.heartbeatTimeoutMs) {
				this.runtime.logGlobalEvent('P2P_NEGOTIATION', `datachannel heartbeat timeout target=${session.target}`).catch(() => {});
				this.closeSession(session.target, false);
				this.runtime.upsertP2PSession(session.target, {
					sessionId: session.sessionId,
					state: 'fallback-exchange',
					lastSignalType: 'failed',
					usingRelay: true,
					reason: 'p2p datachannel heartbeat timeout',
				});
				return;
			}

			this.sendHeartbeat(session, 'heartbeat-ping');
		}, this.heartbeatIntervalMs);
	}

	stopHeartbeat(session) {
		if (session && session.heartbeatTimer) {
			clearInterval(session.heartbeatTimer);
			session.heartbeatTimer = null;
		}
	}

	refreshConnectedStateIfAlreadyOpen(session) {
		if (!session) {
			return;
		}

		const dataChannelOpen = Boolean(
			session.dataChannel
			&& session.dataChannel.readyState === 'open',
		);

		const connectionState = String(session.connection?.connectionState || '').toLowerCase();
		if (!dataChannelOpen && connectionState !== 'connected') {
			return;
		}

		this.runtime.upsertP2PSession(session.target, {
			sessionId: session.sessionId,
			state: 'connected-p2p',
			lastSignalType: 'connected',
			usingRelay: false,
		});
	}

	async ensureConnected(target) {
		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget) {
			throw new Error('invalid p2p target');
		}

		const existing = this.sessions.get(safeTarget);
		if (existing && existing.isOpen && existing.dataChannel && existing.dataChannel.readyState === 'open') {
			return existing;
		}

		if (this.connecting.has(safeTarget)) {
			return this.connecting.get(safeTarget);
		}

		const connectPromise = (async () => {
			let session = this.createSession(safeTarget, true);
			session.makingOffer = true;
			try {
				const offer = await session.connection.createOffer();
				this.runtime.logGlobalEvent('P2P_NEGOTIATION', `offer created for ${safeTarget}`).catch(() => {});
				if (!session.localOfferAborted && this.sessions.get(safeTarget) === session) {
					await session.connection.setLocalDescription(offer);
				}
				if (!session.localOfferAborted && this.sessions.get(safeTarget) === session) {
					await this.runtime.sendP2PSignal(safeTarget, 'offer', {
						type: offer.type,
						sdp: offer.sdp,
						sdpBase64: Buffer.from(String(offer.sdp || ''), 'utf8').toString('base64'),
					}, { sessionId: session.sessionId });
				}
			} finally {
				session.makingOffer = false;
			}

			const started = Date.now();
			while (Date.now() - started < this.connectTimeoutMs) {
				const current = this.sessions.get(safeTarget);
				if (current && current !== session) {
					session = current;
				}

				if (session.isOpen && session.dataChannel && session.dataChannel.readyState === 'open') {
					return session;
				}

				await waitFor(100);
			}

			throw new Error('p2p datachannel connection timeout');
		})();

		this.connecting.set(safeTarget, connectPromise);
		try {
			return await connectPromise;
		} finally {
			this.connecting.delete(safeTarget);
		}
	}

	async isPolitePeer(target) {
		const safeTarget = String(target || '').trim().toLowerCase();
		if (!safeTarget) {
			return false;
		}

		if (this.runtime && typeof this.runtime.shouldInitiateP2PWithPeer === 'function') {
			return !(await this.runtime.shouldInitiateP2PWithPeer(safeTarget));
		}

		const localName = String(this.runtime?.cachedReactorName || '').trim().toLowerCase();
		return Boolean(localName && localName !== safeTarget && localName.localeCompare(safeTarget) > 0);
	}

	async handleSignal(signal = {}) {
		if (!this.supported) {
			return;
		}

		const from = String(signal.from || '').trim().toLowerCase();
		const signalType = String(signal.signalType || '').trim().toLowerCase();
		if (!from || !signalType) {
			return;
		}

		const previous = this.signalChains.get(from) || Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(() => this._handleSignalForPeer(signal, from, signalType));
		this.signalChains.set(from, next);

		try {
			await next;
		} finally {
			if (this.signalChains.get(from) === next) {
				this.signalChains.delete(from);
			}
		}
	}

	async _handleSignalForPeer(signal, from, signalType) {
		if (signalType === 'close') {
			this.closeSession(from, false);
			return;
		}

		let session = this.sessions.get(from);
		if (!session) {
			if (signalType !== 'offer' && signalType !== 'candidate') {
				return;
			}
			session = this.createSession(from, false);
		}

		if (signal.sessionId) {
			session.sessionId = String(signal.sessionId);
		}

		if (signalType === 'offer') {
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `remote offer received from ${from}`).catch(() => {});
			let signalingState = String(session.connection.signalingState || '').toLowerCase();
			let localDescription = session.connection.localDescription;
			let alreadyAnswered = Boolean(
				session.remoteDescriptionSet
				&& localDescription
				&& String(localDescription.type || '').toLowerCase() === 'answer'
				&& localDescription.sdp,
			);
			const offerCollision = Boolean(session.makingOffer || signalingState === 'have-local-offer');
			if (!alreadyAnswered && offerCollision) {
				const polite = await this.isPolitePeer(from);
				if (!polite) {
					this.runtime.logGlobalEvent('P2P_NEGOTIATION', `ignored colliding offer from ${from} as impolite peer (signalingState=${signalingState})`).catch(() => {});
					return;
				}

				this.runtime.logGlobalEvent('P2P_NEGOTIATION', `accepting colliding offer from ${from} as polite peer (signalingState=${signalingState})`).catch(() => {});
				session.localOfferAborted = true;
				this.closeSession(from, false);
				session = this.createSession(from, false);
				if (signal.sessionId) {
					session.sessionId = String(signal.sessionId);
				}
				signalingState = String(session.connection.signalingState || '').toLowerCase();
				localDescription = session.connection.localDescription;
				alreadyAnswered = false;
			}

			// A remote offer can only be applied when the connection is idle ('stable')
			// or is still awaiting the same offer ('have-remote-offer'). Applying an
			// offer while a local offer is pending (glare) or after the DTLS role has
			// been negotiated triggers 'Failed to set SSL role for the transport'.
			if (alreadyAnswered || (signalingState !== 'stable' && signalingState !== 'have-remote-offer')) {
				this.runtime.logGlobalEvent('P2P_NEGOTIATION', `ignored duplicate/late offer from ${from} (signalingState=${signalingState})`).catch(() => {});
				// Re-send the existing answer so the initiator can recover if it was lost.
				if (localDescription && String(localDescription.type || '').toLowerCase() === 'answer' && localDescription.sdp) {
					await this.runtime.sendP2PSignal(from, 'answer', {
						type: String(localDescription.type || 'answer'),
						sdp: String(localDescription.sdp || ''),
						sdpBase64: Buffer.from(String(localDescription.sdp || ''), 'utf8').toString('base64'),
					}, { sessionId: session.sessionId }).catch(() => {});
				}
				return;
			}

			const remoteSdp = decodeSdpFromPayload(signal?.payload || {});
			const remoteDesc = new webrtc.RTCSessionDescription({
				type: 'offer',
				sdp: remoteSdp,
			});
			session.remoteDescriptionPending = true;
			await new Promise((resolve, reject) => {
				session.connection.setRemoteDescription(remoteDesc, resolve, reject);
			}).catch((error) => {
				session.remoteDescriptionPending = false;
				throw error;
			});
			session.remoteDescriptionPending = false;
			session.remoteDescriptionSet = true;
			await this.flushQueuedCandidates(session);

			const answer = await session.connection.createAnswer();
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `answer created for ${from}`).catch(() => {});
			await new Promise((resolve, reject) => {
				session.connection.setLocalDescription(answer, resolve, reject);
			});
			await this.runtime.sendP2PSignal(from, 'answer', {
				type: answer.type,
				sdp: answer.sdp,
				sdpBase64: Buffer.from(String(answer.sdp || ''), 'utf8').toString('base64'),
			}, { sessionId: session.sessionId });
			this.refreshConnectedStateIfAlreadyOpen(session);
			return;
		}

		if (signalType === 'answer') {
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `remote answer received from ${from}`).catch(() => {});
			const signalingState = String(session.connection.signalingState || '').toLowerCase();

			// An answer is only valid while a local offer is pending. Applying a
			// duplicate/late answer after the connection is already 'stable' sets the
			// DTLS role a second time and fails with 'Failed to set SSL role for the transport'.
			if (signalingState !== 'have-local-offer') {
				this.runtime.logGlobalEvent('P2P_NEGOTIATION', `ignored duplicate/late answer from ${from} (signalingState=${signalingState})`).catch(() => {});
				session.remoteDescriptionSet = true;
				await this.flushQueuedCandidates(session);
				this.refreshConnectedStateIfAlreadyOpen(session);
				return;
			}

			const remoteSdp = decodeSdpFromPayload(signal?.payload || {});
			const remoteDesc = new webrtc.RTCSessionDescription({
				type: 'answer',
				sdp: remoteSdp,
			});
			session.remoteDescriptionPending = true;
			await new Promise((resolve, reject) => {
				session.connection.setRemoteDescription(remoteDesc, resolve, reject);
			}).catch((error) => {
				session.remoteDescriptionPending = false;
				throw error;
			});
			session.remoteDescriptionPending = false;
			session.remoteDescriptionSet = true;
			await this.flushQueuedCandidates(session);
			this.refreshConnectedStateIfAlreadyOpen(session);
			return;
		}

		if (signalType === 'candidate') {
			const candidatePayload = signal?.payload || {};
			const candidate = new webrtc.RTCIceCandidate({
				candidate: String(candidatePayload.candidate || ''),
				sdpMid: candidatePayload.sdpMid ?? null,
				sdpMLineIndex: Number.isFinite(Number(candidatePayload.sdpMLineIndex)) ? Number(candidatePayload.sdpMLineIndex) : 0,
			});

			if (!session.remoteDescriptionSet || session.remoteDescriptionPending) {
				session.queuedCandidates.push(candidate);
				this.runtime.logGlobalEvent('P2P_NEGOTIATION', `queued ICE candidate for ${from} (remote SDP not ready)`).catch(() => {});
				return;
			}

			await session.connection.addIceCandidate(candidate).catch(() => {});
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `applied ICE candidate for ${from}`).catch(() => {});
		}
	}

	async flushQueuedCandidates(session) {
		if (!session || !session.queuedCandidates || session.queuedCandidates.length === 0) {
			return;
		}

		const queue = [...session.queuedCandidates];
		session.queuedCandidates.length = 0;
		for (const candidate of queue) {
			await session.connection.addIceCandidate(candidate).catch(() => {});
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `flushed queued ICE candidate for ${session.target}`).catch(() => {});
		}
	}

	async sendEnvelope(target, envelope = {}) {
		const session = await this.ensureConnected(target);
		if (!session.dataChannel || session.dataChannel.readyState !== 'open') {
			throw new Error('p2p data channel is not open');
		}

		if (!isReliableDataChannel(session.dataChannel)) {
			throw new Error('p2p data channel is not reliable');
		}

		const startedAt = Date.now();
		while (
			session.dataChannel.readyState === 'open'
			&& Number(session.dataChannel.bufferedAmount || 0) > this.dataChannelBufferedHighWatermarkBytes
		) {
			if (Date.now() - startedAt > this.dataChannelBufferedWaitTimeoutMs) {
				throw new Error('p2p data channel backpressure timeout');
			}
			await waitFor(10);
		}

		if (session.dataChannel.readyState !== 'open') {
			throw new Error('p2p data channel closed during backpressure wait');
		}

		session.dataChannel.send(JSON.stringify(envelope));
		return {
			target: String(target || '').trim().toLowerCase(),
			via: 'p2p-datachannel',
			sessionId: session.sessionId,
		};
	}

	closeSession(target, notifyRemote = false) {
		const safeTarget = String(target || '').trim().toLowerCase();
		const session = this.sessions.get(safeTarget);
		if (!session) {
			return;
		}

		if (notifyRemote) {
			this.runtime.sendP2PSignal(safeTarget, 'close', null, { sessionId: session.sessionId }).catch(() => {});
		}

		session.closed = true;
		session.isOpen = false;
		session.queuedCandidates = [];
		this.stopHeartbeat(session);

		try {
			if (session.dataChannel) {
				session.dataChannel.onopen = null;
				session.dataChannel.onclose = null;
				session.dataChannel.onerror = null;
				session.dataChannel.onmessage = null;
				session.dataChannel.close();
			}
		} catch {
			// ignore
		}

		try {
			session.connection.onicecandidate = null;
			session.connection.onconnectionstatechange = null;
			session.connection.ondatachannel = null;
			session.connection.close();
		} catch {
			// ignore
		}

		this.sessions.delete(safeTarget);
	}

	closeAllSessions() {
		const targets = Array.from(this.sessions.keys());
		for (const target of targets) {
			this.closeSession(target, false);
		}
		this.connecting.clear();
		this.signalChains.clear();
	}

	async closeAllSessionsAndWait(timeoutMs = 1500, notifyRemote = false) {
		const sessions = Array.from(this.sessions.values());
		this.closeAllSessions();

		const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
		while (Date.now() < deadline) {
			const allClosed = sessions.every((session) => {
				const connectionState = String(session.connection?.connectionState || '').toLowerCase();
				const iceConnectionState = String(session.connection?.iceConnectionState || '').toLowerCase();
				const dataChannelState = String(session.dataChannel?.readyState || '').toLowerCase();
				const connectionClosed = !session.connection || connectionState === 'closed' || iceConnectionState === 'closed';
				const channelClosed = !session.dataChannel || dataChannelState === 'closed' || dataChannelState === 'closing';

				return connectionClosed && channelClosed;
			});

			if (allClosed) {
				break;
			}

			await waitFor(25);
		}

		if (notifyRemote) {
			await Promise.allSettled(sessions.map((session) => {
				const safeTarget = String(session.target || '').trim().toLowerCase();
				if (!safeTarget) {
					return null;
				}

				return this.runtime.sendP2PSignal(safeTarget, 'close', null, { sessionId: session.sessionId });
			}));
		}
	}
}

module.exports = {
	P2PDataChannelManager,
};
