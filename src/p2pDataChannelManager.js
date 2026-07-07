const crypto = require('crypto');

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

class P2PDataChannelManager {
	constructor(runtime) {
		this.runtime = runtime;
		this.supported = Boolean(webrtc && webrtc.RTCPeerConnection && webrtc.RTCSessionDescription && webrtc.RTCIceCandidate);
		this.sessions = new Map();
		this.connecting = new Map();
		this.connectTimeoutMs = Number(process.env.REACTOR_P2P_CONNECT_TIMEOUT_MS) > 0 ? Number(process.env.REACTOR_P2P_CONNECT_TIMEOUT_MS) : 25000;
		this.dataChannelBufferedHighWatermarkBytes = parsePositiveInt(process.env.REACTOR_P2P_DATA_CHANNEL_BUFFER_HIGH_WATERMARK_BYTES, 4 * 1024 * 1024);
		this.dataChannelBufferedWaitTimeoutMs = parsePositiveInt(process.env.REACTOR_P2P_DATA_CHANNEL_BUFFER_WAIT_TIMEOUT_MS, 15000);
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
			dataChannel: null,
			isOpen: false,
			openPromise,
			openResolve,
			openReject,
			remoteDescriptionSet: false,
			remoteDescriptionPending: false,
			queuedCandidates: [],
		};

		connection.onicecandidate = (event) => {
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
			if (!event || !event.channel) {
				return;
			}
			this.attachDataChannel(session, event.channel);
		};

		if (session.initiator) {
			const channel = connection.createDataChannel('reactor-data', {
				ordered: true,
			});
			this.attachDataChannel(session, channel);
		}

		this.sessions.set(safeTarget, session);
		return session;
	}

	attachDataChannel(session, channel) {
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
			session.isOpen = true;
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `datachannel state=open target=${session.target}`).catch(() => {});
			session.openResolve(true);
		};

		channel.onclose = () => {
			session.isOpen = false;
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `datachannel state=closed target=${session.target}`).catch(() => {});
		};

		channel.onerror = () => {
			session.isOpen = false;
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `datachannel state=error target=${session.target}`).catch(() => {});
		};

		channel.onmessage = (event) => {
			const payload = event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : '';
			this.runtime.handleIncomingP2PEnvelope(session.target, payload).catch((error) => {
				this.runtime.log(`[P2P] incoming envelope error from ${session.target}: ${error.message}`);
			});
		};
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
			const session = this.createSession(safeTarget, true);
			const offer = await session.connection.createOffer();
			this.runtime.logGlobalEvent('P2P_NEGOTIATION', `offer created for ${safeTarget}`).catch(() => {});
			await session.connection.setLocalDescription(offer);

			await this.runtime.sendP2PSignal(safeTarget, 'offer', {
				type: offer.type,
				sdp: offer.sdp,
				sdpBase64: Buffer.from(String(offer.sdp || ''), 'utf8').toString('base64'),
			}, { sessionId: session.sessionId });

			let nextOfferRetryAt = Date.now() + 3000;

			const started = Date.now();
			while (Date.now() - started < this.connectTimeoutMs) {
				if (session.isOpen && session.dataChannel && session.dataChannel.readyState === 'open') {
					return session;
				}

				if (!session.remoteDescriptionSet && Date.now() >= nextOfferRetryAt) {
					const localDescription = session.connection.localDescription;
					if (localDescription && localDescription.sdp) {
						this.runtime.logGlobalEvent('P2P_NEGOTIATION', `offer retransmit for ${safeTarget}`).catch(() => {});
						await this.runtime.sendP2PSignal(safeTarget, 'offer', {
							type: String(localDescription.type || 'offer'),
							sdp: String(localDescription.sdp || ''),
							sdpBase64: Buffer.from(String(localDescription.sdp || ''), 'utf8').toString('base64'),
						}, { sessionId: session.sessionId }).catch(() => {});
					}
					nextOfferRetryAt = Date.now() + 3000;
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

	async handleSignal(signal = {}) {
		if (!this.supported) {
			return;
		}

		const from = String(signal.from || '').trim().toLowerCase();
		const signalType = String(signal.signalType || '').trim().toLowerCase();
		if (!from || !signalType) {
			return;
		}

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

		try {
			if (session.dataChannel) {
				session.dataChannel.close();
			}
		} catch {
			// ignore
		}

		try {
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
	}
}

module.exports = {
	P2PDataChannelManager,
};
