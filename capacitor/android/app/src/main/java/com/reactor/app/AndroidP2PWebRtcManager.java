package com.reactor.app;

import android.content.Context;
import android.util.Log;

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
import java.util.concurrent.TimeUnit;

public final class AndroidP2PWebRtcManager {
    private static final String TAG = "AndroidP2PWebRtc";

    private static volatile AndroidP2PWebRtcManager instance;

    private final Context appContext;
    private final ExecutorService executor;
    private final Map<String, SessionState> sessions;
    private final Map<String, PendingScriptsRequest> pendingScriptRequests;
    private volatile PeerConnectionFactory peerConnectionFactory;
    private volatile boolean initialized;

    private AndroidP2PWebRtcManager(Context context) {
        this.appContext = context.getApplicationContext();
        this.executor = Executors.newSingleThreadExecutor();
        this.sessions = new ConcurrentHashMap<>();
        this.pendingScriptRequests = new ConcurrentHashMap<>();
        this.initialized = false;
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

                ReactorHttpService.setP2PSignalListener((from, sessionId, signalType, payload) ->
                        handleIncomingSignal(from, sessionId, signalType, payload)
                );

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

    public JSObject startSession(String target, boolean initiator, RelayConfig relayConfig) {
        String safeTarget = normalizeTarget(target);
        if (safeTarget.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "invalid target");
        }

        ensureInitialized();

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

    public JSObject requestRemoteScripts(String target, RelayConfig relayConfig, long timeoutMs) {
        String safeTarget = normalizeTarget(target);
        if (safeTarget.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "invalid target");
        }

        ensureInitialized();

        try {
            SessionState session = ensureSession(safeTarget, true, relayConfig != null ? relayConfig : new RelayConfig());
            if (session == null || session.peerConnection == null) {
                return new JSObject().put("ok", false).put("error", "unable to create peer connection");
            }

            if (!session.offerStarted) {
                session.offerStarted = true;
                createOffer(session);
            }

            long safeTimeoutMs = timeoutMs > 0 ? timeoutMs : 8000L;
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
            PendingScriptsRequest pending = new PendingScriptsRequest(requestId, safeTarget);
            pendingScriptRequests.put(requestId, pending);

            JSONObject payload = new JSONObject();
            payload.put("__reactorP2PControl", true);
            payload.put("action", "scripts-request");
            payload.put("requestId", requestId);
            payload.put("timestamp", Instant.now().toString());

            JSONObject envelope = buildControlEnvelope(payload);
            byte[] encoded = envelope.toString().getBytes(StandardCharsets.UTF_8);
            boolean sent = session.dataChannel.send(new DataChannel.Buffer(ByteBuffer.wrap(encoded), false));
            if (!sent) {
                pendingScriptRequests.remove(requestId);
                return new JSObject().put("ok", false).put("error", "unable to send p2p scripts request");
            }

            boolean completed = pending.latch.await(safeTimeoutMs, TimeUnit.MILLISECONDS);
            pendingScriptRequests.remove(requestId);
            if (!completed) {
                return new JSObject().put("ok", false).put("error", "p2p scripts request timeout");
            }

            return new JSObject()
                    .put("ok", true)
                    .put("target", safeTarget)
                    .put("requestId", requestId)
                    .put("node", pending.node)
                    .put("scripts", pending.scripts != null ? pending.scripts : new JSArray())
                    .put("generatedAt", pending.generatedAt != null ? pending.generatedAt : JSONObject.NULL);
        } catch (Exception error) {
            return new JSObject().put("ok", false).put("error", error.getMessage() != null ? error.getMessage() : "unable to request remote scripts");
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
            String safeTarget = normalizeTarget(from);
            String safeSignalType = String.valueOf(signalType == null ? "" : signalType).trim().toLowerCase(Locale.ROOT);
            if (safeTarget.isEmpty() || safeSignalType.isEmpty()) {
                return;
            }

            RelayConfig relayConfig = fromWorkingMode(ReactorHttpService.getWorkingModeConfigForP2P());
            SessionState session = sessions.get(safeTarget);
            if (session == null && ("offer".equals(safeSignalType) || "candidate".equals(safeSignalType))) {
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
                    applyRemoteSdpAndAnswer(session, payload);
                    return;
                }
                if ("answer".equals(safeSignalType)) {
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

    private void createOffer(SessionState session) {
        MediaConstraints constraints = new MediaConstraints();
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"));
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));

        session.peerConnection.createOffer(new SimpleSdpObserver(
                sdp -> {
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
                    JSObject payload = new JSObject();
                    payload.put("type", sdp.type.canonicalForm());
                    payload.put("sdp", sdp.description);
                    ReactorHttpService.sendP2PSignal(session.target, "offer", payload, session.sessionId);
                },
                error -> ReactorHttpService.sendP2PSignal(session.target, "failed", new JSObject().put("reason", "offer failed: " + error), session.sessionId)
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
                    ReactorHttpService.sendP2PSignal(session.target, "answer", answerPayload, session.sessionId);
                },
                error -> ReactorHttpService.sendP2PSignal(session.target, "failed", new JSObject().put("reason", "answer failed: " + error), session.sessionId)
        ), constraints);
    }

    private boolean applyRemoteSdp(SessionState session, JSONObject payload, SessionDescription.Type defaultType) {
        if (payload == null) {
            return false;
        }

        String sdp = String.valueOf(payload.optString("sdp", "")).trim();
        if (sdp.isEmpty()) {
            return false;
        }

        String typeRaw = String.valueOf(payload.optString("type", defaultType.canonicalForm())).trim().toLowerCase(Locale.ROOT);
        SessionDescription.Type sdpType = "answer".equals(typeRaw) ? SessionDescription.Type.ANSWER : SessionDescription.Type.OFFER;
        SessionDescription description = new SessionDescription(sdpType, sdp);
        CountDownLatch remoteDescriptionLatch = new CountDownLatch(1);
        session.remoteDescriptionSet = false;
        session.peerConnection.setRemoteDescription(new SdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sessionDescription) {
                // no-op
            }

            @Override
            public void onSetSuccess() {
                session.remoteDescriptionSet = true;
                remoteDescriptionLatch.countDown();
            }

            @Override
            public void onCreateFailure(String s) {
                remoteDescriptionLatch.countDown();
            }

            @Override
            public void onSetFailure(String s) {
                remoteDescriptionLatch.countDown();
            }
        }, description);

        try {
            if (!remoteDescriptionLatch.await(3L, TimeUnit.SECONDS)) {
                return false;
            }
        } catch (InterruptedException interruptedException) {
            Thread.currentThread().interrupt();
            return false;
        }

        if (sdpType == SessionDescription.Type.ANSWER) {
            session.state = "connected-p2p";
        }

        flushQueuedCandidates(session);
        return true;
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
            return;
        }

        session.peerConnection.addIceCandidate(candidate);
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
                if (state == DataChannel.State.OPEN) {
                    session.state = "connected-p2p";
                    ReactorHttpService.sendP2PSignal(session.target, "connected", null, session.sessionId);
                } else if (state == DataChannel.State.CONNECTING) {
                    session.state = "connecting";
                } else if (state == DataChannel.State.CLOSED || state == DataChannel.State.CLOSING) {
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
                    }
                } catch (Exception ignored) {
                    // Ignore malformed or unsupported P2P control payloads.
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
        if (action.isEmpty() || requestId.isEmpty()) {
            return;
        }

        if ("scripts-request".equals(action)) {
            try {
                JSONObject response = new JSONObject();
                response.put("__reactorP2PControl", true);
                response.put("action", "scripts-response");
                response.put("requestId", requestId);
                response.put("node", ReactorHttpService.getCurrentReactorNameForP2P());
                response.put("scripts", ReactorHttpService.getDiscoveryScriptsPayloadForP2P());
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

        if ("scripts-response".equals(action)) {
            PendingScriptsRequest pending = pendingScriptRequests.get(requestId);
            if (pending == null) {
                return;
            }

            JSONArray scriptsRaw = payload.optJSONArray("scripts");
            JSArray scripts = new JSArray();
            if (scriptsRaw != null) {
                for (int i = 0; i < scriptsRaw.length(); i += 1) {
                    Object item = scriptsRaw.opt(i);
                    if (item == null) {
                        continue;
                    }
                    scripts.put(item);
                }
            }

            pending.node = String.valueOf(payload.optString("node", session.target)).trim();
            pending.scripts = scripts;
            pending.generatedAt = String.valueOf(payload.optString("generatedAt", "")).trim();
            pending.latch.countDown();
        }
    }

    private void closeSessionInternal(SessionState session, boolean closePeer) {
        if (session == null) {
            return;
        }

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
        boolean remoteDescriptionSet;
        PeerConnection peerConnection;
        DataChannel dataChannel;
        List<IceCandidate> queuedCandidates = new ArrayList<>();
    }

    private static final class PendingScriptsRequest {
        final String requestId;
        final String target;
        final CountDownLatch latch;
        volatile String node;
        volatile JSArray scripts;
        volatile String generatedAt;

        PendingScriptsRequest(String requestId, String target) {
            this.requestId = requestId;
            this.target = target;
            this.latch = new CountDownLatch(1);
            this.node = target;
            this.scripts = new JSArray();
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
