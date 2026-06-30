package com.reactor.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;

import androidx.core.app.NotificationCompat;

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
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Enumeration;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
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

    private static final String CHANNEL_ID = "reactor_http_channel";
    private static final int NOTIFICATION_ID = 4242;
    private static final String WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final long WS_HEARTBEAT_INTERVAL_MS = 15000L;
    private static final long WS_HEARTBEAT_TIMEOUT_MS = 45000L;
    private static final long DEFAULT_MESSAGE_QUEUE_TTL_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final long DEFAULT_MESSAGE_QUEUE_RETRY_MS = 30000L;
    private static final long DEFAULT_P2P_SESSION_TIMEOUT_MS = 2L * 60L * 1000L;
    private static final long NET_CHANGE_DEBOUNCE_MS = 2500L;
    private static final long NET_CHANGE_FALLBACK_POLL_INTERVAL_MS = 60000L;

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
    private static volatile P2PSignalListener p2pSignalListener = null;
    private static ReactorHttpService instance = null;
    private static volatile boolean stopRequestedByUser = false;

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

    private static final Pattern SEND_MESSAGE_CALL_PATTERN = Pattern.compile(
            "Node\\.sendMessage\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\1\\s*,\\s*(['\"])\\s*(.*?)\\s*\\3",
            Pattern.DOTALL
    );
        private static final Pattern EXCHANGE_SEND_MESSAGE_CALL_PATTERN = Pattern.compile(
            "Node\\.exchange\\s*\\(\\s*\\)\\s*\\.\\s*sendMessage\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\1\\s*,\\s*(['\"])\\s*(.*?)\\s*\\3",
            Pattern.DOTALL
        );
        private static final Pattern STREAM_FILE_CALL_PATTERN = Pattern.compile(
            "Node\\.stream\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\1\\s*,\\s*File\\.readStream\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\3",
            Pattern.DOTALL
        );
        private static final Pattern EXCHANGE_STREAM_FILE_CALL_PATTERN = Pattern.compile(
            "Node\\.exchange\\s*\\(\\s*\\)\\s*\\.\\s*stream\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\1\\s*,\\s*File\\.readStream\\s*\\(\\s*(['\"])\\s*(.*?)\\s*\\3",
            Pattern.DOTALL
        );
            private static final Pattern STREAM_CALL_GENERIC_PATTERN = Pattern.compile(
                "Node\\.stream\\s*\\(\\s*([^,\\)]+)\\s*,\\s*File\\.readStream\\s*\\(\\s*([^\\),]+)",
                Pattern.DOTALL
            );
            private static final Pattern EXCHANGE_STREAM_CALL_GENERIC_PATTERN = Pattern.compile(
                "Node\\.exchange\\s*\\(\\s*\\)\\s*\\.\\s*stream\\s*\\(\\s*([^,\\)]+)\\s*,\\s*File\\.readStream\\s*\\(\\s*([^\\),]+)",
                Pattern.DOTALL
            );
            private static final Pattern STREAM_VAR_ASSIGN_PATTERN = Pattern.compile(
                "(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:await\\s+)?File\\.readStream\\s*\\(\\s*([^\\),]+)",
                Pattern.DOTALL
            );
            private static final Pattern STRING_VAR_ASSIGN_PATTERN = Pattern.compile(
                "(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(['\"])(.*?)\\2",
                Pattern.DOTALL
            );
        private static final int DEFAULT_STREAM_CHUNK_SIZE = 64 * 1024;

    private static class MessageScript {
        File scriptFile;
        String scriptName;
        String scriptPath;
        String scriptId;
        String scriptState;
        String source;
        boolean enabled;
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
        String scriptId;
        boolean directAddress;
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

    public interface P2PSignalListener {
        void onSignal(String from, String sessionId, String signalType, JSONObject payload);
    }

    public static void setP2PSignalListener(P2PSignalListener listener) {
        p2pSignalListener = listener;
    }

    private static String normalizeP2PTarget(String rawTarget) {
        return String.valueOf(rawTarget == null ? "" : rawTarget).trim().toLowerCase(Locale.ROOT);
    }

    private static void cleanupExpiredP2PSessions() {
        long now = System.currentTimeMillis();
        for (Map.Entry<String, JSONObject> entry : p2pSessions.entrySet()) {
            JSONObject session = entry.getValue();
            long lastUpdateMs = session != null ? session.optLong("lastUpdateMs", 0L) : 0L;
            if (lastUpdateMs <= 0L || (now - lastUpdateMs) > DEFAULT_P2P_SESSION_TIMEOUT_MS) {
                p2pSessions.remove(entry.getKey());
            }
        }
    }

    private static JSONObject upsertP2PSession(String target, String sessionId, String state, String signalType, boolean usingRelay, String reason) {
        String safeTarget = normalizeP2PTarget(target);
        if (safeTarget.isEmpty()) {
            return null;
        }

        JSONObject existing = p2pSessions.get(safeTarget);
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

        JSObject p2p = new JSObject();
        p2p.put("enabled", "node".equals(currentExchangeMode));
        p2p.put("signalingViaExchange", true);
        p2p.put("connectedToExchange", isExchangeClientConnected());
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
                    "close".equals(safeSignalType) ? "idle" : "signaling",
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

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
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

        int requestedPort = readConfiguredPort(intent);
        currentPort = requestedPort;

        Notification notification = buildNotification(currentPort);
        startForeground(NOTIFICATION_ID, notification);

        try {
            if (!running || currentPort != readActivePort()) {
                startServer(currentPort);
            }
        } catch (Exception e) {
            stopServer();
            stopSelf();
            return START_NOT_STICKY;
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
    }

    private synchronized void stopServer() {
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
        List<MessageScript> listeners = collectMessageListeners();
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
        for (MessageScript script : listeners) {
            if (!matchesEventSender(script, senderCandidates, "NET_CHANGE")) {
                continue;
            }

            try {
                writeExecutionStart(script, "NET_CHANGE", "NET_CHANGE");
                executeScriptActions(script, bodyText, headers);
            } catch (Exception executionError) {
                writeExecutionError(script, "NET_CHANGE", "NET_CHANGE", executionError.getMessage());
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
                List<MessageScript> listeners = collectMessageListeners();
                JSONObject payload = new JSONObject();
                payload.put("ok", true);
                payload.put("service", "reactor");
                payload.put("status", "healthy");
                payload.put("timestamp", Instant.now().toString());
                payload.put("uptimeSec", Math.max(0L, (System.currentTimeMillis() - startedAtMs) / 1000L));
                payload.put("httpPort", currentPort);
                payload.put("scriptsCount", listeners.size());
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
                String targetScriptId = headers.getOrDefault("reactor-target-script-id", "").trim().toLowerCase(Locale.ROOT);
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

                List<MessageScript> listeners = collectMessageListeners();
                Set<String> senderCandidates = resolveSenderCandidates(senderName, senderId, remoteHost);
                JSONObject streamPayload = tryParseJsonObject(bodyText);
                boolean streamEnvelope = isStreamEnvelope(streamPayload);
                String streamPhase = streamEnvelope
                        ? streamPayload.optString("phase", "").trim().toLowerCase(Locale.ROOT)
                        : "";
                String primaryEvent = streamEnvelope ? "STREAM" : "MESSAGE";
                Map<String, String> effectiveHeaders = streamEnvelope
                        ? withStreamHeaders(headers, streamPayload, primaryEvent)
                        : new HashMap<>(headers);
                JSONArray deliveredScripts = new JSONArray();
                JSONArray streamEndScripts = new JSONArray();
                int deliveredCount = 0;
                int streamEndCount = 0;

                for (MessageScript script : listeners) {
                    if (!matchesEventSender(script, senderCandidates, primaryEvent)) {
                        continue;
                    }
                    if (!matchesTargetScript(script, targetScriptId)) {
                        continue;
                    }

                    try {
                        writeExecutionStart(script, primaryEvent, primaryEvent);
                        executeScriptActions(script, bodyText, effectiveHeaders);
                        deliveredScripts.put(script.scriptName);
                        deliveredCount += 1;
                    } catch (Exception executionError) {
                        writeExecutionError(script, primaryEvent, primaryEvent, executionError.getMessage());
                    }
                }

                if (streamEnvelope && "end".equals(streamPhase)) {
                    Map<String, String> streamEndHeaders = withStreamHeaders(headers, streamPayload, "STREAMEND");
                    for (MessageScript script : listeners) {
                        if (!matchesEventSender(script, senderCandidates, "STREAMEND")) {
                            continue;
                        }
                        if (!matchesTargetScript(script, targetScriptId)) {
                            continue;
                        }

                        try {
                            writeExecutionStart(script, "STREAMEND", "STREAMEND");
                            executeScriptActions(script, bodyText, streamEndHeaders);
                            streamEndScripts.put(script.scriptName);
                            streamEndCount += 1;
                        } catch (Exception executionError) {
                            writeExecutionError(script, "STREAMEND", "STREAMEND", executionError.getMessage());
                        }
                    }
                }

                JSONObject payload = new JSONObject();
                payload.put("ok", true);
                payload.put("trigger", primaryEvent);
                payload.put("delivered", deliveredCount > 0);
                payload.put("scripts", deliveredScripts);
                payload.put("deliveredCount", deliveredCount);
                payload.put("streamEndScripts", streamEndScripts);
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

    private List<MessageScript> collectMessageListeners() {
        List<MessageScript> listeners = new ArrayList<>();
        File projectsDir = new File(getFilesDir(), "projects");
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

            File scriptFile = resolveScriptFileFromProject(child);
            if (scriptFile == null || !scriptFile.exists()) {
                continue;
            }

            MessageScript script = parseMessageScript(scriptFile, child.getName());
            if (script == null || !script.enabled) {
                continue;
            }

            listeners.add(script);
        }

        return listeners;
    }

    private File resolveScriptFileFromProject(File projectDir) {
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

    private String readProjectScriptId(File projectDir) {
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

    private JSONArray parseScriptTriggersFromSource(String source) {
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
            List<String> tokens = splitDirectiveTokens(value);
            for (String token : tokens) {
                String normalized = String.valueOf(token).trim();
                if (normalized.isEmpty()) {
                    continue;
                }

                int open = normalized.indexOf('(');
                String trigger = (open >= 0 ? normalized.substring(0, open) : normalized)
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

    private JSONArray buildDiscoveryScriptsPayload() {
        JSONArray scripts = new JSONArray();
        File projectsDir = new File(getFilesDir(), "projects");
        if (!projectsDir.exists() || !projectsDir.isDirectory()) {
            return scripts;
        }

        File[] children = projectsDir.listFiles();
        if (children == null) {
            return scripts;
        }

        for (File child : children) {
            if (child == null || !child.isDirectory()) {
                continue;
            }

            File scriptFile = resolveScriptFileFromProject(child);
            if (scriptFile == null || !scriptFile.exists()) {
                continue;
            }

            try {
                String source = readTextFile(scriptFile);
                String scriptId = readProjectScriptId(child);
                if (scriptId == null || scriptId.trim().isEmpty()) {
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

                    if (line.startsWith("// @state")) {
                        enabled = line.toUpperCase(Locale.ROOT).contains("ENABLED");
                        continue;
                    }

                    if (line.startsWith("// @mutex")) {
                        mutex = line.toUpperCase(Locale.ROOT).contains("ON");
                    }
                }

                JSONObject script = new JSONObject();
                script.put("uuid", scriptId);
                script.put("name", child.getName());
                script.put("triggers", parseScriptTriggersFromSource(source));
                script.put("enabled", enabled);
                script.put("mutex", mutex);
                scripts.put(script);
            } catch (Exception ignored) {
                // Skip malformed script metadata entries.
            }
        }

        return scripts;
    }

    private ParsedTarget parseTarget(String rawTarget) {
        String trimmed = String.valueOf(rawTarget).trim();
        if (trimmed.isEmpty()) {
            return null;
        }

        ParsedTarget parsed = new ParsedTarget();
        parsed.originalTarget = trimmed;

        int slashIndex = trimmed.indexOf('/');
        if (slashIndex < 0) {
            parsed.baseTarget = trimmed;
            parsed.nodeName = trimmed.toLowerCase(Locale.ROOT);
            parsed.scriptId = null;
        } else {
            String baseTarget = trimmed.substring(0, slashIndex).trim();
            String scriptId = trimmed.substring(slashIndex + 1).trim().toLowerCase(Locale.ROOT);
            if (baseTarget.isEmpty() || !isUuidV4(scriptId)) {
                return null;
            }
            parsed.baseTarget = baseTarget;
            parsed.nodeName = baseTarget.toLowerCase(Locale.ROOT);
            parsed.scriptId = scriptId;
        }

        String loweredBase = String.valueOf(parsed.baseTarget).trim().toLowerCase(Locale.ROOT);
        parsed.directAddress = loweredBase.matches("^[^:]+:[0-9]{1,5}$")
                || loweredBase.matches("^\\d+\\.\\d+\\.\\d+\\.\\d+$")
                || loweredBase.contains(".");

        return parsed;
    }

    private MessageScript parseMessageScript(File scriptFile, String projectName) {
        try {
            String source = readTextFile(scriptFile);
            String[] lines = source.split("\\r?\\n", -1);

            String state = "DISABLED";
            boolean enabled = false;
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

            for (String rawLine : lines) {
                String line = rawLine.trim();
                if (!line.startsWith("// @")) {
                    continue;
                }

                if (line.startsWith("// @state")) {
                    boolean isEnabled = line.toUpperCase(Locale.ROOT).contains("ENABLED");
                    state = isEnabled ? "ENABLED" : "DISABLED";
                    enabled = isEnabled;
                    continue;
                }

                if (line.startsWith("// @on")) {
                    String value = line.replace("// @on", "").trim();
                    List<String> tokens = splitDirectiveTokens(value);
                    for (String token : tokens) {
                        String normalizedToken = token.trim();
                        String upperToken = normalizedToken.toUpperCase(Locale.ROOT);

                        if (upperToken.startsWith("STREAMEND")) {
                            hasStreamEndEvent = true;
                            int open = normalizedToken.indexOf('(');
                            int close = normalizedToken.lastIndexOf(')');
                            if (open < 0 || close <= open) {
                                streamEndFromAnySender = true;
                                continue;
                            }

                            String sendersRaw = normalizedToken.substring(open + 1, close).trim();
                            if (sendersRaw.isEmpty()) {
                                streamEndFromAnySender = true;
                                continue;
                            }

                            for (String senderCandidate : sendersRaw.split(",")) {
                                String normalizedSender = normalizeMessageSender(senderCandidate);
                                if (normalizedSender != null && !streamEndSenders.contains(normalizedSender)) {
                                    streamEndSenders.add(normalizedSender);
                                }
                            }
                            continue;
                        }

                        if (upperToken.startsWith("NET_CHANGE")) {
                            hasNetChangeEvent = true;
                            continue;
                        }

                        if (upperToken.startsWith("STREAM")) {
                            hasStreamEvent = true;
                            int open = normalizedToken.indexOf('(');
                            int close = normalizedToken.lastIndexOf(')');
                            if (open < 0 || close <= open) {
                                streamFromAnySender = true;
                                continue;
                            }

                            String sendersRaw = normalizedToken.substring(open + 1, close).trim();
                            if (sendersRaw.isEmpty()) {
                                streamFromAnySender = true;
                                continue;
                            }

                            for (String senderCandidate : sendersRaw.split(",")) {
                                String normalizedSender = normalizeMessageSender(senderCandidate);
                                if (normalizedSender != null && !streamSenders.contains(normalizedSender)) {
                                    streamSenders.add(normalizedSender);
                                }
                            }
                            continue;
                        }

                        if (!upperToken.startsWith("MESSAGE")) {
                            continue;
                        }

                        hasMessageEvent = true;
                        int open = normalizedToken.indexOf('(');
                        int close = normalizedToken.lastIndexOf(')');
                        if (open < 0 || close <= open) {
                            messageFromAnySender = true;
                            continue;
                        }

                        String sendersRaw = normalizedToken.substring(open + 1, close).trim();
                        if (sendersRaw.isEmpty()) {
                            messageFromAnySender = true;
                            continue;
                        }

                        for (String senderCandidate : sendersRaw.split(",")) {
                            String normalizedSender = normalizeMessageSender(senderCandidate);
                            if (normalizedSender != null && !messageSenders.contains(normalizedSender)) {
                                messageSenders.add(normalizedSender);
                            }
                        }
                    }
                }
            }

            if (!hasMessageEvent && !hasStreamEvent && !hasStreamEndEvent && !hasNetChangeEvent) {
                return null;
            }

            MessageScript script = new MessageScript();
            script.scriptFile = scriptFile;
            script.scriptName = projectName;
            script.scriptPath = scriptFile.getAbsolutePath();
            script.scriptId = readProjectScriptId(scriptFile.getParentFile());
            script.scriptState = state;
            script.source = source;
            script.enabled = enabled;
            script.hasMessageEvent = hasMessageEvent;
            script.messageFromAnySender = messageFromAnySender || messageSenders.isEmpty();
            script.messageSenders = messageSenders;
            script.hasStreamEvent = hasStreamEvent;
            script.streamFromAnySender = streamFromAnySender || streamSenders.isEmpty();
            script.streamSenders = streamSenders;
            script.hasStreamEndEvent = hasStreamEndEvent;
            script.streamEndFromAnySender = streamEndFromAnySender || streamEndSenders.isEmpty();
            script.streamEndSenders = streamEndSenders;
            script.hasNetChangeEvent = hasNetChangeEvent;
            return script;
        } catch (Exception ignored) {
            return null;
        }
    }

    private List<String> splitDirectiveTokens(String rawValue) {
        List<String> out = new ArrayList<>();
        StringBuilder token = new StringBuilder();
        int parenDepth = 0;
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

            if ((ch == ',' || Character.isWhitespace(ch)) && parenDepth == 0) {
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

    private String normalizeMessageSender(String rawSender) {
        String sender = String.valueOf(rawSender).trim().toLowerCase(Locale.ROOT);
        if (sender.isEmpty()) {
            return null;
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

        String normalizedSender = normalizeMessageSender(senderId);
        if (normalizedSender != null) {
            candidates.add(normalizedSender);
        }

        String normalizedRemoteHost = String.valueOf(remoteHost).trim().toLowerCase(Locale.ROOT);
        if (!normalizedRemoteHost.isEmpty()) {
            candidates.add(normalizedRemoteHost + ":" + DEFAULT_PORT);
        }

        return candidates;
    }

    private boolean matchesMessageSender(MessageScript script, Set<String> senderCandidates) {
        return matchesEventSender(script, senderCandidates, "MESSAGE");
    }

    private boolean matchesEventSender(MessageScript script, Set<String> senderCandidates, String eventName) {
        if (script == null) {
            return false;
        }

        String safeEvent = String.valueOf(eventName).trim().toUpperCase(Locale.ROOT);
        boolean fromAnySender;
        List<String> allowedSenders;

        if ("STREAM".equals(safeEvent)) {
            if (!script.hasStreamEvent) {
                return false;
            }
            fromAnySender = script.streamFromAnySender;
            allowedSenders = script.streamSenders;
        } else if ("STREAMEND".equals(safeEvent)) {
            if (!script.hasStreamEndEvent) {
                return false;
            }
            fromAnySender = script.streamEndFromAnySender;
            allowedSenders = script.streamEndSenders;
        } else if ("NET_CHANGE".equals(safeEvent)) {
            if (!script.hasNetChangeEvent) {
                return false;
            }
            fromAnySender = true;
            allowedSenders = new ArrayList<>();
        } else {
            if (!script.hasMessageEvent) {
                return false;
            }
            fromAnySender = script.messageFromAnySender;
            allowedSenders = script.messageSenders;
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

    private boolean matchesTargetScript(MessageScript script, String targetScriptId) {
        String safeTargetScriptId = String.valueOf(targetScriptId).trim().toLowerCase(Locale.ROOT);
        if (safeTargetScriptId.isEmpty()) {
            return true;
        }

        return safeTargetScriptId.equals(String.valueOf(script.scriptId).trim().toLowerCase(Locale.ROOT));
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

        String targetScriptId = headers.getOrDefault("reactor-target-script-id", "").trim().toLowerCase(Locale.ROOT);
        if (!targetScriptId.isEmpty()) {
            headers.put("reactor-target-script-id", targetScriptId);
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

    private void writeExecutionStart(MessageScript script, String trigger, String event) {
        try {
            JSONObject entry = new JSONObject();
            JSONObject scriptNode = new JSONObject();
            scriptNode.put("name", script.scriptName);
            scriptNode.put("path", script.scriptPath);
            scriptNode.put("state", script.scriptState);

            entry.put("timestamp", Instant.now().toString());
            entry.put("type", "SCRIPT_EXECUTION");
            entry.put("scope", "PROJECT");
            entry.put("phase", "START");
            entry.put("script", scriptNode);
            entry.put("trigger", trigger);
            entry.put("event", event);
            entry.put("expression", JSONObject.NULL);
            entry.put("watchPath", JSONObject.NULL);
            entry.put("watchType", JSONObject.NULL);
            entry.put("durationMs", JSONObject.NULL);
            entry.put("output", JSONObject.NULL);
            entry.put("error", JSONObject.NULL);
            appendProjectLog(script, entry.toString());

            JSONObject globalEntry = new JSONObject(entry.toString());
            globalEntry.put("scope", "GLOBAL");
            appendGlobalLog(globalEntry.toString());
        } catch (Exception ignored) {
            // Ignore JSON logging failures.
        }
    }

    private void writeExecutionError(MessageScript script, String trigger, String event, String errorMessage) {
        try {
            JSONObject entry = new JSONObject();
            JSONObject scriptNode = new JSONObject();
            scriptNode.put("name", script.scriptName);
            scriptNode.put("path", script.scriptPath);
            scriptNode.put("state", script.scriptState);

            entry.put("timestamp", Instant.now().toString());
            entry.put("type", "SCRIPT_EXECUTION");
            entry.put("scope", "PROJECT");
            entry.put("phase", "ERROR");
            entry.put("script", scriptNode);
            entry.put("trigger", trigger);
            entry.put("event", event);
            entry.put("expression", JSONObject.NULL);
            entry.put("watchPath", JSONObject.NULL);
            entry.put("watchType", JSONObject.NULL);
            entry.put("durationMs", JSONObject.NULL);
            entry.put("output", JSONObject.NULL);
            entry.put("error", String.valueOf(errorMessage));
            appendProjectLog(script, entry.toString());
        } catch (Exception ignored) {
            // Ignore JSON logging failures.
        }
    }

    private void appendProjectLog(MessageScript script, String line) {
        try {
            File projectLogFile = new File(script.scriptFile.getParentFile(), "activity.log");
            try (FileOutputStream stream = new FileOutputStream(projectLogFile, true)) {
                stream.write((line + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            // Ignore per-project logging failures.
        }
    }

    private void executeScriptActions(MessageScript script, String messageBody, Map<String, String> incomingHeaders) {
        Matcher directMatcher = SEND_MESSAGE_CALL_PATTERN.matcher(script.source);
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

            sendNodeMessage(target, content, extraHeaders);
        }

        Matcher exchangeMatcher = EXCHANGE_SEND_MESSAGE_CALL_PATTERN.matcher(script.source);
        while (exchangeMatcher.find()) {
            String target = exchangeMatcher.group(2) != null ? exchangeMatcher.group(2).trim() : "";
            String content = exchangeMatcher.group(4) != null ? exchangeMatcher.group(4) : "";
            if (target.isEmpty()) {
                continue;
            }

            sendExchangeMessage(target, content);
        }

        Map<String, String> stringVariables = extractStringVariables(script.source);
        Map<String, String> streamVariables = extractStreamVariables(script.source, stringVariables);
        Set<String> scheduledStreams = new HashSet<>();

        Matcher directStreamMatcher = STREAM_FILE_CALL_PATTERN.matcher(script.source);
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
                streamFileToNode(target, streamPath, new HashMap<>());
                scheduledStreams.add(dedupeKey);
            } catch (Exception error) {
                appendGlobalLog(buildExchangeLog("STREAM_DIRECT_ERROR", error.getMessage() != null ? error.getMessage() : "stream direct failed"));
            }
        }

        Matcher exchangeStreamMatcher = EXCHANGE_STREAM_FILE_CALL_PATTERN.matcher(script.source);
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

        Matcher genericDirectStreamMatcher = STREAM_CALL_GENERIC_PATTERN.matcher(script.source);
        while (genericDirectStreamMatcher.find()) {
            String targetToken = genericDirectStreamMatcher.group(1);
            String pathToken = genericDirectStreamMatcher.group(2);

            String target = resolveTokenValue(targetToken, stringVariables);
            String streamPath = resolveTokenValue(pathToken, stringVariables);
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
                streamFileToNode(target, streamPath, new HashMap<>());
                scheduledStreams.add(dedupeKey);
            } catch (Exception error) {
                appendGlobalLog(buildExchangeLog("STREAM_DIRECT_ERROR", error.getMessage() != null ? error.getMessage() : "stream direct failed"));
            }
        }

        Matcher genericExchangeStreamMatcher = EXCHANGE_STREAM_CALL_GENERIC_PATTERN.matcher(script.source);
        while (genericExchangeStreamMatcher.find()) {
            String targetToken = genericExchangeStreamMatcher.group(1);
            String pathToken = genericExchangeStreamMatcher.group(2);

            String target = resolveTokenValue(targetToken, stringVariables);
            String streamPath = resolveTokenValue(pathToken, stringVariables);
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
    }

    private Map<String, String> extractStringVariables(String source) {
        Map<String, String> vars = new HashMap<>();
        Matcher matcher = STRING_VAR_ASSIGN_PATTERN.matcher(String.valueOf(source));
        while (matcher.find()) {
            String name = matcher.group(1) != null ? matcher.group(1).trim() : "";
            String value = matcher.group(3) != null ? matcher.group(3) : "";
            if (!name.isEmpty()) {
                vars.put(name, value);
            }
        }
        return vars;
    }

    private Map<String, String> extractStreamVariables(String source, Map<String, String> stringVariables) {
        Map<String, String> vars = new HashMap<>();
        Matcher matcher = STREAM_VAR_ASSIGN_PATTERN.matcher(String.valueOf(source));
        while (matcher.find()) {
            String name = matcher.group(1) != null ? matcher.group(1).trim() : "";
            String pathToken = matcher.group(2);
            if (name.isEmpty()) {
                continue;
            }

            String resolvedPath = resolveTokenValue(pathToken, stringVariables);
            if (!resolvedPath.isEmpty()) {
                vars.put(name, resolvedPath);
            }
        }
        return vars;
    }

    private String resolveTokenValue(String rawToken, Map<String, String> stringVariables) {
        String token = String.valueOf(rawToken).trim();
        if (token.isEmpty()) {
            return "";
        }

        if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
            return token.substring(1, token.length() - 1);
        }

        String fromVars = stringVariables.get(token);
        return fromVars != null ? fromVars : "";
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

    private void streamFileToNode(String target, String filePath, Map<String, String> extraHeaders) {
        File file = resolveStreamFilePath(filePath);
        if (file == null || !file.exists() || !file.isFile()) {
            throw new RuntimeException("stream source file not found: " + filePath);
        }

        ParsedTarget parsedTarget = parseTarget(target);
        if (parsedTarget == null) {
            throw new RuntimeException("invalid target");
        }

        if (!parsedTarget.directAddress) {
            streamFileToExchange(target, filePath);
            return;
        }

        Map<String, String> effectiveHeaders = new HashMap<>();
        if (extraHeaders != null) {
            effectiveHeaders.putAll(extraHeaders);
        }
        if (parsedTarget.scriptId != null && !parsedTarget.scriptId.isEmpty()) {
            effectiveHeaders.put("Reactor-Target-Node", String.valueOf(parsedTarget.baseTarget).trim().toLowerCase(Locale.ROOT));
            effectiveHeaders.put("Reactor-Target-Script-Id", parsedTarget.scriptId);
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
        } catch (Exception error) {
            throw new RuntimeException(error.getMessage() != null ? error.getMessage() : "unable to build stream start packet");
        }
        sendNodeMessageWithContentType(parsedTarget.baseTarget, start.toString(), "application/json; charset=utf-8", effectiveHeaders);

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

                sendNodeMessageWithContentType(parsedTarget.baseTarget, packet.toString(), "application/json; charset=utf-8", effectiveHeaders);
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
        sendNodeMessageWithContentType(parsedTarget.baseTarget, end.toString(), "application/json; charset=utf-8", effectiveHeaders);
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
    }

    private String bytesToHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            builder.append(String.format(Locale.ROOT, "%02x", b));
        }
        return builder.toString();
    }

    private void sendNodeMessageWithContentType(String target, String content, String contentType, Map<String, String> extraHeaders) {
        String targetValue = String.valueOf(target).trim();
        if (targetValue.isEmpty()) {
            return;
        }

        List<String> normalizedTargets = buildTargetCandidates(targetValue);
        if (normalizedTargets.isEmpty()) {
            return;
        }

        String reactorName = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(PREF_REACTOR_NAME, "mobile-reactor");
        String senderId = String.valueOf(reactorName) + ":" + currentPort;

        RuntimeException lastError = null;
        for (String normalizedTarget : normalizedTargets) {
            try {
                sendDirectMessageNow(normalizedTarget, content, String.valueOf(contentType), reactorName, senderId, extraHeaders);
                return;
            } catch (Exception error) {
                lastError = new RuntimeException(error.getMessage());
            }
        }

        if (lastError != null) {
            try {
                sendExchangeMessageNow(targetValue.toLowerCase(Locale.ROOT), String.valueOf(content), String.valueOf(contentType));
                return;
            } catch (Exception ignored) {
                enqueueOutgoingMessage("direct", targetValue, String.valueOf(content), String.valueOf(contentType), extraHeaders);
                return;
            }
        }

        enqueueOutgoingMessage("direct", targetValue, String.valueOf(content), String.valueOf(contentType), extraHeaders);
    }

    private void sendNodeMessage(String target, String content, Map<String, String> extraHeaders) {
        String targetValue = String.valueOf(target).trim();
        if (targetValue.isEmpty()) {
            return;
        }

        List<String> normalizedTargets = buildTargetCandidates(targetValue);
        if (normalizedTargets.isEmpty()) {
            return;
        }

        String reactorName = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(PREF_REACTOR_NAME, "mobile-reactor");
        String senderId = String.valueOf(reactorName) + ":" + currentPort;

        RuntimeException lastError = null;
        for (String normalizedTarget : normalizedTargets) {
            try {
                sendDirectMessageNow(normalizedTarget, content, "text/plain; charset=utf-8", reactorName, senderId, extraHeaders);
                return;
            } catch (Exception error) {
                lastError = new RuntimeException(error.getMessage());
            }
        }

        if (lastError != null) {
            // Fallback via Exchange se siamo in modalità node/client.
            try {
                sendExchangeMessageNow(targetValue.toLowerCase(Locale.ROOT), String.valueOf(content), "text/plain");
                return;
            } catch (Exception ignored) {
                enqueueOutgoingMessage("direct", targetValue, String.valueOf(content), "text/plain", extraHeaders);
                return;
            }
        }

        enqueueOutgoingMessage("direct", targetValue, String.valueOf(content), "text/plain", extraHeaders);
    }

    private void sendExchangeMessage(String target, String content) {
        String normalizedTarget = String.valueOf(target).trim().toLowerCase(Locale.ROOT);
        if (normalizedTarget.isEmpty()) {
            return;
        }

        try {
            sendExchangeMessageNow(normalizedTarget, String.valueOf(content), "text/plain");
        } catch (Exception error) {
            enqueueOutgoingMessage("exchange", normalizedTarget, String.valueOf(content), "text/plain", new HashMap<>());
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

        ParsedTarget parsedTarget = parseTarget(target);
        if (parsedTarget == null || parsedTarget.baseTarget == null || parsedTarget.baseTarget.trim().isEmpty()) {
            throw new RuntimeException("invalid exchange target");
        }

        JSONObject packet = new JSONObject();
        try {
            packet.put("type", "message");
            packet.put("to", String.valueOf(parsedTarget.baseTarget).toLowerCase(Locale.ROOT));
            if (parsedTarget.scriptId != null && !parsedTarget.scriptId.isEmpty()) {
                packet.put("targetScriptId", parsedTarget.scriptId);
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

        ParsedTarget parsedTarget = parseTarget(target);
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
            if (parsedTarget.scriptId != null && !parsedTarget.scriptId.isEmpty()) {
                packet.put("targetScriptId", parsedTarget.scriptId);
            }
        } catch (JSONException exception) {
            throw new RuntimeException(exception.getMessage() != null ? exception.getMessage() : "signal packet serialization failed");
        }

        if (!wsExchangeClientSocket.send(packet.toString())) {
            throw new RuntimeException("exchange websocket send failed");
        }
    }

    // =========================================================================
    // EXCHANGE — configurazione e lifecycle
    // =========================================================================

    private void startExchange() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String mode = normalizeExchangeMode(prefs.getString(PREF_EXCHANGE_MODE, "node"));
        String host = prefs.getString(PREF_EXCHANGE_HOST, "");
        int port = prefs.getInt(PREF_EXCHANGE_PORT, DEFAULT_PORT);
        boolean tls = prefs.getBoolean(PREF_EXCHANGE_TLS, false);
        String token = readExchangeToken();
        if (token.isEmpty()) {
            token = prefs.getString(PREF_EXCHANGE_TOKEN, "");
        }

        currentExchangeMode = mode;
        currentExchangeHost = host;
        currentExchangePort = port;
        currentExchangeTls = tls;
        currentExchangeToken = token != null ? token : "";

        stopExchange();
        startOutgoingQueueFlusher();

        // In EXCHANGE mode the WS server is integrated into the HTTP server:
        // handleClient() detects upgrade requests and handles WS connections.
        if ("exchange".equals(mode)) {
            wsExchangeClients.clear();
            appendGlobalLog(buildExchangeLog("SERVER_START", "Exchange server active on HTTP port " + currentPort));
            flushOutgoingQueue();
        } else if ("node".equals(mode) && !host.isEmpty()) {
            startWsExchangeClient();
            flushOutgoingQueue();
        }
    }

    private void stopExchange() {
        stopOutgoingQueueFlusher();
        if ("exchange".equals(currentExchangeMode)) {
            wsExchangeClients.clear();
        }
        stopWsExchangeClient();
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
                                packet.optString("contentType", "text/plain"));
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
                wsExchangeClients.remove(clientName);
                appendGlobalLog(buildExchangeLog("CLIENT_DISCONNECTED", clientName));
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

    private void routeExchangeMessage(String to, String from, String content, String contentType) {
        WsConnection target = wsExchangeClients.get(to);
        if (target == null) {
            appendGlobalLog(buildExchangeLog("ROUTE_MISS", "target not connected: " + to));
            return;
        }
        try {
            JSONObject packet = new JSONObject();
            packet.put("type", "message");
            packet.put("from", from);
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
            outbound.put("targetScriptId", packet.optString("targetScriptId", ""));
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
        okHttpClient = buildExchangeWsClient(currentExchangeTls);
        wsClientRunning = true;

        wsClientThread = new Thread(() -> {
            while (wsClientRunning) {
                connectToExchangeServer();
                if (!wsClientRunning) break;
                try { Thread.sleep(5000); } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }, "reactor-ws-exchange-client");
        wsClientThread.setDaemon(true);
        wsClientThread.start();
    }

    private void stopWsExchangeClient() {
        wsClientRunning = false;
        WebSocket ws = wsExchangeClientSocket;
        if (ws != null) {
            ws.close(1000, "stopping");
            wsExchangeClientSocket = null;
        }
        if (wsClientThread != null) {
            wsClientThread.interrupt();
            wsClientThread = null;
        }
    }

    private void connectToExchangeServer() {
        final Object lock = new Object();
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

        okHttpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                wsExchangeClientSocket = webSocket;
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
                    packet.put("scripts", buildDiscoveryScriptsPayload());
                    packet.put("httpPort", currentPort);
                    packet.put("httpTls", false);
                    webSocket.send(packet.toString());
                } catch (Exception ignored) {
                    webSocket.send("{\"type\":\"register\",\"name\":\"mobile-reactor\",\"token\":\"\",\"scripts\":[],\"httpPort\":7070,\"httpTls\":false}");
                }
                appendGlobalLog(buildExchangeLog("CLIENT_CONNECTED", "connected to " + url + " as " + reactorName));
                flushOutgoingQueue();
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
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
                wsExchangeClientSocket = null;
                synchronized (wsClientPendingBinaryChunks) {
                    wsClientPendingBinaryChunks.clear();
                }
                appendGlobalLog(buildExchangeLog("CLIENT_DISCONNECTED", "disconnected from exchange"));
                synchronized (lock) { lock.notifyAll(); }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                wsExchangeClientSocket = null;
                synchronized (wsClientPendingBinaryChunks) {
                    wsClientPendingBinaryChunks.clear();
                }
                String detail = t.getMessage() != null ? t.getMessage() : "unknown error";
                if (response != null) {
                    detail += " (HTTP " + response.code() + ")";
                }
                appendGlobalLog(buildExchangeLog("CLIENT_FAILURE", detail));
                synchronized (lock) { lock.notifyAll(); }
            }
        });

        synchronized (lock) {
            try { lock.wait(); } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private OkHttpClient buildExchangeWsClient(boolean tls) {
        OkHttpClient.Builder builder = new OkHttpClient.Builder()
                .retryOnConnectionFailure(false)
                .pingInterval(WS_HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);

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
            if ("signal".equals(type)) {
                handleIncomingExchangeSignal(packet);
                return;
            }
            if (!"message".equals(type)) {
                return;
            }

            String from = packet.optString("from", "unknown");
            String content = packet.optString("content", "");
            String contentType = packet.optString("contentType", "text/plain");

            appendGlobalLog(buildExchangeLog("MESSAGE_RECEIVED", "message from " + from + " via exchange"));

            List<MessageScript> listeners = collectMessageListeners();
            Set<String> senderCandidates = new HashSet<>();
            senderCandidates.add(from.toLowerCase(Locale.ROOT));
            JSONObject streamPayload = tryParseJsonObject(content);
            boolean streamEnvelope = isStreamEnvelope(streamPayload);
            String streamPhase = streamEnvelope
                    ? streamPayload.optString("phase", "").trim().toLowerCase(Locale.ROOT)
                    : "";
            String primaryEvent = streamEnvelope ? "STREAM" : "MESSAGE";

            Map<String, String> headers = new HashMap<>();
            headers.put("content-type", contentType);
            headers.put("x-exchange-from", from);
            Map<String, String> effectiveHeaders = streamEnvelope
                    ? withStreamHeaders(headers, streamPayload, primaryEvent)
                    : headers;

            for (MessageScript script : listeners) {
                if (!matchesEventSender(script, senderCandidates, primaryEvent)) continue;
                try {
                    writeExecutionStart(script, primaryEvent, primaryEvent);
                    executeScriptActions(script, content, effectiveHeaders);
                } catch (Exception e) {
                    writeExecutionError(script, primaryEvent, primaryEvent, e.getMessage());
                }
            }

            if (streamEnvelope && "end".equals(streamPhase)) {
                Map<String, String> streamEndHeaders = withStreamHeaders(headers, streamPayload, "STREAMEND");
                for (MessageScript script : listeners) {
                    if (!matchesEventSender(script, senderCandidates, "STREAMEND")) continue;
                    try {
                        writeExecutionStart(script, "STREAMEND", "STREAMEND");
                        executeScriptActions(script, content, streamEndHeaders);
                    } catch (Exception e) {
                        writeExecutionError(script, "STREAMEND", "STREAMEND", e.getMessage());
                    }
                }
            }
        } catch (Exception ignored) {}
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

        JSONObject payload = packet.optJSONObject("payload");
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

        P2PSignalListener listener = p2pSignalListener;
        if (listener != null) {
            try {
                listener.onSignal(
                        from,
                        packet.optString("sessionId", ""),
                        signalType,
                        payload
                );
            } catch (Exception ignored) {
                // Listener failures should not break signaling updates.
            }
        }

        appendGlobalLog(buildExchangeLog("SIGNAL_RECEIVED", signalType + " from " + from));
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

    private void appendGlobalLog(String line) {
        try {
            File logFile = new File(getFilesDir(), "activity.log");
            File parent = logFile.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            try (FileOutputStream stream = new FileOutputStream(logFile, true)) {
                stream.write((line + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            // Logging should never crash the service.
        }
    }

    private Notification buildNotification(int port) {
        String title = "Reactor HTTP server";
        String text = "Listening on port " + port;

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
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
}
