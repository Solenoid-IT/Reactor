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

class P2PDataChannelManager {
	constructor(runtime) {
		this.runtime = runtime;
		this.supported = Boolean(webrtc && webrtc.RTCPeerConnection && webrtc.RTCSessionDescription && webrtc.RTCIceCandidate);
		this.sessions = new Map();
		this.connecting = new Map();
		this.connectTimeoutMs = Number(process.env.REACTOR_P2P_CONNECT_TIMEOUT_MS) > 0 ? Number(process.env.REACTOR_P2P_CONNECT_TIMEOUT_MS) : 12000;
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
			queuedCandidates: [],
		};

		connection.onicecandidate = (event) => {
			if (!event || !event.candidate) {
				return;
			}

			this.runtime.sendP2PSignal(safeTarget, 'candidate', {
				candidate: event.candidate.candidate,
				sdpMid: event.candidate.sdpMid,
				sdpMLineIndex: event.candidate.sdpMLineIndex,
			}, { sessionId: session.sessionId }).catch(() => {});
		};

		connection.onconnectionstatechange = () => {
			const state = String(connection.connectionState || '').toLowerCase();
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
			const channel = connection.createDataChannel('reactor-data', { ordered: true });
			this.attachDataChannel(session, channel);
		}

		this.sessions.set(safeTarget, session);
		return session;
	}

	attachDataChannel(session, channel) {
		session.dataChannel = channel;

		channel.onopen = () => {
			session.isOpen = true;
			session.openResolve(true);
		};

		channel.onclose = () => {
			session.isOpen = false;
		};

		channel.onerror = () => {
			session.isOpen = false;
		};

		channel.onmessage = (event) => {
			const payload = event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : '';
			this.runtime.handleIncomingP2PEnvelope(session.target, payload).catch((error) => {
				this.runtime.log(`[P2P] incoming envelope error from ${session.target}: ${error.message}`);
			});
		};
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
			await session.connection.setLocalDescription(offer);

			await this.runtime.sendP2PSignal(safeTarget, 'offer', {
				type: offer.type,
				sdp: offer.sdp,
			}, { sessionId: session.sessionId });

			const started = Date.now();
			while (Date.now() - started < this.connectTimeoutMs) {
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
			const remoteDesc = new webrtc.RTCSessionDescription({
				type: 'offer',
				sdp: String(signal?.payload?.sdp || ''),
			});
			await session.connection.setRemoteDescription(remoteDesc);
			session.remoteDescriptionSet = true;
			await this.flushQueuedCandidates(session);

			const answer = await session.connection.createAnswer();
			await session.connection.setLocalDescription(answer);
			await this.runtime.sendP2PSignal(from, 'answer', {
				type: answer.type,
				sdp: answer.sdp,
			}, { sessionId: session.sessionId });
			return;
		}

		if (signalType === 'answer') {
			const remoteDesc = new webrtc.RTCSessionDescription({
				type: 'answer',
				sdp: String(signal?.payload?.sdp || ''),
			});
			await session.connection.setRemoteDescription(remoteDesc);
			session.remoteDescriptionSet = true;
			await this.flushQueuedCandidates(session);
			return;
		}

		if (signalType === 'candidate') {
			const candidatePayload = signal?.payload || {};
			const candidate = new webrtc.RTCIceCandidate({
				candidate: String(candidatePayload.candidate || ''),
				sdpMid: candidatePayload.sdpMid ?? null,
				sdpMLineIndex: Number.isFinite(Number(candidatePayload.sdpMLineIndex)) ? Number(candidatePayload.sdpMLineIndex) : 0,
			});

			if (!session.remoteDescriptionSet) {
				session.queuedCandidates.push(candidate);
				return;
			}

			await session.connection.addIceCandidate(candidate).catch(() => {});
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
		}
	}

	async sendEnvelope(target, envelope = {}) {
		const session = await this.ensureConnected(target);
		if (!session.dataChannel || session.dataChannel.readyState !== 'open') {
			throw new Error('p2p data channel is not open');
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
}

module.exports = {
	P2PDataChannelManager,
};
