package com.reactor.app;

import android.content.Context;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

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
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class AndroidP2PWebRtcManager {
    private static final String TAG = "AndroidP2PWebRtc";

    private static volatile AndroidP2PWebRtcManager instance;

    private final Context appContext;
    private final ExecutorService executor;
    private final Map<String, SessionState> sessions;
    private volatile PeerConnectionFactory peerConnectionFactory;
    private volatile boolean initialized;

    private AndroidP2PWebRtcManager(Context context) {
        this.appContext = context.getApplicationContext();
        this.executor = Executors.newSingleThreadExecutor();
        this.sessions = new ConcurrentHashMap<>();
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
            if (config.token != null && !config.token.isEmpty()) {
                builder.setUsername(config.token);
                builder.setPassword(config.token);
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

            RelayConfig relayConfig = new RelayConfig();
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
                    session.peerConnection.setLocalDescription(new SimpleSdpObserver(null, null), sdp);
                    JSObject payload = new JSObject();
                    payload.put("type", sdp.type.canonicalForm());
                    payload.put("sdp", sdp.description);
                    ReactorHttpService.sendP2PSignal(session.target, "offer", payload, session.sessionId);
                },
                error -> ReactorHttpService.sendP2PSignal(session.target, "failed", new JSObject().put("reason", "offer failed: " + error), session.sessionId)
        ), constraints);
    }

    private void applyRemoteSdpAndAnswer(SessionState session, JSONObject payload) {
        applyRemoteSdp(session, payload, SessionDescription.Type.OFFER);

        MediaConstraints constraints = new MediaConstraints();
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"));
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));

        session.peerConnection.createAnswer(new SimpleSdpObserver(
                sdp -> {
                    session.peerConnection.setLocalDescription(new SimpleSdpObserver(null, null), sdp);
                    JSObject answerPayload = new JSObject();
                    answerPayload.put("type", sdp.type.canonicalForm());
                    answerPayload.put("sdp", sdp.description);
                    ReactorHttpService.sendP2PSignal(session.target, "answer", answerPayload, session.sessionId);
                },
                error -> ReactorHttpService.sendP2PSignal(session.target, "failed", new JSObject().put("reason", "answer failed: " + error), session.sessionId)
        ), constraints);
    }

    private void applyRemoteSdp(SessionState session, JSONObject payload, SessionDescription.Type defaultType) {
        if (payload == null) {
            return;
        }

        String sdp = String.valueOf(payload.optString("sdp", "")).trim();
        if (sdp.isEmpty()) {
            return;
        }

        String typeRaw = String.valueOf(payload.optString("type", defaultType.canonicalForm())).trim().toLowerCase(Locale.ROOT);
        SessionDescription.Type sdpType = "answer".equals(typeRaw) ? SessionDescription.Type.ANSWER : SessionDescription.Type.OFFER;
        SessionDescription description = new SessionDescription(sdpType, sdp);
        session.peerConnection.setRemoteDescription(new SimpleSdpObserver(null, null), description);
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
        session.peerConnection.addIceCandidate(candidate);
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
                }
            }

            @Override
            public void onMessage(DataChannel.Buffer buffer) {
                // Native message bridge can be mapped to script events in a second phase.
            }
        });
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
        public String token = "";
    }

    private static final class SessionState {
        String target;
        String sessionId;
        String state;
        String dataChannelState;
        boolean initiator;
        boolean offerStarted;
        PeerConnection peerConnection;
        DataChannel dataChannel;
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
