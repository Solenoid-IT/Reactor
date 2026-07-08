package com.reactor.app;

import android.content.Context;
import android.util.Log;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public final class AndroidP2PWebRtcManager {
    private static final String TAG = "AndroidP2PWebRtc";
    private static final long DEFAULT_REMOTE_ENDPOINTS_TIMEOUT_MS = 12000L;
    private static final long P2P_HEARTBEAT_INTERVAL_MS = 10000L;
    private static final long P2P_HEARTBEAT_TIMEOUT_MS = 30000L;

    private static volatile AndroidP2PWebRtcManager instance;

    private final Context appContext;
    private final ExecutorService executor;
    private final ScheduledExecutorService heartbeatExecutor;
    private final Map<String, SessionState> sessions;
    private final Map<String, PendingEndpointsRequest> pendingEndpointRequests;
    private volatile PeerConnectionFactory peerConnectionFactory;
    private volatile boolean initialized;
    private volatile int preferredSdpVariantIndex;

    private AndroidP2PWebRtcManager(Context context) {
        this.appContext = context.getApplicationContext();
        this.executor = Executors.newSingleThreadExecutor();
        this.heartbeatExecutor = Executors.newSingleThreadScheduledExecutor();
        this.sessions = new ConcurrentHashMap<>();
        this.pendingEndpointRequests = new ConcurrentHashMap<>();
        this.initialized = false;
        this.preferredSdpVariantIndex = -1;
    }

    public static AndroidP2PWebRtcManager getInstance(Context context) {
        if (instance == null) {
            synchronized (AndroidP2PWebRtcManager.class) {
                if (instance == null) {
                    instance = new AndroidP2PWebRtcManager(context);
                }
            }
        }
        return instance;
    }

    public void initialize() {
        ReactorHttpService.setP2PSignalListener((from, sessionId, signalType, payload) ->
                handleIncomingSignal(from, sessionId, signalType, payload)
        );

        executor.execute(() -> {
            if (initialized) {
                return;
            }

            try {
                PeerConnectionFactory.InitializationOptions initOptions =
                        PeerConnectionFactory.InitializationOptions.builder(appContext)
                                .setEnableInternalTracer(false)
                                .createInitializationOptions();
                PeerConnectionFactory.initialize(initOptions);

                PeerConnectionFactory.Options options = new PeerConnectionFactory.Options();
                peerConnectionFactory = PeerConnectionFactory.builder()
                        .setOptions(options)
                        .createPeerConnectionFactory();

                initialized = true;
            } catch (Exception error) {
                Log.e(TAG, "Unable to initialize WebRTC", error);
            }
        });
    }

    public void shutdown() {
        executor.execute(() -> {
            ReactorHttpService.setP2PSignalListener(null);
            for (SessionState session : sessions.values()) {
                closeSessionInternal(session, true);
            }
            sessions.clear();

            if (peerConnectionFactory != null) {
                peerConnectionFactory.dispose();
                peerConnectionFactory = null;
            }
            initialized = false;
        });
    }

    public void closeAllSessions() {
        executor.execute(() -> {
            List<SessionState> toClose = new ArrayList<>(sessions.values());
            sessions.clear();
            for (SessionState session : toClose) {
                closeSessionInternal(session, true);
            }
        });
    }

    public JSArray closeAllSessionsAndWait(long timeoutMs) {
        JSArray closedSessions = new JSArray();
        CountDownLatch latch = new CountDownLatch(1);
        executor.execute(() -> {
            try {
                List<SessionState> toClose = new ArrayList<>(sessions.values());
                sessions.clear();
                for (SessionState session : toClose) {
                    if (session != null) {
                        closedSessions.put(new JSObject()
                                .put("target", session.target)
                                .put("sessionId", session.sessionId));
                    }
                    closeSessionInternal(session, true);
                }
            } finally {
                latch.countDown();
            }
        });

        try {
            latch.await(Math.max(0L, timeoutMs), TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }

        return closedSessions;
    }

    public JSObject startSession(String target, boolean initiator, RelayConfig relayConfig) {
        String safeTarget = normalizeTarget(target);
        if (safeTarget.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "invalid target");
        }

        ensureInitialized();
        if (!waitForFactoryReady(3000L)) {
            return new JSObject().put("ok", false).put("error", "webrtc initialization timeout");
        }

        try {
            SessionState session = ensureSession(safeTarget, initiator, relayConfig);
            if (session == null || session.peerConnection == null) {
                return new JSObject().put("ok", false).put("error", "unable to create peer connection");
            }

            if (initiator && !session.offerStarted) {
                session.offerStarted = true;
                createOffer(session);
            }

            return new JSObject()
                    .put("ok", true)
                    .put("target", safeTarget)
                    .put("sessionId", session.sessionId)
                    .put("state", session.state);
        } catch (Exception error) {
            return new JSObject().put("ok", false).put("error", error.getMessage() != null ? error.getMessage() : "unable to start session");
        }
    }

    public JSObject sendData(String target, String text) {
        String safeTarget = normalizeTarget(target);
        if (safeTarget.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "invalid target");
        }

        SessionState session = sessions.get(safeTarget);
        if (session == null || session.dataChannel == null) {
            return new JSObject().put("ok", false).put("error", "p2p data channel not ready");
        }

        if (session.dataChannel.state() != DataChannel.State.OPEN) {
            return new JSObject().put("ok", false).put("error", "p2p data channel is not open");
        }

        byte[] payload = String.valueOf(text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
        DataChannel.Buffer buffer = new DataChannel.Buffer(ByteBuffer.wrap(payload), false);
        boolean sent = session.dataChannel.send(buffer);

        return new JSObject().put("ok", sent).put("target", safeTarget).put("bytes", payload.length);
    }

    public JSObject requestRemoteEndpoints(String target, RelayConfig relayConfig, long timeoutMs) {
        String safeTarget = normalizeTarget(target);
        if (safeTarget.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "invalid target");
        }

        ensureInitialized();
        if (!waitForFactoryReady(3000L)) {
            return new JSObject().put("ok", false).put("error", "webrtc initialization timeout");
        }

        try {
            SessionState session = ensureSession(safeTarget, true, relayConfig != null ? relayConfig : new RelayConfig());
            if (session == null || session.peerConnection == null) {
                return new JSObject().put("ok", false).put("error", "unable to create peer connection");
            }

            if (!session.offerStarted) {
                session.offerStarted = true;
                createOffer(session);
            }

            long safeTimeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_REMOTE_ENDPOINTS_TIMEOUT_MS;
            long openDeadline = System.currentTimeMillis() + safeTimeoutMs;
            while (System.currentTimeMillis() < openDeadline) {
                if (session.dataChannel != null && session.dataChannel.state() == DataChannel.State.OPEN) {
                    break;
                }
                try {
                    Thread.sleep(120L);
                } catch (InterruptedException interruptedException) {
                    Thread.currentThread().interrupt();
                    return new JSObject().put("ok", false).put("error", "interrupted while waiting p2p channel");
                }
            }

            if (session.dataChannel == null || session.dataChannel.state() != DataChannel.State.OPEN) {
                return new JSObject().put("ok", false).put("error", "p2p data channel not open");
            }

            String requestId = UUID.randomUUID().toString().toLowerCase(Locale.ROOT);
            PendingEndpointsRequest pending = new PendingEndpointsRequest(requestId, safeTarget);
            pendingEndpointRequests.put(requestId, pending);

            JSONObject payload = new JSONObject();
            payload.put("__reactorP2PControl", true);
            payload.put("action", "endpoints-request");
            payload.put("requestId", requestId);
            payload.put("timestamp", Instant.now().toString());

            JSONObject envelope = buildControlEnvelope(payload);
            byte[] encoded = envelope.toString().getBytes(StandardCharsets.UTF_8);
            boolean sent = session.dataChannel.send(new DataChannel.Buffer(ByteBuffer.wrap(encoded), false));
            if (!sent) {
                pendingEndpointRequests.remove(requestId);
                return new JSObject().put("ok", false).put("error", "unable to send p2p endpoints request");
            }

            boolean completed = pending.latch.await(safeTimeoutMs, TimeUnit.MILLISECONDS);
            pendingEndpointRequests.remove(requestId);
            if (!completed) {
                return new JSObject().put("ok", false).put("error", "p2p endpoints request timeout");
            }

            return new JSObject()
                    .put("ok", true)
                    .put("target", safeTarget)
                    .put("requestId", requestId)
                    .put("node", pending.node)
                    .put("endpoints", pending.endpoints != null ? pending.endpoints : new JSArray())
                    .put("generatedAt", pending.generatedAt != null ? pending.generatedAt : JSONObject.NULL);
        } catch (Exception error) {
            return new JSObject().put("ok", false).put("error", error.getMessage() != null ? error.getMessage() : "unable to request remote endpoints");
        }
    }

    public JSObject closeSession(String target) {
        String safeTarget = normalizeTarget(target);
        if (safeTarget.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "invalid target");
        }

        SessionState session = sessions.remove(safeTarget);
        if (session == null) {
            return new JSObject().put("ok", true).put("target", safeTarget).put("closed", false);
        }

        closeSessionInternal(session, true);
        return new JSObject().put("ok", true).put("target", safeTarget).put("closed", true);
    }

    public JSObject getNativeStatus() {
        JSArray all = new JSArray();
        for (SessionState session : sessions.values()) {
            JSObject item = new JSObject();
            item.put("target", session.target);
            item.put("sessionId", session.sessionId);
            item.put("state", session.state);
            item.put("dataChannel", session.dataChannelState);
            all.put(item);
        }

        return new JSObject().put("ok", true).put("sessions", all);
    }

    public void handleExchangeSignal(String from, String sessionId, String signalType, JSONObject payload) {
        handleIncomingSignal(from, sessionId, signalType, payload);
    }

    public static RelayConfig fromWorkingMode(JSObject workingMode) {
        RelayConfig config = new RelayConfig();
        if (workingMode == null) {
            return config;
        }

        JSONObject stun = workingMode.optJSONObject("stun");
        JSONObject turn = workingMode.optJSONObject("turn");

        config.stunHost = stun != null ? String.valueOf(stun.optString("host", "")).trim() : "";
        config.stunPort = stun != null ? sanitizePort(stun.optInt("port", 3478), 3478) : 3478;

        config.turnHost = turn != null ? String.valueOf(turn.optString("host", "")).trim() : "";
        config.turnPort = turn != null ? sanitizePort(turn.optInt("port", 3478), 3478) : 3478;
        config.turnTls = turn != null && turn.optBoolean("tls", false);
        config.turnUsername = turn != null ? String.valueOf(turn.optString("username", turn.optString("user", ""))).trim() : "";
        config.turnPassword = turn != null ? String.valueOf(turn.optString("password", "")).trim() : "";
        config.token = String.valueOf(workingMode.optString("token", "")).trim();

        return config;
    }

    private void ensureInitialized() {
        if (initialized) {
            return;
        }
        initialize();
    }

    private boolean waitForFactoryReady(long timeoutMs) {
        long safeTimeoutMs = timeoutMs > 0 ? timeoutMs : 3000L;
        long deadline = System.currentTimeMillis() + safeTimeoutMs;

        while (System.currentTimeMillis() < deadline) {
            if (initialized && peerConnectionFactory != null) {
                return true;
            }
            try {
                Thread.sleep(20L);
            } catch (InterruptedException interruptedException) {
                Thread.currentThread().interrupt();
                return false;
            }
        }

        return initialized && peerConnectionFactory != null;
    }

    private SessionState ensureSession(String target, boolean initiator, RelayConfig relayConfig) {
        SessionState existing = sessions.get(target);
        if (existing != null) {
            return existing;
        }

        if (peerConnectionFactory == null) {
            return null;
        }

        List<PeerConnection.IceServer> iceServers = buildIceServers(relayConfig != null ? relayConfig : new RelayConfig());
        PeerConnection.RTCConfiguration rtcConfig = new PeerConnection.RTCConfiguration(iceServers);
        rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        rtcConfig.iceTransportsType = PeerConnection.IceTransportsType.ALL;

        SessionState created = new SessionState();
        created.target = target;
        created.sessionId = UUID.randomUUID().toString().toLowerCase(Locale.ROOT);
        created.state = "signaling";
        created.dataChannelState = "closed";
        created.lastHeartbeatAt = System.currentTimeMillis();

        created.peerConnection = peerConnectionFactory.createPeerConnection(rtcConfig, new PeerConnectionObserver(created));
        if (created.peerConnection == null) {
            return null;
        }

        created.initiator = initiator;
        if (initiator) {
            DataChannel.Init init = new DataChannel.Init();
            init.ordered = true;
            created.dataChannel = created.peerConnection.createDataChannel("reactor-data", init);
            attachDataChannelObserver(created);
        }

        sessions.put(target, created);
        return created;
    }

    private List<PeerConnection.IceServer> buildIceServers(RelayConfig config) {
        List<PeerConnection.IceServer> servers = new ArrayList<>();

        if (config.stunHost != null && !config.stunHost.isEmpty()) {
            servers.add(PeerConnection.IceServer.builder("stun:" + config.stunHost + ":" + config.stunPort).createIceServer());
        }

        if (config.turnHost != null && !config.turnHost.isEmpty()) {
            String scheme = config.turnTls ? "turns:" : "turn:";
            PeerConnection.IceServer.Builder builder = PeerConnection.IceServer.builder(
                    scheme + config.turnHost + ":" + config.turnPort + "?transport=tcp"
            );
            String username = config.turnUsername != null && !config.turnUsername.isEmpty() ? config.turnUsername : config.token;
            String password = config.turnPassword != null && !config.turnPassword.isEmpty() ? config.turnPassword : config.token;
            if (username != null && !username.isEmpty()) {
                builder.setUsername(username);
            }
            if (password != null && !password.isEmpty()) {
                builder.setPassword(password);
            }
            servers.add(builder.createIceServer());
        }

        return servers;
    }

    private void handleIncomingSignal(String from, String sessionId, String signalType, JSONObject payload) {
        executor.execute(() -> {
            ensureInitialized();
            if (!waitForFactoryReady(3000L)) {
                return;
            }

            String safeTarget = normalizeTarget(from);
            String safeSignalType = String.valueOf(signalType == null ? "" : signalType).trim().toLowerCase(Locale.ROOT);
            if (safeTarget.isEmpty() || safeSignalType.isEmpty()) {
                return;
            }

            RelayConfig relayConfig = fromWorkingMode(ReactorHttpService.getWorkingModeConfigForP2P());
            SessionState session = sessions.get(safeTarget);

            if (("offer".equals(safeSignalType) || "candidate".equals(safeSignalType)) && (session == null || session.peerConnection == null)) {
                if (session != null) {
                    closeSessionInternal(session, true);
                    sessions.remove(safeTarget);
                }
                session = ensureSession(safeTarget, false, relayConfig);
            }
            if (session == null) {
                return;
            }

            if (sessionId != null && !sessionId.trim().isEmpty()) {
                session.sessionId = sessionId.trim();
            }

            try {
                if ("offer".equals(safeSignalType)) {
                    if (hasIncomingOfferCollision(session)) {
                        if (!isPolitePeer(safeTarget)) {
                            ReactorHttpService.logGlobalEvent(
                                    "P2P_NEGOTIATION",
                                    "ignored colliding offer for " + session.target + " as impolite peer"
                            );
                            return;
                        }

                        ReactorHttpService.logGlobalEvent(
                                "P2P_NEGOTIATION",
                                "accepting colliding offer for " + session.target + " as polite peer"
                        );
                        session.localOfferAborted = true;
                        closeSessionInternal(session, true);
                        sessions.remove(safeTarget);
                        session = ensureSession(safeTarget, false, relayConfig);
                        if (session == null) {
                            return;
                        }
                        if (sessionId != null && !sessionId.trim().isEmpty()) {
                            session.sessionId = sessionId.trim();
                        }
                    }

                    if (!shouldApplyIncomingOffer(session)) {
                        ReactorHttpService.logGlobalEvent(
                                "P2P_NEGOTIATION",
                                "ignored duplicate/late offer for " + session.target + " (signalingState not stable/have-remote-offer)"
                        );
                        return;
                    }

                    applyRemoteSdpAndAnswer(session, payload);
                    return;
                }
                if ("answer".equals(safeSignalType)) {
                    if (!shouldApplyIncomingAnswer(session)) {
                        ReactorHttpService.logGlobalEvent(
                                "P2P_NEGOTIATION",
                                "ignored duplicate/late answer for " + session.target + " (signalingState not have-local-offer)"
                        );
                        return;
                    }
                    applyRemoteSdp(session, payload, SessionDescription.Type.ANSWER);
                    return;
                }
                if ("candidate".equals(safeSignalType)) {
                    applyRemoteCandidate(session, payload);
                    return;
                }
                if ("close".equals(safeSignalType)) {
                    sessions.remove(safeTarget);
                    closeSessionInternal(session, false);
                }
            } catch (Exception error) {
                Log.e(TAG, "Signal handling error", error);
                ReactorHttpService.sendP2PSignal(safeTarget, "failed", new JSObject().put("reason", "native webrtc error"), session.sessionId);
            }
        });
    }

    private boolean isPolitePeer(String target) {
        String safeTarget = normalizeTarget(target);
        if (safeTarget.isEmpty()) {
            return false;
        }

        String localName = String.valueOf(ReactorHttpService.getCurrentReactorNameForP2P()).trim().toLowerCase(Locale.ROOT);
        return !localName.isEmpty() && !localName.equals(safeTarget) && localName.compareTo(safeTarget) > 0;
    }

    private boolean hasIncomingOfferCollision(SessionState session) {
        if (session == null || session.peerConnection == null || session.answerSent) {
            return false;
        }

        try {
            return session.makingOffer
                    || session.peerConnection.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER;
        } catch (Exception ignored) {
            return session.makingOffer;
        }
    }

    private boolean shouldApplyIncomingOffer(SessionState session) {
        if (session == null || session.peerConnection == null) {
            return false;
        }
        if (session.answerSent) {
            return false;
        }
        try {
            PeerConnection.SignalingState signalingState = session.peerConnection.signalingState();
            return signalingState == PeerConnection.SignalingState.STABLE
                    || signalingState == PeerConnection.SignalingState.HAVE_REMOTE_OFFER;
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean shouldApplyIncomingAnswer(SessionState session) {
        if (session == null || session.peerConnection == null) {
            return false;
        }

        try {
            // An answer must only be applied while a local offer is pending. Applying a
            // duplicate/late answer once the connection is already STABLE sets the DTLS
            // role a second time and fails with "Failed to set SSL role for the transport".
            return session.peerConnection.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void createOffer(SessionState session) {
        MediaConstraints constraints = new MediaConstraints();
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"));
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));

        session.makingOffer = true;
        session.peerConnection.createOffer(new SimpleSdpObserver(
                sdp -> {
                    if (session.localOfferAborted || sessions.get(session.target) != session) {
                        session.makingOffer = false;
                        ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "offer abandoned for " + session.target + " after polite collision");
                        return;
                    }

                    ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "offer created for " + session.target);
                    CountDownLatch localDescriptionLatch = new CountDownLatch(1);
                    session.peerConnection.setLocalDescription(new SdpObserver() {
                        @Override
                        public void onCreateSuccess(SessionDescription sessionDescription) {
                            // no-op
                        }

                        @Override
                        public void onSetSuccess() {
                            localDescriptionLatch.countDown();
                        }

                        @Override
                        public void onCreateFailure(String s) {
                            localDescriptionLatch.countDown();
                        }

                        @Override
                        public void onSetFailure(String s) {
                            localDescriptionLatch.countDown();
                        }
                    }, sdp);

                    try {
                        localDescriptionLatch.await(3L, TimeUnit.SECONDS);
                    } catch (InterruptedException interruptedException) {
                        Thread.currentThread().interrupt();
                    }

                    if (session.localOfferAborted || sessions.get(session.target) != session) {
                        session.makingOffer = false;
                        ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "offer send skipped for " + session.target + " after polite collision");
                        return;
                    }

                    JSObject payload = new JSObject();
                    payload.put("type", sdp.type.canonicalForm());
                    payload.put("sdp", sdp.description);
                    payload.put("sdpBase64", Base64.encodeToString(String.valueOf(sdp.description == null ? "" : sdp.description).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                    ReactorHttpService.sendP2PSignal(session.target, "offer", payload, session.sessionId);
                    session.makingOffer = false;
                },
                error -> {
                    session.makingOffer = false;
                    ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "offer failed for " + session.target + ": " + error);
                    ReactorHttpService.sendP2PSignal(session.target, "failed", new JSObject().put("reason", "offer failed: " + error), session.sessionId);
                }
        ), constraints);
    }

    private void applyRemoteSdpAndAnswer(SessionState session, JSONObject payload) {
        if (!applyRemoteSdp(session, payload, SessionDescription.Type.OFFER)) {
            return;
        }

        MediaConstraints constraints = new MediaConstraints();
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"));
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));

        session.peerConnection.createAnswer(new SimpleSdpObserver(
                sdp -> {
                ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "answer created for " + session.target);
                        CountDownLatch localDescriptionLatch = new CountDownLatch(1);
                        session.peerConnection.setLocalDescription(new SdpObserver() {
                        @Override
                        public void onCreateSuccess(SessionDescription sessionDescription) {
                            // no-op
                        }

                        @Override
                        public void onSetSuccess() {
                            localDescriptionLatch.countDown();
                        }

                        @Override
                        public void onCreateFailure(String s) {
                            localDescriptionLatch.countDown();
                        }

                        @Override
                        public void onSetFailure(String s) {
                            localDescriptionLatch.countDown();
                        }
                    }, sdp);
                        try {
                        localDescriptionLatch.await(3L, TimeUnit.SECONDS);
                        } catch (InterruptedException interruptedException) {
                            Thread.currentThread().interrupt();
                        }
                    JSObject answerPayload = new JSObject();
                    answerPayload.put("type", sdp.type.canonicalForm());
                    answerPayload.put("sdp", sdp.description);
                    answerPayload.put("sdpBase64", Base64.encodeToString(String.valueOf(sdp.description == null ? "" : sdp.description).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                    ReactorHttpService.sendP2PSignal(session.target, "answer", answerPayload, session.sessionId);
                    session.answerSent = true;
                    refreshConnectedStateIfAlreadyOpen(session);
                },
                error -> {
                    ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "answer failed for " + session.target + ": " + error);
                    ReactorHttpService.sendP2PSignal(session.target, "failed", new JSObject().put("reason", "answer failed: " + error), session.sessionId);
                }
        ), constraints);
    }

    private boolean applyRemoteSdp(SessionState session, JSONObject payload, SessionDescription.Type defaultType) {
        if (payload == null) {
            ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "remote SDP missing payload from " + (session != null ? session.target : "unknown"));
            return false;
        }

        payload = normalizeSignalPayload(payload);
        if (payload == null) {
            ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "remote SDP payload normalize failed for " + (session != null ? session.target : "unknown"));
            return false;
        }

        Object rawSdpPayload = extractRawSdpPayload(payload);
        List<String> sdpCandidates = buildSdpCandidates(rawSdpPayload);
        if (sdpCandidates.isEmpty()) {
            ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "remote SDP empty for " + session.target);
            return false;
        }

        String typeRaw = String.valueOf(payload.optString("type", defaultType.canonicalForm())).trim().toLowerCase(Locale.ROOT);
        SessionDescription.Type sdpType = "answer".equals(typeRaw) ? SessionDescription.Type.ANSWER : SessionDescription.Type.OFFER;
        String lastReason = "setRemoteDescription failed";
        boolean applied = false;
        List<Integer> attemptOrder = buildSdpVariantAttemptOrder(sdpCandidates.size());
        for (int attempt = 0; attempt < attemptOrder.size(); attempt += 1) {
            int variantIndex = attemptOrder.get(attempt);
            String sdp = sdpCandidates.get(variantIndex);
            boolean hasDataChannelMLine = sdp.contains("\nm=application") || sdp.startsWith("m=application");
            ReactorHttpService.logGlobalEvent(
                    "P2P_NEGOTIATION",
                    "remote SDP normalized for " + session.target + " type=" + sdpType.canonicalForm() + " len=" + sdp.length() + " variant=" + (variantIndex + 1) + "/" + sdpCandidates.size() + " attempt=" + (attempt + 1) + "/" + attemptOrder.size() + " datachannel=" + hasDataChannelMLine
            );

            String attemptError = applyRemoteDescriptionAttempt(session, sdpType, sdp);
            if (attemptError == null) {
                preferredSdpVariantIndex = variantIndex;
                applied = true;
                break;
            }
            lastReason = attemptError;
        }

        if (!applied) {
            ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "remote SDP failed for " + session.target + " type=" + sdpType.canonicalForm() + " reason=" + lastReason);
            return false;
        }

        ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "remote SDP applied for " + session.target + " type=" + sdpType.canonicalForm());

        if (sdpType == SessionDescription.Type.ANSWER) {
            session.state = "connected-p2p";
        }

        refreshConnectedStateIfAlreadyOpen(session);

        flushQueuedCandidates(session);
        return true;
    }

    private void refreshConnectedStateIfAlreadyOpen(SessionState session) {
        if (session == null) {
            return;
        }

        boolean dataChannelOpen = session.dataChannel != null && session.dataChannel.state() == DataChannel.State.OPEN;
        boolean peerConnected = false;
        try {
            peerConnected = session.peerConnection != null && session.peerConnection.connectionState() == PeerConnection.PeerConnectionState.CONNECTED;
        } catch (Exception ignored) {
            peerConnected = false;
        }

        if (!dataChannelOpen && !peerConnected) {
            return;
        }

        session.state = "connected-p2p";
        ReactorHttpService.sendP2PSignal(session.target, "connected", null, session.sessionId);
    }

    private String applyRemoteDescriptionAttempt(SessionState session, SessionDescription.Type sdpType, String sdp) {
        if (session == null || session.peerConnection == null) {
            return "peer connection unavailable";
        }

        SessionDescription description = new SessionDescription(sdpType, sdp);
        CountDownLatch remoteDescriptionLatch = new CountDownLatch(1);
        final boolean[] remoteDescriptionApplied = {false};
        final String[] remoteDescriptionError = {""};
        session.remoteDescriptionSet = false;
        session.peerConnection.setRemoteDescription(new SdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sessionDescription) {
                // no-op
            }

            @Override
            public void onSetSuccess() {
                session.remoteDescriptionSet = true;
                remoteDescriptionApplied[0] = true;
                remoteDescriptionLatch.countDown();
            }

            @Override
            public void onCreateFailure(String s) {
                remoteDescriptionError[0] = String.valueOf(s == null ? "unknown" : s);
                remoteDescriptionLatch.countDown();
            }

            @Override
            public void onSetFailure(String s) {
                remoteDescriptionError[0] = String.valueOf(s == null ? "unknown" : s);
                remoteDescriptionLatch.countDown();
            }
        }, description);

        try {
            if (!remoteDescriptionLatch.await(3L, TimeUnit.SECONDS)) {
                return "remote SDP timeout";
            }
        } catch (InterruptedException interruptedException) {
            Thread.currentThread().interrupt();
            return "remote SDP interrupted";
        }

        if (remoteDescriptionApplied[0] && session.remoteDescriptionSet) {
            return null;
        }

        String reason = String.valueOf(remoteDescriptionError[0] == null ? "unknown" : remoteDescriptionError[0]).trim();
        return reason.isEmpty() ? "setRemoteDescription failed" : reason;
    }

    private List<String> buildSdpCandidates(Object rawSdpPayload) {
        List<String> candidates = new ArrayList<>();

        String decodedRaw = decodeLooseSdpString(rawSdpPayload);
        addSdpCandidate(candidates, decodedRaw);

        String normalized = normalizeSdpString(rawSdpPayload);
        addSdpCandidate(candidates, normalized);

        String compat = stripPotentiallyUnsupportedSdpLines(normalized);
        addSdpCandidate(candidates, compat);

        return candidates;
    }

    private List<Integer> buildSdpVariantAttemptOrder(int size) {
        List<Integer> order = new ArrayList<>();
        if (size <= 0) {
            return order;
        }

        int preferredIndex = preferredSdpVariantIndex;
        if (preferredIndex >= 0 && preferredIndex < size) {
            order.add(preferredIndex);
        }

        for (int i = 0; i < size; i += 1) {
            if (i == preferredIndex) {
                continue;
            }
            order.add(i);
        }

        return order;
    }

    private void addSdpCandidate(List<String> candidates, String value) {
        String safeValue = String.valueOf(value == null ? "" : value);
        if (safeValue.isEmpty()) {
            return;
        }
        if (!safeValue.startsWith("v=0")) {
            return;
        }
        if (candidates.contains(safeValue)) {
            return;
        }
        candidates.add(safeValue);
    }

    private String decodeLooseSdpString(Object rawSdp) {
        if (rawSdp == null) {
            return "";
        }

        String current = String.valueOf(rawSdp).trim();
        if (current.isEmpty()) {
            return "";
        }

        for (int i = 0; i < 2; i += 1) {
            if (!(current.startsWith("\"") && current.endsWith("\""))) {
                break;
            }
            try {
                Object parsed = new org.json.JSONTokener(current).nextValue();
                if (parsed instanceof String) {
                    current = String.valueOf(parsed).trim();
                    continue;
                }
            } catch (Exception ignored) {
                break;
            }
            break;
        }

        current = current
                .replace("\\u000d\\u000a", "\r\n")
                .replace("\\u000a", "\n")
                .replace("\\u000d", "\r")
                .replace("\\r\\n", "\r\n")
                .replace("\\n", "\n")
                .replace("\\r", "\r");

        return current;
    }

    private String stripPotentiallyUnsupportedSdpLines(String sdp) {
        String safeSdp = String.valueOf(sdp == null ? "" : sdp);
        if (safeSdp.isEmpty()) {
            return "";
        }

        String normalized = safeSdp.replace("\r\n", "\n").replace('\r', '\n');
        String[] lines = normalized.split("\n");
        StringBuilder builder = new StringBuilder();
        for (String line : lines) {
            String safeLine = String.valueOf(line == null ? "" : line).trim();
            if (safeLine.isEmpty()) {
                continue;
            }
            if (safeLine.startsWith("a=extmap:")) {
                continue;
            }
            if ("a=extmap-allow-mixed".equalsIgnoreCase(safeLine)) {
                continue;
            }
            builder.append(safeLine).append("\r\n");
        }

        return builder.toString();
    }

    private String normalizeSdpString(Object rawSdp) {
        if (rawSdp == null) {
            return "";
        }

        String current = String.valueOf(rawSdp).trim();
        if (current.isEmpty()) {
            return "";
        }

        // Unwrap JSON-string encoded values up to a small bounded depth.
        for (int i = 0; i < 2; i += 1) {
            if (!(current.startsWith("\"") && current.endsWith("\""))) {
                break;
            }
            try {
                Object parsed = new org.json.JSONTokener(current).nextValue();
                if (parsed instanceof String) {
                    current = String.valueOf(parsed).trim();
                    continue;
                }
            } catch (Exception ignored) {
                break;
            }
            break;
        }

        // Handle accidental nested JSON payloads where SDP is embedded again.
        for (int i = 0; i < 2; i += 1) {
            if (!(current.startsWith("{") && current.endsWith("}"))) {
                break;
            }
            try {
                JSONObject nested = new JSONObject(current);
                Object nestedSdp = nested.opt("sdp");
                if (nestedSdp != null) {
                    current = String.valueOf(nestedSdp).trim();
                    continue;
                }
            } catch (Exception ignored) {
                break;
            }
            break;
        }

        // Convert escaped line breaks into SDP-compatible separators.
        current = current
                .replace("\\u000d\\u000a", "\r\n")
                .replace("\\u000a", "\n")
                .replace("\\u000d", "\r")
                .replace("\\r\\n", "\r\n")
                .replace("\\n", "\n")
                .replace("\\r", "\r");

        // Canonicalize all line endings to CRLF for stricter SDP parsers.
        current = current.replace("\r\n", "\n").replace('\r', '\n');
        String[] lines = current.split("\n");
        StringBuilder builder = new StringBuilder();
        for (String line : lines) {
            String safeLine = String.valueOf(line == null ? "" : line).trim();
            if (safeLine.isEmpty()) {
                continue;
            }
            // Some native parser builds reject this line; safe to omit for datachannel-only SDP.
            if ("a=extmap-allow-mixed".equalsIgnoreCase(safeLine)) {
                continue;
            }
            builder.append(safeLine).append("\r\n");
        }

        current = builder.toString();

        if (!current.startsWith("v=0")) {
            return "";
        }

        return current.trim();
    }

    private Object extractRawSdpPayload(JSONObject payload) {
        if (payload == null) {
            return null;
        }

        String sdpBase64 = String.valueOf(payload.optString("sdpBase64", "")).trim();
        if (!sdpBase64.isEmpty()) {
            try {
                byte[] decoded = Base64.decode(sdpBase64, Base64.DEFAULT);
                return new String(decoded, StandardCharsets.UTF_8);
            } catch (Exception ignored) {
                // Fallback to raw sdp below.
            }
        }

        return payload.opt("sdp");
    }

    private JSONObject normalizeSignalPayload(JSONObject payload) {
        if (payload == null) {
            return null;
        }

        if (payload.has("sdp") || payload.has("candidate")) {
            return payload;
        }

        String nestedPayload = String.valueOf(payload.optString("payload", "")).trim();
        if (nestedPayload.isEmpty()) {
            return payload;
        }

        try {
            JSONObject parsed = new JSONObject(nestedPayload);
            return parsed;
        } catch (Exception ignored) {
            return payload;
        }
    }

    private void applyRemoteCandidate(SessionState session, JSONObject payload) {
        if (payload == null) {
            return;
        }

        String candidateValue = String.valueOf(payload.optString("candidate", "")).trim();
        if (candidateValue.isEmpty()) {
            return;
        }

        String sdpMid = String.valueOf(payload.optString("sdpMid", "0"));
        int sdpMLineIndex = payload.optInt("sdpMLineIndex", 0);
        IceCandidate candidate = new IceCandidate(sdpMid, sdpMLineIndex, candidateValue);
        if (!session.remoteDescriptionSet) {
            session.queuedCandidates.add(candidate);
            ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "queued ICE candidate for " + session.target + " (remote SDP not ready)");
            return;
        }

        session.peerConnection.addIceCandidate(candidate);
        ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "applied ICE candidate for " + session.target);
    }

    private void flushQueuedCandidates(SessionState session) {
        if (session == null || session.queuedCandidates == null || session.queuedCandidates.isEmpty()) {
            return;
        }

        List<IceCandidate> queued = new ArrayList<>(session.queuedCandidates);
        session.queuedCandidates.clear();
        for (IceCandidate candidate : queued) {
            try {
                session.peerConnection.addIceCandidate(candidate);
            } catch (Exception ignored) {
                // ignore add candidate failures and continue
            }
        }
    }

    private void attachDataChannelObserver(SessionState session) {
        if (session.dataChannel == null) {
            return;
        }

        session.dataChannel.registerObserver(new DataChannel.Observer() {
            @Override
            public void onBufferedAmountChange(long previousAmount) {
                // no-op
            }

            @Override
            public void onStateChange() {
                DataChannel.State state = session.dataChannel != null ? session.dataChannel.state() : DataChannel.State.CLOSED;
                session.dataChannelState = state.name().toLowerCase(Locale.ROOT);
                ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "datachannel state=" + session.dataChannelState + " target=" + session.target);
                if (state == DataChannel.State.OPEN) {
                    session.state = "connected-p2p";
                    session.lastHeartbeatAt = System.currentTimeMillis();
                    startHeartbeat(session);
                    ReactorHttpService.sendP2PSignal(session.target, "connected", null, session.sessionId);
                } else if (state == DataChannel.State.CONNECTING) {
                    session.state = "connecting";
                } else if (state == DataChannel.State.CLOSED || state == DataChannel.State.CLOSING) {
                    stopHeartbeat(session);
                    session.state = "fallback-exchange";
                }
            }

            @Override
            public void onMessage(DataChannel.Buffer buffer) {
                if (buffer == null || buffer.binary || buffer.data == null) {
                    return;
                }

                try {
                    ByteBuffer data = buffer.data.duplicate();
                    byte[] bytes = new byte[data.remaining()];
                    data.get(bytes);
                    String text = new String(bytes, StandardCharsets.UTF_8);
                    JSONObject payload = extractControlPayloadFromEnvelope(text);
                    if (payload != null && payload.optBoolean("__reactorP2PControl", false)) {
                        handleControlPayload(session, payload);
                        return;
                    }

                    ReactorHttpService.handleIncomingP2PEnvelope(session != null ? session.target : "", text);
                } catch (Exception ignored) {
                    // Ignore malformed envelopes and keep session alive.
                }
            }
        });
    }

    private JSONObject buildControlEnvelope(JSONObject payload) throws Exception {
        JSONObject envelope = new JSONObject();
        envelope.put("kind", "message");
        envelope.put("payloadType", "json");
        envelope.put("payload", payload != null ? payload.toString() : "{}");
        envelope.put("contentType", "application/json; charset=utf-8");

        JSONObject headers = new JSONObject();
        headers.put("content-type", "application/json; charset=utf-8");
        headers.put("x-reactor-p2p-control", "true");
        envelope.put("messageHeaders", headers);
        return envelope;
    }

    private JSONObject extractControlPayloadFromEnvelope(String rawText) {
        if (rawText == null || rawText.trim().isEmpty()) {
            return null;
        }

        try {
            JSONObject root = new JSONObject(rawText);
            String payloadType = String.valueOf(root.optString("payloadType", "")).trim().toLowerCase(Locale.ROOT);
            String contentType = String.valueOf(root.optString("contentType", "")).trim().toLowerCase(Locale.ROOT);
            JSONObject headers = root.optJSONObject("messageHeaders");
            String headerContentType = headers != null
                    ? String.valueOf(headers.optString("content-type", "")).trim().toLowerCase(Locale.ROOT)
                    : "";

            boolean jsonPayload = "json".equals(payloadType)
                    || contentType.contains("application/json")
                    || headerContentType.contains("application/json")
                    || (headers != null && headers.optString("x-reactor-p2p-control", "").trim().length() > 0);

            if (!jsonPayload) {
                return root.optBoolean("__reactorP2PControl", false) ? root : null;
            }

            if ("json".equals(payloadType)) {
                String payload = String.valueOf(root.optString("payload", "")).trim();
                return payload.isEmpty() ? null : new JSONObject(payload);
            }

            if ("string".equals(payloadType) || payloadType.isEmpty()) {
                String payload = String.valueOf(root.optString("payload", "")).trim();
                if (payload.isEmpty()) {
                    return root.optBoolean("__reactorP2PControl", false) ? root : null;
                }
                return new JSONObject(payload);
            }

            return root.optBoolean("__reactorP2PControl", false) ? root : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void handleControlPayload(SessionState session, JSONObject payload) {
        if (session == null || payload == null) {
            return;
        }

        String action = String.valueOf(payload.optString("action", "")).trim().toLowerCase(Locale.ROOT);
        String requestId = String.valueOf(payload.optString("requestId", "")).trim();
        if (action.isEmpty()) {
            return;
        }

        if ("heartbeat-ping".equals(action) || "heartbeat-pong".equals(action)) {
            session.lastHeartbeatAt = System.currentTimeMillis();
            if ("heartbeat-ping".equals(action)) {
                sendHeartbeat(session, "heartbeat-pong");
            }
            return;
        }

        if (requestId.isEmpty()) {
            return;
        }

        if ("endpoints-request".equals(action)) {
            try {
                JSONObject response = new JSONObject();
                response.put("__reactorP2PControl", true);
                response.put("action", "endpoints-response");
                response.put("requestId", requestId);
                response.put("node", ReactorHttpService.getCurrentReactorNameForP2P());
                response.put("endpoints", ReactorHttpService.getDiscoveryEndpointsPayloadForP2P());
                response.put("generatedAt", Instant.now().toString());
                if (session.dataChannel != null && session.dataChannel.state() == DataChannel.State.OPEN) {
                    JSONObject envelope = buildControlEnvelope(response);
                    byte[] encoded = envelope.toString().getBytes(StandardCharsets.UTF_8);
                    session.dataChannel.send(new DataChannel.Buffer(ByteBuffer.wrap(encoded), false));
                }
            } catch (Exception ignored) {
                // Ignore response errors; caller will timeout and fallback.
            }
            return;
        }

        if ("endpoints-response".equals(action)) {
            PendingEndpointsRequest pending = pendingEndpointRequests.get(requestId);
            if (pending == null) {
                return;
            }

            JSONArray endpointsRaw = payload.optJSONArray("endpoints");
            JSArray endpoints = new JSArray();
            if (endpointsRaw != null) {
                for (int i = 0; i < endpointsRaw.length(); i += 1) {
                    Object item = endpointsRaw.opt(i);
                    if (item == null) {
                        continue;
                    }
                    endpoints.put(item);
                }
            }

            pending.node = String.valueOf(payload.optString("node", session.target)).trim();
            pending.endpoints = endpoints;
            pending.generatedAt = String.valueOf(payload.optString("generatedAt", "")).trim();
            pending.latch.countDown();
        }
    }

    private void startHeartbeat(SessionState session) {
        if (session == null) {
            return;
        }

        stopHeartbeat(session);
        session.heartbeatFuture = heartbeatExecutor.scheduleAtFixedRate(() -> {
            if (session.dataChannel == null || session.dataChannel.state() != DataChannel.State.OPEN) {
                stopHeartbeat(session);
                return;
            }

            long lastHeartbeatAt = session.lastHeartbeatAt;
            if (lastHeartbeatAt > 0L && System.currentTimeMillis() - lastHeartbeatAt > P2P_HEARTBEAT_TIMEOUT_MS) {
                ReactorHttpService.logGlobalEvent("P2P_NEGOTIATION", "datachannel heartbeat timeout target=" + session.target);
                sessions.remove(session.target, session);
                closeSessionInternal(session, true);
                ReactorHttpService.sendP2PSignal(session.target, "failed", new JSObject().put("reason", "p2p datachannel heartbeat timeout"), session.sessionId);
                return;
            }

            sendHeartbeat(session, "heartbeat-ping");
        }, P2P_HEARTBEAT_INTERVAL_MS, P2P_HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    private void stopHeartbeat(SessionState session) {
        if (session == null || session.heartbeatFuture == null) {
            return;
        }

        session.heartbeatFuture.cancel(false);
        session.heartbeatFuture = null;
    }

    private boolean sendHeartbeat(SessionState session, String action) {
        if (session == null || session.dataChannel == null || session.dataChannel.state() != DataChannel.State.OPEN) {
            return false;
        }

        try {
            JSONObject payload = new JSONObject();
            payload.put("__reactorP2PControl", true);
            payload.put("action", action);
            payload.put("sessionId", session.sessionId);
            payload.put("timestamp", Instant.now().toString());
            JSONObject envelope = buildControlEnvelope(payload);
            byte[] encoded = envelope.toString().getBytes(StandardCharsets.UTF_8);
            return session.dataChannel.send(new DataChannel.Buffer(ByteBuffer.wrap(encoded), false));
        } catch (Exception ignored) {
            return false;
        }
    }

    private void closeSessionInternal(SessionState session, boolean closePeer) {
        if (session == null) {
            return;
        }

        stopHeartbeat(session);

        if (session.dataChannel != null) {
            try {
                session.dataChannel.close();
            } catch (Exception ignored) {
            }
            try {
                session.dataChannel.dispose();
            } catch (Exception ignored) {
            }
            session.dataChannel = null;
        }

        if (closePeer && session.peerConnection != null) {
            try {
                session.peerConnection.close();
            } catch (Exception ignored) {
            }
            try {
                session.peerConnection.dispose();
            } catch (Exception ignored) {
            }
            session.peerConnection = null;
        }

        session.state = "idle";
        session.dataChannelState = "closed";
    }

    private static String normalizeTarget(String rawTarget) {
        return String.valueOf(rawTarget == null ? "" : rawTarget).trim().toLowerCase(Locale.ROOT);
    }

    private static int sanitizePort(int value, int fallback) {
        if (value < 1 || value > 65535) {
            return fallback;
        }
        return value;
    }

    public static final class RelayConfig {
        public String stunHost = "";
        public int stunPort = 3478;
        public String turnHost = "";
        public int turnPort = 3478;
        public boolean turnTls = false;
        public String turnUsername = "";
        public String turnPassword = "";
        public String token = "";
    }

    private static final class SessionState {
        String target;
        String sessionId;
        String state;
        String dataChannelState;
        boolean initiator;
        boolean offerStarted;
        boolean answerSent;
        boolean makingOffer;
        boolean localOfferAborted;
        boolean remoteDescriptionSet;
        volatile long lastHeartbeatAt;
        volatile ScheduledFuture<?> heartbeatFuture;
        PeerConnection peerConnection;
        DataChannel dataChannel;
        List<IceCandidate> queuedCandidates = new ArrayList<>();
    }

    private static final class PendingEndpointsRequest {
        final String requestId;
        final String target;
        final CountDownLatch latch;
        volatile String node;
        volatile JSArray endpoints;
        volatile String generatedAt;

        PendingEndpointsRequest(String requestId, String target) {
            this.requestId = requestId;
            this.target = target;
            this.latch = new CountDownLatch(1);
            this.node = target;
            this.endpoints = new JSArray();
            this.generatedAt = null;
        }
    }

    private static final class SimpleSdpObserver implements SdpObserver {
        interface SuccessHandler {
            void onSuccess(SessionDescription sdp);
        }

        interface ErrorHandler {
            void onError(String error);
        }

        private final SuccessHandler successHandler;
        private final ErrorHandler errorHandler;

        SimpleSdpObserver(SuccessHandler successHandler, ErrorHandler errorHandler) {
            this.successHandler = successHandler;
            this.errorHandler = errorHandler;
        }

        @Override
        public void onCreateSuccess(SessionDescription sessionDescription) {
            if (successHandler != null) {
                successHandler.onSuccess(sessionDescription);
            }
        }

        @Override
        public void onSetSuccess() {
            // no-op
        }

        @Override
        public void onCreateFailure(String s) {
            if (errorHandler != null) {
                errorHandler.onError(s);
            }
        }

        @Override
        public void onSetFailure(String s) {
            if (errorHandler != null) {
                errorHandler.onError(s);
            }
        }
    }

    private final class PeerConnectionObserver implements PeerConnection.Observer {
        private final SessionState session;

        PeerConnectionObserver(SessionState session) {
            this.session = session;
        }

        @Override
        public void onSignalingChange(PeerConnection.SignalingState signalingState) {
            // no-op
        }

        @Override
        public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
            if (iceConnectionState == null) {
                return;
            }

            String state = iceConnectionState.name().toLowerCase(Locale.ROOT);
            if ("connected".equals(state) || "completed".equals(state)) {
                session.state = "connected-p2p";
                ReactorHttpService.sendP2PSignal(session.target, "connected", null, session.sessionId);
                return;
            }

            if ("failed".equals(state) || "disconnected".equals(state)) {
                session.state = "fallback-exchange";
                ReactorHttpService.sendP2PSignal(session.target, "failed", new JSObject().put("reason", "ice " + state), session.sessionId);
            }
        }

        @Override
        public void onIceConnectionReceivingChange(boolean b) {
            // no-op
        }

        @Override
        public void onIceGatheringChange(PeerConnection.IceGatheringState iceGatheringState) {
            // no-op
        }

        @Override
        public void onIceCandidate(IceCandidate iceCandidate) {
            if (iceCandidate == null) {
                return;
            }

            JSObject payload = new JSObject();
            payload.put("candidate", iceCandidate.sdp);
            payload.put("sdpMid", iceCandidate.sdpMid == null ? "0" : iceCandidate.sdpMid);
            payload.put("sdpMLineIndex", iceCandidate.sdpMLineIndex);
            ReactorHttpService.sendP2PSignal(session.target, "candidate", payload, session.sessionId);
        }

        @Override
        public void onIceCandidatesRemoved(IceCandidate[] iceCandidates) {
            // no-op
        }

        @Override
        public void onAddStream(org.webrtc.MediaStream mediaStream) {
            // no-op
        }

        @Override
        public void onRemoveStream(org.webrtc.MediaStream mediaStream) {
            // no-op
        }

        @Override
        public void onDataChannel(DataChannel dataChannel) {
            session.dataChannel = dataChannel;
            attachDataChannelObserver(session);
        }

        @Override
        public void onRenegotiationNeeded() {
            // no-op
        }

        @Override
        public void onAddTrack(org.webrtc.RtpReceiver rtpReceiver, org.webrtc.MediaStream[] mediaStreams) {
            // no-op
        }

        @Override
        public void onTrack(org.webrtc.RtpTransceiver transceiver) {
            // no-op
        }

        @Override
        public void onConnectionChange(PeerConnection.PeerConnectionState newState) {
            if (newState == null) {
                return;
            }

            String state = newState.name().toLowerCase(Locale.ROOT);
            if ("connected".equals(state)) {
                session.state = "connected-p2p";
                return;
            }
            if ("failed".equals(state)) {
                session.state = "fallback-exchange";
            }
        }

        @Override
        public void onStandardizedIceConnectionChange(PeerConnection.IceConnectionState newState) {
            // no-op
        }
    }
}
