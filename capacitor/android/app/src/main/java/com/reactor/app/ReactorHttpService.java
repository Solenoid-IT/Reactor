package com.reactor.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Environment;
import android.os.FileObserver;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.UnknownHostException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Enumeration;
import java.util.Set;
import java.util.UUID;
import java.util.Arrays;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.SSLContext;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.Dns;
import okio.ByteString;

public class ReactorHttpService extends Service {
    public static final String ACTION_START = "com.reactor.app.http.START";
    public static final String ACTION_STOP = "com.reactor.app.http.STOP";
    public static final String EXTRA_PORT = "port";

    public static final String PREFS_NAME = "reactor_mobile";
    public static final String PREF_HTTP_PORT = "httpServerPort";
    public static final String PREF_REACTOR_NAME = "reactorName";
    public static final String PREF_EXCHANGE_MODE = "exchangeMode";
    public static final String PREF_EXCHANGE_HOST = "exchangeHost";
    public static final String PREF_EXCHANGE_PORT = "exchangePort";
    public static final String PREF_EXCHANGE_TLS = "exchangeTls";
    public static final String PREF_EXCHANGE_TOKEN = "exchangeToken";
    public static final String PREF_MESSAGE_QUEUE_TTL_MS = "messageQueueTtlMs";
    public static final String PREF_MESSAGE_QUEUE_RETRY_MS = "messageQueueRetryMs";
    public static final int DEFAULT_PORT = 7070;
    private static final String WORKING_MODE_FILE = "working-mode.json";
    private static final String ENV_DIR = "envs";

    private static final String CHANNEL_ID = "reactor_http_channel";
    private static final String ENDPOINT_NOTIFY_CHANNEL_ID = "reactor_endpoint_notify_channel";
    private static final int NOTIFICATION_ID = 4242;
    private static final AtomicInteger ENDPOINT_NOTIFICATION_IDS = new AtomicInteger(5000);
    private static final String WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final long WS_HEARTBEAT_INTERVAL_MS = 15000L;
    private static final long WS_HEARTBEAT_TIMEOUT_MS = 45000L;
    private static final long WS_CLIENT_CONNECT_TIMEOUT_MS = 20000L;
    private static final long DEFAULT_MESSAGE_QUEUE_TTL_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final long DEFAULT_MESSAGE_QUEUE_RETRY_MS = 30000L;
    private static final long DEFAULT_P2P_SESSION_TIMEOUT_MS = 2L * 60L * 1000L;
    private static final long DEFAULT_P2P_AUTODIAL_COOLDOWN_MS = 30L * 1000L;
    private static final long NET_CHANGE_DEBOUNCE_MS = 2500L;
    private static final long NET_CHANGE_FALLBACK_POLL_INTERVAL_MS = 60000L;
    private static final long WATCH_CREATED_POLL_MS = 1000L;
    private static final long WATCH_CREATED_QUIET_MS = 10000L;
    private static final long WATCH_CREATED_LARGE_QUIET_MS = 30000L;
    private static final long WATCH_CREATED_TIMEOUT_MS = 10L * 60L * 1000L;
    private static final long WATCH_CREATED_CLOSE_SETTLE_MS = 1500L;
    private static final long WATCH_CREATED_LARGE_FILE_BYTES = 1024L * 1024L * 1024L;

    private static volatile boolean running = false;
    private static volatile int currentPort = DEFAULT_PORT;

    // Exchange state
    private static volatile String currentExchangeMode = "node";
    private static volatile String currentExchangeHost = "";
    private static volatile int currentExchangePort = DEFAULT_PORT;
    private static volatile boolean currentExchangeTls = false;
    private static volatile String currentExchangeToken = "";
    private static volatile WebSocket wsExchangeClientSocket = null;
    private static final ConcurrentHashMap<String, JSONObject> p2pSessions = new ConcurrentHashMap<>();
    private static final Set<String> exchangeRemotePeers = ConcurrentHashMap.newKeySet();
    private static final ConcurrentHashMap<String, Long> p2pAutodialAttempts = new ConcurrentHashMap<>();
    private static final ConcurrentLinkedQueue<JSONObject> pendingP2PSignals = new ConcurrentLinkedQueue<>();
    private static volatile P2PSignalListener p2pSignalListener = null;
    private static ReactorHttpService instance = null;
    private static volatile boolean stopRequestedByUser = false;
    private static final Object envCacheLock = new Object();
    private static volatile JSONObject envCacheMap = new JSONObject();

    private final ExecutorService clientPool = Executors.newCachedThreadPool();
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private long startedAtMs = 0L;

    // Exchange server: gestito tramite handleClient (WS upgrade detection)
    private final ConcurrentHashMap<String, WsConnection> wsExchangeClients = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<WsConnection, List<PendingBinaryChunkMeta>> wsExchangePendingBinaryByConn = new ConcurrentHashMap<>();
    private final List<PendingBinaryChunkMeta> wsClientPendingBinaryChunks = new ArrayList<>();

    // Exchange client
    private OkHttpClient okHttpClient;
    private volatile boolean wsClientRunning = false;
    private Thread wsClientThread;
    private final Object wsClientLifecycleLock = new Object();
    private final Object exchangeLifecycleLock = new Object();
    private volatile long wsClientGeneration = 0L;
    private volatile boolean exchangeStarted = false;
        private volatile boolean outgoingQueueFlusherRunning = false;
        private Thread outgoingQueueFlusherThread;
    private volatile boolean networkWatcherRunning = false;
    private Thread networkWatcherThread;
    private volatile String lastNetworkSignature = null;
    private volatile JSONObject lastNetworkSnapshot = null;
    private ConnectivityManager networkConnectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean networkCallbackRegistered = false;
    private Handler networkDebounceHandler;
    private Runnable networkDebounceRunnable;
    private final List<EndpointWatchObserver> watchObservers = new ArrayList<>();
    private final Object watchObserverLock = new Object();
    private final ConcurrentHashMap<String, IncomingStreamState> incomingStreams = new ConcurrentHashMap<>();

    private static final Pattern SEND_MESSAGE_CALL_PATTERN = Pattern.compile(
            "Node\\.sendMessage\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\1\\s*,\\s*(['\"])\\s*(.*?)\\s*\\3",
            Pattern.DOTALL
    );
        private static final Pattern FILE_COPY_STREAM_CALL_PATTERN = Pattern.compile(
            "FileSystem\\.File\\.copyStream\\s*\\(\\s*([^,\\)]+)\\s*,\\s*([^\\)]+)\\s*\\)",
            Pattern.DOTALL
        );
        private static final Pattern EXCHANGE_SEND_MESSAGE_CALL_PATTERN = Pattern.compile(
            "Node\\.exchange\\s*\\(\\s*\\)\\s*\\.\\s*sendMessage\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\1\\s*,\\s*(['\"])\\s*(.*?)\\s*\\3",
            Pattern.DOTALL
        );
        private static final Pattern STREAM_FILE_CALL_PATTERN = Pattern.compile(
            "Node\\.stream\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\1\\s*,\\s*(?:File\\.open|FileSystem\\.File\\.open)\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\3",
            Pattern.DOTALL
        );
        private static final Pattern EXCHANGE_STREAM_FILE_CALL_PATTERN = Pattern.compile(
            "Node\\.exchange\\s*\\(\\s*\\)\\s*\\.\\s*stream\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\1\\s*,\\s*(?:File\\.open|FileSystem\\.File\\.open)\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\3",
            Pattern.DOTALL
        );
            private static final Pattern STREAM_CALL_GENERIC_PATTERN = Pattern.compile(
                "Node\\.stream\\s*\\(\\s*([^,\\)]+)\\s*,\\s*([^,\\)]+)",
                Pattern.DOTALL
            );
            private static final Pattern EXCHANGE_STREAM_CALL_GENERIC_PATTERN = Pattern.compile(
                "Node\\.exchange\\s*\\(\\s*\\)\\s*\\.\\s*stream\\s*\\(\\s*([^,\\)]+)\\s*,\\s*([^,\\)]+)",
                Pattern.DOTALL
            );
            private static final Pattern STREAM_VAR_ASSIGN_PATTERN = Pattern.compile(
                "(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:await\\s+)?(?:File\\.open|FileSystem\\.File\\.open)\\s*\\(\\s*([^\\),]+)",
                Pattern.DOTALL
            );
            private static final Pattern STRING_VAR_ASSIGN_PATTERN = Pattern.compile(
                "(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(['\"])(.*?)\\2",
                Pattern.DOTALL
            );
            private static final Pattern GENERIC_VAR_ASSIGN_PATTERN = Pattern.compile(
                "(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*([^;\\r\\n]+)",
                Pattern.DOTALL
            );
            private static final Pattern HOME_DIR_VAR_ASSIGN_PATTERN = Pattern.compile(
                "(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:await\\s+)?Node\\.getHomeDirectory\\s*\\(",
                Pattern.DOTALL
            );
        private static final Pattern DEVICE_NOTIFY_CALL_PATTERN = Pattern.compile(
            "Device\\.notify\\s*\\(\\s*([^\\)]+)\\)",
            Pattern.DOTALL
        );
        private static final Set<String> VALID_WATCH_LISTENERS = new HashSet<>(Arrays.asList(
                "file:created",
                "file:deleted",
                "file:moved",
                "file:changed",
                "dir:created",
                "dir:deleted",
                "dir:moved"
        ));
        private static final int DEFAULT_STREAM_CHUNK_SIZE = 64 * 1024;

    private static class MessageEndpoint {
        File endpointFile;
        String endpointName;
        String endpointPath;
        String endpointId;
        String endpointState;
        String source;
        boolean enabled;
        boolean debug;
        boolean hasMessageEvent;
        boolean messageFromAnySender;
        List<String> messageSenders;
        boolean hasStreamEvent;
        boolean streamFromAnySender;
        List<String> streamSenders;
        boolean hasStreamEndEvent;
        boolean streamEndFromAnySender;
        List<String> streamEndSenders;
        boolean hasNetChangeEvent;
        boolean hasWatchEvent;
        List<WatchRule> watchRules;
    }

    private static class WatchRule {
        String path;
        Set<String> listeners;
        boolean recursive;
    }

    private static class EndpointWatchObserver {
        MessageEndpoint endpoint;
        WatchRule rule;
        String resolvedPath;
        FileObserver observer;
        ConcurrentHashMap<String, PendingWatchCreatedState> pendingCreatedStates = new ConcurrentHashMap<>();
        Set<String> pendingCreatedInFlight = ConcurrentHashMap.newKeySet();
    }

    private static class PendingWatchCreatedState {
        volatile long firstSeenAtMs;
        volatile long lastMutationAtMs;
        volatile long lastCloseWriteAtMs;
        volatile long lastSize;
        volatile long lastMtimeMs;
    }

    private static class IncomingStreamState {
        String key;
        String streamId;
        String sender;
        File partFile;
        FileOutputStream output;
        JSONObject metadata;
        String contentType;
        long totalBytes;
        int chunks;
    }

    private static class PendingBinaryChunkMeta {
        String to;
        String from;
        String streamId;
        int index;
        int size;
    }

    private static class ParsedTarget {
        String originalTarget;
        String baseTarget;
        String nodeName;
        String endpointSelector;
        String endpointId;
        boolean directAddress;
    }

    private static class SendDeliveryResult {
        boolean ok;
        String target;
        String deliveredVia;
        boolean queued;
        String reason;

        static SendDeliveryResult success(String target, String deliveredVia) {
            SendDeliveryResult result = new SendDeliveryResult();
            result.ok = true;
            result.target = String.valueOf(target);
            result.deliveredVia = String.valueOf(deliveredVia == null ? "" : deliveredVia).trim().toUpperCase(Locale.ROOT);
            result.queued = false;
            result.reason = "";
            return result;
        }

        static SendDeliveryResult queued(String target, String deliveredVia, String reason) {
            SendDeliveryResult result = success(target, deliveredVia);
            result.queued = true;
            result.reason = String.valueOf(reason == null ? "" : reason);
            return result;
        }
    }

    public static boolean isRunning() {
        return running;
    }

    public static int getCurrentPort() {
        return currentPort;
    }

    public static String getCurrentExchangeMode() { return currentExchangeMode; }
    public static String getCurrentExchangeHost() { return currentExchangeHost; }
    public static int getCurrentExchangePort() { return currentExchangePort; }
    public static boolean getCurrentExchangeTls() { return currentExchangeTls; }
    public static boolean isExchangeServerActive() {
        // Exchange server è attivo se il service HTTP è running in modalità exchange
        return "exchange".equals(currentExchangeMode) && running;
    }
    public static boolean isExchangeClientConnected() { return wsExchangeClientSocket != null; }
    public static boolean isExchangeClientConnecting() {
        ReactorHttpService current = instance;
        return current != null
                && "node".equals(currentExchangeMode)
                && current.wsClientRunning
                && wsExchangeClientSocket == null;
    }

    public static void refreshExchangeClientProfile(String reason) {
        ReactorHttpService current = instance;
        if (current == null) {
            return;
        }

        if (!"node".equals(currentExchangeMode)) {
            return;
        }

        synchronized (current.wsClientLifecycleLock) {
            if (wsExchangeClientSocket == null) {
                return;
            }

            try {
                JSONObject packet = new JSONObject();
                packet.put("type", "profile");
                packet.put("endpoints", current.buildDiscoveryEndpointsPayload());
                packet.put("httpPort", currentPort);
                packet.put("httpTls", false);
                boolean sent = wsExchangeClientSocket.send(packet.toString());
                if (sent) {
                    String safeReason = String.valueOf(reason == null ? "runtime-update" : reason).trim();
                    current.appendGlobalLog(current.buildExchangeLog("CLIENT_PROFILE_REFRESHED", "reason=" + (safeReason.isEmpty() ? "runtime-update" : safeReason)));
                }
            } catch (Exception ignored) {
                // Best-effort update: discovery profile will be sent again on reconnect.
            }
        }
    }

    public static void reconnectExchangeClient(String reason) {
        ReactorHttpService current = instance;
        if (current == null) {
            return;
        }

        current.reconnectExchangeClientInternal(reason);
    }

    public interface P2PSignalListener {
        void onSignal(String from, String sessionId, String signalType, JSONObject payload);
    }

    public interface P2PStatusListener {
        void onStatus(JSObject p2pStatus);
    }

    public interface ExchangeConnectionStatusListener {
        void onStatusChanged();
    }

    public static void setP2PSignalListener(P2PSignalListener listener) {
        p2pSignalListener = listener;
        ReactorHttpService current = instance;
        if (current != null && listener != null) {
            current.flushPendingP2PSignals();
        }
    }

    private static volatile P2PStatusListener p2pStatusListener = null;
    private static volatile ExchangeConnectionStatusListener exchangeConnectionStatusListener = null;

    public static void setP2PStatusListener(P2PStatusListener listener) {
        p2pStatusListener = listener;
    }

    public static void setExchangeConnectionStatusListener(ExchangeConnectionStatusListener listener) {
        exchangeConnectionStatusListener = listener;
        if (listener != null) {
            emitExchangeConnectionStatusUpdate();
        }
    }

    private static void emitP2PStatusUpdate() {
        P2PStatusListener listener = p2pStatusListener;
        if (listener == null) {
            return;
        }

        try {
            listener.onStatus(getP2PStatus());
        } catch (Exception ignored) {
            // Status notifications are best-effort only.
        }
    }

    private static void emitExchangeConnectionStatusUpdate() {
        ExchangeConnectionStatusListener listener = exchangeConnectionStatusListener;
        if (listener == null) {
            return;
        }

        try {
            listener.onStatusChanged();
        } catch (Exception ignored) {
            // Status notifications are best-effort only.
        }
    }

    private static String normalizeP2PTarget(String rawTarget) {
        return String.valueOf(rawTarget == null ? "" : rawTarget).trim().toLowerCase(Locale.ROOT);
    }

    private static int sanitizePort(int value, int fallback) {
        if (value >= 1 && value <= 65535) {
            return value;
        }
        return (fallback >= 1 && fallback <= 65535) ? fallback : 3478;
    }

    private static void cleanupExpiredP2PSessions() {
        long now = System.currentTimeMillis();
        for (Map.Entry<String, JSONObject> entry : p2pSessions.entrySet()) {
            JSONObject session = entry.getValue();
            String target = entry.getKey();
            if (isNativeP2PDataChannelOpen(target)) {
                try {
                    if (session == null) {
                        session = new JSONObject();
                        session.put("target", normalizeP2PTarget(target));
                        session.put("sessionId", UUID.randomUUID().toString().toLowerCase(Locale.ROOT));
                        p2pSessions.put(target, session);
                    }
                    session.put("state", "connected-p2p");
                    session.put("lastSignalType", "connected");
                    session.put("usingRelay", false);
                    session.put("reason", "");
                    session.put("lastUpdateMs", now);
                } catch (Exception ignored) {
                    // Ignore refresh failures and proceed with default cleanup logic.
                }
                continue;
            }

            long lastUpdateMs = session != null ? session.optLong("lastUpdateMs", 0L) : 0L;
            if (lastUpdateMs <= 0L || (now - lastUpdateMs) > DEFAULT_P2P_SESSION_TIMEOUT_MS) {
                p2pSessions.remove(entry.getKey());
            }
        }
    }

    private static boolean isNativeP2PDataChannelOpen(String targetNodeName) {
        ReactorHttpService current = instance;
        if (current == null) {
            return false;
        }

        String safeTarget = normalizeP2PTarget(targetNodeName);
        if (safeTarget.isEmpty()) {
            return false;
        }

        try {
            AndroidP2PWebRtcManager nativeManager = AndroidP2PWebRtcManager.getInstance(current.getApplicationContext());
            JSObject nativeStatus = nativeManager.getNativeStatus();
            JSONArray sessions = nativeStatus != null ? nativeStatus.optJSONArray("sessions") : null;
            if (sessions == null) {
                return false;
            }

            for (int index = 0; index < sessions.length(); index += 1) {
                JSONObject nativeSession = sessions.optJSONObject(index);
                if (nativeSession == null) {
                    continue;
                }

                String target = normalizeP2PTarget(nativeSession.optString("target", ""));
                String dataChannelState = String.valueOf(nativeSession.optString("dataChannel", "")).trim().toLowerCase(Locale.ROOT);
                if (safeTarget.equals(target) && "open".equals(dataChannelState)) {
                    return true;
                }
            }
        } catch (Exception ignored) {
            return false;
        }

        return false;
    }

    private static JSONObject upsertP2PSession(String target, String sessionId, String state, String signalType, boolean usingRelay, String reason) {
        String safeTarget = normalizeP2PTarget(target);
        if (safeTarget.isEmpty()) {
            return null;
        }

        JSONObject existing = p2pSessions.get(safeTarget);
        String previousSessionId = existing != null ? existing.optString("sessionId", "") : "";
        String previousState = existing != null ? existing.optString("state", "") : "";
        String previousSignalType = existing != null ? existing.optString("lastSignalType", "") : "";
        boolean previousUsingRelay = existing != null && existing.optBoolean("usingRelay", false);
        String previousReason = existing != null ? existing.optString("reason", "") : "";
        JSONObject session = existing != null ? existing : new JSONObject();

        try {
            session.put("target", safeTarget);
            if (sessionId != null && !sessionId.trim().isEmpty()) {
                session.put("sessionId", sessionId.trim());
            } else if (!session.has("sessionId") || session.optString("sessionId", "").trim().isEmpty()) {
                session.put("sessionId", UUID.randomUUID().toString().toLowerCase(Locale.ROOT));
            }

            String nextState = String.valueOf(state == null ? "signaling" : state).trim();
            session.put("state", nextState.isEmpty() ? "signaling" : nextState);
            session.put("lastSignalType", String.valueOf(signalType == null ? "" : signalType).trim().toLowerCase(Locale.ROOT));
            session.put("usingRelay", usingRelay);
            session.put("reason", String.valueOf(reason == null ? "" : reason));
            session.put("lastUpdateMs", System.currentTimeMillis());
        } catch (Exception ignored) {
            return null;
        }

        p2pSessions.put(safeTarget, session);

        String nextSessionId = session.optString("sessionId", "");
        String nextState = session.optString("state", "");
        String nextSignalType = session.optString("lastSignalType", "");
        boolean nextUsingRelay = session.optBoolean("usingRelay", false);
        String nextReason = session.optString("reason", "");
        boolean changed = existing == null
                || !String.valueOf(previousSessionId).equals(String.valueOf(nextSessionId))
                || !String.valueOf(previousState).equals(String.valueOf(nextState))
                || !String.valueOf(previousSignalType).equals(String.valueOf(nextSignalType))
                || previousUsingRelay != nextUsingRelay
                || !String.valueOf(previousReason).equals(String.valueOf(nextReason));
        if (changed) {
            emitP2PStatusUpdate();
        }

        return session;
    }

    private static String stateForSignalType(String signalType) {
        String safeSignal = String.valueOf(signalType == null ? "" : signalType).trim().toLowerCase(Locale.ROOT);
        if ("offer".equals(safeSignal) || "answer".equals(safeSignal) || "candidate".equals(safeSignal)) {
            return "connecting";
        }
        if ("connected".equals(safeSignal)) {
            return "connected-p2p";
        }
        if ("relay".equals(safeSignal)) {
            return "connected-turn";
        }
        if ("failed".equals(safeSignal)) {
            return "fallback-exchange";
        }
        if ("close".equals(safeSignal)) {
            return "idle";
        }
        return "signaling";
    }

    public static JSObject getP2PStatus() {
        cleanupExpiredP2PSessions();

        JSArray sessions = new JSArray();
        for (JSONObject session : p2pSessions.values()) {
            if (session == null) {
                continue;
            }

            JSObject item = new JSObject();
            item.put("target", session.optString("target", ""));
            item.put("sessionId", session.optString("sessionId", ""));
            item.put("state", session.optString("state", "idle"));
            item.put("lastSignalType", session.optString("lastSignalType", ""));
            item.put("usingRelay", session.optBoolean("usingRelay", false));
            item.put("reason", session.optString("reason", ""));

            long lastUpdateMs = session.optLong("lastUpdateMs", 0L);
            item.put("lastUpdateAt", lastUpdateMs > 0L ? Instant.ofEpochMilli(lastUpdateMs).toString() : JSONObject.NULL);
            sessions.put(item);
        }

        String selfName = "";
        if (instance != null) {
            try {
                selfName = String.valueOf(instance.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .getString(PREF_REACTOR_NAME, "mobile-reactor")).trim().toLowerCase(Locale.ROOT);
            } catch (Exception ignored) {
                selfName = "";
            }
        }

        List<String> peers = new ArrayList<>();
        for (String peer : exchangeRemotePeers) {
            String safePeer = String.valueOf(peer == null ? "" : peer).trim().toLowerCase(Locale.ROOT);
            if (safePeer.isEmpty()) {
                continue;
            }
            if (!selfName.isEmpty() && selfName.equals(safePeer)) {
                continue;
            }
            peers.add(safePeer);
        }
        peers.sort(String::compareTo);

        JSArray remotePeers = new JSArray();
        for (String peer : peers) {
            remotePeers.put(peer);
        }

        JSObject workingMode = getWorkingModeConfigForP2P();
        JSONObject stunConfig = workingMode.optJSONObject("stun");
        JSONObject turnConfig = workingMode.optJSONObject("turn");
        String token = String.valueOf(workingMode.optString("token", "")).trim();

        JSArray iceServers = new JSArray();

        String stunHost = String.valueOf(stunConfig != null ? stunConfig.optString("host", "") : "").trim();
        int stunPort = sanitizePort(stunConfig != null ? stunConfig.optInt("port", 3478) : 3478, 3478);
        if (!stunHost.isEmpty()) {
            JSObject stunServer = new JSObject();
            JSArray urls = new JSArray();
            urls.put("stun:" + stunHost + ":" + stunPort);
            stunServer.put("urls", urls);
            iceServers.put(stunServer);
        }

        String turnHost = String.valueOf(turnConfig != null ? turnConfig.optString("host", "") : "").trim();
        int turnPort = sanitizePort(turnConfig != null ? turnConfig.optInt("port", 3478) : 3478, 3478);
        boolean turnTls = turnConfig != null && turnConfig.optBoolean("tls", false);
        String turnUsername = String.valueOf(turnConfig != null ? turnConfig.optString("username", turnConfig.optString("user", "")) : "").trim();
        String turnPassword = String.valueOf(turnConfig != null ? turnConfig.optString("password", "") : "").trim();
        if (!turnHost.isEmpty()) {
            JSObject turnServer = new JSObject();
            JSArray urls = new JSArray();
            String turnScheme = turnTls ? "turns" : "turn";
            urls.put(turnScheme + ":" + turnHost + ":" + turnPort + "?transport=tcp");
            urls.put("turn:" + turnHost + ":" + turnPort + "?transport=udp");
            turnServer.put("urls", urls);
            turnServer.put("username", !turnUsername.isEmpty() ? turnUsername : token);
            turnServer.put("credential", !turnPassword.isEmpty() ? turnPassword : token);
            if (turnTls) {
                turnServer.put("tlsCertPolicy", "insecure_no_check");
            }
            iceServers.put(turnServer);
        }

        boolean dataChannelSupported = false;
        int dataChannelSessions = 0;
        try {
            if (instance != null) {
                AndroidP2PWebRtcManager nativeManager = AndroidP2PWebRtcManager.getInstance(instance.getApplicationContext());
                JSObject nativeStatus = nativeManager.getNativeStatus();
                dataChannelSupported = nativeStatus.optBoolean("ok", false);
                JSONArray nativeSessions = nativeStatus.optJSONArray("sessions");
                dataChannelSessions = nativeSessions != null ? nativeSessions.length() : 0;
            }
        } catch (Exception ignored) {
            dataChannelSupported = false;
            dataChannelSessions = 0;
        }

        JSObject p2p = new JSObject();
        p2p.put("enabled", "node".equals(currentExchangeMode));
        p2p.put("signalingViaExchange", true);
        p2p.put("connectedToExchange", isExchangeClientConnected());
        p2p.put("dataChannelSupported", dataChannelSupported);
        p2p.put("dataChannelSessions", dataChannelSessions);
        p2p.put("iceServersConfigured", iceServers.length() > 0);
        p2p.put("iceServers", iceServers);
        p2p.put("remotePeers", remotePeers);
        p2p.put("sessions", sessions);
        return p2p;
    }

    public static JSObject sendP2PSignal(String target, String signalType, JSObject payload, String sessionId) {
        if (instance == null) {
            return new JSObject().put("ok", false).put("error", "runtime not ready");
        }

        try {
            String safeTarget = normalizeP2PTarget(target);
            String safeSignalType = String.valueOf(signalType == null ? "" : signalType).trim().toLowerCase(Locale.ROOT);
            if (safeTarget.isEmpty()) {
                return new JSObject().put("ok", false).put("error", "invalid p2p signaling target");
            }
            if (safeSignalType.isEmpty()) {
                return new JSObject().put("ok", false).put("error", "invalid p2p signal type");
            }
            if (!"node".equals(currentExchangeMode)) {
                return new JSObject().put("ok", false).put("error", "p2p signaling available only in node mode");
            }

            JSONObject session = upsertP2PSession(
                    safeTarget,
                    sessionId,
                    stateForSignalType(safeSignalType),
                    safeSignalType,
                    "relay".equals(safeSignalType) || "failed".equals(safeSignalType),
                    "failed".equals(safeSignalType) ? "p2p failed" : ""
            );

            String resolvedSessionId = session != null ? session.optString("sessionId", "") : String.valueOf(sessionId == null ? "" : sessionId).trim();
            instance.sendExchangeSignalNow(safeTarget, safeSignalType, payload, resolvedSessionId);

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("to", safeTarget);
            result.put("signalType", safeSignalType);
            result.put("sessionId", resolvedSessionId);
            result.put("session", session != null ? new JSObject(session.toString()) : JSONObject.NULL);
            return result;
        } catch (Exception error) {
            return new JSObject().put("ok", false).put("error", error.getMessage() != null ? error.getMessage() : "unable to send p2p signal");
        }
    }

    public static JSObject closeP2PSession(String target, String sessionId, JSObject payload) {
        String safeTarget = normalizeP2PTarget(target);
        if (safeTarget.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "invalid p2p session target");
        }

        JSObject signalResult = null;
        if ("node".equals(currentExchangeMode)) {
            signalResult = sendP2PSignal(safeTarget, "close", payload, sessionId);
        }

        p2pSessions.remove(safeTarget);
        emitP2PStatusUpdate();
        return new JSObject().put("ok", true).put("target", safeTarget).put("signal", signalResult != null ? signalResult : JSONObject.NULL);
    }

    public static JSObject getOutgoingQueueStatus() {
        JSObject queue = new JSObject();
        if (instance == null) {
            queue.put("pending", 0);
            queue.put("directPending", 0);
            queue.put("exchangePending", 0);
            queue.put("ttlMs", DEFAULT_MESSAGE_QUEUE_TTL_MS);
            queue.put("ttlDays", 7.0);
            queue.put("retryMs", DEFAULT_MESSAGE_QUEUE_RETRY_MS);
            return queue;
        }

        List<JSONObject> entries = instance.readOutgoingQueueEntries();
        long now = System.currentTimeMillis();
        int pending = 0;
        int directPending = 0;
        int exchangePending = 0;
        for (JSONObject item : entries) {
            if (item == null) {
                continue;
            }
            long expiresAt = item.optLong("expiresAt", 0L);
            if (expiresAt > 0 && expiresAt <= now) {
                continue;
            }
            pending += 1;
            if ("exchange".equals(item.optString("channel", "direct"))) {
                exchangePending += 1;
            } else {
                directPending += 1;
            }
        }

        long ttlMs = instance.getQueueTtlMs();
        queue.put("pending", pending);
        queue.put("directPending", directPending);
        queue.put("exchangePending", exchangePending);
        queue.put("ttlMs", ttlMs);
        queue.put("ttlDays", ((double) ttlMs) / (24.0 * 60.0 * 60.0 * 1000.0));
        queue.put("retryMs", instance.getQueueRetryMs());
        queue.put("path", instance.getOutgoingQueueFile().getAbsolutePath());
        return queue;
    }

    public static void setOutgoingQueueTtlDays(double ttlDays) {
        if (instance == null) {
            return;
        }
        if (!Double.isFinite(ttlDays) || ttlDays <= 0.0) {
            throw new IllegalArgumentException("invalid queue ttl days");
        }

        long ttlMs = Math.max(60000L, (long) Math.floor(ttlDays * 24.0 * 60.0 * 60.0 * 1000.0));
        SharedPreferences prefs = instance.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putLong(PREF_MESSAGE_QUEUE_TTL_MS, ttlMs).apply();
    }

    public static void flushOutgoingQueueNow() {
        if (instance != null) {
            instance.flushOutgoingQueue();
        }
    }

    public static void clearOutgoingQueueNow() {
        if (instance == null) {
            return;
        }
        instance.writeOutgoingQueueEntries(new ArrayList<>());
    }

        private String normalizeExchangeMode(String rawMode) {
            String mode = String.valueOf(rawMode).trim().toLowerCase(Locale.ROOT);
            if ("exchange".equals(mode)) {
                return "exchange";
            }
            return "node";
        }

        private File getWorkingModeFile() {
            return new File(getFilesDir(), WORKING_MODE_FILE);
        }

        private File getEnvDir() {
            File envDir = new File(getFilesDir(), ENV_DIR);
            if (!envDir.exists()) {
                envDir.mkdirs();
            }
            return envDir;
        }

        private JSONObject copyJsonObject(JSONObject source) {
            if (source == null) {
                return new JSONObject();
            }

            try {
                return new JSONObject(source.toString());
            } catch (Exception ignored) {
                return new JSONObject();
            }
        }

        private JSONObject readEnvMapFromDisk() {
            JSONObject envs = new JSONObject();

            try {
                File envDir = getEnvDir();
                File[] entries = envDir.listFiles();

                if (entries == null) {
                    return envs;
                }

                for (File entry : entries) {
                    if (entry == null || !entry.isFile()) {
                        continue;
                    }

                    String name = String.valueOf(entry.getName() == null ? "" : entry.getName()).trim();
                    if (name.isEmpty() || name.contains("/") || name.contains("\\") || "..".equals(name) || ".".equals(name)) {
                        continue;
                    }

                    try {
                        envs.put(name, new String(Files.readAllBytes(entry.toPath()), StandardCharsets.UTF_8));
                    } catch (Exception perEntryError) {
                        Log.e("SCRIPT_ENGINE", "ENV_READ_ENTRY_ERROR name=" + name + " message=" + perEntryError.getMessage(), perEntryError);
                    }
                }
            } catch (Exception ignored) {
                return new JSONObject();
            }

            return envs;
        }

        private JSONObject getEnvCacheSnapshot() {
            synchronized (envCacheLock) {
                return copyJsonObject(envCacheMap);
            }
        }

        private void refreshEnvCacheFromDisk(String reason) {
            JSONObject loaded = readEnvMapFromDisk();
            synchronized (envCacheLock) {
                envCacheMap = copyJsonObject(loaded);
            }

            try {
                File envDir = getEnvDir();
                JSONObject payload = new JSONObject();
                payload.put("reason", String.valueOf(reason == null ? "" : reason));
                payload.put("path", envDir.getAbsolutePath());
                payload.put("envCount", getEnvCacheSnapshot().length());
                Log.d("SCRIPT_ENGINE", "ENV_STARTUP_SNAPSHOT: " + payload.toString());
            } catch (Exception error) {
                Log.e("SCRIPT_ENGINE", "ENV_STARTUP_SNAPSHOT_ERROR: " + error.getMessage(), error);
            }
        }

    public static void refreshEnvCacheNow(String reason) {
        if (instance != null) {
            instance.refreshEnvCacheFromDisk(reason);
        }
    }

    public static JSObject getEnvCacheSnapshotForUi() {
        JSObject payload = new JSObject();
        if (instance == null) {
            payload.put("ok", false);
            payload.put("path", "");
            payload.put("envs", new JSObject());
            return payload;
        }

        payload.put("ok", true);
        payload.put("path", instance.getEnvDir().getAbsolutePath());
        payload.put("envs", instance.getEnvCacheSnapshot());
        return payload;
    }

        private String readExchangeToken() {
            try {
                File workingModeFile = getWorkingModeFile();
                if (!workingModeFile.exists()) {
                    return "";
                }
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                try (FileInputStream input = new FileInputStream(workingModeFile)) {
                    byte[] buffer = new byte[1024];
                    int read;
                    while ((read = input.read(buffer)) >= 0) {
                        output.write(buffer, 0, read);
                    }
                }
                JSONObject parsed = new JSONObject(output.toString(StandardCharsets.UTF_8.name()).trim());
                return String.valueOf(parsed.optString("token", "")).trim();
            } catch (Exception ignored) {
                return "";
            }
        }

        private String readBearerToken(Map<String, String> headers) {
            String authorization = headers.getOrDefault("authorization", "").trim();
            if (authorization.isEmpty()) {
                return "";
            }
            String prefix = "bearer ";
            String lower = authorization.toLowerCase(Locale.ROOT);
            if (!lower.startsWith(prefix)) {
                return "";
            }
            return authorization.substring(prefix.length()).trim();
        }

        private void writeUnauthorizedResponse(Socket client) {
            try {
                OutputStream output = client.getOutputStream();
                String body = "Unauthorized";
                String response = "HTTP/1.1 401 Unauthorized\r\n"
                        + "Content-Type: text/plain; charset=utf-8\r\n"
                        + "Connection: close\r\n"
                        + "Content-Length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n\r\n"
                        + body;
                output.write(response.getBytes(StandardCharsets.UTF_8));
                output.flush();
            } catch (Exception ignored) {
                // ignore response write failures
            }
        }

    public static List<String> getExchangeConnectedClients() {
        if (instance != null) {
            return new ArrayList<>(instance.wsExchangeClients.keySet());
        }
        return new ArrayList<>();
    }

    public static JSONArray getDiscoveryEndpointsPayloadForP2P() {
        if (instance == null) {
            return new JSONArray();
        }
        return instance.buildDiscoveryEndpointsPayload();
    }

    public static String getCurrentReactorNameForP2P() {
        if (instance == null) {
            return "mobile-reactor";
        }

        try {
            return String.valueOf(instance.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(PREF_REACTOR_NAME, "mobile-reactor")).trim();
        } catch (Exception ignored) {
            return "mobile-reactor";
        }
    }

    public static JSObject getWorkingModeConfigForP2P() {
        JSObject fallback = new JSObject();
        fallback.put("stun", new JSObject());
        fallback.put("turn", new JSObject());
        fallback.put("token", "");

        if (instance == null) {
            return fallback;
        }

        try {
            File workingModeFile = new File(instance.getFilesDir(), WORKING_MODE_FILE);
            if (!workingModeFile.exists()) {
                return fallback;
            }

            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (FileInputStream input = new FileInputStream(workingModeFile)) {
                byte[] buffer = new byte[1024];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    output.write(buffer, 0, read);
                }
            }

            String raw = output.toString(StandardCharsets.UTF_8.name()).trim();
            if (raw.isEmpty()) {
                return fallback;
            }

            return new JSObject(raw);
        } catch (Exception ignored) {
            return fallback;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
        createEndpointNotificationChannel();
        refreshEnvCacheFromDisk("service-onCreate");
        ReactorServiceWatchdogWorker.schedule(getApplicationContext());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        if (ACTION_STOP.equals(action)) {
            stopRequestedByUser = true;
            stopServer();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        stopRequestedByUser = false;
    refreshEnvCacheFromDisk("service-onStartCommand");

        int requestedPort = readConfiguredPort(intent);
        currentPort = requestedPort;

        Notification notification = buildNotification(currentPort);
        try {
            startForeground(NOTIFICATION_ID, notification);
        } catch (Exception foregroundError) {
            stopRequestedByUser = true;
            appendGlobalLog(buildExchangeLog(
                    "SERVICE_FOREGROUND_BLOCKED",
                    foregroundError.getMessage() != null ? foregroundError.getMessage() : "startForeground blocked by system"
            ));
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            if (!running || currentPort != readActivePort()) {
                startServer(currentPort);
            }
        } catch (Exception e) {
            stopServer();
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            AndroidP2PWebRtcManager.getInstance(getApplicationContext()).initialize();
        } catch (Exception ignored) {
            // Native WebRTC init is best-effort; Exchange relay remains available.
        }

        startExchange();

        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        if (!stopRequestedByUser) {
            appendGlobalLog(buildExchangeLog("SERVICE_TASK_REMOVED", "task removed, keeping foreground service alive"));
            requestSelfRestart();
        }
    }

    @Override
    public void onDestroy() {
        stopExchange();
        stopServer();
        clientPool.shutdownNow();
        instance = null;

        if (!stopRequestedByUser) {
            appendGlobalLog(buildExchangeLog("SERVICE_RESTART", "service destroyed unexpectedly, requesting restart"));
            requestSelfRestart();
        }

        super.onDestroy();
    }

    private void requestSelfRestart() {
        try {
            Intent restartIntent = new Intent(getApplicationContext(), ReactorHttpService.class);
            restartIntent.setAction(ACTION_START);
            restartIntent.putExtra(EXTRA_PORT, currentPort > 0 ? currentPort : DEFAULT_PORT);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getApplicationContext().startForegroundService(restartIntent);
            } else {
                getApplicationContext().startService(restartIntent);
            }
        } catch (Exception restartError) {
            appendGlobalLog(buildExchangeLog("SERVICE_RESTART_ERROR", restartError.getMessage() != null ? restartError.getMessage() : "restart failed"));
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private int readConfiguredPort(Intent intent) {
        int requestedPort = intent != null ? intent.getIntExtra(EXTRA_PORT, DEFAULT_PORT) : DEFAULT_PORT;
        if (requestedPort < 1 || requestedPort > 65535) {
            requestedPort = DEFAULT_PORT;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int savedPort = prefs.getInt(PREF_HTTP_PORT, DEFAULT_PORT);
        if (savedPort >= 1 && savedPort <= 65535) {
            requestedPort = savedPort;
        }

        return requestedPort;
    }

    private int readActivePort() {
        return this.serverSocket != null ? this.serverSocket.getLocalPort() : -1;
    }

    private synchronized void startServer(int port) throws IOException {
        stopServer();

        serverSocket = new ServerSocket(port);
        serverSocket.setReuseAddress(true);
        currentPort = port;
        running = true;
        startedAtMs = System.currentTimeMillis();

        acceptThread = new Thread(() -> {
            while (running && serverSocket != null && !serverSocket.isClosed()) {
                try {
                    Socket client = serverSocket.accept();
                    clientPool.submit(() -> handleClient(client));
                } catch (IOException ignored) {
                    if (!running) {
                        return;
                    }
                }
            }
        }, "reactor-http-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();

        appendGlobalLog(buildServerLifecycleLog("START", "listening on port " + port));
        startNetworkWatcher();
        startWatchObservers();
    }

    private synchronized void stopServer() {
        stopWatchObservers();
        stopNetworkWatcher();
        running = false;

        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
                // Ignore close failures.
            }
            serverSocket = null;
        }

        if (acceptThread != null) {
            acceptThread.interrupt();
            acceptThread = null;
        }

        appendGlobalLog(buildServerLifecycleLog("STOP", "server stopped"));
    }

    private synchronized void startNetworkWatcher() {
        if (networkWatcherRunning) {
            return;
        }

        networkWatcherRunning = true;
        lastNetworkSignature = null;
        lastNetworkSnapshot = null;

        if (networkDebounceHandler == null) {
            networkDebounceHandler = new Handler(Looper.getMainLooper());
        }

        boolean callbackReady = registerNetworkCallbackWatcher();
        scheduleNetworkEvaluation(0L);

        if (!callbackReady) {
            startNetworkWatcherFallbackThread();
        }
    }

    private synchronized void stopNetworkWatcher() {
        networkWatcherRunning = false;
        if (networkDebounceHandler != null && networkDebounceRunnable != null) {
            networkDebounceHandler.removeCallbacks(networkDebounceRunnable);
            networkDebounceRunnable = null;
        }
        unregisterNetworkCallbackWatcher();
        if (networkWatcherThread != null) {
            networkWatcherThread.interrupt();
            networkWatcherThread = null;
        }
        lastNetworkSnapshot = null;
        lastNetworkSignature = null;
    }

    private synchronized boolean registerNetworkCallbackWatcher() {
        unregisterNetworkCallbackWatcher();

        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) {
            appendGlobalLog(buildExchangeLog("NET_CHANGE_CALLBACK_UNAVAILABLE", "connectivity manager unavailable, using fallback polling"));
            return false;
        }

        networkConnectivityManager = cm;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                scheduleNetworkEvaluation(NET_CHANGE_DEBOUNCE_MS);
            }

            @Override
            public void onLost(Network network) {
                scheduleNetworkEvaluation(NET_CHANGE_DEBOUNCE_MS);
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities networkCapabilities) {
                scheduleNetworkEvaluation(NET_CHANGE_DEBOUNCE_MS);
            }

            @Override
            public void onLinkPropertiesChanged(Network network, LinkProperties linkProperties) {
                scheduleNetworkEvaluation(NET_CHANGE_DEBOUNCE_MS);
            }
        };

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                cm.registerDefaultNetworkCallback(networkCallback);
            } else {
                NetworkRequest request = new NetworkRequest.Builder()
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .build();
                cm.registerNetworkCallback(request, networkCallback);
            }
            networkCallbackRegistered = true;
            appendGlobalLog(buildExchangeLog("NET_CHANGE_CALLBACK_READY", "using connectivity callback"));
            return true;
        } catch (Exception error) {
            appendGlobalLog(buildExchangeLog("NET_CHANGE_CALLBACK_UNAVAILABLE", error.getMessage() != null ? error.getMessage() : "using fallback polling"));
            networkCallback = null;
            networkConnectivityManager = null;
            networkCallbackRegistered = false;
            return false;
        }
    }

    private synchronized void unregisterNetworkCallbackWatcher() {
        if (networkConnectivityManager != null && networkCallback != null && networkCallbackRegistered) {
            try {
                networkConnectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
                // Ignore unregister races during service shutdown.
            }
        }

        networkCallbackRegistered = false;
        networkCallback = null;
        networkConnectivityManager = null;
    }

    private void startNetworkWatcherFallbackThread() {
        networkWatcherThread = new Thread(() -> {
            while (networkWatcherRunning && !networkCallbackRegistered) {
                scheduleNetworkEvaluation(0L);

                try {
                    Thread.sleep(NET_CHANGE_FALLBACK_POLL_INTERVAL_MS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }, "reactor-net-change-fallback");
        networkWatcherThread.setDaemon(true);
        networkWatcherThread.start();
    }

    private void scheduleNetworkEvaluation(long delayMs) {
        synchronized (this) {
            if (!networkWatcherRunning) {
                return;
            }

            if (networkDebounceHandler == null) {
                networkDebounceHandler = new Handler(Looper.getMainLooper());
            }

            if (networkDebounceRunnable != null) {
                networkDebounceHandler.removeCallbacks(networkDebounceRunnable);
            }

            networkDebounceRunnable = this::evaluateNetworkChange;
            networkDebounceHandler.postDelayed(networkDebounceRunnable, Math.max(0L, delayMs));
        }
    }

    private void evaluateNetworkChange() {
        try {
            JSONObject current = buildNetworkSnapshot();
            String currentSignature = buildNetworkSignature(current);
            JSONObject previous = lastNetworkSnapshot;
            String previousSignature = lastNetworkSignature;

            if (previousSignature == null) {
                emitNetChange(previous, current, "initial");
            } else if (!previousSignature.equals(currentSignature)) {
                emitNetChange(previous, current, "changed");
            }

            lastNetworkSnapshot = new JSONObject(current.toString());
            lastNetworkSignature = currentSignature;
        } catch (Exception ignored) {
            // Best effort monitor: callback or fallback polling will retry on the next trigger.
        }
    }

    private void emitNetChange(JSONObject previousSnapshot, JSONObject currentSnapshot, String reason) {
        List<MessageEndpoint> listeners = collectMessageEndpoints();
        if (listeners.isEmpty()) {
            return;
        }

        JSONObject payload;
        try {
            payload = new JSONObject();
            payload.put("reason", String.valueOf(reason));
            payload.put("previous", previousSnapshot != null ? previousSnapshot : JSONObject.NULL);
            payload.put("current", currentSnapshot != null ? currentSnapshot : JSONObject.NULL);
        } catch (Exception ignored) {
            return;
        }

        Map<String, String> headers = new HashMap<>();
        headers.put("content-type", "application/json; charset=utf-8");
        headers.put("x-reactor-trigger", "NET_CHANGE");

        String bodyText = payload.toString();
        Set<String> senderCandidates = new HashSet<>();
        for (MessageEndpoint endpoint : listeners) {
            if (!matchesEventSender(endpoint, senderCandidates, "NET_CHANGE")) {
                continue;
            }

            try {
                writeExecutionStart(endpoint, "NET_CHANGE", "NET_CHANGE");
                executeEndpointActions(endpoint, bodyText, headers, null);
            } catch (Exception executionError) {
                writeExecutionError(endpoint, "NET_CHANGE", "NET_CHANGE", executionError.getMessage());
            }
        }
    }

    private JSONObject buildNetworkSnapshot() {
        JSONObject snapshot = new JSONObject();
        JSONArray interfaces = new JSONArray();
        String transport = "unknown";

        try {
            snapshot.put("timestamp", Instant.now().toString());
            snapshot.put("online", false);
            snapshot.put("primaryInterface", JSONObject.NULL);
            snapshot.put("primaryAddress", JSONObject.NULL);
            snapshot.put("subnet", JSONObject.NULL);
            snapshot.put("gateway", JSONObject.NULL);
            snapshot.put("transport", transport);
            snapshot.put("signal", JSONObject.NULL);
            snapshot.put("interfaces", interfaces);

            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            Network activeNetwork = null;
            NetworkCapabilities capabilities = null;
            LinkProperties linkProperties = null;
            if (cm != null) {
                activeNetwork = cm.getActiveNetwork();
                capabilities = activeNetwork != null ? cm.getNetworkCapabilities(activeNetwork) : null;
                linkProperties = activeNetwork != null ? cm.getLinkProperties(activeNetwork) : null;
            }

            boolean online = capabilities != null
                    && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
            snapshot.put("online", online);

            transport = inferTransport(capabilities);
            snapshot.put("transport", transport);

            Integer signal = readSignalStrength(capabilities);
            if (signal != null) {
                snapshot.put("signal", signal.intValue());
            }

            if (linkProperties != null) {
                String interfaceName = linkProperties.getInterfaceName();
                if (interfaceName != null && !interfaceName.trim().isEmpty()) {
                    snapshot.put("primaryInterface", interfaceName);
                }

                InetAddress gateway = null;
                try {
                    List<android.net.RouteInfo> routes = linkProperties.getRoutes();
                    for (android.net.RouteInfo route : routes) {
                        if (route == null || !route.isDefaultRoute()) {
                            continue;
                        }

                        InetAddress candidate = route.getGateway();
                        if (candidate != null && !candidate.isAnyLocalAddress()) {
                            gateway = candidate;
                            break;
                        }
                    }
                } catch (Exception ignored) {
                    // Keep gateway null if route APIs are unavailable.
                }

                if (gateway != null) {
                    snapshot.put("gateway", gateway.getHostAddress());
                }

                for (LinkAddress linkAddress : linkProperties.getLinkAddresses()) {
                    if (linkAddress == null || linkAddress.getAddress() == null) {
                        continue;
                    }

                    InetAddress addr = linkAddress.getAddress();
                    int prefix = linkAddress.getPrefixLength();
                    String family = addr instanceof Inet4Address ? "IPv4" : "IPv6";
                    String address = addr.getHostAddress();
                    String netmask = prefixToNetmask(addr, prefix);
                    String cidr = address + "/" + prefix;
                    boolean internal = addr.isLoopbackAddress() || addr.isLinkLocalAddress();

                    JSONObject ifaceEntry = new JSONObject();
                    ifaceEntry.put("name", linkProperties.getInterfaceName() != null ? linkProperties.getInterfaceName() : "unknown");
                    ifaceEntry.put("family", family);
                    ifaceEntry.put("address", address);
                    ifaceEntry.put("netmask", netmask != null ? netmask : JSONObject.NULL);
                    ifaceEntry.put("cidr", cidr);
                    ifaceEntry.put("mac", JSONObject.NULL);
                    ifaceEntry.put("internal", internal);
                    ifaceEntry.put("transport", transport);
                    interfaces.put(ifaceEntry);

                    if (snapshot.isNull("primaryAddress") && addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        snapshot.put("primaryAddress", address);
                        if (netmask != null) {
                            snapshot.put("subnet", netmask);
                        }
                    }
                }
            }

            if (interfaces.length() == 0) {
                appendInterfacesFallback(interfaces, transport);
                for (int i = 0; i < interfaces.length(); i += 1) {
                    JSONObject item = interfaces.optJSONObject(i);
                    if (item == null || item.optBoolean("internal", true)) {
                        continue;
                    }
                    if (!"IPv4".equals(item.optString("family", ""))) {
                        continue;
                    }

                    String address = item.optString("address", "");
                    if (!address.isEmpty()) {
                        snapshot.put("primaryAddress", address);
                    }
                    String netmask = item.optString("netmask", "");
                    if (!netmask.isEmpty()) {
                        snapshot.put("subnet", netmask);
                    }
                    String ifaceName = item.optString("name", "");
                    if (!ifaceName.isEmpty()) {
                        snapshot.put("primaryInterface", ifaceName);
                    }
                    break;
                }
            }

            return snapshot;
        } catch (Exception ignored) {
            try {
                JSONObject fallback = new JSONObject();
                fallback.put("timestamp", Instant.now().toString());
                fallback.put("online", false);
                fallback.put("primaryInterface", JSONObject.NULL);
                fallback.put("primaryAddress", JSONObject.NULL);
                fallback.put("subnet", JSONObject.NULL);
                fallback.put("gateway", JSONObject.NULL);
                fallback.put("transport", "unknown");
                fallback.put("signal", JSONObject.NULL);
                fallback.put("interfaces", new JSONArray());
                return fallback;
            } catch (Exception ignoredAgain) {
                return new JSONObject();
            }
        }
    }

    private void appendInterfacesFallback(JSONArray interfaces, String activeTransport) {
        try {
            Enumeration<NetworkInterface> networkInterfaces = NetworkInterface.getNetworkInterfaces();
            if (networkInterfaces == null) {
                return;
            }

            while (networkInterfaces.hasMoreElements()) {
                NetworkInterface netIf = networkInterfaces.nextElement();
                if (netIf == null) {
                    continue;
                }

                List<InetAddress> addresses = java.util.Collections.list(netIf.getInetAddresses());
                for (InetAddress addr : addresses) {
                    if (addr == null) {
                        continue;
                    }

                    String family = addr instanceof Inet4Address ? "IPv4" : "IPv6";
                    String address = addr.getHostAddress();
                    boolean internal = addr.isLoopbackAddress() || addr.isLinkLocalAddress() || netIf.isLoopback();
                    String inferredTransport = internal ? "loopback" : inferTransportFromInterfaceName(netIf.getName());

                    JSONObject ifaceEntry = new JSONObject();
                    ifaceEntry.put("name", netIf.getName() != null ? netIf.getName() : "unknown");
                    ifaceEntry.put("family", family);
                    ifaceEntry.put("address", address);
                    ifaceEntry.put("netmask", JSONObject.NULL);
                    ifaceEntry.put("cidr", JSONObject.NULL);
                    ifaceEntry.put("mac", formatMacAddress(netIf.getHardwareAddress()));
                    ifaceEntry.put("internal", internal);
                    ifaceEntry.put("transport", "unknown".equals(activeTransport) ? inferredTransport : activeTransport);
                    interfaces.put(ifaceEntry);
                }
            }
        } catch (Exception ignored) {
            // Keep interfaces empty on API errors.
        }
    }

    private String buildNetworkSignature(JSONObject snapshot) {
        if (snapshot == null) {
            return "";
        }

        StringBuilder signature = new StringBuilder();
        signature.append(String.valueOf(snapshot.optBoolean("online", false))).append('|');
        signature.append(snapshot.optString("primaryInterface", "")).append('|');
        signature.append(snapshot.optString("primaryAddress", "")).append('|');
        signature.append(snapshot.optString("subnet", "")).append('|');
        signature.append(snapshot.optString("gateway", "")).append('|');
        signature.append(snapshot.optString("transport", "")).append('|');
        signature.append(snapshot.optString("signal", "")).append('|');

        JSONArray interfaces = snapshot.optJSONArray("interfaces");
        if (interfaces != null) {
            for (int i = 0; i < interfaces.length(); i += 1) {
                JSONObject item = interfaces.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                signature.append(item.optString("name", "")).append('/');
                signature.append(item.optString("family", "")).append('/');
                signature.append(item.optString("address", "")).append('/');
                signature.append(item.optString("netmask", "")).append('/');
                signature.append(item.optString("cidr", "")).append('/');
                signature.append(item.optString("transport", "")).append('/');
                signature.append(item.optBoolean("internal", false)).append('|');
            }
        }

        return signature.toString();
    }

    private String inferTransport(NetworkCapabilities capabilities) {
        if (capabilities == null) {
            return "unknown";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            return "wifi";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            return "cellular";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
            return "ethernet";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)) {
            return "bluetooth";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
            return "vpn";
        }
        return "unknown";
    }

    private Integer readSignalStrength(NetworkCapabilities capabilities) {
        if (capabilities == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return null;
        }
        try {
            int signal = capabilities.getSignalStrength();
            if (signal == Integer.MIN_VALUE) {
                return null;
            }
            return signal;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private String prefixToNetmask(InetAddress address, int prefixLength) {
        if (address instanceof Inet4Address) {
            if (prefixLength < 0 || prefixLength > 32) {
                return null;
            }
            int mask = prefixLength == 0 ? 0 : (int) (0xFFFFFFFFL << (32 - prefixLength));
            return String.format(
                    Locale.ROOT,
                    "%d.%d.%d.%d",
                    (mask >>> 24) & 0xFF,
                    (mask >>> 16) & 0xFF,
                    (mask >>> 8) & 0xFF,
                    mask & 0xFF
            );
        }

        if (prefixLength < 0) {
            return null;
        }
        return "/" + prefixLength;
    }

    private String inferTransportFromInterfaceName(String interfaceName) {
        String name = String.valueOf(interfaceName != null ? interfaceName : "").toLowerCase(Locale.ROOT);
        if (name.startsWith("wlan") || name.startsWith("wifi")) {
            return "wifi";
        }
        if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("pdp") || name.startsWith("wwan")) {
            return "cellular";
        }
        if (name.startsWith("eth") || name.startsWith("en")) {
            return "ethernet";
        }
        if (name.startsWith("lo")) {
            return "loopback";
        }
        if (name.startsWith("tun") || name.startsWith("ppp")) {
            return "vpn";
        }
        return "unknown";
    }

    private String formatMacAddress(byte[] macAddress) {
        if (macAddress == null || macAddress.length == 0) {
            return null;
        }

        StringBuilder out = new StringBuilder();
        for (int i = 0; i < macAddress.length; i += 1) {
            if (i > 0) {
                out.append(':');
            }
            out.append(String.format(Locale.ROOT, "%02x", macAddress[i] & 0xFF));
        }
        return out.toString();
    }

    private void handleClient(Socket client) {
        boolean socketHandedOff = false;
        try {
            client.setSoTimeout(10000);
            BufferedInputStream input = new BufferedInputStream(client.getInputStream());

            String requestLine = readLine(input);
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }

            Map<String, String> headers = new HashMap<>();
            String headerLine;
            while ((headerLine = readLine(input)) != null) {
                if (headerLine.isEmpty()) {
                    break;
                }
                int sep = headerLine.indexOf(':');
                if (sep > 0) {
                    String key = headerLine.substring(0, sep).trim().toLowerCase();
                    String value = headerLine.substring(sep + 1).trim();
                    headers.put(key, value);
                }
            }

            // Rileva WebSocket upgrade: gestito dall'Exchange se siamo in modalità exchange
            String upgradeHeader = headers.getOrDefault("upgrade", "");
            String wsKey = headers.get("sec-websocket-key");
            if ("websocket".equalsIgnoreCase(upgradeHeader) && wsKey != null
                    && "exchange".equals(currentExchangeMode)) {
                String expectedToken = readExchangeToken();
                String providedToken = readBearerToken(headers);
                if (!expectedToken.isEmpty() && !expectedToken.equals(providedToken)) {
                    appendGlobalLog(buildExchangeLog("AUTH_REJECTED", "invalid bearer token on websocket upgrade"));
                    writeUnauthorizedResponse(client);
                    return;
                }
                socketHandedOff = true;
                final Socket socketRef = client;
                final String wsKeyRef = wsKey;
                final InputStream inputRef = input;
                clientPool.submit(() -> handleWsExchangeConnection(socketRef, wsKeyRef, inputRef));
                return;
            }

            int contentLength = 0;
            try {
                contentLength = Integer.parseInt(headers.getOrDefault("content-length", "0"));
            } catch (NumberFormatException ignored) {
                contentLength = 0;
            }

            byte[] bodyBytes = readBody(input, contentLength);
            String bodyText = new String(bodyBytes, StandardCharsets.UTF_8);

            String[] firstParts = requestLine.split("\\s+");
            String method = firstParts.length > 0 ? firstParts[0].toUpperCase() : "GET";
            String target = firstParts.length > 1 ? firstParts[1] : "/";
            String path = target.split("\\?")[0];

            if ("GET".equals(method) && "/".equals(path)) {
                List<MessageEndpoint> listeners = collectMessageEndpoints();
                JSONObject payload = new JSONObject();
                payload.put("ok", true);
                payload.put("service", "reactor");
                payload.put("status", "healthy");
                payload.put("timestamp", Instant.now().toString());
                payload.put("uptimeSec", Math.max(0L, (System.currentTimeMillis() - startedAtMs) / 1000L));
                payload.put("httpPort", currentPort);
                payload.put("endpointsCount", listeners.size());
                writeJsonResponse(client, 200, payload.toString());
                return;
            }

            if ("POST".equals(method) && "/message".equals(path)) {
                if (!"node".equals(currentExchangeMode)) {
                    JSONObject payload = new JSONObject();
                    payload.put("ok", false);
                    payload.put("error", "endpoint disabled in current working mode");
                    payload.put("mode", currentExchangeMode);
                    writeJsonResponse(client, 403, payload.toString());
                    return;
                }

                String senderName = headers.getOrDefault("reactor-name", "");
                String senderId = headers.getOrDefault("reactor-sender", "");
                String targetEndpointSelector = headers.getOrDefault("reactor-target-endpoint", "").trim().toLowerCase(Locale.ROOT);
                String targetEndpointId = headers.getOrDefault("reactor-target-endpoint-id", "").trim().toLowerCase(Locale.ROOT);
                if (targetEndpointSelector.isEmpty() && !targetEndpointId.isEmpty()) {
                    targetEndpointSelector = "id:" + targetEndpointId;
                }
                String remoteHost = client.getInetAddress() != null ? String.valueOf(client.getInetAddress().getHostAddress()) : "";

                JSONObject entry = new JSONObject();
                entry.put("timestamp", Instant.now().toString());
                entry.put("type", "MESSAGE_RECEIVED");
                entry.put("scope", "GLOBAL");
                entry.put("phase", "RECEIVED");
                entry.put("senderName", senderName);
                entry.put("senderId", senderId);
                entry.put("remoteHost", remoteHost);
                entry.put("contentType", headers.getOrDefault("content-type", ""));
                entry.put("rawBody", bodyText);
                appendGlobalLog(entry.toString());

                List<MessageEndpoint> listeners = collectMessageEndpoints();
                Set<String> senderCandidates = resolveSenderCandidates(senderName, senderId, remoteHost);
                JSONObject streamPayload = tryParseJsonObject(bodyText);
                boolean streamEnvelope = isStreamEnvelope(streamPayload);
                String streamPhase = streamEnvelope
                        ? streamPayload.optString("phase", "").trim().toLowerCase(Locale.ROOT)
                        : "";
                String primaryEvent = streamEnvelope ? "STREAM" : "MESSAGE";
                String streamSenderKey = String.valueOf(senderName == null ? "" : senderName).trim().toLowerCase(Locale.ROOT);
                if (streamSenderKey.isEmpty()) {
                    streamSenderKey = String.valueOf(senderId == null ? "" : senderId).trim().toLowerCase(Locale.ROOT);
                }
                if (streamSenderKey.isEmpty()) {
                    streamSenderKey = String.valueOf(remoteHost == null ? "" : remoteHost).trim().toLowerCase(Locale.ROOT);
                }
                Map<String, String> effectiveHeaders = streamEnvelope
                        ? withStreamHeaders(headers, streamPayload, primaryEvent)
                        : new HashMap<>(headers);
                Map<String, String> streamEventContext = streamEnvelope
                    ? buildIncomingStreamEventContext(streamSenderKey, streamPayload)
                    : new HashMap<>();
                JSONArray deliveredEndpoints = new JSONArray();
                JSONArray streamEndEndpoints = new JSONArray();
                int deliveredCount = 0;
                int streamEndCount = 0;

                for (MessageEndpoint endpoint : listeners) {
                    if (!matchesEventSender(endpoint, senderCandidates, primaryEvent)) {
                        continue;
                    }
                    if (!matchesTargetEndpoint(endpoint, targetEndpointSelector)) {
                        continue;
                    }

                    try {
                        writeExecutionStart(endpoint, primaryEvent, primaryEvent, streamEventContext);
                        executeEndpointActions(endpoint, bodyText, effectiveHeaders, streamEventContext);
                        deliveredEndpoints.put(endpoint.endpointName);
                        deliveredCount += 1;
                    } catch (Exception executionError) {
                        writeExecutionError(endpoint, primaryEvent, primaryEvent, executionError.getMessage(), streamEventContext);
                    }
                }

                if (streamEnvelope && "end".equals(streamPhase)) {
                    Map<String, String> streamEndHeaders = withStreamHeaders(headers, streamPayload, "STREAMEND");
                    for (MessageEndpoint endpoint : listeners) {
                        if (!matchesEventSender(endpoint, senderCandidates, "STREAMEND")) {
                            continue;
                        }
                        if (!matchesTargetEndpoint(endpoint, targetEndpointSelector)) {
                            continue;
                        }

                        try {
                            writeExecutionStart(endpoint, "STREAMEND", "STREAMEND", streamEventContext);
                            executeEndpointActions(endpoint, bodyText, streamEndHeaders, streamEventContext);
                            streamEndEndpoints.put(endpoint.endpointName);
                            streamEndCount += 1;
                        } catch (Exception executionError) {
                            writeExecutionError(endpoint, "STREAMEND", "STREAMEND", executionError.getMessage(), streamEventContext);
                        }
                    }
                }

                JSONObject payload = new JSONObject();
                payload.put("ok", true);
                payload.put("trigger", primaryEvent);
                payload.put("delivered", deliveredCount > 0);
                payload.put("endpoints", deliveredEndpoints);
                payload.put("deliveredCount", deliveredCount);
                payload.put("streamEndEndpoints", streamEndEndpoints);
                payload.put("streamEndDeliveredCount", streamEndCount);
                payload.put("senderCandidates", new JSONArray(senderCandidates));

                if (deliveredCount > 0) {
                    writeJsonResponse(client, 200, payload.toString());
                } else {
                    payload.put("reason", "no listeners");
                    writeJsonResponse(client, 202, payload.toString());
                }
                return;
            }

            JSONObject payload = new JSONObject();
            payload.put("ok", false);
            payload.put("error", "endpoint not found");
            payload.put("method", method);
            payload.put("path", path);
            writeJsonResponse(client, 404, payload.toString());
        } catch (Exception ignored) {
            // Best-effort request handling.
        } finally {
            if (!socketHandedOff) {
                try { client.close(); } catch (IOException ignored) {}
            }
        }
    }

    private List<MessageEndpoint> collectMessageEndpoints() {
        List<MessageEndpoint> listeners = new ArrayList<>();
        File projectsDir = new File(getFilesDir(), "endpoints");
        if (!projectsDir.exists() || !projectsDir.isDirectory()) {
            return listeners;
        }

        File[] children = projectsDir.listFiles();
        if (children == null) {
            return listeners;
        }

        for (File child : children) {
            if (child == null || !child.isDirectory()) {
                continue;
            }

            File endpointFile = resolveEndpointFileFromProject(child);
            if (endpointFile == null || !endpointFile.exists()) {
                continue;
            }

            MessageEndpoint endpoint = parseMessageEndpoint(endpointFile, child.getName());
            if (endpoint == null || !endpoint.enabled) {
                continue;
            }

            listeners.add(endpoint);
        }

        return listeners;
    }

    private File resolveEndpointFileFromProject(File projectDir) {
        File bootTs = new File(projectDir, "boot.ts");
        if (bootTs.exists()) {
            return bootTs;
        }

        File bootJs = new File(projectDir, "boot.js");
        if (bootJs.exists()) {
            return bootJs;
        }

        return null;
    }

    private String readProjectEndpointId(File projectDir) {
        try {
            File uuidFile = new File(projectDir, "uuid");
            if (!uuidFile.exists()) {
                return null;
            }

            String value = readTextFile(uuidFile).trim().toLowerCase(Locale.ROOT);
            return isUuidV4(value) ? value : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean isUuidV4(String value) {
        return String.valueOf(value).trim().toLowerCase(Locale.ROOT)
                .matches("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    }

    private JSONArray parseEndpointTriggersFromSource(String source) {
        JSONArray triggers = new JSONArray();
        Set<String> unique = new HashSet<>();
        if (source == null || source.isEmpty()) {
            return triggers;
        }

        String[] lines = source.split("\\r?\\n", -1);
        for (String rawLine : lines) {
            String line = String.valueOf(rawLine).trim();
            if (!line.startsWith("// @on")) {
                continue;
            }

            String value = line.replace("// @on", "").trim();
            String upperValue = value.toUpperCase(Locale.ROOT);
            if (upperValue.startsWith("SCHEDULE")) {
                if (!unique.contains("SCHEDULE")) {
                    unique.add("SCHEDULE");
                    triggers.put("SCHEDULE");
                }
                continue;
            }

            if (upperValue.startsWith("WATCH")) {
                if (!unique.contains("WATCH")) {
                    unique.add("WATCH");
                    triggers.put("WATCH");
                }
                continue;
            }

            if (matchesSingleOnType(value, "STREAMEND")) {
                if (!unique.contains("STREAMEND")) {
                    unique.add("STREAMEND");
                    triggers.put("STREAMEND");
                }
                continue;
            }

            if (matchesSingleOnType(value, "STREAM")) {
                if (!unique.contains("STREAM")) {
                    unique.add("STREAM");
                    triggers.put("STREAM");
                }
                continue;
            }

            if (matchesSingleOnType(value, "MESSAGE")) {
                if (!unique.contains("MESSAGE")) {
                    unique.add("MESSAGE");
                    triggers.put("MESSAGE");
                }
                continue;
            }

            if ("NET_CHANGE".equalsIgnoreCase(value)) {
                if (!unique.contains("NET_CHANGE")) {
                    unique.add("NET_CHANGE");
                    triggers.put("NET_CHANGE");
                }
                continue;
            }

            List<String> tokens = splitDirectiveTokens(value);
            for (String token : tokens) {
                String normalized = String.valueOf(token).trim();
                if (normalized.isEmpty()) {
                    continue;
                }

                int open = normalized.indexOf('(');
                int openBracket = normalized.indexOf('[');
                int cut = open;
                if (cut < 0 || (openBracket >= 0 && openBracket < cut)) {
                    cut = openBracket;
                }

                String trigger = (cut >= 0 ? normalized.substring(0, cut) : normalized)
                        .trim()
                        .toUpperCase(Locale.ROOT);
                if (trigger.isEmpty() || unique.contains(trigger)) {
                    continue;
                }

                unique.add(trigger);
                triggers.put(trigger);
            }
        }

        return triggers;
    }

    private JSONArray buildDiscoveryEndpointsPayload() {
        JSONArray endpoints = new JSONArray();
        File projectsDir = new File(getFilesDir(), "endpoints");
        if (!projectsDir.exists() || !projectsDir.isDirectory()) {
            return endpoints;
        }

        File[] children = projectsDir.listFiles();
        if (children == null) {
            return endpoints;
        }

        for (File child : children) {
            if (child == null || !child.isDirectory()) {
                continue;
            }

            File endpointFile = resolveEndpointFileFromProject(child);
            if (endpointFile == null || !endpointFile.exists()) {
                continue;
            }

            try {
                String source = readTextFile(endpointFile);
                String endpointId = readProjectEndpointId(child);
                if (endpointId == null || endpointId.trim().isEmpty()) {
                    continue;
                }

                boolean enabled = false;
                boolean mutex = false;
                String[] lines = source.split("\\r?\\n", -1);
                for (String rawLine : lines) {
                    String line = String.valueOf(rawLine).trim();
                    if (!line.startsWith("// @")) {
                        continue;
                    }

                    if (line.startsWith("// @enabled")) {
                        enabled = line.toUpperCase(Locale.ROOT).contains("TRUE");
                        continue;
                    }

                    if (line.startsWith("// @mutex")) {
                        mutex = line.toUpperCase(Locale.ROOT).contains("TRUE");
                    }
                }

                JSONObject endpoint = new JSONObject();
                endpoint.put("uuid", endpointId);
                endpoint.put("name", child.getName());
                endpoint.put("triggers", parseEndpointTriggersFromSource(source));
                endpoint.put("enabled", enabled);
                endpoint.put("mutex", mutex);
                endpoints.put(endpoint);
            } catch (Exception ignored) {
                // Skip malformed endpoint metadata entries.
            }
        }

        return endpoints;
    }

    private String parseEndpointSelector(String rawSelector) {
        String selector = String.valueOf(rawSelector).trim().toLowerCase(Locale.ROOT);
        if (selector.isEmpty()) {
            return null;
        }

        if (!selector.startsWith("id:")) {
            return selector;
        }

        String endpointId = selector.substring(3).trim();
        if (!isUuidV4(endpointId)) {
            return null;
        }

        return "id:" + endpointId;
    }

    private String normalizeDirectNodeTarget(String rawNode, int fallbackPort) {
        String node = String.valueOf(rawNode).trim().toLowerCase(Locale.ROOT);
        if (node.isEmpty()) {
            return null;
        }

        if (node.startsWith("http://") || node.startsWith("https://")) {
            try {
                URL parsed = new URL(node);
                String host = String.valueOf(parsed.getHost()).trim().toLowerCase(Locale.ROOT);
                int resolvedPort = parsed.getPort() > 0 ? parsed.getPort() : fallbackPort;
                if (host.isEmpty() || resolvedPort < 1 || resolvedPort > 65535) {
                    return null;
                }
                return host + ":" + resolvedPort;
            } catch (Exception ignored) {
                return null;
            }
        }

        if (node.matches("^[^:]+:[0-9]{1,5}$")) {
            String[] parts = node.split(":", 2);
            try {
                int port = Integer.parseInt(parts[1]);
                if (parts[0].trim().isEmpty() || port < 1 || port > 65535) {
                    return null;
                }
                return parts[0].trim() + ":" + port;
            } catch (NumberFormatException ignored) {
                return null;
            }
        }

        if (node.contains(":")) {
            return null;
        }

        return node + ":" + fallbackPort;
    }

    private ParsedTarget parseTarget(String rawTarget) {
        String trimmed = String.valueOf(rawTarget).trim();
        if (trimmed.isEmpty()) {
            return null;
        }

        ParsedTarget parsed = new ParsedTarget();
        parsed.originalTarget = trimmed;

        int atIndex = trimmed.lastIndexOf('@');
        if (atIndex < 0) {
            String endpointSelector = parseEndpointSelector(trimmed);
            if (endpointSelector == null) {
                return null;
            }
            parsed.baseTarget = "";
            parsed.nodeName = null;
            parsed.endpointSelector = endpointSelector;
            parsed.endpointId = endpointSelector.startsWith("id:") ? endpointSelector.substring(3) : null;
            parsed.directAddress = false;
            return parsed;
        }

        String endpointPart = trimmed.substring(0, atIndex).trim();
        String nodePart = trimmed.substring(atIndex + 1).trim();
        String endpointSelector = parseEndpointSelector(endpointPart);
        if (endpointSelector == null || nodePart.isEmpty()) {
            return null;
        }

        parsed.endpointSelector = endpointSelector;
        parsed.endpointId = endpointSelector.startsWith("id:") ? endpointSelector.substring(3) : null;

        if (nodePart.toLowerCase(Locale.ROOT).startsWith("net:")) {
            String directTarget = normalizeDirectNodeTarget(nodePart.substring(4), currentPort > 0 ? currentPort : DEFAULT_PORT);
            if (directTarget == null) {
                return null;
            }

            parsed.baseTarget = directTarget;
            parsed.nodeName = null;
            parsed.directAddress = true;
            return parsed;
        }

        String logicalNode = nodePart.toLowerCase(Locale.ROOT);
        if (logicalNode.isEmpty()) {
            return null;
        }

        parsed.baseTarget = logicalNode;
        parsed.nodeName = logicalNode;
        parsed.directAddress = false;
        return parsed;
    }

    private static class ParsedIncomingEnvelope {
        String bodyText;
        String contentType;
        Map<String, String> messageHeaders;
    }

    public static void handleIncomingP2PEnvelope(String fromNode, String rawPayload) {
        ReactorHttpService current = instance;
        if (current == null) {
            return;
        }

        current.handleIncomingP2PEnvelopeInternal(fromNode, rawPayload);
    }

    public static JSObject runEndpointNowByPath(String filePath) {
        ReactorHttpService current = instance;
        if (current == null) {
            return new JSObject().put("ok", false).put("error", "runtime not ready");
        }

        return current.runEndpointNowByPathInternal(filePath);
    }

    private JSObject runEndpointNowByPathInternal(String filePath) {
        String normalizedPath = String.valueOf(filePath == null ? "" : filePath).trim();
        if (normalizedPath.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "invalid request");
        }

        File endpointFile = new File(normalizedPath);
        if (!endpointFile.exists() || !endpointFile.isFile()) {
            return new JSObject().put("ok", false).put("error", "endpoint file not found");
        }

        File projectDir = endpointFile.getParentFile();
        if (projectDir == null || !projectDir.exists() || !projectDir.isDirectory()) {
            return new JSObject().put("ok", false).put("error", "invalid endpoint project");
        }

        File resolvedEndpointFile = resolveEndpointFileFromProject(projectDir);
        if (resolvedEndpointFile == null || !resolvedEndpointFile.exists()) {
            return new JSObject().put("ok", false).put("error", "endpoint file not found");
        }

        MessageEndpoint endpoint = parseMessageEndpoint(resolvedEndpointFile, projectDir.getName());
        if (endpoint == null) {
            endpoint = buildManualRunnableEndpoint(resolvedEndpointFile, projectDir.getName());
        }
        if (endpoint == null) {
            return new JSObject().put("ok", false).put("error", "endpoint parse failed");
        }

        Map<String, String> headers = new HashMap<>();
        headers.put("x-reactor-trigger", "MANUAL_TEST");
        final MessageEndpoint endpointToRun = endpoint;
        final Map<String, String> executionHeaders = headers;

        clientPool.execute(() -> {
            try {
                writeExecutionStart(endpointToRun, "MANUAL_TEST", "ON_DEMAND");
                executeEndpointActions(endpointToRun, "", executionHeaders, null);
            } catch (Exception executionError) {
                writeExecutionError(endpointToRun, "MANUAL_TEST", "ON_DEMAND", executionError.getMessage());
            }
        });

        File projectLogFile = new File(projectDir, "activity.log");
        return new JSObject()
                .put("ok", true)
                .put("started", true)
                .put("endpoint", endpoint.endpointName)
                .put("eventLogPath", projectLogFile.getAbsolutePath());
    }

    private MessageEndpoint buildManualRunnableEndpoint(File endpointFile, String projectName) {
        try {
            String source = readTextFile(endpointFile);
            String[] lines = source.split("\\r?\\n", -1);

            boolean enabled = false;
            boolean debug = false;
            String state = "DISABLED";

            for (String rawLine : lines) {
                String line = String.valueOf(rawLine).trim();
                if (line.startsWith("// @enabled")) {
                    enabled = line.toUpperCase(Locale.ROOT).contains("TRUE");
                    state = enabled ? "ENABLED" : "DISABLED";
                    continue;
                }

                if (line.startsWith("// @debug")) {
                    debug = line.toUpperCase(Locale.ROOT).contains("TRUE");
                }
            }

            MessageEndpoint endpoint = new MessageEndpoint();
            endpoint.endpointFile = endpointFile;
            endpoint.endpointName = projectName;
            endpoint.endpointPath = endpointFile.getAbsolutePath();
            endpoint.endpointId = readProjectEndpointId(endpointFile.getParentFile());
            endpoint.endpointState = state;
            endpoint.source = source;
            endpoint.enabled = enabled;
            endpoint.debug = debug;
            endpoint.hasMessageEvent = false;
            endpoint.messageFromAnySender = true;
            endpoint.messageSenders = new ArrayList<>();
            endpoint.hasStreamEvent = false;
            endpoint.streamFromAnySender = true;
            endpoint.streamSenders = new ArrayList<>();
            endpoint.hasStreamEndEvent = false;
            endpoint.streamEndFromAnySender = true;
            endpoint.streamEndSenders = new ArrayList<>();
            endpoint.hasNetChangeEvent = false;
            endpoint.hasWatchEvent = false;
            endpoint.watchRules = new ArrayList<>();
            return endpoint;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void handleIncomingP2PEnvelopeInternal(String fromNode, String rawPayload) {
        String safeFromNode = normalizeP2PTarget(fromNode);
        if (safeFromNode.isEmpty()) {
            return;
        }

        ParsedIncomingEnvelope parsedEnvelope = parseIncomingP2PEnvelope(rawPayload);
        Map<String, String> headers = new HashMap<>();
        headers.putAll(parsedEnvelope.messageHeaders);
        headers.put("x-p2p-from", safeFromNode);
        headers.put("reactor-name", safeFromNode);
        headers.put("reactor-sender", safeFromNode);

        List<MessageEndpoint> listeners = collectMessageEndpoints();
        Set<String> senderCandidates = resolveSenderCandidates(safeFromNode, safeFromNode, "");
        JSONObject streamPayload = tryParseJsonObject(parsedEnvelope.bodyText);
        boolean streamEnvelope = isStreamEnvelope(streamPayload);
        String streamPhase = streamEnvelope
                ? streamPayload.optString("phase", "").trim().toLowerCase(Locale.ROOT)
                : "";
        String primaryEvent = streamEnvelope ? "STREAM" : "MESSAGE";
        Map<String, String> streamEventContext = streamEnvelope
            ? buildIncomingStreamEventContext(safeFromNode, streamPayload)
            : new HashMap<>();
        Map<String, String> effectiveHeaders = streamEnvelope
                ? withStreamHeaders(headers, streamPayload, primaryEvent)
                : new HashMap<>(headers);
        String targetEndpointSelector = effectiveHeaders.getOrDefault("reactor-target-endpoint", "").trim().toLowerCase(Locale.ROOT);
        String targetEndpointId = effectiveHeaders.getOrDefault("reactor-target-endpoint-id", "").trim().toLowerCase(Locale.ROOT);
        if (targetEndpointSelector.isEmpty() && !targetEndpointId.isEmpty()) {
            targetEndpointSelector = "id:" + targetEndpointId;
        }

        for (MessageEndpoint endpoint : listeners) {
            if (!matchesEventSender(endpoint, senderCandidates, primaryEvent)) {
                continue;
            }
            if (!matchesTargetEndpoint(endpoint, targetEndpointSelector)) {
                continue;
            }

            try {
                writeExecutionStart(endpoint, primaryEvent, primaryEvent, streamEventContext);
                executeEndpointActions(endpoint, parsedEnvelope.bodyText, effectiveHeaders, streamEventContext);
            } catch (Exception executionError) {
                writeExecutionError(endpoint, primaryEvent, primaryEvent, executionError.getMessage(), streamEventContext);
            }
        }

        if (streamEnvelope && "end".equals(streamPhase)) {
            Map<String, String> streamEndHeaders = withStreamHeaders(headers, streamPayload, "STREAMEND");
            String streamEndTargetEndpointSelector = streamEndHeaders.getOrDefault("reactor-target-endpoint", "").trim().toLowerCase(Locale.ROOT);
            String streamEndTargetEndpointId = streamEndHeaders.getOrDefault("reactor-target-endpoint-id", "").trim().toLowerCase(Locale.ROOT);
            if (streamEndTargetEndpointSelector.isEmpty() && !streamEndTargetEndpointId.isEmpty()) {
                streamEndTargetEndpointSelector = "id:" + streamEndTargetEndpointId;
            }
            for (MessageEndpoint endpoint : listeners) {
                if (!matchesEventSender(endpoint, senderCandidates, "STREAMEND")) {
                    continue;
                }
                if (!matchesTargetEndpoint(endpoint, streamEndTargetEndpointSelector)) {
                    continue;
                }

                try {
                    writeExecutionStart(endpoint, "STREAMEND", "STREAMEND", streamEventContext);
                    executeEndpointActions(endpoint, parsedEnvelope.bodyText, streamEndHeaders, streamEventContext);
                } catch (Exception executionError) {
                    writeExecutionError(endpoint, "STREAMEND", "STREAMEND", executionError.getMessage(), streamEventContext);
                }
            }
        }
    }

    private ParsedIncomingEnvelope parseIncomingP2PEnvelope(String rawPayload) {
        ParsedIncomingEnvelope parsed = new ParsedIncomingEnvelope();
        parsed.bodyText = String.valueOf(rawPayload == null ? "" : rawPayload);
        parsed.contentType = "text/plain; charset=utf-8";
        parsed.messageHeaders = new HashMap<>();

        JSONObject envelope = tryParseJsonObject(parsed.bodyText);
        if (envelope == null) {
            return parsed;
        }

        String payloadType = String.valueOf(envelope.optString("payloadType", "string")).trim().toLowerCase(Locale.ROOT);
        String contentType = String.valueOf(envelope.optString("contentType", "")).trim();
        if (!contentType.isEmpty()) {
            parsed.contentType = contentType;
        }

        JSONObject messageHeaders = envelope.optJSONObject("messageHeaders");
        if (messageHeaders != null) {
            Iterator<String> keys = messageHeaders.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String safeKey = String.valueOf(key == null ? "" : key).trim().toLowerCase(Locale.ROOT);
                if (safeKey.isEmpty()) {
                    continue;
                }
                parsed.messageHeaders.put(safeKey, String.valueOf(messageHeaders.opt(key)));
            }
        }

        Object rawEnvelopePayload = envelope.opt("payload");
        if ("base64".equals(payloadType)) {
            try {
                byte[] decoded = Base64.decode(String.valueOf(rawEnvelopePayload == null ? "" : rawEnvelopePayload), Base64.DEFAULT);
                parsed.bodyText = new String(decoded, StandardCharsets.UTF_8);
            } catch (Exception ignored) {
                parsed.bodyText = "";
            }
            return parsed;
        }

        if ("json".equals(payloadType)) {
            if (rawEnvelopePayload instanceof JSONObject || rawEnvelopePayload instanceof JSONArray) {
                parsed.bodyText = String.valueOf(rawEnvelopePayload);
            } else {
                parsed.bodyText = String.valueOf(rawEnvelopePayload == null ? "" : rawEnvelopePayload);
            }
            if (parsed.contentType.trim().isEmpty()) {
                parsed.contentType = "application/json; charset=utf-8";
            }
            return parsed;
        }

        if ("null".equals(payloadType)) {
            parsed.bodyText = "";
            return parsed;
        }

        if (rawEnvelopePayload instanceof JSONObject || rawEnvelopePayload instanceof JSONArray) {
            parsed.bodyText = String.valueOf(rawEnvelopePayload);
        } else {
            parsed.bodyText = String.valueOf(rawEnvelopePayload == null ? "" : rawEnvelopePayload);
        }
        return parsed;
    }

    private File getIncomingStreamsDirectory() {
        return new File(getFilesDir(), "temp_files/streams");
    }

    private String buildIncomingStreamKey(String senderKey, String streamId) {
        String safeSender = String.valueOf(senderKey == null ? "" : senderKey).trim().toLowerCase(Locale.ROOT);
        String safeStreamId = String.valueOf(streamId == null ? "" : streamId).trim();
        return safeSender + "|" + safeStreamId;
    }

    private String sanitizeIncomingStreamSegment(String value) {
        String safe = String.valueOf(value == null ? "" : value).replaceAll("[^a-zA-Z0-9._-]", "_");
        if (safe.isEmpty()) {
            return "unknown";
        }
        return safe.length() > 64 ? safe.substring(0, 64) : safe;
    }

    private void appendMetadataContext(Map<String, String> context, String prefix, JSONObject metadata) {
        if (context == null || metadata == null) {
            return;
        }

        Iterator<String> keys = metadata.keys();
        while (keys.hasNext()) {
            String key = String.valueOf(keys.next());
            String safeKey = key.trim();
            if (safeKey.isEmpty()) {
                continue;
            }

            Object value = metadata.opt(safeKey);
            String nextPrefix = prefix + "." + safeKey;
            if (value instanceof JSONObject) {
                appendMetadataContext(context, nextPrefix, (JSONObject) value);
                continue;
            }

            if (value instanceof JSONArray) {
                context.put(nextPrefix, String.valueOf(value));
                continue;
            }

            if (value == null || value == JSONObject.NULL) {
                continue;
            }

            context.put(nextPrefix, String.valueOf(value));
        }
    }

    private Map<String, String> buildIncomingStreamEventContext(String senderKey, JSONObject streamPayload) {
        Map<String, String> context = new HashMap<>();
        if (streamPayload == null || !streamPayload.optBoolean("__reactorStream", false)) {
            return context;
        }

        String streamId = String.valueOf(streamPayload.optString("streamId", "")).trim();
        if (streamId.isEmpty()) {
            return context;
        }

        String phase = String.valueOf(streamPayload.optString("phase", "")).trim().toLowerCase(Locale.ROOT);
        String key = buildIncomingStreamKey(senderKey, streamId);
        context.put("event.streamId", streamId);

        if ("start".equals(phase)) {
            try {
                File dir = getIncomingStreamsDirectory();
                if (!dir.exists()) {
                    dir.mkdirs();
                }

                IncomingStreamState previous = incomingStreams.remove(key);
                if (previous != null) {
                    try {
                        if (previous.output != null) {
                            previous.output.close();
                        }
                    } catch (Exception ignored) {
                        // Ignore stale stream close errors.
                    }
                }

                IncomingStreamState state = new IncomingStreamState();
                state.key = key;
                state.streamId = streamId;
                state.sender = String.valueOf(senderKey == null ? "" : senderKey);
                String senderSegment = sanitizeIncomingStreamSegment(state.sender);
                String streamSegment = sanitizeIncomingStreamSegment(streamId);
                state.partFile = new File(dir, System.currentTimeMillis() + "-" + senderSegment + "-" + streamSegment + ".part");
                state.output = new FileOutputStream(state.partFile, false);
                state.metadata = streamPayload.optJSONObject("metadata");
                state.contentType = String.valueOf(streamPayload.optString("contentType", "application/octet-stream"));
                state.totalBytes = 0L;
                state.chunks = 0;
                incomingStreams.put(key, state);
            } catch (Exception ignored) {
                // Best effort stream cache.
            }
            return context;
        }

        IncomingStreamState state = incomingStreams.get(key);
        if (state == null) {
            return context;
        }

        if ("chunk".equals(phase)) {
            try {
                String encoding = String.valueOf(streamPayload.optString("encoding", "base64")).trim().toLowerCase(Locale.ROOT);
                byte[] bytes;
                if ("base64".equals(encoding)) {
                    bytes = Base64.decode(String.valueOf(streamPayload.optString("data", "")), Base64.DEFAULT);
                } else {
                    bytes = String.valueOf(streamPayload.optString("data", "")).getBytes(StandardCharsets.UTF_8);
                }

                if (bytes != null && bytes.length > 0 && state.output != null) {
                    state.output.write(bytes);
                    state.totalBytes += bytes.length;
                }
                state.chunks += 1;
            } catch (Exception ignored) {
                // Ignore malformed chunks.
            }
            return context;
        }

        if (!"end".equals(phase)) {
            return context;
        }

        incomingStreams.remove(key);
        File finalFile = null;
        try {
            if (state.output != null) {
                state.output.flush();
                state.output.close();
            }
            String finalName = String.valueOf(state.partFile.getName()).replaceAll("\\.part$", ".bin");
            finalFile = new File(state.partFile.getParentFile(), finalName);
            boolean renamed = state.partFile.renameTo(finalFile);
            if (!renamed) {
                finalFile = state.partFile;
            }
        } catch (Exception ignored) {
            finalFile = state.partFile;
        }

        String tmpPath = finalFile != null ? finalFile.getAbsolutePath() : "";
        context.put("event.tmpPath", tmpPath);

        JSONObject metadata = state.metadata != null ? state.metadata : streamPayload.optJSONObject("metadata");
        if (metadata != null) {
            appendMetadataContext(context, "event.metadata", metadata);
        }

        return context;
    }

    private boolean getP2PRoutingEligibility() {
        if (!"node".equals(currentExchangeMode)) {
            return false;
        }

        JSObject workingMode = readWorkingModeConfigFromFile();
        JSONObject stunConfig = workingMode != null ? workingMode.optJSONObject("stun") : null;
        JSONObject turnConfig = workingMode != null ? workingMode.optJSONObject("turn") : null;
        String stunHost = String.valueOf(stunConfig != null ? stunConfig.optString("host", "") : "").trim();
        String turnHost = String.valueOf(turnConfig != null ? turnConfig.optString("host", "") : "").trim();
        if (stunHost.isEmpty() || turnHost.isEmpty()) {
            return false;
        }

        try {
            AndroidP2PWebRtcManager manager = AndroidP2PWebRtcManager.getInstance(getApplicationContext());
            JSObject nativeStatus = manager.getNativeStatus();
            return nativeStatus != null && nativeStatus.optBoolean("ok", false);
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean hasConnectedP2PRoute(String targetNodeName) {
        String safeTarget = normalizeP2PTarget(targetNodeName);
        if (safeTarget.isEmpty()) {
            return false;
        }

        if (!getP2PRoutingEligibility()) {
            return false;
        }

        JSONObject trackedSession = p2pSessions.get(safeTarget);
        String trackedState = String.valueOf(trackedSession != null ? trackedSession.optString("state", "") : "")
                .trim()
                .toLowerCase(Locale.ROOT);
        boolean stateConnected = "connected-p2p".equals(trackedState) || "connected-turn".equals(trackedState);
        if (!stateConnected) {
            return false;
        }

        try {
            AndroidP2PWebRtcManager manager = AndroidP2PWebRtcManager.getInstance(getApplicationContext());
            JSObject nativeStatus = manager.getNativeStatus();
            JSONArray sessions = nativeStatus != null ? nativeStatus.optJSONArray("sessions") : null;
            if (sessions == null) {
                return false;
            }

            for (int index = 0; index < sessions.length(); index += 1) {
                JSONObject session = sessions.optJSONObject(index);
                if (session == null) {
                    continue;
                }

                String target = normalizeP2PTarget(session.optString("target", ""));
                String dataChannelState = String.valueOf(session.optString("dataChannel", "")).trim().toLowerCase(Locale.ROOT);
                if (safeTarget.equals(target) && "open".equals(dataChannelState)) {
                    return true;
                }
            }
        } catch (Exception ignored) {
            return false;
        }

        return false;
    }

    private String resolveP2PDeliveredVia(String targetNodeName) {
        String safeTarget = normalizeP2PTarget(targetNodeName);
        JSONObject trackedSession = p2pSessions.get(safeTarget);
        String trackedState = String.valueOf(trackedSession != null ? trackedSession.optString("state", "") : "")
                .trim()
                .toLowerCase(Locale.ROOT);
        return "connected-turn".equals(trackedState) ? "P2P_RELAY" : "P2P_DIRECT";
    }

    private String buildP2PEnvelope(String content, String contentType, Map<String, String> extraHeaders) {
        JSONObject envelope = new JSONObject();
        JSONObject headers = new JSONObject();
        try {
            envelope.put("kind", "message");
            String safeContentType = String.valueOf(contentType == null ? "" : contentType).trim();
            String safeContent = String.valueOf(content == null ? "" : content);
            if (safeContentType.toLowerCase(Locale.ROOT).contains("application/json")) {
                envelope.put("payloadType", "json");
                envelope.put("payload", safeContent);
            } else {
                envelope.put("payloadType", "string");
                envelope.put("payload", safeContent);
            }
            envelope.put("contentType", safeContentType.isEmpty() ? "text/plain; charset=utf-8" : safeContentType);

            if (extraHeaders != null) {
                for (Map.Entry<String, String> entry : extraHeaders.entrySet()) {
                    String key = String.valueOf(entry.getKey() == null ? "" : entry.getKey()).trim().toLowerCase(Locale.ROOT);
                    if (key.isEmpty()) {
                        continue;
                    }
                    headers.put(key, String.valueOf(entry.getValue() == null ? "" : entry.getValue()));
                }
            }

            envelope.put("messageHeaders", headers);
        } catch (Exception error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "unable to build p2p envelope");
        }

        return envelope.toString();
    }

    private SendDeliveryResult sendP2PMessage(String targetNodeName, String content, String contentType, Map<String, String> extraHeaders) {
        String safeTarget = normalizeP2PTarget(targetNodeName);
        if (safeTarget.isEmpty()) {
            throw new RuntimeException("invalid p2p target");
        }

        try {
            AndroidP2PWebRtcManager manager = AndroidP2PWebRtcManager.getInstance(getApplicationContext());
            String envelope = buildP2PEnvelope(content, contentType, extraHeaders);
            JSObject result = manager.sendData(safeTarget, envelope);
            boolean ok = result != null && result.optBoolean("ok", false);
            if (!ok) {
                String error = result != null ? String.valueOf(result.optString("error", "p2p send failed")) : "p2p send failed";
                throw new RuntimeException(error);
            }

            return SendDeliveryResult.success(safeTarget, resolveP2PDeliveredVia(safeTarget));
        } catch (Exception error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "p2p send failed");
        }
    }

    private MessageEndpoint parseMessageEndpoint(File endpointFile, String projectName) {
        try {
            String source = readTextFile(endpointFile);
            String[] lines = source.split("\\r?\\n", -1);

            String state = "DISABLED";
            boolean enabled = false;
            boolean debug = false;
            boolean hasMessageEvent = false;
            boolean messageFromAnySender = false;
            List<String> messageSenders = new ArrayList<>();
            boolean hasStreamEvent = false;
            boolean streamFromAnySender = false;
            List<String> streamSenders = new ArrayList<>();
            boolean hasStreamEndEvent = false;
            boolean streamEndFromAnySender = false;
            List<String> streamEndSenders = new ArrayList<>();
            boolean hasNetChangeEvent = false;
            boolean hasWatchEvent = false;
            List<WatchRule> watchRules = new ArrayList<>();

            for (String rawLine : lines) {
                String line = rawLine.trim();
                if (!line.startsWith("// @")) {
                    continue;
                }

                if (line.startsWith("// @enabled")) {
                    boolean isEnabled = line.toUpperCase(Locale.ROOT).contains("TRUE");
                    state = isEnabled ? "ENABLED" : "DISABLED";
                    enabled = isEnabled;
                    continue;
                }

                if (line.startsWith("// @debug")) {
                    debug = line.toUpperCase(Locale.ROOT).contains("TRUE");
                    continue;
                }

                if (line.startsWith("// @on")) {
                    String value = line.replace("// @on", "").trim();
                    String normalizedValue = String.valueOf(value).trim();
                    if (matchesSingleOnType(normalizedValue, "STREAMEND")) {
                        hasStreamEndEvent = true;
                        List<String> senders = parseOnSenderList(normalizedValue, "STREAMEND");
                        if (senders == null || senders.isEmpty()) {
                            streamEndFromAnySender = true;
                        } else {
                            for (String sender : senders) {
                                if (!streamEndSenders.contains(sender)) {
                                    streamEndSenders.add(sender);
                                }
                            }
                        }
                        continue;
                    }

                    if (matchesSingleOnType(normalizedValue, "STREAM")) {
                        hasStreamEvent = true;
                        List<String> senders = parseOnSenderList(normalizedValue, "STREAM");
                        if (senders == null || senders.isEmpty()) {
                            streamFromAnySender = true;
                        } else {
                            for (String sender : senders) {
                                if (!streamSenders.contains(sender)) {
                                    streamSenders.add(sender);
                                }
                            }
                        }
                        continue;
                    }

                    if (matchesSingleOnType(normalizedValue, "MESSAGE")) {
                        hasMessageEvent = true;
                        List<String> senders = parseOnSenderList(normalizedValue, "MESSAGE");
                        if (senders == null || senders.isEmpty()) {
                            messageFromAnySender = true;
                        } else {
                            for (String sender : senders) {
                                if (!messageSenders.contains(sender)) {
                                    messageSenders.add(sender);
                                }
                            }
                        }
                        continue;
                    }

                    if (normalizedValue.toUpperCase(Locale.ROOT).startsWith("WATCH")) {
                        WatchRule parsedWatch = parseWatchRule(normalizedValue);
                        if (parsedWatch != null) {
                            hasWatchEvent = true;
                            watchRules.add(parsedWatch);
                        }
                        continue;
                    }

                    if ("NET_CHANGE".equalsIgnoreCase(normalizedValue)) {
                        hasNetChangeEvent = true;
                        continue;
                    }

                    List<String> tokens = splitDirectiveTokens(value);
                    for (String token : tokens) {
                        String normalizedToken = token.trim();
                        String upperToken = normalizedToken.toUpperCase(Locale.ROOT);

                        if (upperToken.startsWith("STREAMEND")) {
                            hasStreamEndEvent = true;
                            List<String> senders = parseOnSenderList(normalizedToken, "STREAMEND");
                            if (senders == null || senders.isEmpty()) {
                                streamEndFromAnySender = true;
                                continue;
                            }

                            for (String sender : senders) {
                                if (!streamEndSenders.contains(sender)) {
                                    streamEndSenders.add(sender);
                                }
                            }
                            continue;
                        }

                        if (upperToken.startsWith("NET_CHANGE")) {
                            hasNetChangeEvent = true;
                            continue;
                        }

                        if (upperToken.startsWith("WATCH")) {
                            WatchRule parsedWatch = parseWatchRule(normalizedToken);
                            if (parsedWatch != null) {
                                hasWatchEvent = true;
                                watchRules.add(parsedWatch);
                            }
                            continue;
                        }

                        if (upperToken.startsWith("STREAM")) {
                            hasStreamEvent = true;
                            List<String> senders = parseOnSenderList(normalizedToken, "STREAM");
                            if (senders == null || senders.isEmpty()) {
                                streamFromAnySender = true;
                                continue;
                            }

                            for (String sender : senders) {
                                if (!streamSenders.contains(sender)) {
                                    streamSenders.add(sender);
                                }
                            }
                            continue;
                        }

                        if (!upperToken.startsWith("MESSAGE")) {
                            continue;
                        }

                        hasMessageEvent = true;
                        List<String> senders = parseOnSenderList(normalizedToken, "MESSAGE");
                        if (senders == null || senders.isEmpty()) {
                            messageFromAnySender = true;
                            continue;
                        }

                        for (String sender : senders) {
                            if (!messageSenders.contains(sender)) {
                                messageSenders.add(sender);
                            }
                        }
                    }
                }
            }

            if (!hasMessageEvent && !hasStreamEvent && !hasStreamEndEvent && !hasNetChangeEvent && !hasWatchEvent) {
                return null;
            }

            MessageEndpoint endpoint = new MessageEndpoint();
            endpoint.endpointFile = endpointFile;
            endpoint.endpointName = projectName;
            endpoint.endpointPath = endpointFile.getAbsolutePath();
            endpoint.endpointId = readProjectEndpointId(endpointFile.getParentFile());
            endpoint.endpointState = state;
            endpoint.source = source;
            endpoint.enabled = enabled;
            endpoint.debug = debug;
            endpoint.hasMessageEvent = hasMessageEvent;
            endpoint.messageFromAnySender = messageFromAnySender || messageSenders.isEmpty();
            endpoint.messageSenders = messageSenders;
            endpoint.hasStreamEvent = hasStreamEvent;
            endpoint.streamFromAnySender = streamFromAnySender || streamSenders.isEmpty();
            endpoint.streamSenders = streamSenders;
            endpoint.hasStreamEndEvent = hasStreamEndEvent;
            endpoint.streamEndFromAnySender = streamEndFromAnySender || streamEndSenders.isEmpty();
            endpoint.streamEndSenders = streamEndSenders;
            endpoint.hasNetChangeEvent = hasNetChangeEvent;
            endpoint.hasWatchEvent = hasWatchEvent;
            endpoint.watchRules = watchRules;
            return endpoint;
        } catch (Exception ignored) {
            return null;
        }
    }

    private List<String> splitDirectiveTokens(String rawValue) {
        List<String> out = new ArrayList<>();
        StringBuilder token = new StringBuilder();
        int parenDepth = 0;
        int bracketDepth = 0;
        String value = String.valueOf(rawValue);

        for (int i = 0; i < value.length(); i += 1) {
            char ch = value.charAt(i);

            if (ch == '(') {
                parenDepth += 1;
                token.append(ch);
                continue;
            }

            if (ch == ')') {
                parenDepth = Math.max(0, parenDepth - 1);
                token.append(ch);
                continue;
            }

            if (ch == '[') {
                bracketDepth += 1;
                token.append(ch);
                continue;
            }

            if (ch == ']') {
                bracketDepth = Math.max(0, bracketDepth - 1);
                token.append(ch);
                continue;
            }

            if ((ch == ',' || Character.isWhitespace(ch)) && parenDepth == 0 && bracketDepth == 0) {
                String trimmed = token.toString().trim();
                if (!trimmed.isEmpty()) {
                    out.add(trimmed);
                }
                token.setLength(0);
                continue;
            }

            token.append(ch);
        }

        String tail = token.toString().trim();
        if (!tail.isEmpty()) {
            out.add(tail);
        }

        return out;
    }

    private String stripWrappingQuotes(String value) {
        String trimmed = String.valueOf(value == null ? "" : value).trim();
        if (trimmed.isEmpty()) {
            return "";
        }

        if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
                || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            return trimmed.substring(1, trimmed.length() - 1).trim();
        }

        return trimmed;
    }

    private WatchRule parseWatchRule(String rawValue) {
        String value = String.valueOf(rawValue == null ? "" : rawValue).trim();
        if (value.isEmpty()) {
            return null;
        }

        String withoutType = value;
        if (withoutType.toUpperCase(Locale.ROOT).startsWith("WATCH")) {
            withoutType = withoutType.substring(5).trim();
        }

        if (withoutType.isEmpty()) {
            return null;
        }

        boolean recursive = false;
        Matcher recursiveMatcher = Pattern.compile("^(.*?)(?:\\s+R)\\s*$", Pattern.CASE_INSENSITIVE | Pattern.DOTALL).matcher(withoutType);
        if (recursiveMatcher.matches()) {
            String withoutRecursiveToken = String.valueOf(recursiveMatcher.group(1) == null ? "" : recursiveMatcher.group(1)).trim();
            if (!withoutRecursiveToken.isEmpty()) {
                withoutType = withoutRecursiveToken;
                recursive = true;
            }
        }

        String watchPath;
        Set<String> listeners = new HashSet<>();

        Matcher withListeners = Pattern.compile("^(.*?)\\s*\\[(.*)]\\s*$", Pattern.DOTALL).matcher(withoutType);
        if (withListeners.matches()) {
            watchPath = stripWrappingQuotes(withListeners.group(1));
            String rawListeners = String.valueOf(withListeners.group(2) == null ? "" : withListeners.group(2)).trim();
            if (!rawListeners.isEmpty()) {
                String[] parts = rawListeners.split(",");
                for (String part : parts) {
                    String normalized = String.valueOf(part).trim().toLowerCase(Locale.ROOT);
                    if (VALID_WATCH_LISTENERS.contains(normalized)) {
                        listeners.add(normalized);
                    }
                }
            }
        } else {
            watchPath = stripWrappingQuotes(withoutType);
        }

        if (watchPath.isEmpty()) {
            return null;
        }

        WatchRule rule = new WatchRule();
        rule.path = watchPath;
        rule.listeners = listeners;
        rule.recursive = recursive;
        return rule;
    }

    private String expandWatchPath(String rawPath, File endpointDir) {
        String watchPath = String.valueOf(rawPath == null ? "" : rawPath).trim();
        if (watchPath.isEmpty()) {
            return "";
        }

        String homePlaceholder = "{HOME_DIR}";
        if (watchPath.contains(homePlaceholder)) {
            String mobileHome = "";
            try {
                mobileHome = Environment.getExternalStorageDirectory().getAbsolutePath();
            } catch (Exception ignored) {
                mobileHome = getFilesDir().getAbsolutePath();
            }
            watchPath = watchPath.replace(homePlaceholder, mobileHome);
        }

        File resolved = new File(watchPath);
        if (!resolved.isAbsolute()) {
            File base = endpointDir != null ? endpointDir : getFilesDir();
            resolved = new File(base, watchPath);
        }

        return resolved.getAbsolutePath();
    }

    private void startWatchObservers() {
        synchronized (watchObserverLock) {
            stopWatchObservers();

            List<MessageEndpoint> endpoints = collectMessageEndpoints();
            for (MessageEndpoint endpoint : endpoints) {
                if (endpoint == null || !endpoint.enabled || !endpoint.hasWatchEvent || endpoint.watchRules == null || endpoint.watchRules.isEmpty()) {
                    continue;
                }

                File endpointDir = endpoint.endpointFile != null ? endpoint.endpointFile.getParentFile() : null;
                for (WatchRule rule : endpoint.watchRules) {
                    if (rule == null || String.valueOf(rule.path).trim().isEmpty()) {
                        continue;
                    }

                    String resolvedPath = expandWatchPath(rule.path, endpointDir);
                    if (resolvedPath.isEmpty()) {
                        continue;
                    }

                    File watchDir = new File(resolvedPath);
                    if (!watchDir.exists() || !watchDir.isDirectory()) {
                        continue;
                    }

                    final String observedRoot = resolvedPath;
                    final MessageEndpoint observedEndpoint = endpoint;
                    final WatchRule observedRule = rule;
                    final EndpointWatchObserver tracked = new EndpointWatchObserver();
                    tracked.endpoint = endpoint;
                    tracked.rule = rule;
                    tracked.resolvedPath = resolvedPath;

                    int mask = FileObserver.CREATE
                            | FileObserver.DELETE
                            | FileObserver.MOVED_FROM
                            | FileObserver.MOVED_TO
                            | FileObserver.MODIFY
                            | FileObserver.CLOSE_WRITE
                            | FileObserver.DELETE_SELF
                            | FileObserver.MOVE_SELF;

                    FileObserver observer = new FileObserver(observedRoot, mask) {
                        @Override
                        public void onEvent(int event, String path) {
                            String suffix = String.valueOf(path == null ? "" : path).trim();
                            if (!observedRule.recursive && !suffix.isEmpty()) {
                                String normalizedSuffix = suffix.replace('\\', '/');
                                if (normalizedSuffix.contains("/")) {
                                    return;
                                }
                            }
                            String fullPath = suffix.isEmpty()
                                    ? observedRoot
                                    : new File(observedRoot, suffix).getAbsolutePath();

                            Set<String> listenerSet = null;
                            if (observedRule.listeners != null && !observedRule.listeners.isEmpty()) {
                                listenerSet = new HashSet<>(observedRule.listeners);
                            }

                            handlePendingWatchCreatedSignal(tracked, fullPath, event, listenerSet);

                            String watchType = resolveWatchType(event, listenerSet);
                            if (watchType == null || watchType.isEmpty()) {
                                return;
                            }

                            dispatchWatchEvent(observedEndpoint, observedRoot, fullPath, watchType);
                        }
                    };

                    try {
                        observer.startWatching();
                        tracked.observer = observer;
                        watchObservers.add(tracked);
                    } catch (Exception ignored) {
                        // Best effort watcher registration.
                    }
                }
            }
        }
    }

    private void stopWatchObservers() {
        synchronized (watchObserverLock) {
            for (EndpointWatchObserver tracked : watchObservers) {
                if (tracked == null || tracked.observer == null) {
                    continue;
                }
                try {
                    tracked.observer.stopWatching();
                } catch (Exception ignored) {
                    // Ignore watcher stop races during shutdown.
                }
            }
            watchObservers.clear();
        }
    }

    private boolean acceptsWatchType(Set<String> listeners, String watchType) {
        return listeners == null || listeners.isEmpty() || listeners.contains(watchType);
    }

    private long resolveWatchCreatedQuietMs(long sizeBytes) {
        if (sizeBytes >= WATCH_CREATED_LARGE_FILE_BYTES) {
            return WATCH_CREATED_LARGE_QUIET_MS;
        }
        return WATCH_CREATED_QUIET_MS;
    }

    private void safeSleep(long ms) {
        try {
            Thread.sleep(Math.max(50L, ms));
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private void handlePendingWatchCreatedSignal(EndpointWatchObserver tracked, String fullPath, int rawEventMask, Set<String> listeners) {
        if (tracked == null || fullPath == null || fullPath.trim().isEmpty()) {
            return;
        }

        if (!acceptsWatchType(listeners, "file:created")) {
            return;
        }

        int eventMask = rawEventMask & FileObserver.ALL_EVENTS;
        boolean isCreateLike = (eventMask & FileObserver.CREATE) != 0 || (eventMask & FileObserver.MOVED_TO) != 0;
        boolean isModifyLike = (eventMask & FileObserver.MODIFY) != 0;
        boolean isCloseWrite = (eventMask & FileObserver.CLOSE_WRITE) != 0;
        boolean trackable = isCreateLike || isModifyLike || isCloseWrite;
        if (!trackable) {
            return;
        }

        long now = System.currentTimeMillis();
        PendingWatchCreatedState state = tracked.pendingCreatedStates.computeIfAbsent(fullPath, key -> {
            PendingWatchCreatedState next = new PendingWatchCreatedState();
            next.firstSeenAtMs = now;
            next.lastMutationAtMs = now;
            next.lastCloseWriteAtMs = 0L;
            next.lastSize = -1L;
            next.lastMtimeMs = -1L;
            return next;
        });

        if (state.firstSeenAtMs <= 0L) {
            state.firstSeenAtMs = now;
        }
        state.lastMutationAtMs = now;
        if (isCloseWrite) {
            state.lastCloseWriteAtMs = now;
        }

        if (tracked.pendingCreatedInFlight.add(fullPath)) {
            clientPool.execute(() -> evaluatePendingWatchCreated(tracked, fullPath, listeners));
        }
    }

    private void evaluatePendingWatchCreated(EndpointWatchObserver tracked, String fullPath, Set<String> listeners) {
        long startedAt = System.currentTimeMillis();

        try {
            while (System.currentTimeMillis() - startedAt <= WATCH_CREATED_TIMEOUT_MS) {
                PendingWatchCreatedState state = tracked.pendingCreatedStates.get(fullPath);
                if (state == null) {
                    return;
                }

                File file = new File(fullPath);
                if (!file.exists() || !file.isFile()) {
                    safeSleep(WATCH_CREATED_POLL_MS);
                    continue;
                }

                long now = System.currentTimeMillis();
                long size = file.length();
                long mtime = file.lastModified();
                if (size != state.lastSize || mtime != state.lastMtimeMs) {
                    state.lastSize = size;
                    state.lastMtimeMs = mtime;
                    state.lastMutationAtMs = now;
                }

                long quietMs = resolveWatchCreatedQuietMs(size);
                boolean closeObserved = state.lastCloseWriteAtMs > 0L;
                boolean closeSettled = !closeObserved || (now - state.lastCloseWriteAtMs) >= WATCH_CREATED_CLOSE_SETTLE_MS;
                boolean quietReached = (now - state.lastMutationAtMs) >= quietMs;
                boolean fallbackElapsed = (now - state.firstSeenAtMs) >= (quietMs * 2L);

                if (quietReached && closeSettled && (closeObserved || fallbackElapsed)) {
                    safeSleep(WATCH_CREATED_POLL_MS);

                    PendingWatchCreatedState confirmState = tracked.pendingCreatedStates.get(fullPath);
                    if (confirmState == null) {
                        return;
                    }

                    File confirmFile = new File(fullPath);
                    if (!confirmFile.exists() || !confirmFile.isFile()) {
                        safeSleep(WATCH_CREATED_POLL_MS);
                        continue;
                    }

                    long confirmSize = confirmFile.length();
                    long confirmMtime = confirmFile.lastModified();
                    if (confirmSize == confirmState.lastSize && confirmMtime == confirmState.lastMtimeMs) {
                        tracked.pendingCreatedStates.remove(fullPath);
                        if (acceptsWatchType(listeners, "file:created")) {
                            dispatchWatchEvent(tracked.endpoint, tracked.resolvedPath, fullPath, "file:created");
                        }
                        return;
                    }

                    confirmState.lastSize = confirmSize;
                    confirmState.lastMtimeMs = confirmMtime;
                    confirmState.lastMutationAtMs = System.currentTimeMillis();
                }

                safeSleep(WATCH_CREATED_POLL_MS);
            }
        } finally {
            tracked.pendingCreatedInFlight.remove(fullPath);

            PendingWatchCreatedState state = tracked.pendingCreatedStates.get(fullPath);
            if (state != null) {
                long now = System.currentTimeMillis();
                if (state.firstSeenAtMs > 0L && (now - state.firstSeenAtMs) > WATCH_CREATED_TIMEOUT_MS) {
                    tracked.pendingCreatedStates.remove(fullPath);
                }
            }
        }
    }

    private String resolveWatchType(int eventMask, Set<String> listeners) {
        int event = eventMask & FileObserver.ALL_EVENTS;
        if (((event & FileObserver.DELETE) != 0 || (event & FileObserver.DELETE_SELF) != 0) && acceptsWatchType(listeners, "file:deleted")) {
            return "file:deleted";
        }

        if ((event & FileObserver.MOVED_TO) != 0) {
            if (acceptsWatchType(listeners, "file:moved")) {
                return "file:moved";
            }
            return null;
        }

        if (((event & FileObserver.MOVED_FROM) != 0 || (event & FileObserver.MOVE_SELF) != 0) && acceptsWatchType(listeners, "file:moved")) {
            return "file:moved";
        }

        if ((((event & FileObserver.MODIFY) != 0) || ((event & FileObserver.CLOSE_WRITE) != 0)) && acceptsWatchType(listeners, "file:changed")) {
            return "file:changed";
        }

        return null;
    }

    private String normalizeEventPath(String rawPath) {
        String normalized = String.valueOf(rawPath == null ? "" : rawPath).replace('\\', '/');
        if (normalized.isEmpty()) {
            return "";
        }

        if ("/".equals(normalized)) {
            return normalized;
        }

        return normalized.replaceAll("/+$", "");
    }

    private String computeWatchRelativePath(String entryPath, String watchPath) {
        String normalizedEntryPath = normalizeEventPath(entryPath);
        String normalizedWatchPath = normalizeEventPath(watchPath);

        if (normalizedEntryPath.isEmpty()) {
            return "";
        }

        if (normalizedWatchPath.isEmpty()) {
            return normalizedEntryPath;
        }

        if (normalizedEntryPath.equals(normalizedWatchPath)) {
            return "";
        }

        String prefix = normalizedWatchPath + "/";
        if (normalizedEntryPath.startsWith(prefix) && normalizedEntryPath.length() > prefix.length()) {
            return normalizedEntryPath.substring(prefix.length());
        }

        return normalizedEntryPath;
    }

    private void dispatchWatchEvent(MessageEndpoint endpoint, String watchPath, String entryPath, String watchType) {
        if (endpoint == null || !endpoint.enabled) {
            return;
        }

        String normalizedWatchPath = normalizeEventPath(watchPath);
        String normalizedEntryPath = normalizeEventPath(entryPath);

        Map<String, String> headers = new HashMap<>();
        headers.put("x-reactor-trigger", "WATCH");

        Map<String, String> eventContext = new HashMap<>();
        eventContext.put("event.type", "WATCH");
        eventContext.put("event.watchPath", normalizedWatchPath);
        eventContext.put("event.entryPath", normalizedEntryPath);
        eventContext.put("event.relativePath", computeWatchRelativePath(normalizedEntryPath, normalizedWatchPath));
        eventContext.put("event.watchType", String.valueOf(watchType == null ? "" : watchType));

        try {
            writeExecutionStart(endpoint, "WATCH", "WATCH", eventContext);
            executeEndpointActions(endpoint, "", headers, eventContext);
        } catch (Exception executionError) {
            writeExecutionError(endpoint, "WATCH", "WATCH", executionError.getMessage(), eventContext);
        }
    }

    private List<String> parseOnSenderList(String value, String type) {
        Matcher listMatch = Pattern.compile("^" + Pattern.quote(type) + "(?:\\s+\\[(.*)\\])?$", Pattern.CASE_INSENSITIVE)
                .matcher(String.valueOf(value).trim());
        if (listMatch.matches()) {
            String sendersRaw = String.valueOf(listMatch.group(1) == null ? "" : listMatch.group(1)).trim();
            if (sendersRaw.isEmpty()) {
                return null;
            }

            List<String> senders = new ArrayList<>();
            for (String senderCandidate : sendersRaw.split(",")) {
                String normalizedSender = normalizeMessageSender(senderCandidate);
                if (normalizedSender != null && !senders.contains(normalizedSender)) {
                    senders.add(normalizedSender);
                }
            }
            return senders;
        }

        Matcher legacyMatch = Pattern.compile("^" + Pattern.quote(type) + "(?:\\((.*)\\))?$", Pattern.CASE_INSENSITIVE)
                .matcher(String.valueOf(value).trim());
        if (legacyMatch.matches()) {
            String sendersRaw = String.valueOf(legacyMatch.group(1) == null ? "" : legacyMatch.group(1)).trim();
            if (sendersRaw.isEmpty()) {
                return null;
            }

            List<String> senders = new ArrayList<>();
            for (String senderCandidate : sendersRaw.split(",")) {
                String normalizedSender = normalizeMessageSender(senderCandidate);
                if (normalizedSender != null && !senders.contains(normalizedSender)) {
                    senders.add(normalizedSender);
                }
            }
            return senders;
        }

        return null;
    }

    private boolean matchesSingleOnType(String value, String type) {
        return Pattern.compile("^" + Pattern.quote(type) + "(?:\\s+\\[.*\\]|\\(.*\\))?$", Pattern.CASE_INSENSITIVE)
                .matcher(String.valueOf(value).trim())
                .matches();
    }

    private boolean isLikelyNetworkIdentity(String value) {
        String safe = String.valueOf(value).trim().toLowerCase(Locale.ROOT);
        if (safe.isEmpty()) {
            return false;
        }

        if (safe.contains(":")) {
            return true;
        }

        return safe.matches("^\\d+\\.\\d+\\.\\d+\\.\\d+$") || safe.contains(".") || safe.endsWith(".local");
    }

    private String normalizeMessageSender(String rawSender) {
        String sender = String.valueOf(rawSender).trim().toLowerCase(Locale.ROOT);
        if (sender.isEmpty()) {
            return null;
        }

        if (sender.startsWith("net:")) {
            String networkSender = sender.substring(4).trim();
            if (networkSender.isEmpty()) {
                return null;
            }

            if (networkSender.startsWith("http://") || networkSender.startsWith("https://")) {
                try {
                    URL parsed = new URL(networkSender);
                    String host = String.valueOf(parsed.getHost()).trim().toLowerCase(Locale.ROOT);
                    int port = parsed.getPort() > 0 ? parsed.getPort() : DEFAULT_PORT;
                    if (host.isEmpty() || port < 1 || port > 65535) {
                        return null;
                    }
                    return parsed.getPort() > 0 ? "net:" + host + ":" + port : "net:" + host;
                } catch (Exception ignored) {
                    return null;
                }
            }

            if (networkSender.matches("^[^:]+:[0-9]{1,5}$")) {
                String[] parts = networkSender.split(":", 2);
                int port;
                try {
                    port = Integer.parseInt(parts[1]);
                } catch (NumberFormatException ignored) {
                    return null;
                }

                if (parts[0].trim().isEmpty() || port < 1 || port > 65535) {
                    return null;
                }
                return "net:" + parts[0].trim() + ":" + port;
            }

            if (networkSender.contains(":")) {
                return null;
            }

            return "net:" + networkSender;
        }

        if (sender.startsWith("http://") || sender.startsWith("https://")) {
            try {
                URL parsed = new URL(sender);
                String host = String.valueOf(parsed.getHost()).trim().toLowerCase(Locale.ROOT);
                int port = parsed.getPort() > 0 ? parsed.getPort() : DEFAULT_PORT;
                if (host.isEmpty() || port < 1 || port > 65535) {
                    return null;
                }
                return host + ":" + port;
            } catch (Exception ignored) {
                return null;
            }
        }

        if (sender.matches("^[^:]+:[0-9]{1,5}$")) {
            String[] parts = sender.split(":", 2);
            int port;
            try {
                port = Integer.parseInt(parts[1]);
            } catch (NumberFormatException ignored) {
                return null;
            }

            if (parts[0].trim().isEmpty() || port < 1 || port > 65535) {
                return null;
            }
            return parts[0].trim() + ":" + port;
        }

        boolean looksLikeHost = sender.matches("^\\d+\\.\\d+\\.\\d+\\.\\d+$") || sender.contains(".") || sender.endsWith(".local");
        if (looksLikeHost) {
            return sender + ":" + DEFAULT_PORT;
        }

        return sender;
    }

    private Set<String> resolveSenderCandidates(String senderName, String senderId, String remoteHost) {
        Set<String> candidates = new HashSet<>();

        String normalizedName = String.valueOf(senderName).trim().toLowerCase(Locale.ROOT);
        if (!normalizedName.isEmpty()) {
            candidates.add(normalizedName);
        }

        String normalizedSenderId = String.valueOf(senderId).trim().toLowerCase(Locale.ROOT);
        if (!normalizedSenderId.isEmpty()) {
            if (isLikelyNetworkIdentity(normalizedSenderId)) {
                String normalizedSender = normalizeMessageSender(normalizedSenderId);
                if (normalizedSender != null) {
                    candidates.add(normalizedSender);
                    if (!normalizedSender.startsWith("net:")) {
                        candidates.add("net:" + normalizedSender);
                        String[] senderParts = normalizedSender.split(":", 2);
                        if (senderParts.length > 0 && !senderParts[0].trim().isEmpty()) {
                            candidates.add("net:" + senderParts[0].trim());
                        }
                    }
                }
            } else {
                candidates.add(normalizedSenderId);
            }
        }

        String normalizedRemoteHost = String.valueOf(remoteHost).trim().toLowerCase(Locale.ROOT);
        if (!normalizedRemoteHost.isEmpty()) {
            candidates.add(normalizedRemoteHost + ":" + DEFAULT_PORT);
            candidates.add("net:" + normalizedRemoteHost + ":" + DEFAULT_PORT);
            candidates.add("net:" + normalizedRemoteHost);
        }

        return candidates;
    }

    private boolean matchesMessageSender(MessageEndpoint endpoint, Set<String> senderCandidates) {
        return matchesEventSender(endpoint, senderCandidates, "MESSAGE");
    }

    private boolean matchesEventSender(MessageEndpoint endpoint, Set<String> senderCandidates, String eventName) {
        if (endpoint == null) {
            return false;
        }

        String safeEvent = String.valueOf(eventName).trim().toUpperCase(Locale.ROOT);
        boolean fromAnySender;
        List<String> allowedSenders;

        if ("STREAM".equals(safeEvent)) {
            if (!endpoint.hasStreamEvent) {
                return false;
            }
            fromAnySender = endpoint.streamFromAnySender;
            allowedSenders = endpoint.streamSenders;
        } else if ("STREAMEND".equals(safeEvent)) {
            if (!endpoint.hasStreamEndEvent) {
                return false;
            }
            fromAnySender = endpoint.streamEndFromAnySender;
            allowedSenders = endpoint.streamEndSenders;
        } else if ("WATCH".equals(safeEvent)) {
            if (!endpoint.hasWatchEvent) {
                return false;
            }
            fromAnySender = true;
            allowedSenders = new ArrayList<>();
        } else if ("NET_CHANGE".equals(safeEvent)) {
            if (!endpoint.hasNetChangeEvent) {
                return false;
            }
            fromAnySender = true;
            allowedSenders = new ArrayList<>();
        } else {
            if (!endpoint.hasMessageEvent) {
                return false;
            }
            fromAnySender = endpoint.messageFromAnySender;
            allowedSenders = endpoint.messageSenders;
        }

        if (fromAnySender || allowedSenders == null || allowedSenders.isEmpty()) {
            return true;
        }

        for (String expected : allowedSenders) {
            if (senderCandidates.contains(expected)) {
                return true;
            }
        }

        return false;
    }

    private boolean matchesTargetEndpoint(MessageEndpoint endpoint, String targetEndpointSelector) {
        String safeSelector = String.valueOf(targetEndpointSelector).trim().toLowerCase(Locale.ROOT);
        if (safeSelector.isEmpty()) {
            return true;
        }

        if (safeSelector.startsWith("id:")) {
            String expectedId = safeSelector.substring(3).trim();
            return expectedId.equals(String.valueOf(endpoint.endpointId).trim().toLowerCase(Locale.ROOT));
        }

        return safeSelector.equals(String.valueOf(endpoint.endpointName).trim().toLowerCase(Locale.ROOT));
    }

    private JSONObject tryParseJsonObject(String value) {
        String raw = String.valueOf(value);
        if (raw.trim().isEmpty()) {
            return null;
        }

        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean isStreamEnvelope(JSONObject payload) {
        return payload != null && payload.optBoolean("__reactorStream", false);
    }

    private Map<String, String> withStreamHeaders(Map<String, String> incomingHeaders, JSONObject streamPayload, String trigger) {
        Map<String, String> headers = new HashMap<>();
        if (incomingHeaders != null) {
            headers.putAll(incomingHeaders);
        }

        headers.put("x-reactor-trigger", String.valueOf(trigger));

        if (streamPayload == null) {
            return headers;
        }

        String streamId = streamPayload.optString("streamId", "");
        String phase = streamPayload.optString("phase", "").toLowerCase(Locale.ROOT);
        String contentType = streamPayload.optString("contentType", "");

        if (!streamId.isEmpty()) {
            headers.put("x-reactor-stream-id", streamId);
        }
        if (!phase.isEmpty()) {
            headers.put("x-reactor-stream-phase", phase);
        }
        if (!contentType.isEmpty()) {
            headers.put("x-reactor-stream-content-type", contentType);
        }

        String targetEndpointId = headers.getOrDefault("reactor-target-endpoint-id", "").trim().toLowerCase(Locale.ROOT);
        if (!targetEndpointId.isEmpty()) {
            headers.put("reactor-target-endpoint-id", targetEndpointId);
        }
        String targetEndpoint = headers.getOrDefault("reactor-target-endpoint", "").trim().toLowerCase(Locale.ROOT);
        if (targetEndpoint.isEmpty() && !targetEndpointId.isEmpty()) {
            targetEndpoint = "id:" + targetEndpointId;
        }
        if (!targetEndpoint.isEmpty()) {
            headers.put("reactor-target-endpoint", targetEndpoint);
        }

        if (streamPayload.has("index")) {
            headers.put("x-reactor-stream-index", String.valueOf(streamPayload.optInt("index", -1)));
        }
        if (streamPayload.has("size")) {
            headers.put("x-reactor-stream-size", String.valueOf(streamPayload.optLong("size", 0L)));
        }
        if (streamPayload.has("chunks")) {
            headers.put("x-reactor-stream-chunks", String.valueOf(streamPayload.optInt("chunks", 0)));
        }
        if (streamPayload.has("totalBytes")) {
            headers.put("x-reactor-stream-total-bytes", String.valueOf(streamPayload.optLong("totalBytes", 0L)));
        }
        if (streamPayload.has("digestSha256")) {
            headers.put("x-reactor-stream-digest", streamPayload.optString("digestSha256", ""));
        }

        return headers;
    }

    private void writeExecutionStart(MessageEndpoint endpoint, String trigger, String event) {
        writeExecutionStart(endpoint, trigger, event, null);
    }

    private void writeExecutionStart(MessageEndpoint endpoint, String trigger, String event, Map<String, String> eventContext) {
        String message = buildEndpointExecutionMessage(endpoint, "START", trigger, event, eventContext, null);
        String line = buildReadableGlobalLogLine("ENDPOINT_EXECUTION", message);
        appendProjectLog(endpoint, line);
        appendGlobalLog(line);
    }

    private void writeExecutionError(MessageEndpoint endpoint, String trigger, String event, String errorMessage) {
        writeExecutionError(endpoint, trigger, event, errorMessage, null);
    }

    private void writeExecutionError(MessageEndpoint endpoint, String trigger, String event, String errorMessage, Map<String, String> eventContext) {
        String message = buildEndpointExecutionMessage(endpoint, "ERROR", trigger, event, eventContext, errorMessage);
        String line = buildReadableGlobalLogLine("ENDPOINT_EXECUTION", message);
        appendProjectLog(endpoint, line);
        appendGlobalLog(line);
    }

    private String buildEndpointExecutionMessage(
            MessageEndpoint endpoint,
            String phase,
            String trigger,
            String event,
            Map<String, String> eventContext,
            String errorMessage
    ) {
        String endpointName = endpoint != null ? String.valueOf(endpoint.endpointName == null ? "" : endpoint.endpointName).trim() : "";
        if (endpointName.isEmpty()) {
            endpointName = "unknown";
        }

        String safeTrigger = String.valueOf(trigger == null ? "" : trigger).trim();
        if (safeTrigger.isEmpty()) {
            safeTrigger = "unknown";
        }

        String safeEvent = String.valueOf(event == null ? "" : event).trim();
        if (safeEvent.isEmpty()) {
            safeEvent = "unknown";
        }

        String watchPath = String.valueOf(eventContext != null ? eventContext.getOrDefault("event.watchPath", "") : "").trim();
        String watchType = String.valueOf(eventContext != null ? eventContext.getOrDefault("event.watchType", "") : "").trim();

        StringBuilder message = new StringBuilder();
        message.append("phase=").append(String.valueOf(phase == null ? "" : phase).trim())
                .append(" endpoint=").append(endpointName)
                .append(" trigger=").append(safeTrigger)
                .append(" event=").append(safeEvent);

        if (!watchPath.isEmpty()) {
            message.append(" watchPath=").append(watchPath);
        }
        if (!watchType.isEmpty()) {
            message.append(" watchType=").append(watchType);
        }

        String safeError = String.valueOf(errorMessage == null ? "" : errorMessage).trim();
        if (!safeError.isEmpty()) {
            message.append(" error=").append(safeError);
        }

        return message.toString();
    }

    private void appendProjectLog(MessageEndpoint endpoint, String line) {
        try {
            File projectLogFile = new File(endpoint.endpointFile.getParentFile(), "activity.log");
            try (FileOutputStream stream = new FileOutputStream(projectLogFile, true)) {
                stream.write((line + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            // Ignore per-project logging failures.
        }
    }

    private void executeEndpointActions(MessageEndpoint endpoint, String messageBody, Map<String, String> incomingHeaders, Map<String, String> eventContext) {
        // ── QuickJS execution: TS → sucrase → CommonJS JS → run(event) ──────────
        refreshEnvCacheFromDisk("before-endpoint-exec:" + String.valueOf(endpoint != null ? endpoint.endpointName : "unknown"));
        JSONObject envSnapshotForScript = getEnvCacheSnapshot();
        if (envSnapshotForScript.length() == 0) {
            JSONObject diskSnapshot = readEnvMapFromDisk();
            if (diskSnapshot.length() > 0) {
                synchronized (envCacheLock) {
                    envCacheMap = copyJsonObject(diskSnapshot);
                }
                envSnapshotForScript = copyJsonObject(diskSnapshot);
            }
        }
        final JSONObject effectiveEnvSnapshot = copyJsonObject(envSnapshotForScript);
        try {
            appendProjectLog(endpoint, buildReadableGlobalLogLine(
                    "SCRIPT_LOG",
                    "ENV_CACHE_BEFORE_ENGINE path=" + getEnvDir().getAbsolutePath() + " envCount=" + effectiveEnvSnapshot.length()
            ));
        } catch (Exception ignored) {
            // Best-effort diagnostic logging.
        }
        String trigger = incomingHeaders != null ? incomingHeaders.getOrDefault("x-reactor-trigger", "") : "";
        if (trigger.isEmpty() && eventContext != null) {
            trigger = eventContext.getOrDefault("event.type", "");
        }
        if (trigger.isEmpty()) trigger = "MANUAL_TEST";

        String eventContextJson = "{}";
        if (eventContext != null && !eventContext.isEmpty()) {
            try {
                org.json.JSONObject obj = new org.json.JSONObject();
                for (Map.Entry<String, String> entry : eventContext.entrySet()) {
                    obj.put(entry.getKey(), entry.getValue());
                }
                eventContextJson = obj.toString();
            } catch (Exception ignored) {}
        }

        final String finalTrigger = trigger;
        final String finalEventContextJson = eventContextJson;

        ReactorScriptOps ops = new ReactorScriptOps() {
            @Override public void log(String message) {
                Log.d("SCRIPT_ENGINE", "SCRIPT_LOG: " + String.valueOf(message == null ? "" : message));
                appendProjectLog(endpoint, buildReadableGlobalLogLine("SCRIPT_LOG", message));
            }

            @Override public boolean deviceNotify(String message) {
                boolean shown = sendEndpointNotification(message);
                appendProjectLog(endpoint, buildReadableGlobalLogLine("DEVICE_NOTIFY",
                    "shown=" + shown + " message=" + message));
                return shown;
            }

            @Override public String fsStat(String path) {
                try {
                    File target = new File(String.valueOf(path == null ? "" : path));
                    org.json.JSONObject out = new org.json.JSONObject();
                    out.put("path", target.getAbsolutePath());
                    out.put("exists", target.exists());
                    out.put("isFile", target.isFile());
                    out.put("isDirectory", target.isDirectory());
                    out.put("size", target.isFile() ? target.length() : 0L);

                    long mTimeSeconds = 0L;
                    try {
                        long lastModifiedMs = target.lastModified();
                        if (lastModifiedMs > 0L) {
                            mTimeSeconds = lastModifiedMs / 1000L;
                        }
                    } catch (Exception ignored) {}

                    out.put("mTime", mTimeSeconds);
                    out.put("cTime", mTimeSeconds);
                    return out.toString();
                } catch (Exception error) {
                    return "{\"exists\":false,\"isFile\":false,\"isDirectory\":false,\"size\":0,\"mTime\":0,\"cTime\":0}";
                }
            }

            @Override public boolean fsDelete(String path) {
                try {
                    String safePath = String.valueOf(path == null ? "" : path).trim();
                    if (safePath.isEmpty()) {
                        return false;
                    }

                    File target = new File(safePath);
                    if (!target.exists() || !target.isFile()) {
                        return false;
                    }

                    return target.delete();
                } catch (Exception error) {
                    return false;
                }
            }

            @Override public String fsList(String path, boolean recursive) {
                try {
                    File root = new File(String.valueOf(path == null ? "" : path));
                    org.json.JSONArray out = new org.json.JSONArray();
                    if (!root.exists() || !root.isDirectory()) {
                        return out.toString();
                    }

                    java.nio.file.Path rootPath = root.toPath();
                    if (!recursive) {
                        File[] children = root.listFiles();
                        if (children == null) {
                            return out.toString();
                        }
                        for (File child : children) {
                            if (child == null) {
                                continue;
                            }
                            out.put(child.getName());
                        }
                        return out.toString();
                    }

                    try (java.util.stream.Stream<java.nio.file.Path> walk = Files.walk(rootPath)) {
                        walk.forEach((candidate) -> {
                            try {
                                if (candidate == null || candidate.equals(rootPath)) {
                                    return;
                                }
                                java.nio.file.Path relative = rootPath.relativize(candidate);
                                String normalized = relative.toString().replace('\\', '/').trim();
                                if (!normalized.isEmpty()) {
                                    out.put(normalized);
                                }
                            } catch (Exception ignored) {
                                // Best effort listing.
                            }
                        });
                    }

                    return out.toString();
                } catch (Exception error) {
                    return "[]";
                }
            }

            @Override public long fsCalcSize(String path) {
                try {
                    File root = new File(String.valueOf(path == null ? "" : path));
                    if (!root.exists()) {
                        return 0L;
                    }

                    if (root.isFile()) {
                        return root.length();
                    }

                    final long[] total = new long[] { 0L };
                    try (java.util.stream.Stream<java.nio.file.Path> walk = Files.walk(root.toPath())) {
                        walk.forEach((candidate) -> {
                            try {
                                if (candidate == null || !Files.isRegularFile(candidate)) {
                                    return;
                                }
                                total[0] += Files.size(candidate);
                            } catch (Exception ignored) {
                                // Ignore unreadable files.
                            }
                        });
                    }

                    return Math.max(0L, total[0]);
                } catch (Exception error) {
                    return 0L;
                }
            }

            @Override public String encryptFile(String filePath, String publicKey) {
                try {
                    String safePath = String.valueOf(filePath == null ? "" : filePath).trim();
                    String safePublicKey = String.valueOf(publicKey == null ? "" : publicKey).trim();
                    if (safePath.isEmpty()) {
                        throw new IllegalArgumentException("file path is required");
                    }
                    if (safePublicKey.isEmpty()) {
                        throw new IllegalArgumentException("public key is required");
                    }

                    File sourceFile = new File(safePath);
                    if (!sourceFile.exists() || !sourceFile.isFile()) {
                        throw new IllegalArgumentException("source file not found");
                    }

                    byte[] plainBytes = Files.readAllBytes(sourceFile.toPath());

                    // Accept both plain PEM/base64 keys and JSON payloads that carry a key field.
                    String extractedKey = safePublicKey;
                    try {
                        if (extractedKey.startsWith("{") && extractedKey.endsWith("}")) {
                            JSONObject keyEnvelope = new JSONObject(extractedKey);
                            String candidate = "";
                            if (candidate.isEmpty()) candidate = String.valueOf(keyEnvelope.optString("publicKey", "")).trim();
                            if (candidate.isEmpty()) candidate = String.valueOf(keyEnvelope.optString("public_key", "")).trim();
                            if (candidate.isEmpty()) candidate = String.valueOf(keyEnvelope.optString("key", "")).trim();
                            if (candidate.isEmpty()) candidate = String.valueOf(keyEnvelope.optString("data", "")).trim();
                            if (!candidate.isEmpty()) {
                                extractedKey = candidate;
                            }
                        }
                    } catch (Exception ignored) {
                        // Keep original key value when payload is not JSON.
                    }

                    if (extractedKey.length() >= 2 && extractedKey.startsWith("\"") && extractedKey.endsWith("\"")) {
                        extractedKey = extractedKey.substring(1, extractedKey.length() - 1);
                    }
                    extractedKey = extractedKey.replace("\\n", "\n").trim();

                    String normalizedPem = extractedKey
                        .replace("-----BEGIN PUBLIC KEY-----", "")
                        .replace("-----END PUBLIC KEY-----", "")
                        .replaceAll("\\s+", "");
                    if (normalizedPem.isEmpty()) {
                        throw new IllegalArgumentException("invalid public key");
                    }

                    byte[] publicKeyBytes = Base64.decode(normalizedPem, Base64.DEFAULT);
                    java.security.spec.X509EncodedKeySpec publicKeySpec = new java.security.spec.X509EncodedKeySpec(publicKeyBytes);
                    java.security.PublicKey rsaPublicKey = java.security.KeyFactory.getInstance("RSA").generatePublic(publicKeySpec);

                    javax.crypto.KeyGenerator keyGenerator = javax.crypto.KeyGenerator.getInstance("AES");
                    keyGenerator.init(256);
                    javax.crypto.SecretKey aesKey = keyGenerator.generateKey();

                    byte[] iv = new byte[12];
                    new SecureRandom().nextBytes(iv);

                    javax.crypto.Cipher aesCipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
                    aesCipher.init(
                        javax.crypto.Cipher.ENCRYPT_MODE,
                        aesKey,
                        new javax.crypto.spec.GCMParameterSpec(128, iv)
                    );
                    byte[] encryptedContent = aesCipher.doFinal(plainBytes);

                    javax.crypto.Cipher rsaCipher = javax.crypto.Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
                    rsaCipher.init(javax.crypto.Cipher.ENCRYPT_MODE, rsaPublicKey);
                    byte[] encryptedResourceKey = rsaCipher.doFinal(aesKey.getEncoded());

                    File encryptedDir = new File(getCacheDir(), "reactor/encrypted");
                    if (!encryptedDir.exists() && !encryptedDir.mkdirs()) {
                        throw new IOException("unable to create encrypted cache directory");
                    }

                    File encryptedFile = new File(encryptedDir, "enc-" + System.currentTimeMillis() + "-" + UUID.randomUUID() + ".bin");
                    Files.write(encryptedFile.toPath(), encryptedContent);

                    JSONObject cryptoObject = new JSONObject();
                    cryptoObject.put("type", "user");
                    cryptoObject.put("resourceIV", Base64.encodeToString(iv, Base64.NO_WRAP));
                    cryptoObject.put("encResourceKey", Base64.encodeToString(encryptedResourceKey, Base64.NO_WRAP));

                    JSONObject response = new JSONObject();
                    response.put("ok", true);
                    response.put("contentPath", encryptedFile.getAbsolutePath());
                    response.put("contentSize", encryptedContent.length);
                    response.put("crypto", cryptoObject);
                    return response.toString();
                } catch (Exception error) {
                    String message = error.getMessage() != null ? error.getMessage() : "encryption failed";
                    return "{\"ok\":false,\"error\":" + JSONObject.quote(message) + "}";
                }
            }

            @Override public String nodeStream(String target, String filePath, String meta) {
                try {
                    Map<String, String> extraHeaders = new HashMap<>();
                    org.json.JSONObject metadataOverride = null;
                    // meta might contain headers as JSON, try to parse it
                    try {
                        org.json.JSONObject metaObj = new org.json.JSONObject(meta);
                        if (metaObj.has("metadata") && metaObj.opt("metadata") instanceof org.json.JSONObject) {
                            metadataOverride = metaObj.optJSONObject("metadata");
                        } else {
                            metadataOverride = metaObj;
                        }
                        if (metaObj.has("headers")) {
                            org.json.JSONObject hdrs = metaObj.getJSONObject("headers");
                            Iterator<String> keys = hdrs.keys();
                            while (keys.hasNext()) { String k = keys.next(); extraHeaders.put(k, hdrs.getString(k)); }
                        }
                    } catch (Exception ignored) {}
                    streamFileToNode(target, filePath, extraHeaders, metadataOverride);
                    appendProjectLog(endpoint, buildReadableGlobalLogLine("NODE_STREAM",
                        "target=" + target + " path=" + filePath));
                    return "{\"ok\":true}";
                } catch (Exception e) {
                    String msg = e.getMessage() != null ? e.getMessage() : "stream failed";
                    appendProjectLog(endpoint, buildReadableGlobalLogLine("NODE_STREAM_ERROR", msg));
                    return "{\"ok\":false,\"error\":" + org.json.JSONObject.quote(msg) + "}";
                }
            }

            @Override public String nodeSendMessage(String target, String stream, String data) {
                try {
                    Map<String, String> extraHeaders = new HashMap<>();
                    // data might contain headers as JSON, try to parse it
                    String messageBody = data;
                    String contentType = "application/octet-stream";
                    try {
                        org.json.JSONObject dataObj = new org.json.JSONObject(data);
                        if (dataObj.has("body")) messageBody = dataObj.getString("body");
                        if (dataObj.has("contentType")) contentType = dataObj.getString("contentType");
                        if (dataObj.has("headers")) {
                            org.json.JSONObject hdrs = dataObj.getJSONObject("headers");
                            Iterator<String> keys = hdrs.keys();
                            while (keys.hasNext()) { String k = keys.next(); extraHeaders.put(k, hdrs.getString(k)); }
                        }
                    } catch (Exception ignored) {
                        // If not JSON, treat entire data as message body
                    }
                    SendDeliveryResult result = sendNodeMessageWithContentType(target, messageBody, contentType, extraHeaders);
                    appendProjectLog(endpoint, buildReadableGlobalLogLine("NODE_SEND",
                        "target=" + target + " deliveredVia=" + result.deliveredVia + " queued=" + result.queued));
                    org.json.JSONObject resp = new org.json.JSONObject();
                    resp.put("ok", true); resp.put("target", target);
                    resp.put("deliveredVia", String.valueOf(result.deliveredVia)); resp.put("queued", result.queued);
                    return resp.toString();
                } catch (Exception e) {
                    String msg = e.getMessage() != null ? e.getMessage() : "send failed";
                    return "{\"ok\":false,\"error\":" + org.json.JSONObject.quote(msg) + "}";
                }
            }

            @Override public boolean copyStream(String sourcePath, String destPath) {
                try { copyResolvedStreamPath(sourcePath, destPath); return true; }
                catch (Exception e) { return false; }
            }

            @Override public String getHomeDirectory() {
                try { return android.os.Environment.getExternalStorageDirectory().getAbsolutePath(); }
                catch (Exception e) { return "/storage/emulated/0"; }
            }

            @Override public String getNetworkStatus() {
                try {
                    android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                        getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
                    boolean online = false;
                    if (cm != null) {
                        android.net.NetworkInfo info = cm.getActiveNetworkInfo();
                        online = info != null && info.isConnected();
                    }
                    return "{\"online\":" + online + "}";
                } catch (Exception e) { return "{\"online\":false}"; }
            }

            @Override public String getGeoLocation() {
                try {
                    boolean hasFine = false;
                    boolean hasCoarse = false;
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                        hasFine = checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED;
                        hasCoarse = checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED;
                    } else {
                        hasFine = true;
                        hasCoarse = true;
                    }

                    if (!hasFine && !hasCoarse) {
                        return "{\"lat\":null,\"lon\":null,\"available\":false}";
                    }

                    android.location.LocationManager manager = (android.location.LocationManager) getSystemService(android.content.Context.LOCATION_SERVICE);
                    if (manager == null) {
                        return "{\"lat\":null,\"lon\":null,\"available\":false}";
                    }

                    android.location.Location best = null;
                    String[] providers = new String[] {
                        android.location.LocationManager.GPS_PROVIDER,
                        android.location.LocationManager.NETWORK_PROVIDER,
                        android.location.LocationManager.PASSIVE_PROVIDER,
                    };

                    for (String provider : providers) {
                        android.location.Location candidate = null;
                        try {
                            candidate = manager.getLastKnownLocation(provider);
                        } catch (Exception ignored) {
                            candidate = null;
                        }

                        if (candidate == null) {
                            continue;
                        }

                        if (best == null || candidate.getTime() > best.getTime()) {
                            best = candidate;
                        }
                    }

                    if (best == null) {
                        return "{\"lat\":null,\"lon\":null,\"available\":false}";
                    }

                    org.json.JSONObject result = new org.json.JSONObject();
                    result.put("lat", best.getLatitude());
                    result.put("lon", best.getLongitude());
                    result.put("available", true);
                    return result.toString();
                } catch (Exception e) {
                    return "{\"lat\":null,\"lon\":null,\"available\":false}";
                }
            }

            @Override public String getEnvConfig() {
                try {
                    JSONObject response = new JSONObject();
                    response.put("envs", effectiveEnvSnapshot);
                    Log.d("SCRIPT_ENGINE", "ENV_DEBUG_MAP: envCount=" + effectiveEnvSnapshot.length());
                    return response.toString();
                } catch (Exception e) {
                    Log.e("SCRIPT_ENGINE", "ENV_DEBUG_MAP_ERROR: " + e.getMessage(), e);
                    return "{\"envs\":{}}";
                }
            }

            @Override public String sendHttpRequest(String url, String method, String headers, String body, long timeoutMs) {
                try {
                    okhttp3.OkHttpClient.Builder clientBuilder = new okhttp3.OkHttpClient.Builder();
                    if (timeoutMs > 0L) {
                        clientBuilder
                            .connectTimeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                            .readTimeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS);
                    }
                    okhttp3.OkHttpClient client = clientBuilder.build();
                    okhttp3.RequestBody reqBody = null;
                    String upperMethod = method.toUpperCase(Locale.ROOT);

                    byte[] requestBodyBytes = null;
                    if (body != null && body.startsWith("@file:")) {
                        String filePath = body.substring("@file:".length()).trim();
                        if (!filePath.isEmpty()) {
                            File sourceFile = new File(filePath);
                            if (sourceFile.exists() && sourceFile.isFile()) {
                                requestBodyBytes = Files.readAllBytes(sourceFile.toPath());
                            }
                        }
                    }

                    if (requestBodyBytes == null && body != null) {
                        requestBodyBytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    }

                    if (requestBodyBytes != null && requestBodyBytes.length > 0 && !"GET".equals(upperMethod) && !"HEAD".equals(upperMethod)) {
                        reqBody = okhttp3.RequestBody.create(
                            requestBodyBytes,
                            okhttp3.MediaType.parse("application/octet-stream"));
                    }
                    okhttp3.Request.Builder rb = new okhttp3.Request.Builder().url(url).method(upperMethod, reqBody);
                    boolean hasUserAgent = false;
                    try {
                        org.json.JSONObject hdrs = new org.json.JSONObject(headers);
                        Iterator<String> keys = hdrs.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            if ("user-agent".equalsIgnoreCase(k)) {
                                hasUserAgent = true;
                            }
                            rb.header(k, hdrs.getString(k));
                        }
                    } catch (Exception ignored) {}
                    if (!hasUserAgent) {
                        rb.header("User-Agent", "ReactorClient/" + BuildConfig.REACTOR_APP_VERSION);
                    }
                    try (okhttp3.Response resp = client.newCall(rb.build()).execute()) {
                        org.json.JSONObject result = new org.json.JSONObject();
                        result.put("status", resp.code());
                        org.json.JSONObject respH = new org.json.JSONObject();
                        for (String name : resp.headers().names()) { respH.put(name, resp.header(name)); }
                        result.put("headers", respH);
                        result.put("body", resp.body() != null ? resp.body().string() : "");
                        return result.toString();
                    }
                } catch (Exception e) {
                    String msg = e.getMessage() != null ? e.getMessage() : "request failed";
                    return "{\"status\":0,\"headers\":{},\"body\":" + org.json.JSONObject.quote(msg) + "}";
                }
            }

            @Override public boolean spawnProcess(String command) { return false; }
        };

        try {
            ops.log("BEFORE_ENGINE_CREATE");
            ReactorScriptEngine engine = ReactorScriptEngine.create(ReactorHttpService.this);
            ops.log("BEFORE_EXECUTE_BLOCKING trigger="+finalTrigger+" source.length="+endpoint.source.length());
            ReactorScriptEngine.Result result = engine.executeBlocking(
                finalTrigger,
                endpoint.source,
                finalEventContextJson,
                ops
            );
            ops.log("AFTER_EXECUTE_BLOCKING result="+(result.getError() != null ? "ERROR: "+result.getError() : "SUCCESS"));
            if (endpoint.debug && result.getError() != null) {
                String debugError = String.valueOf(result.getError()).trim();
                if (!debugError.isEmpty()) {
                    ops.deviceNotify(debugError);
                }
            }
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : "execution failed";
            ops.log("EXECUTE_ERROR: "+msg);
            if (endpoint.debug) {
                ops.deviceNotify(msg);
            }
            appendProjectLog(endpoint, buildReadableGlobalLogLine("SCRIPT_ERROR", msg));
            throw new RuntimeException(msg);
        }
    }

    // ── Legacy regex helpers (kept for reference, no longer called) ──────────
    @SuppressWarnings("unused")
    private void executeEndpointActionsLegacy(MessageEndpoint endpoint, String messageBody, Map<String, String> incomingHeaders, Map<String, String> eventContext) {
        Matcher directMatcher = SEND_MESSAGE_CALL_PATTERN.matcher(endpoint.source);
        while (directMatcher.find()) {
            String target = directMatcher.group(2) != null ? directMatcher.group(2).trim() : "";
            String content = directMatcher.group(4) != null ? directMatcher.group(4) : "";
            if (target.isEmpty()) {
                continue;
            }

            Map<String, String> extraHeaders = new HashMap<>();
            String incomingContentType = incomingHeaders.getOrDefault("content-type", "");
            if (!incomingContentType.isEmpty()) {
                extraHeaders.put("X-Reactor-Message-Content-Type", incomingContentType);
            }
            if (messageBody != null && !messageBody.isEmpty()) {
                extraHeaders.put("X-Reactor-Message-Body", messageBody);
            }

                SendDeliveryResult result = sendNodeMessage(target, content, extraHeaders);
                appendGlobalLog(buildExchangeLog(
                    "NODE_SEND_RESULT",
                    "target=" + target
                        + " deliveredVia=" + String.valueOf(result.deliveredVia)
                        + " queued=" + result.queued
                        + (result.reason != null && !result.reason.isEmpty() ? " reason=" + result.reason : "")
                ));
        }

        Matcher exchangeMatcher = EXCHANGE_SEND_MESSAGE_CALL_PATTERN.matcher(endpoint.source);
        while (exchangeMatcher.find()) {
            String target = exchangeMatcher.group(2) != null ? exchangeMatcher.group(2).trim() : "";
            String content = exchangeMatcher.group(4) != null ? exchangeMatcher.group(4) : "";
            if (target.isEmpty()) {
                continue;
            }

                SendDeliveryResult result = sendExchangeMessage(target, content);
                appendGlobalLog(buildExchangeLog(
                    "NODE_SEND_RESULT",
                    "target=" + target
                        + " deliveredVia=" + String.valueOf(result.deliveredVia)
                        + " queued=" + result.queued
                        + (result.reason != null && !result.reason.isEmpty() ? " reason=" + result.reason : "")
                ));
        }

        Map<String, String> safeEventContext = eventContext != null ? eventContext : new HashMap<>();
        Map<String, String> stringVariables = extractStringVariables(endpoint.source, safeEventContext);
        Map<String, String> streamVariables = extractStreamVariables(endpoint.source, stringVariables, safeEventContext);
        Set<String> scheduledStreams = new HashSet<>();

        Matcher notifyMatcher = DEVICE_NOTIFY_CALL_PATTERN.matcher(endpoint.source);
        while (notifyMatcher.find()) {
            String messageToken = notifyMatcher.group(1);
            String message = resolveTokenValue(messageToken, stringVariables, safeEventContext);
            if (message.isEmpty()) {
                appendProjectLog(endpoint, buildReadableGlobalLogLine("DEVICE_NOTIFY", "message-unresolved token=" + String.valueOf(messageToken)));
                continue;
            }

            boolean shown = sendEndpointNotification(message);
            String notifyMessage = "shown=" + shown + " message=" + message;
            appendProjectLog(endpoint, buildReadableGlobalLogLine("DEVICE_NOTIFY", notifyMessage));
            appendGlobalLog(buildExchangeLog(
                "DEVICE_NOTIFY",
                notifyMessage
            ));
        }

        Matcher directStreamMatcher = STREAM_FILE_CALL_PATTERN.matcher(endpoint.source);
        while (directStreamMatcher.find()) {
            String target = directStreamMatcher.group(2) != null ? directStreamMatcher.group(2).trim() : "";
            String streamPath = directStreamMatcher.group(4) != null ? directStreamMatcher.group(4).trim() : "";
            if (target.isEmpty() || streamPath.isEmpty()) {
                continue;
            }

            String dedupeKey = "direct|" + target + "|" + streamPath;
            if (scheduledStreams.contains(dedupeKey)) {
                continue;
            }

            try {
                streamFileToNode(target, streamPath, new HashMap<>(), null);
                scheduledStreams.add(dedupeKey);
            } catch (Exception error) {
                appendGlobalLog(buildExchangeLog("STREAM_DIRECT_ERROR", error.getMessage() != null ? error.getMessage() : "stream direct failed"));
            }
        }

        Matcher exchangeStreamMatcher = EXCHANGE_STREAM_FILE_CALL_PATTERN.matcher(endpoint.source);
        while (exchangeStreamMatcher.find()) {
            String target = exchangeStreamMatcher.group(2) != null ? exchangeStreamMatcher.group(2).trim() : "";
            String streamPath = exchangeStreamMatcher.group(4) != null ? exchangeStreamMatcher.group(4).trim() : "";
            if (target.isEmpty() || streamPath.isEmpty()) {
                continue;
            }

            String dedupeKey = "exchange|" + target + "|" + streamPath;
            if (scheduledStreams.contains(dedupeKey)) {
                continue;
            }

            try {
                streamFileToExchange(target, streamPath);
                scheduledStreams.add(dedupeKey);
            } catch (Exception error) {
                appendGlobalLog(buildExchangeLog("STREAM_EXCHANGE_ERROR", error.getMessage() != null ? error.getMessage() : "stream exchange failed"));
            }
        }

        Matcher genericDirectStreamMatcher = STREAM_CALL_GENERIC_PATTERN.matcher(endpoint.source);
        while (genericDirectStreamMatcher.find()) {
            String targetToken = genericDirectStreamMatcher.group(1);
            String pathToken = genericDirectStreamMatcher.group(2);

            String target = resolveTokenValue(targetToken, stringVariables, safeEventContext);
            String streamPath = resolveTokenValue(pathToken, stringVariables, safeEventContext);
            if (streamPath.isEmpty()) {
                streamPath = resolveStreamVariablePath(pathToken, streamVariables);
            }

            if (target.isEmpty() || streamPath.isEmpty()) {
                continue;
            }

            String dedupeKey = "direct|" + target + "|" + streamPath;
            if (scheduledStreams.contains(dedupeKey)) {
                continue;
            }

            try {
                streamFileToNode(target, streamPath, new HashMap<>(), null);
                scheduledStreams.add(dedupeKey);
            } catch (Exception error) {
                appendGlobalLog(buildExchangeLog("STREAM_DIRECT_ERROR", error.getMessage() != null ? error.getMessage() : "stream direct failed"));
            }
        }

        Matcher genericExchangeStreamMatcher = EXCHANGE_STREAM_CALL_GENERIC_PATTERN.matcher(endpoint.source);
        while (genericExchangeStreamMatcher.find()) {
            String targetToken = genericExchangeStreamMatcher.group(1);
            String pathToken = genericExchangeStreamMatcher.group(2);

            String target = resolveTokenValue(targetToken, stringVariables, safeEventContext);
            String streamPath = resolveTokenValue(pathToken, stringVariables, safeEventContext);
            if (streamPath.isEmpty()) {
                streamPath = resolveStreamVariablePath(pathToken, streamVariables);
            }

            if (target.isEmpty() || streamPath.isEmpty()) {
                continue;
            }

            String dedupeKey = "exchange|" + target + "|" + streamPath;
            if (scheduledStreams.contains(dedupeKey)) {
                continue;
            }

            try {
                streamFileToExchange(target, streamPath);
                scheduledStreams.add(dedupeKey);
            } catch (Exception error) {
                appendGlobalLog(buildExchangeLog("STREAM_EXCHANGE_ERROR", error.getMessage() != null ? error.getMessage() : "stream exchange failed"));
            }
        }

        Matcher copyStreamMatcher = FILE_COPY_STREAM_CALL_PATTERN.matcher(endpoint.source);
        while (copyStreamMatcher.find()) {
            String sourceToken = copyStreamMatcher.group(1);
            String destinationToken = copyStreamMatcher.group(2);

            String sourcePath = resolveTokenValue(sourceToken, stringVariables, safeEventContext);
            if (sourcePath.isEmpty()) {
                sourcePath = resolveStreamVariablePath(sourceToken, streamVariables);
            }

            String destinationPath = resolveTokenValue(destinationToken, stringVariables, safeEventContext);
            if (destinationPath.isEmpty()) {
                destinationPath = resolveStreamVariablePath(destinationToken, streamVariables);
            }

            if (sourcePath.isEmpty() || destinationPath.isEmpty()) {
                continue;
            }

            try {
                copyResolvedStreamPath(sourcePath, destinationPath);
            } catch (Exception error) {
                appendGlobalLog(buildExchangeLog("STREAM_COPY_ERROR", error.getMessage() != null ? error.getMessage() : "stream copy failed"));
            }
        }
    }

    private Map<String, String> extractStringVariables(String source, Map<String, String> eventContext) {
        Map<String, String> vars = new HashMap<>();
        Matcher matcher = STRING_VAR_ASSIGN_PATTERN.matcher(String.valueOf(source));
        while (matcher.find()) {
            String name = matcher.group(1) != null ? matcher.group(1).trim() : "";
            String value = matcher.group(3) != null ? matcher.group(3) : "";
            if (!name.isEmpty()) {
                vars.put(name, value);
            }
        }

        String mobileHome;
        try {
            mobileHome = Environment.getExternalStorageDirectory().getAbsolutePath();
        } catch (Exception ignored) {
            mobileHome = "/storage/emulated/0";
        }

        Matcher homeDirMatcher = HOME_DIR_VAR_ASSIGN_PATTERN.matcher(String.valueOf(source));
        while (homeDirMatcher.find()) {
            String name = homeDirMatcher.group(1) != null ? homeDirMatcher.group(1).trim() : "";
            if (!name.isEmpty()) {
                vars.put(name, mobileHome);
            }
        }

        for (int pass = 0; pass < 3; pass++) {
            boolean changed = false;
            Matcher genericMatcher = GENERIC_VAR_ASSIGN_PATTERN.matcher(String.valueOf(source));
            while (genericMatcher.find()) {
                String name = genericMatcher.group(1) != null ? genericMatcher.group(1).trim() : "";
                String expression = genericMatcher.group(2) != null ? genericMatcher.group(2).trim() : "";
                if (name.isEmpty() || expression.isEmpty()) {
                    continue;
                }

                String resolvedValue = resolveTokenValue(expression, vars, eventContext);
                if (resolvedValue.isEmpty()) {
                    continue;
                }

                String previous = vars.put(name, resolvedValue);
                if (!resolvedValue.equals(previous)) {
                    changed = true;
                }
            }

            if (!changed) {
                break;
            }
        }

        return vars;
    }

    private String trimWrappingParentheses(String token) {
        String current = String.valueOf(token == null ? "" : token).trim();
        while (current.length() >= 2 && current.startsWith("(") && current.endsWith(")")) {
            int depth = 0;
            boolean validWrap = true;
            for (int index = 0; index < current.length(); index++) {
                char ch = current.charAt(index);
                if (ch == '(') {
                    depth += 1;
                } else if (ch == ')') {
                    depth -= 1;
                    if (depth == 0 && index < current.length() - 1) {
                        validWrap = false;
                        break;
                    }
                    if (depth < 0) {
                        validWrap = false;
                        break;
                    }
                }
            }

            if (!validWrap || depth != 0) {
                break;
            }

            current = current.substring(1, current.length() - 1).trim();
        }

        return current;
    }

    private List<String> splitConcatenationParts(String expression) {
        List<String> parts = new ArrayList<>();
        StringBuilder token = new StringBuilder();
        boolean inSingle = false;
        boolean inDouble = false;
        boolean inTemplate = false;
        int parenDepth = 0;

        String value = String.valueOf(expression == null ? "" : expression);
        for (int index = 0; index < value.length(); index++) {
            char ch = value.charAt(index);

            if (ch == '\'' && !inDouble && !inTemplate) {
                inSingle = !inSingle;
                token.append(ch);
                continue;
            }

            if (ch == '"' && !inSingle && !inTemplate) {
                inDouble = !inDouble;
                token.append(ch);
                continue;
            }

            if (ch == '`' && !inSingle && !inDouble) {
                inTemplate = !inTemplate;
                token.append(ch);
                continue;
            }

            if (!inSingle && !inDouble && !inTemplate) {
                if (ch == '(') {
                    parenDepth += 1;
                    token.append(ch);
                    continue;
                }

                if (ch == ')') {
                    parenDepth = Math.max(0, parenDepth - 1);
                    token.append(ch);
                    continue;
                }

                if (ch == '+' && parenDepth == 0) {
                    String part = token.toString().trim();
                    if (!part.isEmpty()) {
                        parts.add(part);
                    }
                    token.setLength(0);
                    continue;
                }
            }

            token.append(ch);
        }

        String tail = token.toString().trim();
        if (!tail.isEmpty()) {
            parts.add(tail);
        }

        return parts;
    }

    private String resolveConcatenatedExpression(String expression, Map<String, String> stringVariables, Map<String, String> eventContext) {
        List<String> parts = splitConcatenationParts(expression);
        if (parts.size() < 2) {
            return "";
        }

        StringBuilder out = new StringBuilder();
        for (String part : parts) {
            String resolved = resolveTokenValue(part, stringVariables, eventContext);
            if (resolved.isEmpty()) {
                return "";
            }
            out.append(resolved);
        }

        return out.toString();
    }

    private String resolveTemplateToken(String token, Map<String, String> stringVariables, Map<String, String> eventContext) {
        String inner = token.substring(1, token.length() - 1);
        StringBuffer out = new StringBuffer();
        Matcher matcher = Pattern.compile("\\$\\{([^}]+)\\}").matcher(inner);
        while (matcher.find()) {
            String expression = matcher.group(1);
            String resolved = resolveTokenValue(expression, stringVariables, eventContext);
            matcher.appendReplacement(out, Matcher.quoteReplacement(String.valueOf(resolved == null ? "" : resolved)));
        }
        matcher.appendTail(out);
        return out.toString();
    }

    private Map<String, String> extractStreamVariables(String source, Map<String, String> stringVariables, Map<String, String> eventContext) {
        Map<String, String> vars = new HashMap<>();
        Matcher matcher = STREAM_VAR_ASSIGN_PATTERN.matcher(String.valueOf(source));
        while (matcher.find()) {
            String name = matcher.group(1) != null ? matcher.group(1).trim() : "";
            String pathToken = matcher.group(2);
            if (name.isEmpty()) {
                continue;
            }

            String resolvedPath = resolveTokenValue(pathToken, stringVariables, eventContext);
            if (!resolvedPath.isEmpty()) {
                vars.put(name, resolvedPath);
            }
        }
        return vars;
    }

    private String resolveTokenValue(String rawToken, Map<String, String> stringVariables, Map<String, String> eventContext) {
        String token = trimWrappingParentheses(String.valueOf(rawToken));
        if (token.isEmpty()) {
            return "";
        }

        if (token.contains("+")) {
            String resolvedConcat = resolveConcatenatedExpression(token, stringVariables, eventContext);
            if (!resolvedConcat.isEmpty()) {
                return resolvedConcat;
            }
        }

        if (token.startsWith("`") && token.endsWith("`") && token.length() >= 2) {
            return resolveTemplateToken(token, stringVariables, eventContext);
        }

        if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
            return token.substring(1, token.length() - 1);
        }

        String normalizedToken = token.replaceAll("\\s+", "");
        if ("event.watchPath".equals(normalizedToken)) {
            return String.valueOf(eventContext != null ? eventContext.getOrDefault("event.watchPath", "") : "");
        }
        if ("event.relativePath".equals(normalizedToken)) {
            return String.valueOf(eventContext != null ? eventContext.getOrDefault("event.relativePath", "") : "");
        }
        if ("event.watchType".equals(normalizedToken)) {
            return String.valueOf(eventContext != null ? eventContext.getOrDefault("event.watchType", "") : "");
        }
        if ("event.tmpPath".equals(normalizedToken)) {
            return String.valueOf(eventContext != null ? eventContext.getOrDefault("event.tmpPath", "") : "");
        }
        if (normalizedToken.startsWith("event.metadata.")) {
            return String.valueOf(eventContext != null ? eventContext.getOrDefault(normalizedToken, "") : "");
        }

        String fromVars = stringVariables.get(token);
        if (fromVars != null) {
            return fromVars;
        }

        String normalizedFromVars = stringVariables.get(normalizedToken);
        return normalizedFromVars != null ? normalizedFromVars : "";
    }

    private String resolveStreamVariablePath(String rawToken, Map<String, String> streamVariables) {
        String token = String.valueOf(rawToken).trim();
        if (token.isEmpty()) {
            return "";
        }

        String fromVars = streamVariables.get(token);
        return fromVars != null ? fromVars : "";
    }

    private File resolveStreamFilePath(String rawPath) {
        String targetPath = String.valueOf(rawPath).trim();
        if (targetPath.isEmpty()) {
            return null;
        }

        File file = new File(targetPath);
        if (file.isAbsolute()) {
            return file;
        }

        return new File(getFilesDir(), targetPath);
    }

    private void copyResolvedStreamPath(String sourcePath, String destinationPath) {
        File sourceFile = resolveStreamFilePath(sourcePath);
        if (sourceFile == null || !sourceFile.exists() || !sourceFile.isFile()) {
            throw new RuntimeException("stream source file not found: " + sourcePath);
        }

        File destinationFile = resolveStreamFilePath(destinationPath);
        if (destinationFile == null) {
            throw new RuntimeException("invalid stream destination path");
        }

        File parent = destinationFile.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }

        try (FileInputStream input = new FileInputStream(sourceFile);
             FileOutputStream output = new FileOutputStream(destinationFile, false)) {
            byte[] buffer = new byte[DEFAULT_STREAM_CHUNK_SIZE];
            int read;
            while ((read = input.read(buffer)) > 0) {
                output.write(buffer, 0, read);
            }
            output.flush();
        } catch (IOException error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "stream copy failed");
        }
    }

    private String resolveMobileHomePath() {
        try {
            String external = Environment.getExternalStorageDirectory().getAbsolutePath();
            if (external != null && !external.trim().isEmpty()) {
                return external.replace('\\', '/').replaceAll("/+$", "");
            }
        } catch (Exception ignored) {
            // Fallback below.
        }

        return "/storage/emulated/0";
    }

    private JSONObject buildDefaultStreamMetadata(File file) {
        JSONObject metadata = new JSONObject();
        String fileName = file != null ? String.valueOf(file.getName()) : "";
        String safeFileName = fileName.trim().isEmpty() ? "incoming.bin" : fileName;

        String absolutePath = file != null ? String.valueOf(file.getAbsolutePath()) : "";
        String normalizedPath = absolutePath.replace('\\', '/');
        String mobileHome = resolveMobileHomePath();

        String relativePath = safeFileName;
        if (!normalizedPath.isEmpty() && !mobileHome.isEmpty()) {
            String prefix = mobileHome + "/";
            if (normalizedPath.equals(mobileHome)) {
                relativePath = safeFileName;
            } else if (normalizedPath.startsWith(prefix) && normalizedPath.length() > prefix.length()) {
                relativePath = normalizedPath.substring(prefix.length());
            }
        }

        try {
            metadata.put("fileName", safeFileName);
            metadata.put("relativePath", relativePath);
            metadata.put("sourcePath", normalizedPath);
        } catch (JSONException ignored) {
            // Best effort metadata serialization.
        }

        return metadata;
    }

    private JSONObject mergeStreamMetadata(File file, JSONObject metadataOverride) {
        JSONObject metadata = buildDefaultStreamMetadata(file);
        if (metadataOverride == null) {
            return metadata;
        }

        try {
            Iterator<String> keys = metadataOverride.keys();
            while (keys.hasNext()) {
                String key = String.valueOf(keys.next());
                if (key.trim().isEmpty()) {
                    continue;
                }
                metadata.put(key, metadataOverride.opt(key));
            }
        } catch (Exception ignored) {
            // Keep default metadata if merge fails.
        }

        return metadata;
    }

    private void streamFileToNode(String target, String filePath, Map<String, String> extraHeaders, JSONObject metadataOverride) {
        File file = resolveStreamFilePath(filePath);
        if (file == null || !file.exists() || !file.isFile()) {
            throw new RuntimeException("stream source file not found: " + filePath);
        }

        ParsedTarget parsedTarget = parseTarget(target);
        if (parsedTarget == null) {
            throw new RuntimeException("invalid target");
        }

        Map<String, String> effectiveHeaders = new HashMap<>();
        if (extraHeaders != null) {
            effectiveHeaders.putAll(extraHeaders);
        }
        if (parsedTarget.endpointSelector != null && !parsedTarget.endpointSelector.isEmpty()) {
            effectiveHeaders.put("Reactor-Target-Endpoint", parsedTarget.endpointSelector);
        }
        if (parsedTarget.endpointId != null && !parsedTarget.endpointId.isEmpty()) {
            effectiveHeaders.put("Reactor-Target-Endpoint-Id", parsedTarget.endpointId);
        }
        if (parsedTarget.nodeName != null && !parsedTarget.nodeName.isEmpty()) {
            effectiveHeaders.put("Reactor-Target-Node", parsedTarget.nodeName);
        } else if (parsedTarget.directAddress) {
            effectiveHeaders.put("Reactor-Target-Node", "net:" + String.valueOf(parsedTarget.baseTarget).trim().toLowerCase(Locale.ROOT));
        }

        String streamTarget = parsedTarget.directAddress ? parsedTarget.baseTarget : parsedTarget.originalTarget;

        String streamId = UUID.randomUUID().toString();
        String contentType = "application/octet-stream";
        long totalBytes = file.length();

        JSONObject start;
        try {
            start = new JSONObject();
            start.put("__reactorStream", true);
            start.put("phase", "start");
            start.put("streamId", streamId);
            start.put("contentType", contentType);
            start.put("chunkSize", DEFAULT_STREAM_CHUNK_SIZE);
            start.put("totalBytes", totalBytes);
            start.put("metadata", mergeStreamMetadata(file, metadataOverride));
        } catch (Exception error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "unable to build stream start packet");
        }
        Set<String> deliveredViaSeen = new HashSet<>();
        SendDeliveryResult startDelivery = sendNodeMessageWithContentType(streamTarget, start.toString(), "application/json; charset=utf-8", effectiveHeaders);
        deliveredViaSeen.add(String.valueOf(startDelivery.deliveredVia).trim().toUpperCase(Locale.ROOT));

        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new RuntimeException("sha256 unavailable");
        }

        int index = 0;
        long sentBytes = 0L;
        byte[] chunk = new byte[DEFAULT_STREAM_CHUNK_SIZE];
        try (FileInputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(chunk)) > 0) {
                byte[] bytes = read == chunk.length ? chunk : java.util.Arrays.copyOf(chunk, read);
                digest.update(bytes, 0, bytes.length);
                sentBytes += bytes.length;

                JSONObject packet;
                try {
                    packet = new JSONObject();
                    packet.put("__reactorStream", true);
                    packet.put("phase", "chunk");
                    packet.put("streamId", streamId);
                    packet.put("index", index);
                    packet.put("encoding", "base64");
                    packet.put("size", bytes.length);
                    packet.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                } catch (Exception jsonError) {
                    throw new RuntimeException(jsonError.getMessage() != null ? jsonError.getMessage() : "unable to build stream chunk packet");
                }

                SendDeliveryResult chunkDelivery = sendNodeMessageWithContentType(streamTarget, packet.toString(), "application/json; charset=utf-8", effectiveHeaders);
                deliveredViaSeen.add(String.valueOf(chunkDelivery.deliveredVia).trim().toUpperCase(Locale.ROOT));
                index += 1;
            }
        } catch (IOException error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "stream read failed");
        }

        JSONObject end;
        try {
            end = new JSONObject();
            end.put("__reactorStream", true);
            end.put("phase", "end");
            end.put("streamId", streamId);
            end.put("chunks", index);
            end.put("totalBytes", sentBytes);
            end.put("digestSha256", bytesToHex(digest.digest()));
        } catch (Exception error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "unable to build stream end packet");
        }
        SendDeliveryResult endDelivery = sendNodeMessageWithContentType(streamTarget, end.toString(), "application/json; charset=utf-8", effectiveHeaders);
        deliveredViaSeen.add(String.valueOf(endDelivery.deliveredVia).trim().toUpperCase(Locale.ROOT));

        String streamDeliveredVia = "";
        if (deliveredViaSeen.contains("EXCHANGE")) {
            streamDeliveredVia = "EXCHANGE";
        } else if (deliveredViaSeen.contains("P2P_RELAY")) {
            streamDeliveredVia = "P2P_RELAY";
        } else if (deliveredViaSeen.contains("P2P_DIRECT")) {
            streamDeliveredVia = "P2P_DIRECT";
        }
        if (!streamDeliveredVia.isEmpty()) {
            appendGlobalLog(buildExchangeLog("STREAM_DELIVERED", "target=" + streamTarget + " deliveredVia=" + streamDeliveredVia));
        }
    }

    private void streamFileToExchange(String target, String filePath) {
        File file = resolveStreamFilePath(filePath);
        if (file == null || !file.exists() || !file.isFile()) {
            throw new RuntimeException("stream source file not found: " + filePath);
        }

        ParsedTarget parsedTarget = parseTarget(target);
        if (parsedTarget == null || parsedTarget.baseTarget == null || parsedTarget.baseTarget.trim().isEmpty()) {
            throw new RuntimeException("invalid exchange target");
        }

        String streamId = UUID.randomUUID().toString();
        String contentType = "application/octet-stream";
        long totalBytes = file.length();

        JSONObject start;
        try {
            start = new JSONObject();
            start.put("__reactorStream", true);
            start.put("phase", "start");
            start.put("streamId", streamId);
            start.put("contentType", contentType);
            start.put("chunkSize", DEFAULT_STREAM_CHUNK_SIZE);
            start.put("totalBytes", totalBytes);
            start.put("metadata", buildDefaultStreamMetadata(file));
        } catch (Exception error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "unable to build exchange stream start packet");
        }
        sendExchangeMessageNow(parsedTarget.originalTarget, start.toString(), "application/json");

        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new RuntimeException("sha256 unavailable");
        }

        int index = 0;
        long sentBytes = 0L;
        byte[] chunk = new byte[DEFAULT_STREAM_CHUNK_SIZE];
        try (FileInputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(chunk)) > 0) {
                byte[] bytes = read == chunk.length ? chunk : java.util.Arrays.copyOf(chunk, read);
                digest.update(bytes, 0, bytes.length);
                sentBytes += bytes.length;

                JSONObject packet;
                try {
                    packet = new JSONObject();
                    packet.put("__reactorStream", true);
                    packet.put("phase", "chunk");
                    packet.put("streamId", streamId);
                    packet.put("index", index);
                    packet.put("encoding", "base64");
                    packet.put("size", bytes.length);
                    packet.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                } catch (Exception jsonError) {
                    throw new RuntimeException(jsonError.getMessage() != null ? jsonError.getMessage() : "unable to build exchange stream chunk packet");
                }
                sendExchangeMessageNow(parsedTarget.originalTarget, packet.toString(), "application/json");
                index += 1;
            }
        } catch (IOException error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "stream read failed");
        }

        JSONObject end;
        try {
            end = new JSONObject();
            end.put("__reactorStream", true);
            end.put("phase", "end");
            end.put("streamId", streamId);
            end.put("chunks", index);
            end.put("totalBytes", sentBytes);
            end.put("digestSha256", bytesToHex(digest.digest()));
        } catch (Exception error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "unable to build exchange stream end packet");
        }
        sendExchangeMessageNow(parsedTarget.originalTarget, end.toString(), "application/json");
        appendGlobalLog(buildExchangeLog("STREAM_DELIVERED", "target=" + parsedTarget.originalTarget + " deliveredVia=EXCHANGE"));
    }

    private String bytesToHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            builder.append(String.format(Locale.ROOT, "%02x", b));
        }
        return builder.toString();
    }

    private SendDeliveryResult sendNodeMessageWithContentType(String target, String content, String contentType, Map<String, String> extraHeaders) {
        String targetValue = String.valueOf(target).trim();
        if (targetValue.isEmpty()) {
            throw new RuntimeException("invalid target");
        }

        ParsedTarget parsedTarget = parseTarget(targetValue);
        if (parsedTarget == null) {
            throw new RuntimeException("invalid target");
        }

        Map<String, String> effectiveHeaders = new HashMap<>();
        if (extraHeaders != null) {
            effectiveHeaders.putAll(extraHeaders);
        }
        if (parsedTarget.endpointSelector != null && !parsedTarget.endpointSelector.isEmpty()) {
            effectiveHeaders.put("Reactor-Target-Endpoint", parsedTarget.endpointSelector);
        }
        if (parsedTarget.endpointId != null && !parsedTarget.endpointId.isEmpty()) {
            effectiveHeaders.put("Reactor-Target-Endpoint-Id", parsedTarget.endpointId);
        }

        if (parsedTarget.nodeName == null && !parsedTarget.directAddress) {
            String reactorName = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(PREF_REACTOR_NAME, "mobile-reactor");
            String safeNode = String.valueOf(reactorName == null ? "mobile-reactor" : reactorName).trim().toLowerCase(Locale.ROOT);
            if (safeNode.isEmpty()) {
                safeNode = "mobile-reactor";
            }

            effectiveHeaders.put("Reactor-Target-Node", safeNode);
            String envelope = buildP2PEnvelope(String.valueOf(content), String.valueOf(contentType), effectiveHeaders);
            handleIncomingP2PEnvelopeInternal(safeNode, envelope);
            return SendDeliveryResult.success(targetValue, "LOCAL");
        }

        if (parsedTarget.nodeName != null && !parsedTarget.nodeName.isEmpty()) {
            effectiveHeaders.put("Reactor-Target-Node", parsedTarget.nodeName);
        } else if (parsedTarget.directAddress) {
            effectiveHeaders.put("Reactor-Target-Node", "net:" + String.valueOf(parsedTarget.baseTarget).trim().toLowerCase(Locale.ROOT));
        }

        if (!parsedTarget.directAddress) {
            String logicalTarget = String.valueOf(parsedTarget.baseTarget).trim().toLowerCase(Locale.ROOT);
            if (hasConnectedP2PRoute(logicalTarget)) {
                try {
                    return sendP2PMessage(logicalTarget, String.valueOf(content), String.valueOf(contentType), effectiveHeaders);
                } catch (Exception p2pError) {
                    appendGlobalLog(buildExchangeLog("P2P_FALLBACK", "target=" + logicalTarget + " reason=" + (p2pError.getMessage() != null ? p2pError.getMessage() : "p2p send failed")));
                }
            }

            try {
                sendExchangeMessageNow(parsedTarget.originalTarget, String.valueOf(content), String.valueOf(contentType));
                return SendDeliveryResult.success(parsedTarget.originalTarget, "EXCHANGE");
            } catch (Exception exchangeError) {
                enqueueOutgoingMessage("exchange", String.valueOf(parsedTarget.originalTarget).trim().toLowerCase(Locale.ROOT), String.valueOf(content), String.valueOf(contentType), new HashMap<>());
                return SendDeliveryResult.queued(parsedTarget.originalTarget, "EXCHANGE", exchangeError.getMessage());
            }
        }

        List<String> normalizedTargets = buildTargetCandidates(String.valueOf(parsedTarget.baseTarget));
        if (normalizedTargets.isEmpty()) {
            throw new RuntimeException("invalid target");
        }

        String reactorName = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(PREF_REACTOR_NAME, "mobile-reactor");
        String senderId = String.valueOf(reactorName) + ":" + currentPort;

        RuntimeException lastError = null;
        for (String normalizedTarget : normalizedTargets) {
            try {
                sendDirectMessageNow(normalizedTarget, content, String.valueOf(contentType), reactorName, senderId, effectiveHeaders);
                return SendDeliveryResult.success(targetValue, "P2P_DIRECT");
            } catch (Exception error) {
                lastError = new RuntimeException(error.getMessage());
            }
        }

        if (lastError != null) {
            enqueueOutgoingMessage("direct", targetValue, String.valueOf(content), String.valueOf(contentType), effectiveHeaders);
            return SendDeliveryResult.queued(targetValue, "P2P_DIRECT", lastError.getMessage());
        }

        enqueueOutgoingMessage("direct", targetValue, String.valueOf(content), String.valueOf(contentType), effectiveHeaders);
        return SendDeliveryResult.queued(targetValue, "P2P_DIRECT", "no direct route found");
    }

    private SendDeliveryResult sendNodeMessage(String target, String content, Map<String, String> extraHeaders) {
        return sendNodeMessageWithContentType(target, content, "text/plain; charset=utf-8", extraHeaders);
    }

    private SendDeliveryResult sendExchangeMessage(String target, String content) {
        String normalizedTarget = String.valueOf(target).trim().toLowerCase(Locale.ROOT);
        if (normalizedTarget.isEmpty()) {
            throw new RuntimeException("invalid target");
        }

        try {
            sendExchangeMessageNow(normalizedTarget, String.valueOf(content), "text/plain");
            return SendDeliveryResult.success(normalizedTarget, "EXCHANGE");
        } catch (Exception error) {
            enqueueOutgoingMessage("exchange", normalizedTarget, String.valueOf(content), "text/plain", new HashMap<>());
            return SendDeliveryResult.queued(normalizedTarget, "EXCHANGE", error.getMessage());
        }
    }

    private List<String> buildTargetCandidates(String targetValue) {
        List<String> candidates = new ArrayList<>();

        String normalized = normalizeMessageSender(targetValue);
        if (normalized == null) {
            return candidates;
        }

        if (normalized.matches("^[^:]+:[0-9]{1,5}$")) {
            candidates.add(normalized);
            if (!normalized.endsWith(":" + DEFAULT_PORT)) {
                String host = normalized.split(":", 2)[0];
                candidates.add(host + ":" + DEFAULT_PORT);
            }
            return candidates;
        }

        String host = normalized;
        candidates.add(host + ":" + currentPort);
        if (currentPort != DEFAULT_PORT) {
            candidates.add(host + ":" + DEFAULT_PORT);
        }

        return candidates;
    }

    private File getOutgoingQueueFile() {
        return new File(getFilesDir(), "outgoing-message-queue.json");
    }

    private long getQueueTtlMs() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long configured = prefs.getLong(PREF_MESSAGE_QUEUE_TTL_MS, DEFAULT_MESSAGE_QUEUE_TTL_MS);
        if (configured < 60000L) {
            return DEFAULT_MESSAGE_QUEUE_TTL_MS;
        }
        return configured;
    }

    private long getQueueRetryMs() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long configured = prefs.getLong(PREF_MESSAGE_QUEUE_RETRY_MS, DEFAULT_MESSAGE_QUEUE_RETRY_MS);
        if (configured < 5000L) {
            return DEFAULT_MESSAGE_QUEUE_RETRY_MS;
        }
        return configured;
    }

    private synchronized List<JSONObject> readOutgoingQueueEntries() {
        List<JSONObject> entries = new ArrayList<>();
        try {
            File queueFile = getOutgoingQueueFile();
            if (!queueFile.exists()) {
                return entries;
            }

            String raw = readTextFile(queueFile).trim();
            if (raw.isEmpty()) {
                return entries;
            }

            JSONArray parsed = new JSONArray(raw);
            for (int i = 0; i < parsed.length(); i += 1) {
                JSONObject item = parsed.optJSONObject(i);
                if (item != null) {
                    entries.add(item);
                }
            }
        } catch (Exception ignored) {
            // keep empty queue on parse failures
        }
        return entries;
    }

    private synchronized void writeOutgoingQueueEntries(List<JSONObject> entries) {
        JSONArray out = new JSONArray();
        for (JSONObject entry : entries) {
            out.put(entry);
        }

        try {
            writeTextFile(getOutgoingQueueFile(), out.toString() + "\n");
        } catch (Exception ignored) {
            // ignore queue persistence failures
        }
    }

    private void enqueueOutgoingMessage(String channel, String target, String content, String contentType, Map<String, String> headers) {
        long now = System.currentTimeMillis();
        JSONObject entry = new JSONObject();
        try {
            entry.put("id", now + "-" + Math.abs(new SecureRandom().nextInt()));
            entry.put("channel", String.valueOf(channel));
            entry.put("target", String.valueOf(target));
            entry.put("content", String.valueOf(content));
            entry.put("contentType", String.valueOf(contentType));
            entry.put("createdAt", now);
            entry.put("expiresAt", now + getQueueTtlMs());
            entry.put("nextAttemptAt", now + getQueueRetryMs());
            entry.put("attempts", 0);

            JSONObject headersJson = new JSONObject();
            for (Map.Entry<String, String> header : headers.entrySet()) {
                headersJson.put(header.getKey(), String.valueOf(header.getValue()));
            }
            entry.put("headers", headersJson);
        } catch (JSONException exception) {
            appendGlobalLog(buildExchangeLog("QUEUE_ENQUEUE_FAILED", "target=" + target + " error=" + exception.getMessage()));
            return;
        }

        List<JSONObject> queue = readOutgoingQueueEntries();
        queue.add(entry);
        writeOutgoingQueueEntries(queue);
        appendGlobalLog(buildExchangeLog("QUEUE_ENQUEUED", "channel=" + channel + " target=" + target));
    }

    private Map<String, String> jsonToHeaders(JSONObject headersJson) {
        Map<String, String> headers = new HashMap<>();
        if (headersJson == null) {
            return headers;
        }

        JSONArray names = headersJson.names();
        if (names == null) {
            return headers;
        }

        for (int i = 0; i < names.length(); i += 1) {
            String key = names.optString(i, "");
            if (key.isEmpty()) {
                continue;
            }
            headers.put(key, String.valueOf(headersJson.optString(key, "")));
        }

        return headers;
    }

    private void flushOutgoingQueue() {
        List<JSONObject> queue = readOutgoingQueueEntries();
        if (queue.isEmpty()) {
            return;
        }

        long now = System.currentTimeMillis();
        List<JSONObject> nextQueue = new ArrayList<>();
        int delivered = 0;

        for (JSONObject item : queue) {
            if (item == null) {
                continue;
            }

            long expiresAt = item.optLong("expiresAt", 0L);
            if (expiresAt > 0 && expiresAt <= now) {
                continue;
            }

            long nextAttemptAt = item.optLong("nextAttemptAt", 0L);
            if (nextAttemptAt > now) {
                nextQueue.add(item);
                continue;
            }

            String channel = item.optString("channel", "direct");
            String target = item.optString("target", "");
            String content = item.optString("content", "");
            String contentType = item.optString("contentType", "text/plain");
            JSONObject headersJson = item.optJSONObject("headers");

            try {
                if ("exchange".equals(channel)) {
                    sendExchangeMessageNow(target, content, contentType);
                } else {
                    String reactorName = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                            .getString(PREF_REACTOR_NAME, "mobile-reactor");
                    String senderId = String.valueOf(reactorName) + ":" + currentPort;
                    sendDirectMessageNow(target, content, contentType, reactorName, senderId, jsonToHeaders(headersJson));
                }
                delivered += 1;
            } catch (Exception error) {
                int attempts = item.optInt("attempts", 0) + 1;
                long backoffMs = Math.min(getQueueRetryMs() * Math.max(1, attempts), 30L * 60L * 1000L);
                try {
                    item.put("attempts", attempts);
                    item.put("nextAttemptAt", now + backoffMs);
                } catch (JSONException jsonException) {
                    appendGlobalLog(buildExchangeLog("QUEUE_RETRY_UPDATE_FAILED", "target=" + target + " error=" + jsonException.getMessage()));
                }
                nextQueue.add(item);
            }
        }

        writeOutgoingQueueEntries(nextQueue);
        if (delivered > 0) {
            appendGlobalLog(buildExchangeLog("QUEUE_FLUSH", "delivered=" + delivered + " pending=" + nextQueue.size()));
        }
    }

    private void startOutgoingQueueFlusher() {
        if (outgoingQueueFlusherRunning) {
            return;
        }

        outgoingQueueFlusherRunning = true;
        outgoingQueueFlusherThread = new Thread(() -> {
            while (outgoingQueueFlusherRunning) {
                try {
                    flushOutgoingQueue();
                } catch (Exception ignored) {
                    // best effort
                }

                try {
                    Thread.sleep(getQueueRetryMs());
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }, "reactor-outgoing-queue-flusher");
        outgoingQueueFlusherThread.setDaemon(true);
        outgoingQueueFlusherThread.start();
    }

    private void stopOutgoingQueueFlusher() {
        outgoingQueueFlusherRunning = false;
        if (outgoingQueueFlusherThread != null) {
            outgoingQueueFlusherThread.interrupt();
            outgoingQueueFlusherThread = null;
        }
    }

    private void sendDirectMessageNow(String normalizedTarget, String content, String contentType, String reactorName, String senderId, Map<String, String> extraHeaders) {
        String[] hostPort = String.valueOf(normalizedTarget).split(":", 2);
        if (hostPort.length < 2) {
            throw new RuntimeException("invalid target");
        }

        String endpoint = "http://" + hostPort[0] + ":" + hostPort[1] + "/message";
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(4000);
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", String.valueOf(contentType == null || contentType.isEmpty() ? "text/plain; charset=utf-8" : contentType));
            connection.setRequestProperty("Reactor-Name", String.valueOf(reactorName));
            connection.setRequestProperty("Reactor-Sender", String.valueOf(senderId));

            for (Map.Entry<String, String> header : extraHeaders.entrySet()) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }

            byte[] payload = String.valueOf(content).getBytes(StandardCharsets.UTF_8);
            connection.setRequestProperty("content-length", String.valueOf(payload.length));
            connection.getOutputStream().write(payload);

            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new RuntimeException("message dispatch failed with HTTP " + status);
            }
        } catch (Exception error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "direct send failed");
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void sendExchangeMessageNow(String target, String content, String contentType) {
        if (!"node".equals(currentExchangeMode) || wsExchangeClientSocket == null) {
            throw new RuntimeException("exchange client not connected");
        }

        ParsedTarget parsedTarget = parseExchangeTransportTarget(target);
        if (parsedTarget == null || parsedTarget.baseTarget == null || parsedTarget.baseTarget.trim().isEmpty()) {
            throw new RuntimeException("invalid exchange target");
        }

        JSONObject packet = new JSONObject();
        try {
            packet.put("type", "message");
            packet.put("to", String.valueOf(parsedTarget.baseTarget).toLowerCase(Locale.ROOT));
            if (parsedTarget.endpointSelector != null && !parsedTarget.endpointSelector.isEmpty()) {
                packet.put("targetEndpoint", parsedTarget.endpointSelector);
            }
            if (parsedTarget.endpointId != null && !parsedTarget.endpointId.isEmpty()) {
                packet.put("targetEndpointId", parsedTarget.endpointId);
            }
            packet.put("content", String.valueOf(content));
            packet.put("contentType", String.valueOf(contentType));
        } catch (JSONException exception) {
            throw new RuntimeException(exception.getMessage() != null ? exception.getMessage() : "exchange packet serialization failed");
        }
        if (!wsExchangeClientSocket.send(packet.toString())) {
            throw new RuntimeException("exchange websocket send failed");
        }
    }

    private void sendExchangeSignalNow(String target, String signalType, JSObject payload, String sessionId) {
        if (!"node".equals(currentExchangeMode) || wsExchangeClientSocket == null) {
            throw new RuntimeException("exchange client not connected");
        }

        ParsedTarget parsedTarget = parseExchangeTransportTarget(target);
        if (parsedTarget == null || parsedTarget.baseTarget == null || parsedTarget.baseTarget.trim().isEmpty()) {
            throw new RuntimeException("invalid exchange target");
        }

        String safeSignalType = String.valueOf(signalType == null ? "" : signalType).trim().toLowerCase(Locale.ROOT);
        if (safeSignalType.isEmpty()) {
            throw new RuntimeException("invalid signal type");
        }

        JSONObject packet = new JSONObject();
        try {
            packet.put("type", "signal");
            packet.put("to", String.valueOf(parsedTarget.baseTarget).toLowerCase(Locale.ROOT));
            packet.put("signalType", safeSignalType);
            packet.put("sessionId", String.valueOf(sessionId == null ? "" : sessionId).trim());
            packet.put("payload", payload != null ? new JSONObject(payload.toString()) : JSONObject.NULL);
            if (parsedTarget.endpointSelector != null && !parsedTarget.endpointSelector.isEmpty()) {
                packet.put("targetEndpoint", parsedTarget.endpointSelector);
            }
            if (parsedTarget.endpointId != null && !parsedTarget.endpointId.isEmpty()) {
                packet.put("targetEndpointId", parsedTarget.endpointId);
            }
        } catch (JSONException exception) {
            throw new RuntimeException(exception.getMessage() != null ? exception.getMessage() : "signal packet serialization failed");
        }

        if (!wsExchangeClientSocket.send(packet.toString())) {
            throw new RuntimeException("exchange websocket send failed");
        }
    }

    private ParsedTarget parseExchangeTransportTarget(String rawTarget) {
        String trimmed = String.valueOf(rawTarget == null ? "" : rawTarget).trim();
        if (trimmed.isEmpty()) {
            return null;
        }

        ParsedTarget parsed = new ParsedTarget();
        parsed.originalTarget = trimmed;

        int atIndex = trimmed.lastIndexOf('@');
        if (atIndex < 0) {
            // Internal P2P signaling uses plain peer node names (for example "r1").
            String nodeName = trimmed.toLowerCase(Locale.ROOT);
            if (nodeName.isEmpty()) {
                return null;
            }
            parsed.baseTarget = nodeName;
            parsed.nodeName = nodeName;
            parsed.endpointSelector = null;
            parsed.endpointId = null;
            parsed.directAddress = false;
            return parsed;
        }

        String endpointPart = trimmed.substring(0, atIndex).trim();
        String nodePart = trimmed.substring(atIndex + 1).trim().toLowerCase(Locale.ROOT);
        if (endpointPart.isEmpty() || nodePart.isEmpty()) {
            return null;
        }

        String endpointSelector = parseEndpointSelector(endpointPart);
        if (endpointSelector == null) {
            return null;
        }

        parsed.baseTarget = nodePart;
        parsed.nodeName = nodePart;
        parsed.endpointSelector = endpointSelector;
        parsed.endpointId = endpointSelector.startsWith("id:") ? endpointSelector.substring(3) : null;
        parsed.directAddress = false;
        return parsed;
    }

    // =========================================================================
    // EXCHANGE — configurazione e lifecycle
    // =========================================================================

    private void startExchange() {
        synchronized (exchangeLifecycleLock) {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String mode = normalizeExchangeMode(prefs.getString(PREF_EXCHANGE_MODE, "node"));
            String host = prefs.getString(PREF_EXCHANGE_HOST, "");
            int port = prefs.getInt(PREF_EXCHANGE_PORT, DEFAULT_PORT);
            boolean tls = prefs.getBoolean(PREF_EXCHANGE_TLS, false);
            String token = readExchangeToken();
            if (token.isEmpty()) {
                token = prefs.getString(PREF_EXCHANGE_TOKEN, "");
            }

            String safeToken = token != null ? token : "";
            String safeHost = host != null ? host : "";
            boolean sameMode = String.valueOf(currentExchangeMode).equals(mode);
            boolean sameHost = String.valueOf(currentExchangeHost).equals(safeHost);
            boolean samePort = currentExchangePort == port;
            boolean sameTls = currentExchangeTls == tls;
            boolean sameToken = String.valueOf(currentExchangeToken).equals(safeToken);
            boolean sameConfig = sameMode && sameHost && samePort && sameTls && sameToken;
            boolean nodeClientAlreadyRunning = wsClientRunning && wsClientThread != null && wsClientThread.isAlive();

            if (exchangeStarted && sameConfig) {
                startOutgoingQueueFlusher();
                if ("node".equals(mode) && !safeHost.isEmpty() && nodeClientAlreadyRunning) {
                    appendGlobalLog(buildExchangeLog("CLIENT_CONNECTING", "exchange already active with unchanged config"));
                }
                flushOutgoingQueue();
                return;
            }

            currentExchangeMode = mode;
            currentExchangeHost = safeHost;
            currentExchangePort = port;
            currentExchangeTls = tls;
            currentExchangeToken = safeToken;

            stopExchange();
            startOutgoingQueueFlusher();

            // In EXCHANGE mode the WS server is integrated into the HTTP server:
            // handleClient() detects upgrade requests and handles WS connections.
            if ("exchange".equals(mode)) {
                wsExchangeClients.clear();
                appendGlobalLog(buildExchangeLog("SERVER_START", "Exchange server active on HTTP port " + currentPort));
                flushOutgoingQueue();
            } else if ("node".equals(mode) && !safeHost.isEmpty()) {
                startWsExchangeClient();
                flushOutgoingQueue();
            }

            exchangeStarted = true;
        }
    }

    private void stopExchange() {
        synchronized (exchangeLifecycleLock) {
            stopOutgoingQueueFlusher();
            if ("exchange".equals(currentExchangeMode)) {
                wsExchangeClients.clear();
            }
            stopWsExchangeClient();
            exchangeStarted = false;
        }
    }

    // =========================================================================
    // EXCHANGE SERVER — gestito in handleClient via WS upgrade detection
    // =========================================================================

    /** Chiamato da handleClient quando rileva un WebSocket upgrade in modalità EXCHANGE. */
    private void handleWsExchangeConnection(Socket socket, String wsKey, InputStream inputStream) {
        String clientName = null;
        WsConnection conn = null;
        Thread heartbeatThread = null;
        try {
            socket.setSoTimeout(0);
            OutputStream output = socket.getOutputStream();

            // Invia 101 Switching Protocols
            String acceptKey = computeWsAccept(wsKey);
            String handshake = "HTTP/1.1 101 Switching Protocols\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n";
            output.write(handshake.getBytes(StandardCharsets.UTF_8));
            output.flush();

            conn = new WsConnection(socket, output);
            heartbeatThread = startWsServerHeartbeat(conn);

            // Frame loop
            while (!socket.isClosed() && "exchange".equals(currentExchangeMode)) {
                WsFrame frame = readWsFrame(inputStream);
                conn.markSeen();

                if (frame.opcode == 0x8) break; // Close
                if (frame.opcode == 0x9) { conn.sendPong(frame.payload); continue; } // Ping→Pong
                if (frame.opcode == 0xA) { conn.markPong(); continue; } // Pong
                if (frame.opcode == 0x2) {
                    routeExchangeBinaryChunkData(conn, frame.payload);
                    continue;
                }
                if (frame.opcode != 0x1) continue;

                String text = new String(frame.payload, StandardCharsets.UTF_8);
                try {
                    JSONObject packet = new JSONObject(text);
                    String type = packet.optString("type", "");

                    if ("register".equals(type)) {
                        String name = packet.optString("name", "").trim().toLowerCase(Locale.ROOT);
                        String providedToken = packet.optString("token", "").trim();
                        String expectedToken = readExchangeToken();
                        if (!expectedToken.isEmpty() && !expectedToken.equals(providedToken)) {
                            conn.send("{\"type\":\"auth-error\",\"error\":\"invalid exchange token\"}");
                            appendGlobalLog(buildExchangeLog("AUTH_REJECTED", "invalid token for client " + name));
                            break;
                        }
                        if (!name.isEmpty()) {
                            if (clientName != null) wsExchangeClients.remove(clientName);
                            WsConnection previousConn = wsExchangeClients.get(name);
                            if (previousConn != null && previousConn != conn) {
                                try { previousConn.socket.close(); } catch (IOException ignored) {}
                            }
                            clientName = name;
                            wsExchangeClients.put(clientName, conn);
                            appendGlobalLog(buildExchangeLog("CLIENT_REGISTERED", "client: " + clientName));
                            conn.send("{\"type\":\"registered\",\"name\":\"" + clientName + "\"}");
                        }
                    } else if ("message".equals(type)) {
                        routeExchangeMessage(
                                packet.optString("to", "").trim().toLowerCase(Locale.ROOT),
                                clientName != null ? clientName : "unknown",
                                packet.optString("content", ""),
                                packet.optString("contentType", "text/plain"),
                                packet.optString("targetEndpoint", ""),
                                packet.optString("targetEndpointId", ""));
                    } else if ("signal".equals(type)) {
                        routeExchangeSignal(packet, clientName != null ? clientName : "unknown");
                    } else if ("stream-chunk-bin".equals(type)) {
                        routeExchangeBinaryChunkAnnouncement(
                                packet.optString("to", "").trim().toLowerCase(Locale.ROOT),
                                clientName != null ? clientName : "unknown",
                                packet.optString("streamId", "").trim(),
                                packet.optInt("index", -1),
                                packet.optInt("size", 0),
                                conn);
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {
        } finally {
            if (heartbeatThread != null) {
                heartbeatThread.interrupt();
            }
            if (clientName != null) {
                if (wsExchangeClients.get(clientName) == conn) {
                    wsExchangeClients.remove(clientName);
                    appendGlobalLog(buildExchangeLog("CLIENT_DISCONNECTED", clientName));
                }
            }
            if (conn != null) {
                wsExchangePendingBinaryByConn.remove(conn);
            }
            try { socket.close(); } catch (IOException ignored) {}
        }
    }

    private Thread startWsServerHeartbeat(WsConnection conn) {
        Thread thread = new Thread(() -> {
            while (!conn.socket.isClosed() && "exchange".equals(currentExchangeMode)) {
                try {
                    Thread.sleep(WS_HEARTBEAT_INTERVAL_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }

                long idleMs = System.currentTimeMillis() - conn.getLastSeenAt();
                if (idleMs > WS_HEARTBEAT_TIMEOUT_MS) {
                    appendGlobalLog(buildExchangeLog("HEARTBEAT_TIMEOUT", "closing stale websocket client"));
                    try { conn.socket.close(); } catch (IOException ignored) {}
                    return;
                }

                try {
                    conn.sendPing();
                } catch (Exception pingError) {
                    appendGlobalLog(buildExchangeLog("HEARTBEAT_ERROR", pingError.getMessage() != null ? pingError.getMessage() : "ping failed"));
                    try { conn.socket.close(); } catch (IOException ignored) {}
                    return;
                }
            }
        }, "reactor-ws-exchange-heartbeat");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    private void routeExchangeMessage(String to, String from, String content, String contentType, String targetEndpoint, String targetEndpointId) {
        WsConnection target = wsExchangeClients.get(to);
        if (target == null) {
            appendGlobalLog(buildExchangeLog("ROUTE_MISS", "target not connected: " + to));
            return;
        }
        try {
            JSONObject packet = new JSONObject();
            packet.put("type", "message");
            packet.put("from", from);
            packet.put("targetEndpoint", String.valueOf(targetEndpoint == null ? "" : targetEndpoint).trim().toLowerCase(Locale.ROOT));
            packet.put("targetEndpointId", String.valueOf(targetEndpointId == null ? "" : targetEndpointId).trim().toLowerCase(Locale.ROOT));
            packet.put("content", content);
            packet.put("contentType", contentType);
            target.send(packet.toString());
            appendGlobalLog(buildExchangeLog("ROUTED", from + " → " + to));
        } catch (Exception e) {
            appendGlobalLog(buildExchangeLog("ROUTE_ERROR", "error: " + e.getMessage()));
        }
    }

    private void routeExchangeSignal(JSONObject packet, String from) {
        if (packet == null) {
            return;
        }

        String to = packet.optString("to", "").trim().toLowerCase(Locale.ROOT);
        if (to.isEmpty()) {
            return;
        }

        WsConnection target = wsExchangeClients.get(to);
        if (target == null) {
            appendGlobalLog(buildExchangeLog("ROUTE_MISS", "signal target not connected: " + to));
            return;
        }

        String signalType = packet.optString("signalType", "").trim().toLowerCase(Locale.ROOT);
        if (signalType.isEmpty()) {
            return;
        }

        try {
            JSONObject outbound = new JSONObject();
            outbound.put("type", "signal");
            outbound.put("from", from != null ? from : "unknown");
            outbound.put("sessionId", packet.optString("sessionId", ""));
            outbound.put("signalType", signalType);
            outbound.put("payload", packet.has("payload") ? packet.opt("payload") : JSONObject.NULL);
            outbound.put("targetEndpoint", packet.optString("targetEndpoint", ""));
            outbound.put("targetEndpointId", packet.optString("targetEndpointId", ""));
            outbound.put("timestamp", Instant.now().toString());
            target.send(outbound.toString());
        } catch (Exception error) {
            appendGlobalLog(buildExchangeLog("ROUTE_ERROR", "signal route error: " + error.getMessage()));
        }
    }

    private void pushPendingBinaryMeta(WsConnection source, PendingBinaryChunkMeta meta) {
        List<PendingBinaryChunkMeta> queue = wsExchangePendingBinaryByConn.get(source);
        if (queue == null) {
            queue = new ArrayList<>();
            wsExchangePendingBinaryByConn.put(source, queue);
        }
        synchronized (queue) {
            queue.add(meta);
        }
    }

    private PendingBinaryChunkMeta shiftPendingBinaryMeta(WsConnection source) {
        List<PendingBinaryChunkMeta> queue = wsExchangePendingBinaryByConn.get(source);
        if (queue == null) {
            return null;
        }

        synchronized (queue) {
            if (queue.isEmpty()) {
                return null;
            }
            PendingBinaryChunkMeta meta = queue.remove(0);
            if (queue.isEmpty()) {
                wsExchangePendingBinaryByConn.remove(source);
            }
            return meta;
        }
    }

    private void routeExchangeBinaryChunkAnnouncement(String to, String from, String streamId, int index, int size, WsConnection source) {
        WsConnection target = wsExchangeClients.get(to);
        if (target == null) {
            appendGlobalLog(buildExchangeLog("ROUTE_MISS", "binary target not connected: " + to));
            return;
        }

        PendingBinaryChunkMeta meta = new PendingBinaryChunkMeta();
        meta.to = to;
        meta.from = from;
        meta.streamId = streamId;
        meta.index = index;
        meta.size = size;
        pushPendingBinaryMeta(source, meta);

        try {
            JSONObject packet = new JSONObject();
            packet.put("type", "stream-chunk-bin");
            packet.put("from", from);
            packet.put("streamId", streamId);
            packet.put("index", index);
            packet.put("size", size);
            target.send(packet.toString());
        } catch (Exception error) {
            appendGlobalLog(buildExchangeLog("ROUTE_ERROR", "binary announce error: " + error.getMessage()));
        }
    }

    private void routeExchangeBinaryChunkData(WsConnection source, byte[] payload) {
        PendingBinaryChunkMeta meta = shiftPendingBinaryMeta(source);
        if (meta == null) {
            appendGlobalLog(buildExchangeLog("ROUTE_ERROR", "binary chunk without metadata"));
            return;
        }

        WsConnection target = wsExchangeClients.get(meta.to);
        if (target == null) {
            appendGlobalLog(buildExchangeLog("ROUTE_MISS", "binary target disconnected: " + meta.to));
            return;
        }

        try {
            target.sendBinary(payload);
        } catch (Exception error) {
            appendGlobalLog(buildExchangeLog("ROUTE_ERROR", "binary route error: " + error.getMessage()));
        }
    }

    // =========================================================================
    // EXCHANGE CLIENT — OkHttp WebSocket
    // =========================================================================

    private void startWsExchangeClient() {
        synchronized (wsClientLifecycleLock) {
            if (wsClientRunning && wsClientThread != null && wsClientThread.isAlive()) {
                appendGlobalLog(buildExchangeLog("CLIENT_CONNECTING", "websocket client already running"));
                emitExchangeConnectionStatusUpdate();
                return;
            }

            okHttpClient = buildExchangeWsClient(currentExchangeTls);
            wsClientRunning = true;
            wsClientGeneration += 1L;
            final long generation = wsClientGeneration;
            emitExchangeConnectionStatusUpdate();

            wsClientThread = new Thread(() -> {
                while (wsClientRunning && generation == wsClientGeneration) {
                    connectToExchangeServer(generation);
                    if (!wsClientRunning || generation != wsClientGeneration) break;
                    try { Thread.sleep(5000); } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }, "reactor-ws-exchange-client");
            wsClientThread.setDaemon(true);
            wsClientThread.start();
        }
    }

    private void stopWsExchangeClient() {
        synchronized (wsClientLifecycleLock) {
            wsClientRunning = false;
            wsClientGeneration += 1L;
            WebSocket ws = wsExchangeClientSocket;
            if (ws != null) {
                ws.close(1000, "stopping");
                wsExchangeClientSocket = null;
            }
            if (wsClientThread != null) {
                wsClientThread.interrupt();
                wsClientThread = null;
            }
            emitExchangeConnectionStatusUpdate();
        }
    }

    private void connectToExchangeServer(final long generation) {
        final Object lock = new Object();
        final boolean[] connected = new boolean[] { false };
        final boolean[] done = new boolean[] { false };
        ExchangeEndpoint endpoint = normalizeExchangeEndpoint(currentExchangeHost, currentExchangePort);
        if (endpoint == null) {
            appendGlobalLog(buildExchangeLog("CLIENT_FAILURE", "invalid exchange host or port"));
            return;
        }

        String url = (currentExchangeTls ? "wss://" : "ws://") + endpoint.host + ":" + endpoint.port;
        appendGlobalLog(buildExchangeLog("CLIENT_CONNECTING", "connecting to " + url));
        Request.Builder requestBuilder = new Request.Builder().url(url);
        String token = readExchangeToken();
        if (token.isEmpty()) {
            token = currentExchangeToken != null ? currentExchangeToken.trim() : "";
        }
        if (!token.isEmpty()) {
            requestBuilder.addHeader("Authorization", "Bearer " + token);
        }
        Request request = requestBuilder.build();

        WebSocket webSocket = okHttpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                synchronized (wsClientLifecycleLock) {
                    if (!wsClientRunning || generation != wsClientGeneration) {
                        webSocket.close(1000, "stale-client");
                        synchronized (lock) { lock.notifyAll(); }
                        return;
                    }
                    wsExchangeClientSocket = webSocket;
                }
                emitExchangeConnectionStatusUpdate();
                synchronized (lock) {
                    connected[0] = true;
                    lock.notifyAll();
                }
                exchangeRemotePeers.clear();
                String reactorName = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .getString(PREF_REACTOR_NAME, "mobile-reactor");
                String registerToken = readExchangeToken();
                if (registerToken.isEmpty()) {
                    registerToken = currentExchangeToken != null ? currentExchangeToken.trim() : "";
                }
                try {
                    JSONObject packet = new JSONObject();
                    packet.put("type", "register");
                    packet.put("name", reactorName);
                    packet.put("token", registerToken);
                    packet.put("endpoints", buildDiscoveryEndpointsPayload());
                    packet.put("httpPort", currentPort);
                    packet.put("httpTls", false);
                    webSocket.send(packet.toString());
                } catch (Exception ignored) {
                    webSocket.send("{\"type\":\"register\",\"name\":\"mobile-reactor\",\"token\":\"\",\"endpoints\":[],\"httpPort\":7070,\"httpTls\":false}");
                }
                appendGlobalLog(buildExchangeLog("CLIENT_CONNECTED", "connected to " + url + " as " + reactorName));
                flushOutgoingQueue();
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (generation != wsClientGeneration) {
                    return;
                }

                JSONObject packet = tryParseJsonObject(text);
                if (packet != null && "stream-chunk-bin".equals(packet.optString("type", ""))) {
                    PendingBinaryChunkMeta meta = new PendingBinaryChunkMeta();
                    meta.from = packet.optString("from", "unknown");
                    meta.streamId = packet.optString("streamId", "");
                    meta.index = packet.optInt("index", -1);
                    meta.size = packet.optInt("size", 0);
                    synchronized (wsClientPendingBinaryChunks) {
                        wsClientPendingBinaryChunks.add(meta);
                    }
                    return;
                }

                handleIncomingExchangePacket(text);
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                if (generation != wsClientGeneration) {
                    return;
                }

                PendingBinaryChunkMeta meta = null;
                synchronized (wsClientPendingBinaryChunks) {
                    if (!wsClientPendingBinaryChunks.isEmpty()) {
                        meta = wsClientPendingBinaryChunks.remove(0);
                    }
                }

                if (meta == null) {
                    appendGlobalLog(buildExchangeLog("CLIENT_FAILURE", "received binary frame without metadata"));
                    return;
                }

                try {
                    JSONObject streamPayload = new JSONObject();
                    streamPayload.put("__reactorStream", true);
                    streamPayload.put("phase", "chunk");
                    streamPayload.put("streamId", meta.streamId);
                    streamPayload.put("index", meta.index);
                    streamPayload.put("size", bytes.size());
                    streamPayload.put("encoding", "base64");
                    streamPayload.put("data", bytes.base64());

                    JSONObject envelope = new JSONObject();
                    envelope.put("type", "message");
                    envelope.put("from", meta.from != null ? meta.from : "unknown");
                    envelope.put("content", streamPayload.toString());
                    envelope.put("contentType", "application/json");
                    handleIncomingExchangePacket(envelope.toString());
                } catch (Exception ignored) {
                    // Ignore malformed binary stream payloads.
                }
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                synchronized (wsClientLifecycleLock) {
                    if (wsExchangeClientSocket == webSocket) {
                        wsExchangeClientSocket = null;
                    }
                }
                emitExchangeConnectionStatusUpdate();
                exchangeRemotePeers.clear();
                p2pAutodialAttempts.clear();
                synchronized (wsClientPendingBinaryChunks) {
                    wsClientPendingBinaryChunks.clear();
                }
                appendGlobalLog(buildExchangeLog("CLIENT_DISCONNECTED", "disconnected from exchange"));
                synchronized (lock) {
                    done[0] = true;
                    lock.notifyAll();
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                synchronized (wsClientLifecycleLock) {
                    if (wsExchangeClientSocket == webSocket) {
                        wsExchangeClientSocket = null;
                    }
                }
                emitExchangeConnectionStatusUpdate();
                exchangeRemotePeers.clear();
                p2pAutodialAttempts.clear();
                synchronized (wsClientPendingBinaryChunks) {
                    wsClientPendingBinaryChunks.clear();
                }
                String detail = t.getMessage() != null ? t.getMessage() : "unknown error";
                if (response != null) {
                    detail += " (HTTP " + response.code() + ")";
                }
                appendGlobalLog(buildExchangeLog("CLIENT_FAILURE", detail));
                synchronized (lock) {
                    done[0] = true;
                    lock.notifyAll();
                }
            }
        });

        synchronized (lock) {
            long connectDeadline = System.currentTimeMillis() + WS_CLIENT_CONNECT_TIMEOUT_MS;
            while (!done[0]) {
                try {
                    if (!connected[0]) {
                        long waitMs = connectDeadline - System.currentTimeMillis();
                        if (waitMs <= 0L) {
                            appendGlobalLog(buildExchangeLog("CLIENT_FAILURE", "connect timeout"));
                            try {
                                webSocket.cancel();
                            } catch (Exception ignored) {
                                // Best effort cancellation.
                            }
                            break;
                        }
                        lock.wait(waitMs);
                    } else {
                        lock.wait();
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
    }

    private void reconnectExchangeClientInternal(String reason) {
        synchronized (exchangeLifecycleLock) {
            if (!"node".equals(currentExchangeMode)) {
                return;
            }

            appendGlobalLog(buildExchangeLog(
                    "CLIENT_RECONNECT",
                    "reason=" + String.valueOf(reason == null ? "runtime-update" : reason)
            ));

            try {
                if (wsClientRunning) {
                    stopWsExchangeClient();
                }
                startWsExchangeClient();
            } catch (Exception error) {
                appendGlobalLog(buildExchangeLog("CLIENT_FAILURE", "reconnect error: " + error.getMessage()));
            }
        }
    }

    private List<InetAddress> resolveExchangeHostAddresses(String rawHost) {
        List<InetAddress> resolved = new ArrayList<>();
        String host = String.valueOf(rawHost == null ? "" : rawHost).trim();
        if (host.isEmpty()) {
            return resolved;
        }

        try {
            InetAddress[] nativeResolved = InetAddress.getAllByName(host);
            if (nativeResolved != null) {
                resolved.addAll(Arrays.asList(nativeResolved));
            }
        } catch (Exception ignored) {
            // DoH fallback below.
        }

        if (!resolved.isEmpty()) {
            return resolved;
        }

        collectDohAddresses(host, resolved);
        return resolved;
    }

    private void collectDohAddresses(String host, List<InetAddress> resolved) {
        if (host == null || host.trim().isEmpty() || resolved == null) {
            return;
        }

        Set<String> ipCandidates = new HashSet<>();
        String encoded;
        try {
            encoded = URLEncoder.encode(host, StandardCharsets.UTF_8.name());
        } catch (Exception ignored) {
            return;
        }

        String[] providers = new String[] {
                "https://dns.google/resolve?name=" + encoded + "&type=A",
                "https://dns.google/resolve?name=" + encoded + "&type=AAAA",
                "https://8.8.8.8/resolve?name=" + encoded + "&type=A",
                "https://8.8.8.8/resolve?name=" + encoded + "&type=AAAA",
                "https://1.1.1.1/dns-query?name=" + encoded + "&type=A",
                "https://1.1.1.1/dns-query?name=" + encoded + "&type=AAAA"
        };

        for (String endpoint : providers) {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(endpoint);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(2500);
                connection.setReadTimeout(2500);
                connection.setRequestProperty("Accept", "application/json, application/dns-json");

                if (endpoint.startsWith("https://8.8.8.8/")) {
                    connection.setRequestProperty("Host", "dns.google");
                    if (connection instanceof HttpsURLConnection) {
                        applyInsecureTls((HttpsURLConnection) connection);
                    }
                } else if (endpoint.startsWith("https://1.1.1.1/")) {
                    connection.setRequestProperty("Host", "cloudflare-dns.com");
                    if (connection instanceof HttpsURLConnection) {
                        applyInsecureTls((HttpsURLConnection) connection);
                    }
                }

                int status = connection.getResponseCode();
                String body = readHttpResponseBody(connection, status);
                if (status < 200 || status >= 300 || body == null || body.isEmpty()) {
                    continue;
                }

                JSONObject parsed = new JSONObject(body);
                JSONArray answers = parsed.optJSONArray("Answer");
                if (answers == null) {
                    continue;
                }

                for (int index = 0; index < answers.length(); index += 1) {
                    JSONObject answer = answers.optJSONObject(index);
                    if (answer == null) {
                        continue;
                    }

                    String data = String.valueOf(answer.optString("data", "")).trim();
                    if (!data.isEmpty() && looksLikeIpAddress(data)) {
                        ipCandidates.add(data);
                    }
                }
            } catch (Exception ignored) {
                // Try next DoH endpoint.
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }

            if (!ipCandidates.isEmpty()) {
                break;
            }
        }

        for (String ip : ipCandidates) {
            try {
                resolved.add(InetAddress.getByName(ip));
            } catch (Exception ignored) {
                // Ignore invalid fallback addresses.
            }
        }
    }

    private boolean looksLikeIpAddress(String value) {
        if (value == null) {
            return false;
        }

        String candidate = value.trim();
        if (candidate.isEmpty()) {
            return false;
        }

        try {
            InetAddress.getByName(candidate);
            return true;
        } catch (UnknownHostException ignored) {
            return false;
        }
    }

    private void applyInsecureTls(HttpsURLConnection connection) throws Exception {
        X509TrustManager trustAll = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
                // Intentionally permissive for DoH fallback over IP endpoints.
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {
                // Intentionally permissive for DoH fallback over IP endpoints.
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };

        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(null, new TrustManager[] { trustAll }, new SecureRandom());
        connection.setSSLSocketFactory(sslContext.getSocketFactory());
        connection.setHostnameVerifier((hostname, session) -> true);
    }

    private String readHttpResponseBody(HttpURLConnection connection, int status) throws IOException {
        InputStream stream = status >= 200 && status < 400 ? connection.getInputStream() : connection.getErrorStream();
        if (stream == null) {
            return "";
        }

        StringBuilder content = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                content.append(line);
            }
        }
        return content.toString();
    }

    private OkHttpClient buildExchangeWsClient(boolean tls) {
        OkHttpClient.Builder builder = new OkHttpClient.Builder()
                .retryOnConnectionFailure(false)
                .pingInterval(WS_HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);

        builder.dns(new Dns() {
            @Override
            public List<InetAddress> lookup(String hostname) throws java.net.UnknownHostException {
                List<InetAddress> resolved = resolveExchangeHostAddresses(hostname);
                if (resolved == null || resolved.isEmpty()) {
                    throw new java.net.UnknownHostException(hostname);
                }
                return resolved;
            }
        });

        if (tls) {
            try {
                X509TrustManager trustAll = new X509TrustManager() {
                    @Override
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {
                        // Intentionally permissive to support self-signed Reactor exchange certs.
                    }

                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {
                        // Intentionally permissive to support self-signed Reactor exchange certs.
                    }

                    @Override
                    public X509Certificate[] getAcceptedIssuers() {
                        return new X509Certificate[0];
                    }
                };

                SSLContext sslContext = SSLContext.getInstance("TLS");
                sslContext.init(null, new TrustManager[]{trustAll}, new SecureRandom());
                builder.sslSocketFactory(sslContext.getSocketFactory(), trustAll);
                builder.hostnameVerifier((hostname, session) -> true);
                appendGlobalLog(buildExchangeLog("CLIENT_TLS", "TLS enabled (certificate validation disabled for exchange client)"));
            } catch (Exception error) {
                appendGlobalLog(buildExchangeLog("CLIENT_TLS_ERROR", "unable to configure permissive TLS: " + error.getMessage()));
            }
        }

        return builder.build();
    }

    private ExchangeEndpoint normalizeExchangeEndpoint(String rawHost, int rawPort) {
        String hostValue = String.valueOf(rawHost != null ? rawHost : "").trim();
        int portValue = rawPort >= 1 && rawPort <= 65535 ? rawPort : DEFAULT_PORT;
        if (hostValue.isEmpty()) {
            return null;
        }

        try {
            if (hostValue.startsWith("ws://") || hostValue.startsWith("wss://")
                    || hostValue.startsWith("http://") || hostValue.startsWith("https://")) {
                URL parsed = new URL(hostValue.replace("ws://", "http://").replace("wss://", "https://"));
                String parsedHost = String.valueOf(parsed.getHost()).trim();
                int parsedPort = parsed.getPort() > 0 ? parsed.getPort() : portValue;
                if (!parsedHost.isEmpty()) {
                    return new ExchangeEndpoint(parsedHost, parsedPort);
                }
            }
        } catch (Exception ignored) {
            // Fallback to host:port parsing below.
        }

        if (hostValue.contains("/")) {
            hostValue = hostValue.substring(0, hostValue.indexOf('/')).trim();
        }

        String host = hostValue;
        int port = portValue;
        int colonIndex = hostValue.lastIndexOf(':');
        if (colonIndex > 0 && colonIndex < hostValue.length() - 1) {
            String maybeHost = hostValue.substring(0, colonIndex).trim();
            String maybePort = hostValue.substring(colonIndex + 1).trim();
            try {
                int parsedPort = Integer.parseInt(maybePort);
                if (parsedPort >= 1 && parsedPort <= 65535 && !maybeHost.isEmpty()) {
                    host = maybeHost;
                    port = parsedPort;
                }
            } catch (NumberFormatException ignored) {
                // Keep default port.
            }
        }

        if (host.isEmpty()) {
            return null;
        }

        while (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1).trim();
        }

        if (host.isEmpty()) {
            return null;
        }

        return new ExchangeEndpoint(host, port);
    }

    private static class ExchangeEndpoint {
        final String host;
        final int port;

        ExchangeEndpoint(String host, int port) {
            this.host = host;
            this.port = port;
        }
    }

    private void handleIncomingExchangePacket(String text) {
        try {
            JSONObject packet = new JSONObject(text);
            String type = packet.optString("type", "").trim().toLowerCase(Locale.ROOT);
            if ("registered".equals(type)) {
                appendGlobalLog(buildExchangeLog("CLIENT_REGISTERED", "exchange registration acknowledged as " + packet.optString("name", "unknown")));
                return;
            }
            if ("auth-error".equals(type)) {
                appendGlobalLog(buildExchangeLog("AUTH_REJECTED", "exchange auth error: " + packet.optString("error", "invalid token")));
                return;
            }
            if ("peer-list".equals(type)) {
                JSONArray peers = packet.optJSONArray("peers");
                appendGlobalLog(buildExchangeLog("PEER_LIST", "received peer-list size=" + (peers != null ? peers.length() : 0)));
                handleIncomingExchangePeerList(packet);
                return;
            }
            if ("signal".equals(type)) {
                appendGlobalLog(buildExchangeLog(
                        "SIGNAL_INCOMING",
                        "type=" + packet.optString("signalType", "") + " from=" + packet.optString("from", "unknown")
                ));
                handleIncomingExchangeSignal(packet);
                return;
            }
            if (!"message".equals(type)) {
                return;
            }

            String from = packet.optString("from", "unknown");
            String content = packet.optString("content", "");
            String contentType = packet.optString("contentType", "text/plain");
            String targetEndpointSelector = packet.optString("targetEndpoint", "").trim().toLowerCase(Locale.ROOT);
            String targetEndpointId = packet.optString("targetEndpointId", "").trim().toLowerCase(Locale.ROOT);
            if (targetEndpointSelector.isEmpty() && !targetEndpointId.isEmpty()) {
                targetEndpointSelector = "id:" + targetEndpointId;
            }

            appendGlobalLog(buildExchangeLog("MESSAGE_RECEIVED", "message from " + from + " via exchange"));

            List<MessageEndpoint> listeners = collectMessageEndpoints();
            Set<String> senderCandidates = resolveSenderCandidates(from, from, "");
            JSONObject streamPayload = tryParseJsonObject(content);
            boolean streamEnvelope = isStreamEnvelope(streamPayload);
            String streamPhase = streamEnvelope
                    ? streamPayload.optString("phase", "").trim().toLowerCase(Locale.ROOT)
                    : "";
            String primaryEvent = streamEnvelope ? "STREAM" : "MESSAGE";
                Map<String, String> streamEventContext = streamEnvelope
                    ? buildIncomingStreamEventContext(String.valueOf(from).trim().toLowerCase(Locale.ROOT), streamPayload)
                    : new HashMap<>();
                int deliveredCount = 0;

            Map<String, String> headers = new HashMap<>();
            headers.put("content-type", contentType);
            headers.put("x-exchange-from", from);
            if (!targetEndpointSelector.isEmpty()) {
                headers.put("reactor-target-endpoint", targetEndpointSelector);
            }
            if (!targetEndpointId.isEmpty()) {
                headers.put("reactor-target-endpoint-id", targetEndpointId);
            }
            Map<String, String> effectiveHeaders = streamEnvelope
                    ? withStreamHeaders(headers, streamPayload, primaryEvent)
                    : headers;

            for (MessageEndpoint endpoint : listeners) {
                if (!matchesEventSender(endpoint, senderCandidates, primaryEvent)) continue;
                if (!matchesTargetEndpoint(endpoint, targetEndpointSelector)) continue;
                try {
                    writeExecutionStart(endpoint, primaryEvent, primaryEvent, streamEventContext);
                    executeEndpointActions(endpoint, content, effectiveHeaders, streamEventContext);
                    deliveredCount += 1;
                } catch (Exception e) {
                    writeExecutionError(endpoint, primaryEvent, primaryEvent, e.getMessage(), streamEventContext);
                }
            }

            if (streamEnvelope && "end".equals(streamPhase)) {
                Map<String, String> streamEndHeaders = withStreamHeaders(headers, streamPayload, "STREAMEND");
                for (MessageEndpoint endpoint : listeners) {
                    if (!matchesEventSender(endpoint, senderCandidates, "STREAMEND")) continue;
                    if (!matchesTargetEndpoint(endpoint, targetEndpointSelector)) continue;
                    try {
                        writeExecutionStart(endpoint, "STREAMEND", "STREAMEND", streamEventContext);
                        executeEndpointActions(endpoint, content, streamEndHeaders, streamEventContext);
                    } catch (Exception e) {
                        writeExecutionError(endpoint, "STREAMEND", "STREAMEND", e.getMessage(), streamEventContext);
                    }
                }
            }

            if (deliveredCount == 0) {
                String selectorValue = targetEndpointSelector.isEmpty() ? "*" : targetEndpointSelector;
                appendGlobalLog(buildExchangeLog(
                        "MESSAGE_IGNORED",
                        "reason=no-matching-listener from=" + String.valueOf(from).trim().toLowerCase(Locale.ROOT)
                                + " event=" + primaryEvent
                                + " targetEndpoint=" + selectorValue
                                + " senderCandidates=" + String.join(",", senderCandidates)
                                + " listeners=" + listeners.size()
                ));
            }
        } catch (Exception ignored) {}
    }

    private void handleIncomingExchangePeerList(JSONObject packet) {
        exchangeRemotePeers.clear();
        if (packet == null) {
            emitP2PStatusUpdate();
            return;
        }

        JSONArray peers = packet.optJSONArray("peers");
        if (peers == null) {
            emitP2PStatusUpdate();
            return;
        }

        String selfName = String.valueOf(getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(PREF_REACTOR_NAME, "mobile-reactor")).trim().toLowerCase(Locale.ROOT);

        for (int i = 0; i < peers.length(); i++) {
            String safePeer = String.valueOf(peers.optString(i, "")).trim().toLowerCase(Locale.ROOT);
            if (safePeer.isEmpty()) {
                continue;
            }
            if (!selfName.isEmpty() && selfName.equals(safePeer)) {
                continue;
            }
            exchangeRemotePeers.add(safePeer);
            appendGlobalLog(buildExchangeLog("P2P_PEER_DISCOVERED", "peer on exchange: " + safePeer));
            maybeAutoStartNativeP2PSession(safePeer);
        }

        emitP2PStatusUpdate();
    }

    private JSObject readWorkingModeConfigFromFile() {
        JSObject fallback = new JSObject();
        fallback.put("stun", new JSObject());
        fallback.put("turn", new JSObject());
        fallback.put("token", "");

        try {
            File workingModeFile = getWorkingModeFile();
            if (!workingModeFile.exists()) {
                return fallback;
            }

            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (FileInputStream input = new FileInputStream(workingModeFile)) {
                byte[] buffer = new byte[1024];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    output.write(buffer, 0, read);
                }
            }

            String raw = output.toString(StandardCharsets.UTF_8.name()).trim();
            if (raw.isEmpty()) {
                return fallback;
            }
            return new JSObject(raw);
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private void maybeAutoStartNativeP2PSession(String target) {
        flushPendingP2PSignals();
        String safeTarget = normalizeP2PTarget(target);
        if (safeTarget.isEmpty()) {
            return;
        }
        if (!"node".equals(currentExchangeMode)) {
            return;
        }
        if (!isExchangeClientConnected()) {
            return;
        }

        if (!shouldInitiateP2PWithPeer(safeTarget)) {
            if (!shouldForceInitiateP2PAsResponder(safeTarget)) {
                appendGlobalLog(buildExchangeLog("P2P_AUTODIAL_SKIPPED", "reason=deterministic-responder target=" + safeTarget));
                return;
            }
            appendGlobalLog(buildExchangeLog("P2P_AUTODIAL_TAKEOVER", "reason=stale-peer-session target=" + safeTarget));
        }

        JSONObject existing = p2pSessions.get(safeTarget);
        if (existing != null) {
            String state = String.valueOf(existing.optString("state", "")).trim().toLowerCase(Locale.ROOT);
            if ("connecting".equals(state)) {
                long lastUpdateMs = existing.optLong("lastUpdateMs", 0L);
                if (lastUpdateMs > 0L && (System.currentTimeMillis() - lastUpdateMs) >= 4000L) {
                    try {
                        AndroidP2PWebRtcManager.getInstance(getApplicationContext()).closeSession(safeTarget);
                    } catch (Exception ignored) {
                        // Best effort reset of stale connecting session.
                    }
                    p2pSessions.remove(safeTarget);
                } else {
                    return;
                }
            } else if ("connected-p2p".equals(state) || "connected-turn".equals(state)) {
                if (isNativeP2PDataChannelOpen(safeTarget)) {
                    return;
                }
                try {
                    AndroidP2PWebRtcManager.getInstance(getApplicationContext()).closeSession(safeTarget);
                } catch (Exception ignored) {
                    // Best effort reset when tracked state is connected but data channel is not open.
                }
                p2pSessions.remove(safeTarget);
            }
        }

        long now = System.currentTimeMillis();
        long lastAttempt = p2pAutodialAttempts.getOrDefault(safeTarget, 0L);
        long effectiveCooldownMs = DEFAULT_P2P_AUTODIAL_COOLDOWN_MS;
        if (existing != null) {
            String state = String.valueOf(existing.optString("state", "")).trim().toLowerCase(Locale.ROOT);
            if ("idle".equals(state) || "fallback-exchange".equals(state) || "signaling".equals(state)) {
                effectiveCooldownMs = Math.min(DEFAULT_P2P_AUTODIAL_COOLDOWN_MS, 5000L);
            }
        }
        if (lastAttempt > 0L && (now - lastAttempt) < effectiveCooldownMs) {
            return;
        }
        p2pAutodialAttempts.put(safeTarget, now);
        appendGlobalLog(buildExchangeLog("P2P_NEGOTIATION_START", "starting native P2P negotiation with " + safeTarget));

        try {
            AndroidP2PWebRtcManager manager = AndroidP2PWebRtcManager.getInstance(getApplicationContext());
            manager.initialize();

            JSObject workingMode = readWorkingModeConfigFromFile();
            AndroidP2PWebRtcManager.RelayConfig relayConfig = AndroidP2PWebRtcManager.fromWorkingMode(workingMode);
            JSObject result = manager.startSession(safeTarget, true, relayConfig);

            boolean started = false;
            if (result != null) {
                Boolean ok = result.getBool("ok");
                started = Boolean.TRUE.equals(ok);
            }

            if (started) {
                upsertP2PSession(safeTarget, result.getString("sessionId", ""), "connecting", "offer", false, "");
                appendGlobalLog(buildExchangeLog("P2P_AUTODIAL", "started toward " + safeTarget));
            } else {
                p2pAutodialAttempts.remove(safeTarget);
                String error = result != null ? String.valueOf(result.optString("error", "native startSession failed")) : "native startSession failed";
                appendGlobalLog(buildExchangeLog("P2P_AUTODIAL", "failed toward " + safeTarget + ": " + error));
            }
        } catch (Exception ignored) {
            // Keep Exchange relay as fallback when native P2P auto-start fails.
        }
    }

    private boolean shouldInitiateP2PWithPeer(String target) {
        String safeTarget = normalizeP2PTarget(target);
        if (safeTarget.isEmpty()) {
            return false;
        }

        String localName = String.valueOf(getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(PREF_REACTOR_NAME, "mobile-reactor")).trim().toLowerCase(Locale.ROOT);
        if (localName.isEmpty()) {
            return true;
        }

        if (localName.equals(safeTarget)) {
            return false;
        }

        return localName.compareTo(safeTarget) < 0;
    }

    private boolean shouldForceInitiateP2PAsResponder(String target) {
        String safeTarget = normalizeP2PTarget(target);
        if (safeTarget.isEmpty()) {
            return false;
        }

        if (isNativeP2PDataChannelOpen(safeTarget)) {
            return false;
        }

        JSONObject tracked = p2pSessions.get(safeTarget);
        if (tracked == null) {
            return true;
        }

        String state = String.valueOf(tracked.optString("state", "")).trim().toLowerCase(Locale.ROOT);
        long lastUpdateMs = tracked.optLong("lastUpdateMs", 0L);
        if ("connected-p2p".equals(state) || "connected-turn".equals(state)) {
            return true;
        }

        if (lastUpdateMs <= 0L) {
            return true;
        }

        return (System.currentTimeMillis() - lastUpdateMs) >= 8000L;
    }

    private void handleIncomingExchangeSignal(JSONObject packet) {
        if (packet == null) {
            return;
        }

        String from = normalizeP2PTarget(packet.optString("from", ""));
        String signalType = String.valueOf(packet.optString("signalType", "")).trim().toLowerCase(Locale.ROOT);
        if (from.isEmpty() || signalType.isEmpty()) {
            return;
        }

        JSONObject payload = extractSignalPayload(packet);
        String reason = "failed".equals(signalType)
                ? (payload != null ? payload.optString("reason", "p2p failed") : "p2p failed")
                : "";

        upsertP2PSession(
                from,
                packet.optString("sessionId", ""),
                stateForSignalType(signalType),
                signalType,
                "relay".equals(signalType) || "failed".equals(signalType),
                reason
        );

        if (
            "offer".equals(signalType)
                || "answer".equals(signalType)
                || "candidate".equals(signalType)
                || "connected".equals(signalType)
                || "failed".equals(signalType)
                || "close".equals(signalType)
        ) {
            String detail = "signal=" + signalType + " from=" + from;
            if (!reason.isEmpty()) {
            detail += " reason=" + reason;
            }
            appendGlobalLog(buildExchangeLog("P2P_SIGNAL", detail));
        }

        boolean delivered = dispatchP2PSignal(from, packet.optString("sessionId", ""), signalType, payload);
        if (!delivered) {
            try {
                JSONObject queued = new JSONObject();
                queued.put("from", from);
                queued.put("sessionId", packet.optString("sessionId", ""));
                queued.put("signalType", signalType);
                queued.put("payload", payload != null ? payload : JSONObject.NULL);
                pendingP2PSignals.offer(queued);
                appendGlobalLog(buildExchangeLog("P2P_SIGNAL_QUEUED", "signal=" + signalType + " from=" + from));
            } catch (Exception ignored) {
                // Best effort queueing.
            }
        }

        appendGlobalLog(buildExchangeLog("SIGNAL_RECEIVED", signalType + " from " + from));
    }

    private boolean dispatchP2PSignal(String from, String sessionId, String signalType, JSONObject payload) {
        P2PSignalListener listener = p2pSignalListener;
        if (listener != null) {
            try {
                listener.onSignal(from, String.valueOf(sessionId == null ? "" : sessionId), signalType, payload);
                return true;
            } catch (Exception ignored) {
                // Fallback to direct native dispatch below.
            }
        }

        try {
            AndroidP2PWebRtcManager manager = AndroidP2PWebRtcManager.getInstance(getApplicationContext());
            manager.initialize();
            manager.handleExchangeSignal(from, String.valueOf(sessionId == null ? "" : sessionId), signalType, payload);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void flushPendingP2PSignals() {
        int flushed = 0;
        while (flushed < 128) {
            JSONObject queued = pendingP2PSignals.poll();
            if (queued == null) {
                break;
            }

            String from = normalizeP2PTarget(queued.optString("from", ""));
            String sessionId = queued.optString("sessionId", "");
            String signalType = String.valueOf(queued.optString("signalType", "")).trim().toLowerCase(Locale.ROOT);
            JSONObject payload = queued.optJSONObject("payload");
            if (from.isEmpty() || signalType.isEmpty()) {
                continue;
            }

            if (!dispatchP2PSignal(from, sessionId, signalType, payload)) {
                pendingP2PSignals.offer(queued);
                break;
            }
            flushed += 1;
        }
    }

    private JSONObject extractSignalPayload(JSONObject packet) {
        if (packet == null) {
            return null;
        }

        JSONObject payloadObject = packet.optJSONObject("payload");
        if (payloadObject != null) {
            return payloadObject;
        }

        String payloadRaw = String.valueOf(packet.optString("payload", "")).trim();
        if (payloadRaw.isEmpty()) {
            return null;
        }

        try {
            return new JSONObject(payloadRaw);
        } catch (Exception ignored) {
            return null;
        }
    }

    // =========================================================================
    // EXCHANGE — WebSocket frame utilities e inner classes
    // =========================================================================

    private static class WsConnection {
        final Socket socket;
        final OutputStream output;
        volatile String name = null;
        volatile long lastSeenAt = System.currentTimeMillis();
        volatile long lastPongAt = System.currentTimeMillis();

        WsConnection(Socket socket, OutputStream output) {
            this.socket = socket;
            this.output = output;
        }

        synchronized void send(String message) throws IOException {
            byte[] payload = message.getBytes(StandardCharsets.UTF_8);
            writeWsFrame(output, 0x1, payload);
            markSeen();
        }

        synchronized void sendBinary(byte[] payload) throws IOException {
            writeWsFrame(output, 0x2, payload != null ? payload : new byte[0]);
            markSeen();
        }

        synchronized void sendPing() throws IOException {
            writeWsFrame(output, 0x9, new byte[0]);
        }

        synchronized void sendPong(byte[] payload) throws IOException {
            writeWsFrame(output, 0xA, payload != null ? payload : new byte[0]);
            markSeen();
            markPong();
        }

        void markSeen() {
            lastSeenAt = System.currentTimeMillis();
        }

        void markPong() {
            long now = System.currentTimeMillis();
            lastPongAt = now;
            lastSeenAt = now;
        }

        long getLastSeenAt() {
            return lastSeenAt;
        }
    }

    private static class WsFrame {
        int opcode;
        byte[] payload;
    }

    private static void writeWsFrame(OutputStream output, int opcode, byte[] payload) throws IOException {
        ByteArrayOutputStream frame = new ByteArrayOutputStream();
        frame.write(0x80 | (opcode & 0x0F)); // FIN=1
        int len = payload.length;
        if (len <= 125) {
            frame.write(len);
        } else if (len <= 65535) {
            frame.write(126);
            frame.write((len >> 8) & 0xFF);
            frame.write(len & 0xFF);
        } else {
            frame.write(127);
            for (int i = 7; i >= 0; i--) {
                frame.write((int) ((len >> (8 * i)) & 0xFF));
            }
        }
        frame.write(payload);
        output.write(frame.toByteArray());
        output.flush();
    }

    private static WsFrame readWsFrame(InputStream input) throws IOException {
        int b0 = input.read();
        int b1 = input.read();
        if (b0 < 0 || b1 < 0) throw new IOException("connection closed");

        int opcode = b0 & 0x0F;
        boolean masked = (b1 & 0x80) != 0;
        long payloadLen = b1 & 0x7F;

        if (payloadLen == 126) {
            int hi = input.read(), lo = input.read();
            if (hi < 0 || lo < 0) throw new IOException("truncated length");
            payloadLen = ((hi & 0xFF) << 8) | (lo & 0xFF);
        } else if (payloadLen == 127) {
            payloadLen = 0;
            for (int i = 0; i < 8; i++) {
                int b = input.read();
                if (b < 0) throw new IOException("truncated length");
                payloadLen = (payloadLen << 8) | (b & 0xFF);
            }
        }

        byte[] maskKey = new byte[4];
        if (masked) {
            for (int i = 0; i < 4; i++) {
                int b = input.read();
                if (b < 0) throw new IOException("truncated mask");
                maskKey[i] = (byte) b;
            }
        }

        int safeLen = (int) Math.min(payloadLen, 2 * 1024 * 1024L); // max 2 MB
        byte[] payload = new byte[safeLen];
        int offset = 0;
        while (offset < safeLen) {
            int read = input.read(payload, offset, safeLen - offset);
            if (read < 0) throw new IOException("connection closed during payload");
            offset += read;
        }

        if (masked) {
            for (int i = 0; i < payload.length; i++) {
                payload[i] ^= maskKey[i % 4];
            }
        }

        WsFrame frame = new WsFrame();
        frame.opcode = opcode;
        frame.payload = payload;
        return frame;
    }

    private static String computeWsAccept(String key) {
        try {
            String combined = key.trim() + WS_MAGIC;
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] hash = sha1.digest(combined.getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(hash, Base64.NO_WRAP);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-1 not available", e);
        }
    }

    private String buildExchangeLog(String phase, String message) {
        JSObject entry = new JSObject();
        entry.put("timestamp", Instant.now().toString());
        entry.put("type", "EXCHANGE");
        entry.put("scope", "GLOBAL");
        entry.put("phase", phase);
        entry.put("message", message);
        entry.put("exchangeMode", currentExchangeMode);
        return entry.toString();
    }

    private String readTextFile(File file) throws IOException {
        StringBuilder content = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                content.append(line).append('\n');
            }
        }
        return content.toString();
    }

    private void writeTextFile(File file, String content) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }

        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(String.valueOf(content).getBytes(StandardCharsets.UTF_8));
            output.flush();
        }
    }

    private String readLine(BufferedInputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int previous = -1;
        int next;
        while ((next = input.read()) != -1) {
            if (previous == '\r' && next == '\n') {
                break;
            }
            if (previous != -1) {
                buffer.write(previous);
            }
            previous = next;
        }

        if (next == -1 && previous == -1 && buffer.size() == 0) {
            return null;
        }

        if (previous != -1 && previous != '\r') {
            buffer.write(previous);
        }

        return buffer.toString(StandardCharsets.UTF_8.name()).trim();
    }

    private byte[] readBody(BufferedInputStream input, int contentLength) throws IOException {
        if (contentLength <= 0) {
            return new byte[0];
        }

        byte[] body = new byte[contentLength];
        int offset = 0;
        while (offset < contentLength) {
            int read = input.read(body, offset, contentLength - offset);
            if (read == -1) {
                break;
            }
            offset += read;
        }

        if (offset == contentLength) {
            return body;
        }

        byte[] truncated = new byte[offset];
        System.arraycopy(body, 0, truncated, 0, offset);
        return truncated;
    }

    private void writeJsonResponse(Socket socket, int statusCode, String jsonBody) throws IOException {
        byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
        String reason = statusCode == 200 ? "OK" : statusCode == 202 ? "Accepted" : statusCode == 404 ? "Not Found" : "Error";

        String headers = "HTTP/1.1 " + statusCode + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n"
                + "\r\n";

        socket.getOutputStream().write(headers.getBytes(StandardCharsets.UTF_8));
        socket.getOutputStream().write(bytes);
        socket.getOutputStream().flush();
    }

    private String buildServerLifecycleLog(String phase, String message) {
        JSObject entry = new JSObject();
        entry.put("timestamp", Instant.now().toString());
        entry.put("type", "HTTP_SERVER");
        entry.put("scope", "GLOBAL");
        entry.put("phase", phase);
        entry.put("message", message);
        entry.put("port", currentPort);
        return entry.toString();
    }

    private String buildReadableGlobalLogLine(String category, String message) {
        String safeCategory = String.valueOf(category == null ? "LOG" : category).trim();
        if (safeCategory.isEmpty()) {
            safeCategory = "LOG";
        }

        String safeMessage = String.valueOf(message == null ? "" : message).trim();
        if (safeMessage.isEmpty()) {
            safeMessage = "-";
        }

        return Instant.now().toString() + " [" + safeCategory + "] " + safeMessage;
    }

    private String formatGlobalLogLine(String line) {
        String raw = String.valueOf(line == null ? "" : line).trim();
        if (raw.isEmpty()) {
            return buildReadableGlobalLogLine("LOG", "-");
        }

        if (!(raw.startsWith("{") && raw.endsWith("}"))) {
            return buildReadableGlobalLogLine("LOG", raw);
        }

        try {
            JSONObject parsed = new JSONObject(raw);
            String timestamp = String.valueOf(parsed.optString("timestamp", Instant.now().toString())).trim();
            if (timestamp.isEmpty()) {
                timestamp = Instant.now().toString();
            }

            String type = String.valueOf(parsed.optString("type", "LOG")).trim().toUpperCase(Locale.ROOT);
            if (type.isEmpty()) {
                type = "LOG";
            }

            String phase = String.valueOf(parsed.optString("phase", "")).trim().toUpperCase(Locale.ROOT);
            String category = phase.isEmpty() ? type : (type + "/" + phase);

            String message = String.valueOf(parsed.optString("message", "")).trim();
            if (message.isEmpty()) {
                message = String.valueOf(parsed.optString("error", "")).trim();
            }

            if (message.isEmpty() && "MESSAGE_RECEIVED".equals(type)) {
                String senderName = String.valueOf(parsed.optString("senderName", "")).trim();
                String remoteHost = String.valueOf(parsed.optString("remoteHost", "")).trim();
                String contentType = String.valueOf(parsed.optString("contentType", "")).trim();
                message = "sender=" + (senderName.isEmpty() ? "unknown" : senderName)
                        + " remote=" + (remoteHost.isEmpty() ? "unknown" : remoteHost)
                        + " contentType=" + (contentType.isEmpty() ? "unknown" : contentType);
            }

            if (message.isEmpty() && "ENDPOINT_EXECUTION".equals(type)) {
                JSONObject endpoint = parsed.optJSONObject("endpoint");
                String endpointName = endpoint != null ? String.valueOf(endpoint.optString("name", "")).trim() : "";
                String trigger = String.valueOf(parsed.optString("trigger", "")).trim();
                String event = String.valueOf(parsed.optString("event", "")).trim();
                message = "endpoint=" + (endpointName.isEmpty() ? "unknown" : endpointName)
                        + " trigger=" + (trigger.isEmpty() ? "unknown" : trigger)
                        + " event=" + (event.isEmpty() ? "unknown" : event);
            }

            if (message.isEmpty()) {
                message = raw;
            }

            String exchangeMode = String.valueOf(parsed.optString("exchangeMode", "")).trim();
            if (!exchangeMode.isEmpty()) {
                message = message + " (mode=" + exchangeMode + ")";
            }

            return timestamp + " [" + category + "] " + message;
        } catch (Exception ignored) {
            return buildReadableGlobalLogLine("LOG", raw);
        }
    }

    public static void logGlobalEvent(String category, String message) {
        ReactorHttpService current = instance;
        if (current == null) {
            return;
        }
        current.appendGlobalLog(current.buildReadableGlobalLogLine(category, message));
    }

    private void appendGlobalLog(String line) {
        try {
            File logFile = new File(getFilesDir(), "activity.log");
            File parent = logFile.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            try (FileOutputStream stream = new FileOutputStream(logFile, true)) {
                String formatted = formatGlobalLogLine(line);
                stream.write((formatted + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            // Logging should never crash the service.
        }
    }

    private Notification buildNotification(int port) {
        String title = "Reactor HTTP server";
        String text = "Listening on port " + port;
        int appIconResId = resolveNotificationIconResId();
        Bitmap largeIcon = loadNotificationLargeIcon(appIconResId);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(appIconResId)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW);

        if (largeIcon != null) {
            builder.setLargeIcon(largeIcon);
        }

        return builder.build();
    }

    private boolean hasPostNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) {
            return true;
        }

        return checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean sendEndpointNotification(String message) {
        String text = String.valueOf(message == null ? "" : message).trim();
        if (text.isEmpty()) {
            return false;
        }

        if (!hasPostNotificationPermission()) {
            return false;
        }

        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) {
                return false;
            }

            int appIconResId = resolveNotificationIconResId();
            Bitmap largeIcon = loadNotificationLargeIcon(appIconResId);

            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, ENDPOINT_NOTIFY_CHANNEL_ID)
                .setSmallIcon(appIconResId)
                .setContentTitle("Reactor")
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);

            if (largeIcon != null) {
                builder.setLargeIcon(largeIcon);
            }

            Notification notification = builder.build();

            manager.notify(ENDPOINT_NOTIFICATION_IDS.incrementAndGet(), notification);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private int resolveNotificationIconResId() {
        int appIcon = 0;
        try {
            appIcon = getApplicationInfo() != null ? getApplicationInfo().icon : 0;
        } catch (Exception ignored) {
            appIcon = 0;
        }

        return appIcon != 0 ? appIcon : android.R.drawable.stat_notify_more;
    }

    private Bitmap loadNotificationLargeIcon(int resourceId) {
        if (resourceId == 0) {
            return null;
        }

        try {
            return BitmapFactory.decodeResource(getResources(), resourceId);
        } catch (Exception ignored) {
            return null;
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Reactor HTTP",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps Reactor HTTP server running in background");

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private void createEndpointNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            ENDPOINT_NOTIFY_CHANNEL_ID,
            "Reactor Endpoint Notifications",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Notifications triggered by endpoint scripts");

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }
}
