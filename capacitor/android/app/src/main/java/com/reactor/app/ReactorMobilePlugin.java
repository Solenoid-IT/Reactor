package com.reactor.app;

import android.app.Activity;
import android.Manifest;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationManagerCompat;

import android.util.Base64;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.BufferedOutputStream;
import java.io.BufferedInputStream;
import java.time.Instant;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.stream.Stream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import java.util.Map;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.net.HttpURLConnection;
import java.net.UnknownHostException;
import java.net.URLEncoder;
import java.util.LinkedHashSet;
import java.util.Set;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "ReactorMobile",
    permissions = {
        @Permission(alias = "location", strings = {
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION,
        }),
    }
)
public class ReactorMobilePlugin extends Plugin {

    private static final int DEFAULT_HTTP_PORT = 7070;
    private static final String TAG = "ReactorMobilePlugin";
    private static final String WORKING_MODE_FILE = "working-mode.json";
    private static final String REACTOR_NAME_FILE = "name";
    private static final String ENV_DIR = "envs";
    private static final String ENDPOINT_TEMPLATES_DIR = "templates";
    private static final String ENDPOINT_TEMPLATE_ASSETS_DIR = "public/templates";
    private static final Set<String> ALLOWED_ENDPOINT_TEMPLATE_KEYS = new LinkedHashSet<>(Arrays.asList("blank", "schedule", "event", "watch"));
    private static final int STUN_MAGIC_COOKIE = 0x2112A442;
    private static final int STUN_HEADER_LENGTH = 20;
    private static final int STUN_ATTR_USERNAME = 0x0006;
    private static final int STUN_ATTR_MESSAGE_INTEGRITY = 0x0008;
    private static final int STUN_ATTR_ERROR_CODE = 0x0009;
    private static final int STUN_ATTR_REALM = 0x0014;
    private static final int STUN_ATTR_NONCE = 0x0015;
    private static final int TURN_ATTR_REQUESTED_TRANSPORT = 0x0019;
    private static final int TURN_ALLOCATE_REQUEST = 0x0003;
    private static final int TURN_ALLOCATE_SUCCESS_RESPONSE = 0x0103;
    private static final int TURN_RELAY_TEST_TIMEOUT_MS = 12000;
    private static final int P2P_REMOTE_ENDPOINTS_TIMEOUT_MS = 12000;
    private static final String ENV_TURN_TEST_TIMEOUT_MS = "REACTOR_TURN_TEST_TIMEOUT_MS";
    private static final String ENV_P2P_REMOTE_ENDPOINTS_TIMEOUT_MS = "REACTOR_P2P_ENDPOINTS_TIMEOUT_MS";
    private File pendingBackupExportFile = null;
    private AndroidP2PWebRtcManager nativeP2PManager;

    private static final class TurnRequest {
        final byte[] transactionId;
        final byte[] message;

        TurnRequest(byte[] transactionId, byte[] message) {
            this.transactionId = transactionId;
            this.message = message;
        }
    }

    private static final class TurnMessage {
        final int type;
        final byte[] transactionId;
        final Map<Integer, byte[]> attributes;

        TurnMessage(int type, byte[] transactionId, Map<Integer, byte[]> attributes) {
            this.type = type;
            this.transactionId = transactionId;
            this.attributes = attributes;
        }
    }

    @Override
    public void load() {
        super.load();
        try {
            JSObject startupEnv = readEnvConfig();
            Log.d(TAG, "ENV_PLUGIN_LOAD path=" + getEnvDir().getAbsolutePath() + " envCount=" + startupEnv.length());
        } catch (Exception error) {
            Log.e(TAG, "ENV_PLUGIN_LOAD_ERROR: " + error.getMessage(), error);
        }
        nativeP2PManager = AndroidP2PWebRtcManager.getInstance(getContext());
        nativeP2PManager.initialize();
        ReactorHttpService.setP2PStatusListener((p2pStatus) -> {
            JSObject payload = new JSObject();
            payload.put("ok", true);
            payload.put("p2p", p2pStatus != null ? p2pStatus : new JSObject());
            notifyListeners("p2pStatus", payload);
        });
        ReactorHttpService.setExchangeConnectionStatusListener(() -> emitExchangeStatusToUi("exchange-status-changed"));
        ensureEndpointTemplatesPresent();
        ensureHttpServerRunning();
        emitExchangeStatusToUi("plugin-load");
    }

    @Override
    protected void handleOnDestroy() {
        ReactorHttpService.setP2PStatusListener(null);
        ReactorHttpService.setExchangeConnectionStatusListener(null);
        super.handleOnDestroy();
    }

    private void emitExchangeStatusToUi(String reason) {
        try {
            JSObject workingMode = readWorkingModeConfig();
            String host = workingMode.getString("host", "");
            JSObject connection = buildExchangeConnectionStatus(ReactorHttpService.getCurrentExchangeMode(), host);

            JSObject payload = new JSObject();
            payload.put("ok", true);
            payload.put("reason", String.valueOf(reason == null ? "" : reason));
            payload.put("connection", connection);
            payload.put("active", Boolean.TRUE.equals(connection.getBool("connected")));
            notifyListeners("exchangeStatus", payload);
        } catch (Exception ignored) {
            // Best-effort UI status update.
        }
    }

    private SharedPreferences getPrefs() {
        return getContext().getSharedPreferences(ReactorHttpService.PREFS_NAME, Context.MODE_PRIVATE);
    }

    private int getConfiguredHttpPort() {
        int configured = getPrefs().getInt(ReactorHttpService.PREF_HTTP_PORT, DEFAULT_HTTP_PORT);
        if (configured < 1 || configured > 65535) {
            return DEFAULT_HTTP_PORT;
        }
        return configured;
    }

    private void notifyExchangeProfileUpdated(String reason) {
        try {
            ReactorHttpService.refreshExchangeClientProfile(reason);
        } catch (Exception ignored) {
            // Best-effort profile refresh.
        }
    }

    private void setConfiguredHttpPort(int port) {
        getPrefs().edit().putInt(ReactorHttpService.PREF_HTTP_PORT, port).apply();
    }

    private String getConfiguredReactorName() {
        String fromFile = readConfiguredReactorNameFile();
        if (!fromFile.isEmpty()) {
            return fromFile;
        }
        return String.valueOf(getPrefs().getString(ReactorHttpService.PREF_REACTOR_NAME, "mobile-reactor"));
    }

    private void setConfiguredReactorName(String name) {
        getPrefs().edit().putString(ReactorHttpService.PREF_REACTOR_NAME, name).commit();
        try {
            writeTextFile(getReactorNameFile(), name + "\n");
        } catch (Exception ignored) {
            // Keep prefs as fallback even if file write fails.
        }
    }

    private void startHttpService(int port) {
        try {
            Intent intent = new Intent(getContext(), ReactorHttpService.class);
            intent.setAction(ReactorHttpService.ACTION_START);
            intent.putExtra(ReactorHttpService.EXTRA_PORT, port);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
        } catch (Exception error) {
            Log.e(TAG, "Unable to start ReactorHttpService", error);
        }
    }

    private void stopHttpService() {
        Intent intent = new Intent(getContext(), ReactorHttpService.class);
        intent.setAction(ReactorHttpService.ACTION_STOP);
        getContext().startService(intent);
    }

    private void ensureHttpServerRunning() {
        if (!ReactorHttpService.isRunning()) {
            startHttpService(getConfiguredHttpPort());
        }
    }

    private File getWorkingModeFile() {
        return new File(getContext().getFilesDir(), WORKING_MODE_FILE);
    }

    private File getReactorNameFile() {
        return new File(getContext().getFilesDir(), REACTOR_NAME_FILE);
    }

    private File getEnvDir() {
        File envDir = new File(getContext().getFilesDir(), ENV_DIR);
        if (!envDir.exists()) {
            envDir.mkdirs();
        }
        return envDir;
    }

    @PluginMethod
    public void getHomeDirectory(PluginCall call) {
        try {
            File filesDir = getContext().getFilesDir();
            String path = filesDir != null ? filesDir.getAbsolutePath() : "";
            call.resolve(new JSObject()
                    .put("ok", true)
                    .put("path", path));
        } catch (Exception e) {
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("error", e.getMessage())
                    .put("path", ""));
        }
    }

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("version", BuildConfig.REACTOR_APP_VERSION);
        result.put("packageName", getContext().getPackageName());
        call.resolve(result);
    }

    private String readConfiguredReactorNameFile() {
        try {
            File file = getReactorNameFile();
            if (!file.exists()) {
                return "";
            }
            return readTextFile(file).trim();
        } catch (Exception ignored) {
            return "";
        }
    }

    private JSObject getDefaultWorkingModeConfig() {
        JSObject config = new JSObject();
        config.put("mode", "node");
        config.put("host", "");
        config.put("port", ReactorHttpService.DEFAULT_PORT);
        config.put("tls", false);
        config.put("token", "");
        config.put("discovery", false);
        config.put("stun", new JSObject().put("host", "").put("port", 3478).put("tls", false).put("username", "").put("password", ""));
        config.put("turn", new JSObject().put("host", "").put("port", 3478).put("tls", false).put("username", "").put("password", ""));
        return config;
    }

    private JSObject normalizeRelayConfig(JSObject source, int defaultPort, boolean allowTls) {
        JSObject input = source != null ? source : new JSObject();
        String host = sanitizeNetworkHost(String.valueOf(input.optString("host", "")));

        int port = defaultPort;
        try {
            int raw = input.optInt("port", defaultPort);
            if (raw >= 1 && raw <= 65535) {
                port = raw;
            }
        } catch (Exception ignored) {
            port = defaultPort;
        }

        boolean tls = allowTls && input.optBoolean("tls", false);
        String username = String.valueOf(input.optString("username", input.optString("user", ""))).trim();
        String password = String.valueOf(input.optString("password", "")).trim();
        return new JSObject().put("host", host).put("port", port).put("tls", tls).put("username", username).put("password", password);
    }

    private String sanitizeNetworkHost(String rawHost) {
        String value = String.valueOf(rawHost == null ? "" : rawHost).trim();
        if (value.isEmpty()) {
            return "";
        }

        value = value.replaceFirst("^(stun|stuns|turn|turns|ws|wss|http|https):", "");
        if (value.startsWith("//")) {
            value = value.substring(2);
        }

        int slashIndex = value.indexOf('/');
        if (slashIndex >= 0) {
            value = value.substring(0, slashIndex).trim();
        }

        if (value.startsWith("[") && value.contains("]")) {
            value = value.substring(1, value.indexOf(']')).trim();
        }

        int colonCount = 0;
        for (int i = 0; i < value.length(); i += 1) {
            if (value.charAt(i) == ':') {
                colonCount += 1;
            }
        }

        if (colonCount == 1) {
            int colonIndex = value.lastIndexOf(':');
            if (colonIndex > 0 && colonIndex < value.length() - 1) {
                String maybeHost = value.substring(0, colonIndex).trim();
                String maybePort = value.substring(colonIndex + 1).trim();
                if (maybePort.matches("\\d+")) {
                    value = maybeHost;
                }
            }
        }

        while (value.endsWith(".")) {
            value = value.substring(0, value.length() - 1).trim();
        }

        return value;
    }

    private List<InetAddress> resolveHostAddresses(String rawHost) {
        String host = sanitizeNetworkHost(rawHost);
        List<InetAddress> resolved = new ArrayList<>();
        if (host.isEmpty()) {
            return resolved;
        }

        try {
            InetAddress[] nativeResolved = InetAddress.getAllByName(host);
            if (nativeResolved != null) {
                for (InetAddress address : nativeResolved) {
                    if (address != null) {
                        resolved.add(address);
                    }
                }
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

        Set<String> ipCandidates = new LinkedHashSet<>();
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

                for (int i = 0; i < answers.length(); i += 1) {
                    JSONObject answer = answers.optJSONObject(i);
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
                // Skip invalid IP candidates.
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

    private JSObject normalizeRelayConfigFromJson(JSONObject source, String key, int defaultPort, boolean allowTls) {
        if (source == null) {
            return normalizeRelayConfig(null, defaultPort, allowTls);
        }

        JSONObject relay = source.optJSONObject(key);
        if (relay == null) {
            return normalizeRelayConfig(null, defaultPort, allowTls);
        }

        JSObject input = new JSObject();
        input.put("host", relay.optString("host", ""));
        input.put("port", relay.optInt("port", defaultPort));
        input.put("tls", relay.optBoolean("tls", false));
        input.put("username", relay.optString("username", relay.optString("user", "")));
        input.put("password", relay.optString("password", ""));
        return normalizeRelayConfig(input, defaultPort, allowTls);
    }

    private String sanitizeWorkingMode(String rawMode) {
        String mode = String.valueOf(rawMode == null ? "" : rawMode).trim().toLowerCase();
        if ("exchange".equals(mode)) {
            return "exchange";
        }
        return "node";
    }

    private JSObject readWorkingModeConfig() {
        try {
            File file = getWorkingModeFile();
            if (!file.exists()) {
                return getDefaultWorkingModeConfig();
            }

            String raw = readTextFile(file).trim();
            if (raw.isEmpty()) {
                return getDefaultWorkingModeConfig();
            }

            JSONObject parsed = new JSONObject(raw);
            JSObject config = getDefaultWorkingModeConfig();
            config.put("mode", sanitizeWorkingMode(parsed.optString("mode", "node")));
            config.put("host", String.valueOf(parsed.optString("host", "")));
            config.put("port", parsed.optInt("port", ReactorHttpService.DEFAULT_PORT));
            config.put("tls", parsed.optBoolean("tls", false));
            config.put("token", String.valueOf(parsed.optString("token", "")));
            config.put("discovery", parsed.optBoolean("discovery", false));
            config.put("stun", normalizeRelayConfigFromJson(parsed, "stun", 3478, false));
            config.put("turn", normalizeRelayConfigFromJson(parsed, "turn", 3478, true));
            return config;
        } catch (Exception ignored) {
            return getDefaultWorkingModeConfig();
        }
    }

    private JSObject writeWorkingModeConfig(String mode, String host, int port, boolean tls, String token, boolean discovery, JSObject stun, JSObject turn) throws IOException {
        JSObject config = new JSObject();
        config.put("mode", mode);
        config.put("host", host != null ? host : "");
        config.put("port", port);
        config.put("tls", tls);
        config.put("token", token != null ? token : "");
        config.put("discovery", discovery);
        config.put("stun", normalizeRelayConfig(stun, 3478, false));
        config.put("turn", normalizeRelayConfig(turn, 3478, true));
        writeTextFile(getWorkingModeFile(), config.toString() + "\n");
        return config;
    }

    private JSObject writeWorkingModeConfig(String mode, String host, int port, boolean tls, String token, boolean discovery) throws IOException {
        JSObject current = readWorkingModeConfig();
        JSONObject stunRaw = current.optJSONObject("stun");
        JSONObject turnRaw = current.optJSONObject("turn");
        JSObject stunSource = new JSObject();
        if (stunRaw != null) {
            stunSource.put("host", stunRaw.optString("host", ""));
            stunSource.put("port", stunRaw.optInt("port", 3478));
            stunSource.put("tls", stunRaw.optBoolean("tls", false));
            stunSource.put("username", stunRaw.optString("username", stunRaw.optString("user", "")));
            stunSource.put("password", stunRaw.optString("password", ""));
        }

        JSObject turnSource = new JSObject();
        if (turnRaw != null) {
            turnSource.put("host", turnRaw.optString("host", ""));
            turnSource.put("port", turnRaw.optInt("port", 3478));
            turnSource.put("tls", turnRaw.optBoolean("tls", false));
            turnSource.put("username", turnRaw.optString("username", turnRaw.optString("user", "")));
            turnSource.put("password", turnRaw.optString("password", ""));
        }

        JSObject stun = normalizeRelayConfig(
            stunSource,
            3478,
            false
        );
        JSObject turn = normalizeRelayConfig(
            turnSource,
            3478,
            true
        );
        return writeWorkingModeConfig(mode, host, port, tls, token, discovery, stun, turn);
    }

    private JSObject testUdpRelay(String host, int port, String label) {
        String safeHost = sanitizeNetworkHost(host);
        if (safeHost.isEmpty()) {
            return new JSObject().put("ok", false).put("error", label + " host is empty");
        }

        long startedAt = System.currentTimeMillis();
        DatagramSocket socket = null;
        try {
            byte[] txId = new byte[12];
            new SecureRandom().nextBytes(txId);

            byte[] request = new byte[20];
            request[0] = 0x00;
            request[1] = 0x01;
            request[2] = 0x00;
            request[3] = 0x00;
            request[4] = 0x21;
            request[5] = 0x12;
            request[6] = (byte) 0xA4;
            request[7] = 0x42;
            System.arraycopy(txId, 0, request, 8, txId.length);

            List<InetAddress> addresses = resolveHostAddresses(safeHost);
            if (addresses.isEmpty()) {
                return new JSObject().put("ok", false).put("error", "Unable to resolve host \"" + safeHost + "\"");
            }

            String lastError = "";
            for (InetAddress address : addresses) {
                try {
                    socket = new DatagramSocket();
                    socket.setSoTimeout(2500);
                    socket.connect(address, port);

                    DatagramPacket out = new DatagramPacket(request, request.length, address, port);
                    socket.send(out);

                    byte[] response = new byte[1024];
                    DatagramPacket in = new DatagramPacket(response, response.length);
                    socket.receive(in);

                    if (in.getLength() < 20) {
                        lastError = label + " response too short";
                    } else {
                        return new JSObject()
                                .put("ok", true)
                                .put("protocol", "udp")
                                .put("elapsedMs", Math.max(0L, System.currentTimeMillis() - startedAt));
                    }
                } catch (Exception probeError) {
                    lastError = probeError.getMessage() != null ? probeError.getMessage() : (label + " udp test failed");
                } finally {
                    if (socket != null) {
                        socket.close();
                        socket = null;
                    }
                }
            }

            return new JSObject().put("ok", false).put("error", lastError.isEmpty() ? (label + " udp test failed") : lastError);
        } catch (Exception error) {
            return new JSObject().put("ok", false).put("error", error.getMessage() != null ? error.getMessage() : (label + " udp test failed"));
        } finally {
            if (socket != null) {
                socket.close();
            }
        }
    }

    private JSObject testTcpRelay(String host, int port, String label) {
        String safeHost = sanitizeNetworkHost(host);
        if (safeHost.isEmpty()) {
            return buildRelayTestFailure(label + " host is empty", "configuration");
        }

        long startedAt = System.currentTimeMillis();
        List<InetAddress> addresses = resolveHostAddresses(safeHost);
        if (addresses.isEmpty()) {
            return buildRelayTestFailure("Unable to resolve host \"" + safeHost + "\"", "connection");
        }

        String lastError = "";
        for (InetAddress address : addresses) {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(address, port), 2500);
                return new JSObject()
                        .put("ok", true)
                        .put("protocol", "tcp")
                        .put("elapsedMs", Math.max(0L, System.currentTimeMillis() - startedAt));
            } catch (Exception error) {
                lastError = error.getMessage() != null ? error.getMessage() : (label + " tcp test failed");
            }
        }

        return buildRelayTestFailure(lastError.isEmpty() ? (label + " tcp test failed") : lastError, "connection");
    }

    private JSObject buildRelayTestFailure(String error, String errorType) {
        return new JSObject()
                .put("ok", false)
                .put("error", error != null ? error : "relay test failed")
                .put("errorType", errorType != null ? errorType : "connection");
    }

    private String classifyExchangeFailureType(String reason, int closeCode) {
        String safeReason = String.valueOf(reason == null ? "" : reason).trim().toLowerCase(Locale.ROOT);
        if (closeCode == 4001) {
            return "authentication";
        }
        if (safeReason.contains("invalid exchange token")
                || safeReason.contains("auth error")
                || safeReason.contains("unauthorized")
                || safeReason.contains("http 401")
                || safeReason.contains("bearer token")) {
            return "authentication";
        }
        return "connection";
    }

    private byte[] buildStunHeader(int messageType, int bodyLength, byte[] transactionId) {
        byte[] header = new byte[STUN_HEADER_LENGTH];
        header[0] = (byte) ((messageType >> 8) & 0xff);
        header[1] = (byte) (messageType & 0xff);
        header[2] = (byte) ((bodyLength >> 8) & 0xff);
        header[3] = (byte) (bodyLength & 0xff);
        header[4] = 0x21;
        header[5] = 0x12;
        header[6] = (byte) 0xA4;
        header[7] = 0x42;
        System.arraycopy(transactionId, 0, header, 8, Math.min(12, transactionId.length));
        return header;
    }

    private byte[] encodeStunAttribute(int type, byte[] value) {
        byte[] safeValue = value != null ? value : new byte[0];
        int padding = (4 - (safeValue.length % 4)) % 4;
        byte[] attribute = new byte[4 + safeValue.length + padding];
        attribute[0] = (byte) ((type >> 8) & 0xff);
        attribute[1] = (byte) (type & 0xff);
        attribute[2] = (byte) ((safeValue.length >> 8) & 0xff);
        attribute[3] = (byte) (safeValue.length & 0xff);
        System.arraycopy(safeValue, 0, attribute, 4, safeValue.length);
        return attribute;
    }

    private TurnMessage parseTurnMessage(byte[] data, int length) {
        if (data == null || length < STUN_HEADER_LENGTH) {
            return null;
        }

        int bodyLength = ((data[2] & 0xff) << 8) | (data[3] & 0xff);
        int totalLength = STUN_HEADER_LENGTH + bodyLength;
        if (length < totalLength) {
            return null;
        }
        int magicCookie = ((data[4] & 0xff) << 24) | ((data[5] & 0xff) << 16) | ((data[6] & 0xff) << 8) | (data[7] & 0xff);
        if (magicCookie != STUN_MAGIC_COOKIE) {
            return null;
        }

        Map<Integer, byte[]> attributes = new HashMap<>();
        int offset = STUN_HEADER_LENGTH;
        while (offset + 4 <= totalLength) {
            int type = ((data[offset] & 0xff) << 8) | (data[offset + 1] & 0xff);
            int attrLength = ((data[offset + 2] & 0xff) << 8) | (data[offset + 3] & 0xff);
            int valueStart = offset + 4;
            int valueEnd = valueStart + attrLength;
            if (valueEnd > totalLength) {
                return null;
            }
            byte[] value = Arrays.copyOfRange(data, valueStart, valueEnd);
            attributes.put(type, value);
            offset = valueEnd + ((4 - (attrLength % 4)) % 4);
        }

        int type = ((data[0] & 0xff) << 8) | (data[1] & 0xff);
        byte[] transactionId = Arrays.copyOfRange(data, 8, 20);
        return new TurnMessage(type, transactionId, attributes);
    }

    private String getTurnTextAttribute(TurnMessage message, int attributeType) {
        if (message == null || message.attributes == null) {
            return "";
        }

        byte[] raw = message.attributes.get(attributeType);
        if (raw == null || raw.length == 0) {
            return "";
        }
        return new String(raw, StandardCharsets.UTF_8).trim();
    }

    private JSObject getTurnErrorDetails(TurnMessage message) {
        if (message == null || message.attributes == null) {
            return null;
        }

        byte[] raw = message.attributes.get(STUN_ATTR_ERROR_CODE);
        if (raw == null || raw.length < 4) {
            return null;
        }

        int errorClass = raw[2] & 0x07;
        int errorNumber = raw[3] & 0xff;
        int code = (errorClass * 100) + errorNumber;
        String reason = raw.length > 4 ? new String(Arrays.copyOfRange(raw, 4, raw.length), StandardCharsets.UTF_8).trim() : "";
        return new JSObject().put("code", code).put("reason", reason);
    }

    private String describeTurnResponseFailure(TurnMessage message, String fallback) {
        JSObject error = getTurnErrorDetails(message);
        if (error == null) {
            return fallback;
        }
        int code = error.optInt("code", 0);
        String reason = error.optString("reason", "").trim();
        return reason.isEmpty() ? ("TURN error " + code) : (code + " " + reason);
    }

    private TurnRequest buildTurnAllocateRequest(String username, String realm, String nonce, String password) throws Exception {
        byte[] transactionId = new byte[12];
        new SecureRandom().nextBytes(transactionId);
        byte[] requestedTransport = encodeStunAttribute(TURN_ATTR_REQUESTED_TRANSPORT, new byte[] { 17, 0, 0, 0 });

        if (username == null || username.trim().isEmpty() || realm == null || realm.trim().isEmpty() || nonce == null || nonce.trim().isEmpty() || password == null || password.trim().isEmpty()) {
            byte[] header = buildStunHeader(TURN_ALLOCATE_REQUEST, requestedTransport.length, transactionId);
            byte[] message = new byte[header.length + requestedTransport.length];
            System.arraycopy(header, 0, message, 0, header.length);
            System.arraycopy(requestedTransport, 0, message, header.length, requestedTransport.length);
            return new TurnRequest(transactionId, message);
        }

        byte[] usernameAttr = encodeStunAttribute(STUN_ATTR_USERNAME, username.trim().getBytes(StandardCharsets.UTF_8));
        byte[] realmAttr = encodeStunAttribute(STUN_ATTR_REALM, realm.trim().getBytes(StandardCharsets.UTF_8));
        byte[] nonceAttr = encodeStunAttribute(STUN_ATTR_NONCE, nonce.trim().getBytes(StandardCharsets.UTF_8));
        int authBodyLength = requestedTransport.length + usernameAttr.length + realmAttr.length + nonceAttr.length;
        byte[] authBody = new byte[authBodyLength];
        int offset = 0;
        System.arraycopy(requestedTransport, 0, authBody, offset, requestedTransport.length);
        offset += requestedTransport.length;
        System.arraycopy(usernameAttr, 0, authBody, offset, usernameAttr.length);
        offset += usernameAttr.length;
        System.arraycopy(realmAttr, 0, authBody, offset, realmAttr.length);
        offset += realmAttr.length;
        System.arraycopy(nonceAttr, 0, authBody, offset, nonceAttr.length);

        byte[] headerForIntegrity = buildStunHeader(TURN_ALLOCATE_REQUEST, authBody.length + 24, transactionId);
        byte[] key = MessageDigest.getInstance("MD5").digest((username.trim() + ":" + realm.trim() + ":" + password.trim()).getBytes(StandardCharsets.UTF_8));
        Mac mac = Mac.getInstance("HmacSHA1");
        mac.init(new SecretKeySpec(key, "HmacSHA1"));
        mac.update(headerForIntegrity);
        mac.update(authBody);
        byte[] integrity = mac.doFinal();
        byte[] integrityAttr = encodeStunAttribute(STUN_ATTR_MESSAGE_INTEGRITY, integrity);

        byte[] body = new byte[authBody.length + integrityAttr.length];
        System.arraycopy(authBody, 0, body, 0, authBody.length);
        System.arraycopy(integrityAttr, 0, body, authBody.length, integrityAttr.length);
        byte[] header = buildStunHeader(TURN_ALLOCATE_REQUEST, body.length, transactionId);
        byte[] message = new byte[header.length + body.length];
        System.arraycopy(header, 0, message, 0, header.length);
        System.arraycopy(body, 0, message, header.length, body.length);
        return new TurnRequest(transactionId, message);
    }

    private JSObject testTurnAllocateUdp(InetAddress address, int port, TurnRequest request, int timeoutMs) {
        DatagramSocket socket = null;
        try {
            socket = new DatagramSocket();
            int safeTimeoutMs = timeoutMs > 0 ? timeoutMs : TURN_RELAY_TEST_TIMEOUT_MS;
            socket.setSoTimeout(safeTimeoutMs);
            socket.connect(address, port);
            socket.send(new DatagramPacket(request.message, request.message.length, address, port));
            byte[] response = new byte[2048];
            DatagramPacket packet = new DatagramPacket(response, response.length);
            socket.receive(packet);
            TurnMessage parsed = parseTurnMessage(packet.getData(), packet.getLength());
            if (parsed == null || !Arrays.equals(parsed.transactionId, request.transactionId)) {
                return buildRelayTestFailure("TURN UDP response invalid", "protocol");
            }
            return new JSObject().put("ok", true).put("protocol", "udp-auth").put("messageType", parsed.type).put("message", parsed);
        } catch (Exception error) {
            return buildRelayTestFailure(error.getMessage() != null ? error.getMessage() : "TURN UDP request failed", "connection");
        } finally {
            if (socket != null) {
                socket.close();
            }
        }
    }

    private JSObject testTurnAllocateTls(String host, InetAddress address, int port, TurnRequest request, int timeoutMs) {
        SSLSocket socket = null;
        try {
            int safeTimeoutMs = timeoutMs > 0 ? timeoutMs : TURN_RELAY_TEST_TIMEOUT_MS;
            socket = createStrictTlsSocket(host, address, port, safeTimeoutMs);

            socket.getOutputStream().write(request.message);
            socket.getOutputStream().flush();

            InputStream input = socket.getInputStream();
            byte[] response = new byte[4096];
            int read = input.read(response);
            if (read <= 0) {
                return buildRelayTestFailure("TURN TLS socket closed before response", "connection");
            }

            TurnMessage parsed = parseTurnMessage(response, read);
            if (parsed == null || !Arrays.equals(parsed.transactionId, request.transactionId)) {
                return buildRelayTestFailure("TURN TLS response invalid", "protocol");
            }

            return new JSObject().put("ok", true).put("protocol", "tls-auth").put("messageType", parsed.type).put("message", parsed);
        } catch (Exception error) {
            return buildRelayTestFailure(formatTlsCertificateError(error), "connection");
        } finally {
            if (socket != null) {
                try {
                    socket.close();
                } catch (Exception ignored) {
                    // Ignore close failures.
                }
            }
        }
    }

    private JSObject testTurnRelayAuthentication(String host, int port, boolean tls, String username, String password, int timeoutMs) {
        String safeHost = sanitizeNetworkHost(host);
        if (safeHost.isEmpty()) {
            return buildRelayTestFailure("turn host is empty", "configuration");
        }

        List<InetAddress> addresses = resolveHostAddresses(safeHost);
        if (addresses.isEmpty()) {
            return buildRelayTestFailure("Unable to resolve host \"" + safeHost + "\"", "connection");
        }

        if (String.valueOf(username == null ? "" : username).trim().isEmpty() || String.valueOf(password == null ? "" : password).trim().isEmpty()) {
            return buildRelayTestFailure("TURN credentials are required", "authentication");
        }

        String lastError = "TURN authentication failed";
        String lastErrorType = "connection";
        long startedAt = System.currentTimeMillis();
        for (InetAddress address : addresses) {
            SSLSocket persistentTlsSocket = null;
            try {
                if (tls) {
                    int safeTimeoutMs = timeoutMs > 0 ? timeoutMs : TURN_RELAY_TEST_TIMEOUT_MS;
                    persistentTlsSocket = createStrictTlsSocket(host, address, port, safeTimeoutMs);
                }

                TurnRequest challengeRequest = buildTurnAllocateRequest("", "", "", "");
                JSObject challengeResponse = tls
                        ? testTurnAllocateTlsWithSocket(persistentTlsSocket, challengeRequest)
                    : testTurnAllocateUdp(address, port, challengeRequest, timeoutMs);
                if (!challengeResponse.optBoolean("ok", false)) {
                    lastError = challengeResponse.optString("error", lastError);
                    lastErrorType = challengeResponse.optString("errorType", lastErrorType);
                    continue;
                }

                TurnMessage challengeMessage = (TurnMessage) challengeResponse.get("message");
                if (challengeMessage.type == TURN_ALLOCATE_SUCCESS_RESPONSE) {
                    return new JSObject().put("ok", true).put("protocol", tls ? "tls-auth" : "udp-auth").put("elapsedMs", Math.max(0L, System.currentTimeMillis() - startedAt));
                }

                JSObject error = getTurnErrorDetails(challengeMessage);
                int errorCode = error != null ? error.optInt("code", 0) : 0;
                if (errorCode != 401 && errorCode != 438) {
                    lastError = describeTurnResponseFailure(challengeMessage, "TURN allocate failed");
                    lastErrorType = "connection";
                    continue;
                }

                String realm = getTurnTextAttribute(challengeMessage, STUN_ATTR_REALM);
                String nonce = getTurnTextAttribute(challengeMessage, STUN_ATTR_NONCE);
                if (realm.isEmpty() || nonce.isEmpty()) {
                    lastError = "TURN auth challenge missing realm or nonce";
                    lastErrorType = "protocol";
                    continue;
                }

                for (int attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
                    TurnRequest authenticatedRequest = buildTurnAllocateRequest(username, realm, nonce, password);
                        JSObject authenticatedResponse = tls
                            ? testTurnAllocateTlsWithSocket(persistentTlsSocket, authenticatedRequest)
                            : testTurnAllocateUdp(address, port, authenticatedRequest, timeoutMs);
                    if (!authenticatedResponse.optBoolean("ok", false)) {
                        lastError = authenticatedResponse.optString("error", "TURN connection failed");
                        lastErrorType = authenticatedResponse.optString("errorType", "connection");
                        break;
                    }

                    TurnMessage authenticatedMessage = (TurnMessage) authenticatedResponse.get("message");
                    if (authenticatedMessage.type == TURN_ALLOCATE_SUCCESS_RESPONSE) {
                        return new JSObject().put("ok", true).put("protocol", tls ? "tls-auth" : "udp-auth").put("elapsedMs", Math.max(0L, System.currentTimeMillis() - startedAt));
                    }

                    JSObject authError = getTurnErrorDetails(authenticatedMessage);
                    int authErrorCode = authError != null ? authError.optInt("code", 0) : 0;
                    if (authErrorCode == 438) {
                        realm = getTurnTextAttribute(authenticatedMessage, STUN_ATTR_REALM);
                        nonce = getTurnTextAttribute(authenticatedMessage, STUN_ATTR_NONCE);
                        if (realm.isEmpty() || nonce.isEmpty()) {
                            lastError = "TURN auth challenge missing realm or nonce";
                            lastErrorType = "protocol";
                            break;
                        }
                        continue;
                    }

                    lastError = describeTurnResponseFailure(authenticatedMessage, "TURN authentication failed");
                    lastErrorType = "authentication";
                    break;
                }
            } catch (Exception error) {
                lastError = formatTlsCertificateError(error);
                lastErrorType = "connection";
            } finally {
                if (persistentTlsSocket != null) {
                    try {
                        persistentTlsSocket.close();
                    } catch (Exception ignored) {
                        // Ignore close failures.
                    }
                }
            }
        }

        return buildRelayTestFailure(lastError, lastErrorType);
    }

    private JSObject testRelayEndpoint(String kind, JSObject relayConfig) {
        String safeKind = String.valueOf(kind == null ? "" : kind).trim().toLowerCase();
        JSObject safeConfig = normalizeRelayConfig(relayConfig, 3478, "turn".equals(safeKind));
        String host = safeConfig.optString("host", "").trim();
        int port = safeConfig.optInt("port", 3478);
        boolean tls = safeConfig.optBoolean("tls", false);

        if (host.isEmpty()) {
            return buildRelayTestFailure(safeKind + " host is empty", "configuration");
        }

        if ("stun".equals(safeKind)) {
            return testUdpRelay(host, port, "stun");
        }

        if ("turn".equals(safeKind)) {
            int turnTimeoutMs = resolveTimeoutFromEnv(ENV_TURN_TEST_TIMEOUT_MS, TURN_RELAY_TEST_TIMEOUT_MS);
            return testTurnRelayAuthentication(
                    host,
                    port,
                    tls,
                    safeConfig.optString("username", "").trim(),
                    safeConfig.optString("password", "").trim(),
                turnTimeoutMs
            );
        }

        return new JSObject().put("ok", false).put("error", "unsupported relay kind");
    }

    private JSObject testTurnAllocateTlsWithSocket(SSLSocket socket, TurnRequest request) {
        if (socket == null || request == null || request.message == null || request.transactionId == null || request.transactionId.length != 12) {
            return buildRelayTestFailure("invalid TURN TLS request parameters", "configuration");
        }

        try {
            socket.getOutputStream().write(request.message);
            socket.getOutputStream().flush();

            InputStream input = socket.getInputStream();
            byte[] response = new byte[4096];
            int read = input.read(response);
            if (read <= 0) {
                return buildRelayTestFailure("TURN TLS socket closed before response", "connection");
            }

            TurnMessage parsed = parseTurnMessage(response, read);
            if (parsed == null || !Arrays.equals(parsed.transactionId, request.transactionId)) {
                return buildRelayTestFailure("TURN TLS response invalid", "protocol");
            }

            return new JSObject().put("ok", true).put("protocol", "tls-auth").put("messageType", parsed.type).put("message", parsed);
        } catch (Exception error) {
            return buildRelayTestFailure(formatTlsCertificateError(error), "connection");
        }
    }

    private SSLSocket createStrictTlsSocket(String host, InetAddress address, int port, int timeoutMs) throws Exception {
        String safeHost = sanitizeNetworkHost(host);
        int safeTimeoutMs = timeoutMs > 0 ? timeoutMs : TURN_RELAY_TEST_TIMEOUT_MS;
        if (safeHost.isEmpty() || address == null || port < 1 || port > 65535) {
            throw new IOException("invalid TURN TLS request parameters");
        }

        Socket tcpSocket = new Socket();
        tcpSocket.connect(new InetSocketAddress(address, port), safeTimeoutMs);
        tcpSocket.setSoTimeout(safeTimeoutMs);

        SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
        SSLSocket sslSocket = (SSLSocket) factory.createSocket(tcpSocket, safeHost, port, true);
        SSLParameters sslParameters = sslSocket.getSSLParameters();
        sslParameters.setEndpointIdentificationAlgorithm("HTTPS");
        sslSocket.setSSLParameters(sslParameters);
        sslSocket.setSoTimeout(safeTimeoutMs);
        sslSocket.startHandshake();
        return sslSocket;
    }

    private String formatTlsCertificateError(Exception error) {
        String detail = error != null && error.getMessage() != null
                ? error.getMessage().trim()
                : "TLS certificate validation failed";
        String lowered = detail.toLowerCase(Locale.ROOT);
        boolean certificateIssue = lowered.contains("self signed")
                || lowered.contains("unable to verify")
                || lowered.contains("certificate")
                || lowered.contains("hostname")
                || lowered.contains("x509")
                || lowered.contains("cert_");
        if (certificateIssue) {
            return "TLS certificate validation failed: " + detail;
        }
        return detail;
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

    private JSObject waitForExchangeClientConnection(long timeoutMs) {
        long safeTimeoutMs = timeoutMs > 0 ? timeoutMs : 5000L;

        long startedAt = System.currentTimeMillis();
        while (System.currentTimeMillis() - startedAt <= safeTimeoutMs) {
            String currentMode = String.valueOf(ReactorHttpService.getCurrentExchangeMode());
            if ("node".equals(currentMode) && ReactorHttpService.isExchangeClientAuthenticated()) {
                return new JSObject()
                        .put("connected", true)
                        .put("skipped", false)
                        .put("reason", "")
                        .put("errorType", "")
                        .put("elapsedMs", System.currentTimeMillis() - startedAt);
            }

            try {
                Thread.sleep(150L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }

    String finalMode = String.valueOf(ReactorHttpService.getCurrentExchangeMode());
        String reason = String.valueOf(ReactorHttpService.getExchangeClientLastError()).trim();
        if (reason.isEmpty()) {
            reason = String.valueOf(ReactorHttpService.getExchangeClientLastCloseReason()).trim();
        }
        if (reason.isEmpty() && "node".equals(finalMode)) {
            reason = ReactorHttpService.isExchangeClientConnected() ? "waiting for exchange registration" : "timeout waiting for connection";
        }
        String errorType = classifyExchangeFailureType(reason, ReactorHttpService.getExchangeClientLastCloseCode());
        return new JSObject()
                .put("connected", ReactorHttpService.isExchangeClientAuthenticated())
                .put("skipped", !"node".equals(finalMode))
                .put("reason", "node".equals(finalMode) ? reason : "exchange mode is " + finalMode)
                .put("errorType", "node".equals(finalMode) ? errorType : "")
                .put("elapsedMs", System.currentTimeMillis() - startedAt);
    }

    private File getEndpointsDir() {
        File projectsDir = new File(getContext().getFilesDir(), "endpoints");
        if (!projectsDir.exists()) {
            projectsDir.mkdirs();
        }
        return projectsDir;
    }

    private File getGlobalLogFile() {
        return new File(getContext().getFilesDir(), "activity.log");
    }

    private File getUiSettingsFile() {
        return new File(getContext().getFilesDir(), "ui-settings.json");
    }

    private File getWorkflowFile() {
        return new File(getContext().getFilesDir(), "workflow.json");
    }

    private File getTlsDir() {
        return new File(getContext().getFilesDir(), "tls");
    }

    private File getPermissionsFile() {
        return new File(getContext().getFilesDir(), "permissions.json");
    }

    private File getTemplatesDir() {
        File templatesDir = new File(getContext().getFilesDir(), ENDPOINT_TEMPLATES_DIR);
        if (!templatesDir.exists()) {
            templatesDir.mkdirs();
        }
        return templatesDir;
    }

    private File getBackupsDir() {
        File externalDir = getContext().getExternalFilesDir("backups");
        File backupsDir = externalDir != null ? externalDir : new File(getContext().getFilesDir(), "backups");
        if (!backupsDir.exists()) {
            backupsDir.mkdirs();
        }
        return backupsDir;
    }

    private List<File> getBackupSourceEntries(boolean includeConnections, boolean includeEndpoints, boolean endpointSelectionProvided, List<File> selectedEndpointDirs) {
        List<File> entries = new ArrayList<>();

        if (includeEndpoints) {
            if (endpointSelectionProvided) {
                if (selectedEndpointDirs != null && !selectedEndpointDirs.isEmpty()) {
                    entries.addAll(selectedEndpointDirs);
                }
            } else if (selectedEndpointDirs != null && !selectedEndpointDirs.isEmpty()) {
                entries.addAll(selectedEndpointDirs);
            } else {
                entries.add(getEndpointsDir());
            }
        }

        if (includeConnections) {
            entries.add(getWorkingModeFile());
        }

        entries.add(getReactorNameFile());
        entries.add(getEnvDir());
        entries.add(getPermissionsFile());
        entries.add(getUiSettingsFile());
        entries.add(getWorkflowFile());
        entries.add(getGlobalLogFile());
        entries.add(getTlsDir());
        return entries;
    }

    private List<String> getRequestedBackupEndpointPaths(PluginCall call) {
        JSArray input = call != null ? call.getArray("endpointPaths", new JSArray()) : new JSArray();
        List<String> normalized = new ArrayList<>();
        if (input == null) {
            return normalized;
        }

        for (int index = 0; index < input.length(); index += 1) {
            String endpointPath = String.valueOf(input.optString(index, "")).trim();
            if (!endpointPath.isEmpty() && !normalized.contains(endpointPath)) {
                normalized.add(endpointPath);
            }
        }

        return normalized;
    }

    private List<File> resolveSelectedEndpointExportDirs(List<String> endpointPaths) {
        List<File> selectedDirs = new ArrayList<>();
        if (endpointPaths == null || endpointPaths.isEmpty()) {
            return selectedDirs;
        }

        try {
            File endpointsRoot = getEndpointsDir().getCanonicalFile();
            String endpointsRootPath = endpointsRoot.getCanonicalPath();
            Set<String> seen = new LinkedHashSet<>();

            for (String endpointPath : endpointPaths) {
                String rawPath = String.valueOf(endpointPath == null ? "" : endpointPath).trim();
                if (rawPath.isEmpty()) {
                    continue;
                }

                File candidate = new File(rawPath).getCanonicalFile();
                String candidatePath = candidate.getCanonicalPath();
                if (!candidatePath.startsWith(endpointsRootPath + File.separator)) {
                    continue;
                }

                Path relative = endpointsRoot.toPath().relativize(candidate.toPath());
                if (relative.getNameCount() < 1) {
                    continue;
                }

                String endpointDirName = String.valueOf(relative.getName(0)).trim();
                if (endpointDirName.isEmpty()) {
                    continue;
                }

                File endpointDir = new File(endpointsRoot, endpointDirName).getCanonicalFile();
                if (!endpointDir.exists() || !endpointDir.isDirectory()) {
                    continue;
                }

                String endpointDirPath = endpointDir.getCanonicalPath();
                if (seen.contains(endpointDirPath)) {
                    continue;
                }

                seen.add(endpointDirPath);
                selectedDirs.add(endpointDir);
            }
        } catch (Exception ignored) {
            // Keep full endpoint export fallback when path parsing fails.
        }

        return selectedDirs;
    }

    private String toArchiveRelativeName(File target) throws IOException {
        String base = getContext().getFilesDir().getCanonicalPath();
        String full = target.getCanonicalPath();
        if (full.equals(base)) {
            return "";
        }
        if (full.startsWith(base + File.separator)) {
            return full.substring(base.length() + 1).replace(File.separatorChar, '/');
        }
        throw new IOException("path outside reactor root");
    }

    private void addPathToZip(ZipOutputStream output, File source) throws IOException {
        if (!source.exists()) {
            return;
        }

        if (source.isDirectory()) {
            File[] children = source.listFiles();
            if (children == null || children.length == 0) {
                String relative = toArchiveRelativeName(source);
                if (!relative.isEmpty()) {
                    ZipEntry entry = new ZipEntry(relative + "/.keep");
                    output.putNextEntry(entry);
                    output.closeEntry();
                }
                return;
            }

            for (File child : children) {
                addPathToZip(output, child);
            }
            return;
        }

        String relative = toArchiveRelativeName(source);
        if (relative.isEmpty()) {
            return;
        }

        ZipEntry entry = new ZipEntry(relative);
        output.putNextEntry(entry);
        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(source))) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
        output.closeEntry();
    }

    private List<String> getAllowedBackupRoots() {
        return Arrays.asList(
                "endpoints",
                "working-mode.json",
                "name",
                "envs",
                "permissions.json",
                "ui-settings.json",
                "workflow.json",
                "activity.log",
                "tls",
                "backup-meta.json"
        );
    }

    private File resolveSafeBackupTarget(String entryName) throws IOException {
        String normalized = String.valueOf(entryName == null ? "" : entryName)
                .replace('\\', '/')
                .replaceAll("^/+", "")
                .trim();
        if (normalized.isEmpty() || normalized.contains("..")) {
            return null;
        }

        String[] segments = normalized.split("/");
        if (segments.length == 0) {
            return null;
        }

        String root = segments[0];
        if (!getAllowedBackupRoots().contains(root)) {
            return null;
        }

        File base = getContext().getFilesDir();
        File target = new File(base, normalized);
        String canonicalBase = base.getCanonicalPath();
        String canonicalTarget = target.getCanonicalPath();
        if (!canonicalTarget.startsWith(canonicalBase + File.separator) && !canonicalTarget.equals(canonicalBase)) {
            return null;
        }
        return target;
    }

    private void writeUiSettingsSnapshot() {
        try {
            JSObject snapshot = new JSObject();
            snapshot.put("defaultProgramPath", "");
            snapshot.put("httpServerPort", getConfiguredHttpPort());
            writeTextFile(getUiSettingsFile(), snapshot.toString() + "\n");
        } catch (Exception ignored) {
            // Optional backup metadata.
        }
    }

    private void applyRuntimeStateAfterBackupImport() {
        try {
            JSObject workingMode = readWorkingModeConfig();

            String mode = workingMode.getString("mode", "node");
            String host = workingMode.getString("host", "");
            int port = workingMode.getInteger("port", ReactorHttpService.DEFAULT_PORT);
            boolean tls = workingMode.has("tls") && workingMode.getBool("tls");
            String token = workingMode.getString("token", "");

            SharedPreferences.Editor editor = getPrefs().edit();
            editor.putString(ReactorHttpService.PREF_EXCHANGE_MODE, mode);
            editor.putString(ReactorHttpService.PREF_EXCHANGE_HOST, host);
            editor.putInt(ReactorHttpService.PREF_EXCHANGE_PORT, port);
            editor.putBoolean(ReactorHttpService.PREF_EXCHANGE_TLS, tls);
            editor.putString(ReactorHttpService.PREF_EXCHANGE_TOKEN, token);

            String restoredName = readConfiguredReactorNameFile();
            if (!restoredName.isEmpty()) {
                editor.putString(ReactorHttpService.PREF_REACTOR_NAME, restoredName);
            }
            editor.apply();
        } catch (Exception ignored) {
            // Keep previous runtime state on partial failures.
        }

        try {
            startHttpService(getConfiguredHttpPort());
        } catch (Exception ignored) {
            // Ignore restart failures.
        }
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
        try (FileOutputStream stream = new FileOutputStream(file, false)) {
            stream.write(content.getBytes(StandardCharsets.UTF_8));
        }
    }

    private List<String> getRequestedPermissionNames(PluginCall call) {
        JSArray input = call != null ? call.getArray("permissions", new JSArray()) : new JSArray();
        List<String> normalized = new ArrayList<>();
        if (input == null) {
            return normalized;
        }

        for (int index = 0; index < input.length(); index++) {
            String permissionName = String.valueOf(input.optString(index, "")).trim();
            if (!permissionName.isEmpty() && !normalized.contains(permissionName)) {
                normalized.add(permissionName);
            }
        }

        return normalized;
    }

    private boolean requestsFilesystemPermission(List<String> permissions) {
        if (permissions == null) {
            return false;
        }

        for (String permissionName : permissions) {
            if (permissionName != null && permissionName.trim().startsWith("filesystem.")) {
                return true;
            }
        }

        return false;
    }

    private JSObject buildPermissionRequestResult(List<String> requestedPermissions, boolean granted) {
        List<String> grantedPermissionsList = new ArrayList<>();
        List<String> deniedPermissionsList = new ArrayList<>();
        for (String permissionName : requestedPermissions) {
            if (granted) {
                grantedPermissionsList.add(permissionName);
            } else {
                deniedPermissionsList.add(permissionName);
            }
        }
        return buildPermissionRequestResult(requestedPermissions, grantedPermissionsList, deniedPermissionsList);
    }

    private JSObject buildPermissionRequestResult(List<String> requestedPermissions, List<String> grantedNames, List<String> deniedNames) {
        JSArray grantedPermissions = new JSArray();
        JSArray deniedPermissions = new JSArray();
        Set<String> requestedSet = new LinkedHashSet<>();
        if (requestedPermissions != null) {
            requestedSet.addAll(requestedPermissions);
        }

        Set<String> grantedSet = new LinkedHashSet<>();
        if (grantedNames != null) {
            for (String permissionName : grantedNames) {
                String safeName = String.valueOf(permissionName == null ? "" : permissionName).trim();
                if (!safeName.isEmpty()) {
                    grantedSet.add(safeName);
                }
            }
        }

        Set<String> deniedSet = new LinkedHashSet<>();
        if (deniedNames != null) {
            for (String permissionName : deniedNames) {
                String safeName = String.valueOf(permissionName == null ? "" : permissionName).trim();
                if (!safeName.isEmpty()) {
                    deniedSet.add(safeName);
                }
            }
        }

        for (String permissionName : requestedSet) {
            if (grantedSet.contains(permissionName) && !deniedSet.contains(permissionName)) {
                grantedPermissions.put(permissionName);
            } else {
                deniedPermissions.put(permissionName);
            }
        }

        return new JSObject()
                .put("ok", true)
                .put("platform", "Android")
                .put("granted", grantedPermissions)
                .put("denied", deniedPermissions);
    }

    private boolean requestsNotificationPermission(List<String> permissions) {
        if (permissions == null) {
            return false;
        }

        for (String permissionName : permissions) {
            String normalized = String.valueOf(permissionName == null ? "" : permissionName).trim().toLowerCase(Locale.ROOT);
            if ("system.notification".equals(normalized)) {
                return true;
            }
        }

        return false;
    }

    private boolean requestsGeolocationPermission(List<String> permissions) {
        if (permissions == null) {
            return false;
        }

        for (String permissionName : permissions) {
            String normalized = String.valueOf(permissionName == null ? "" : permissionName).trim().toLowerCase(Locale.ROOT);
            if ("system.geolocation".equals(normalized)) {
                return true;
            }
        }

        return false;
    }

    private boolean isBackgroundLocationPermissionGranted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return true;
        }

        try {
            return getContext().checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isNotificationPermissionGranted() {
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                return getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
            }

            NotificationManagerCompat managerCompat = NotificationManagerCompat.from(getContext());
            return managerCompat.areNotificationsEnabled();
        } catch (Exception ignored) {
            return false;
        }
    }

    private Intent buildNotificationSettingsIntent() {
        String packageName = getContext().getPackageName();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, packageName);
            return intent;
        }

        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + packageName));
        return intent;
    }

    private JSObject evaluatePermissionGrantState(List<String> requestedPermissions) {
        List<String> grantedNames = new ArrayList<>();
        List<String> deniedNames = new ArrayList<>();

        if (requestedPermissions != null) {
            for (String permissionName : requestedPermissions) {
                String normalized = String.valueOf(permissionName == null ? "" : permissionName).trim().toLowerCase(Locale.ROOT);
                if (normalized.isEmpty()) {
                    continue;
                }

                if (normalized.startsWith("filesystem.")) {
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()) {
                        grantedNames.add(permissionName);
                    } else {
                        deniedNames.add(permissionName);
                    }
                    continue;
                }

                if ("system.notification".equals(normalized)) {
                    if (isNotificationPermissionGranted()) {
                        grantedNames.add(permissionName);
                    } else {
                        deniedNames.add(permissionName);
                    }
                    continue;
                }

                if ("system.geolocation".equals(normalized)) {
                    final boolean foregroundGranted = getPermissionState("location") == PermissionState.GRANTED;
                    final boolean backgroundGranted = isBackgroundLocationPermissionGranted();
                    if (foregroundGranted && backgroundGranted) {
                        grantedNames.add(permissionName);
                    } else {
                        deniedNames.add(permissionName);
                    }
                    continue;
                }

                grantedNames.add(permissionName);
            }
        }

        return buildPermissionRequestResult(requestedPermissions, grantedNames, deniedNames);
    }

    private JSObject readPermissionsConfig() throws Exception {
        File file = getPermissionsFile();
        if (!file.exists() || !file.isFile()) {
            return new JSObject();
        }

        String content = readTextFile(file).trim();
        if (content.isEmpty()) {
            return new JSObject();
        }

        return new JSObject(content);
    }

    private JSObject writePermissionsConfig(JSObject permissions) throws Exception {
        JSObject safePermissions = permissions != null ? permissions : new JSObject();
        writeTextFile(getPermissionsFile(), safePermissions.toString(2) + "\n");
        return safePermissions;
    }

    private JSObject readEnvConfig() throws Exception {
        File envDir = getEnvDir();
        JSObject envs = new JSObject();
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

            envs.put(name, readTextFile(entry));
        }

        return envs;
    }

    private String parseEnvFileValue(String rawValue) {
        String value = String.valueOf(rawValue == null ? "" : rawValue).trim();
        if (value.isEmpty()) {
            return "";
        }

        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
            return value.substring(1, Math.max(1, value.length() - 1));
        }

        return value;
    }

    private String readEnvValueFromContent(String content, String key) {
        if (content == null || key == null || key.trim().isEmpty()) {
            return "";
        }

        String safeKey = key.trim();
        String[] lines = String.valueOf(content).split("\\r?\\n");
        for (String rawLine : lines) {
            String line = String.valueOf(rawLine == null ? "" : rawLine).trim();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }

            int equalIndex = line.indexOf('=');
            if (equalIndex < 1) {
                continue;
            }

            String rawName = line.substring(0, equalIndex).trim();
            if (rawName.startsWith("export ")) {
                rawName = rawName.substring(7).trim();
            }

            if (!safeKey.equals(rawName)) {
                continue;
            }

            return parseEnvFileValue(line.substring(equalIndex + 1));
        }

        return "";
    }

    private int resolveTimeoutFromEnv(String envKey, int fallback) {
        int safeFallback = fallback > 0 ? fallback : 12000;

        try {
            JSObject envs = readEnvConfig();
            JSONArray keys = envs.names();
            if (keys == null) {
                return safeFallback;
            }

            int resolved = -1;
            for (int index = 0; index < keys.length(); index += 1) {
                String fileName = String.valueOf(keys.optString(index, "")).trim();
                if (fileName.isEmpty()) {
                    continue;
                }

                String content = String.valueOf(envs.opt(fileName));
                String rawValue = readEnvValueFromContent(content, envKey);
                if (rawValue.isEmpty()) {
                    continue;
                }

                int numericValue = Integer.parseInt(rawValue.trim());
                if (numericValue > 0) {
                    resolved = numericValue;
                    if (".env".equalsIgnoreCase(fileName)) {
                        break;
                    }
                }
            }

            return resolved > 0 ? resolved : safeFallback;
        } catch (Exception ignored) {
            return safeFallback;
        }
    }

    private JSObject writeEnvConfig(JSObject env) throws Exception {
        JSObject safeEnv = env != null ? env : new JSObject();
        File envDir = getEnvDir();
        JSObject normalized = new JSObject();
        Set<String> keepNames = new LinkedHashSet<>();

        JSONArray keys = safeEnv.names();
        if (keys != null) {
            for (int index = 0; index < keys.length(); index++) {
                String name = String.valueOf(keys.optString(index, "")).trim();
                if (name.isEmpty() || name.contains("/") || name.contains("\\") || "..".equals(name) || ".".equals(name)) {
                    continue;
                }

                String content = String.valueOf(safeEnv.opt(name));
                writeTextFile(new File(envDir, name), content);
                normalized.put(name, content);
                keepNames.add(name);
            }
        }

        File[] existing = envDir.listFiles();
        if (existing != null) {
            for (File entry : existing) {
                if (entry == null || !entry.isFile()) {
                    continue;
                }

                if (!keepNames.contains(entry.getName())) {
                    entry.delete();
                }
            }
        }

        return normalized;
    }

    @PluginMethod
    public void getPermissionsConfig(PluginCall call) {
        try {
            JSObject permissions = readPermissionsConfig();
            call.resolve(new JSObject()
                    .put("ok", true)
                    .put("platform", "Android")
                    .put("permissions", permissions));
        } catch (Exception e) {
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("error", e.getMessage())
                    .put("platform", "Android")
                    .put("permissions", new JSObject()));
        }
    }

    @PluginMethod
    public void savePermissionsConfig(PluginCall call) {
        try {
            JSObject saved = writePermissionsConfig(call.getObject("permissions", new JSObject()));
            call.resolve(new JSObject()
                    .put("ok", true)
                    .put("platform", "Android")
                    .put("permissions", saved));
        } catch (Exception e) {
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("error", e.getMessage())
                    .put("platform", "Android")
                    .put("permissions", new JSObject()));
        }
    }

    @PluginMethod
    public void getEnvConfig(PluginCall call) {
        try {
            ReactorHttpService.refreshEnvCacheNow("plugin-get-env-config");
            JSObject fromService = ReactorHttpService.getEnvCacheSnapshotForUi();
            if (Boolean.TRUE.equals(fromService.getBool("ok"))) {
                call.resolve(fromService);
                return;
            }

            JSObject env = readEnvConfig();
            call.resolve(new JSObject()
                    .put("ok", true)
                    .put("path", getEnvDir().getAbsolutePath())
                    .put("envs", env));
        } catch (Exception e) {
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("error", e.getMessage())
                    .put("path", getEnvDir().getAbsolutePath())
                    .put("envs", new JSObject()));
        }
    }

    @PluginMethod
    public void saveEnvConfig(PluginCall call) {
        try {
            writeEnvConfig(call.getObject("envs", call.getObject("env", new JSObject())));
            ReactorHttpService.refreshEnvCacheNow("plugin-save-env-config");
            JSObject fromService = ReactorHttpService.getEnvCacheSnapshotForUi();
            if (Boolean.TRUE.equals(fromService.getBool("ok"))) {
                call.resolve(fromService);
                return;
            }

            JSObject saved = readEnvConfig();
            call.resolve(new JSObject()
                    .put("ok", true)
                    .put("path", getEnvDir().getAbsolutePath())
                    .put("envs", saved));
        } catch (Exception e) {
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("error", e.getMessage())
                    .put("path", getEnvDir().getAbsolutePath())
                    .put("envs", new JSObject()));
        }
    }

    @PluginMethod
    public void requestSystemPermissions(PluginCall call) {
        List<String> requestedPermissions = getRequestedPermissionNames(call);
        if (requestedPermissions.isEmpty()) {
            call.resolve(buildPermissionRequestResult(requestedPermissions, true));
            return;
        }

        if (requestsGeolocationPermission(requestedPermissions) && getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "handleLocationPermissionResult");
            return;
        }

        if (requestsGeolocationPermission(requestedPermissions) && !isBackgroundLocationPermissionGranted()) {
            try {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(call, intent, "handleBackgroundLocationPermissionResult");
                return;
            } catch (Exception error) {
                call.resolve(new JSObject().put("ok", false).put("error", error.getMessage()).put("platform", "Android"));
                return;
            }
        }

        if (requestsFilesystemPermission(requestedPermissions) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(call, intent, "handleManageStoragePermissionResult");
                return;
            } catch (Exception ignored) {
                try {
                    Intent fallbackIntent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    startActivityForResult(call, fallbackIntent, "handleManageStoragePermissionResult");
                    return;
                } catch (Exception fallbackError) {
                    call.resolve(new JSObject().put("ok", false).put("error", fallbackError.getMessage()).put("platform", "Android"));
                    return;
                }
            }
        }

        if (requestsNotificationPermission(requestedPermissions) && !isNotificationPermissionGranted()) {
            try {
                Intent intent = buildNotificationSettingsIntent();
                startActivityForResult(call, intent, "handleNotificationPermissionResult");
                return;
            } catch (Exception error) {
                call.resolve(new JSObject().put("ok", false).put("error", error.getMessage()).put("platform", "Android"));
                return;
            }
        }

        call.resolve(evaluatePermissionGrantState(requestedPermissions));
    }

    @PluginMethod
    public void openSystemPermissionSettings(PluginCall call) {
        List<String> requestedPermissions = getRequestedPermissionNames(call);
        try {
            if (requestsGeolocationPermission(requestedPermissions)) {
                Intent locationSettingsIntent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                locationSettingsIntent.setData(Uri.parse("package:" + getContext().getPackageName()));
                locationSettingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(locationSettingsIntent);
                call.resolve(new JSObject()
                        .put("ok", true)
                        .put("opened", true)
                        .put("platform", "Android")
                    .put("target", "ACTION_APPLICATION_DETAILS_SETTINGS"));
                return;
            }

            if (requestsFilesystemPermission(requestedPermissions) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);
                    call.resolve(new JSObject()
                            .put("ok", true)
                            .put("opened", true)
                            .put("platform", "Android")
                            .put("target", "ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION"));
                    return;
                } catch (Exception ignored) {
                    Intent fallbackIntent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    fallbackIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(fallbackIntent);
                    call.resolve(new JSObject()
                            .put("ok", true)
                            .put("opened", true)
                            .put("platform", "Android")
                            .put("target", "ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION"));
                    return;
                }
            }

            if (requestsNotificationPermission(requestedPermissions)) {
                Intent notificationIntent = buildNotificationSettingsIntent();
                notificationIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(notificationIntent);
                call.resolve(new JSObject()
                        .put("ok", true)
                        .put("opened", true)
                        .put("platform", "Android")
                        .put("target", "ACTION_APP_NOTIFICATION_SETTINGS"));
                return;
            }

            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject()
                    .put("ok", true)
                    .put("opened", true)
                    .put("platform", "Android")
                    .put("target", "ACTION_APPLICATION_DETAILS_SETTINGS"));
        } catch (Exception e) {
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("opened", false)
                    .put("platform", "Android")
                    .put("error", e.getMessage() != null ? e.getMessage() : "unable to open system permission settings"));
        }
    }

    @PermissionCallback
    private void handleLocationPermissionResult(PluginCall call) {
        if (call == null) {
            return;
        }

        List<String> requestedPermissions = getRequestedPermissionNames(call);

        if (requestsGeolocationPermission(requestedPermissions) && getPermissionState("location") == PermissionState.GRANTED && !isBackgroundLocationPermissionGranted()) {
            try {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(call, intent, "handleBackgroundLocationPermissionResult");
                return;
            } catch (Exception error) {
                call.resolve(new JSObject().put("ok", false).put("error", error.getMessage()).put("platform", "Android"));
                return;
            }
        }

        call.resolve(evaluatePermissionGrantState(requestedPermissions));
    }

    @ActivityCallback
    private void handleBackgroundLocationPermissionResult(PluginCall call, ActivityResult activityResult) {
        if (call == null) {
            return;
        }

        List<String> requestedPermissions = getRequestedPermissionNames(call);
        call.resolve(evaluatePermissionGrantState(requestedPermissions));
    }

    @ActivityCallback
    private void handleManageStoragePermissionResult(PluginCall call, ActivityResult activityResult) {
        if (call == null) {
            return;
        }

        List<String> requestedPermissions = getRequestedPermissionNames(call);
        call.resolve(evaluatePermissionGrantState(requestedPermissions));
    }

    @ActivityCallback
    private void handleNotificationPermissionResult(PluginCall call, ActivityResult activityResult) {
        if (call == null) {
            return;
        }

        List<String> requestedPermissions = getRequestedPermissionNames(call);
        call.resolve(evaluatePermissionGrantState(requestedPermissions));
    }

    private void appendTextFile(File file, String content) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }
        try (FileOutputStream stream = new FileOutputStream(file, true)) {
            stream.write(content.getBytes(StandardCharsets.UTF_8));
        }
    }

    private String normalizeEndpointTemplateKey(String rawTemplate, String fallbackTemplate) {
        String normalized = String.valueOf(rawTemplate == null ? "" : rawTemplate)
                .trim()
                .toLowerCase()
                .replaceAll("[^a-z0-9_-]", "");
        if (ALLOWED_ENDPOINT_TEMPLATE_KEYS.contains(normalized)) {
            return normalized;
        }
        return fallbackTemplate;
    }

    private String readAssetTextFile(String assetPath) throws IOException {
        StringBuilder content = new StringBuilder();
        try (InputStream stream = getContext().getAssets().open(assetPath);
             BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                content.append(line).append('\n');
            }
        }
        return content.toString();
    }

    private String readEndpointTemplateFromAssets(String templateKey) throws IOException {
        String safeTemplateKey = normalizeEndpointTemplateKey(templateKey, "blank");
        String[] candidates = new String[] {
                ENDPOINT_TEMPLATE_ASSETS_DIR + "/" + safeTemplateKey,
                "templates/" + safeTemplateKey
        };

        IOException lastError = null;
        for (String candidate : candidates) {
            try {
                return readAssetTextFile(candidate);
            } catch (IOException error) {
                lastError = error;
            }
        }

        if (lastError != null) {
            throw new IOException("endpoint template file not found for type \"" + safeTemplateKey + "\": " + lastError.getMessage(), lastError);
        }

        throw new IOException("endpoint template file not found for type \"" + safeTemplateKey + "\"");
    }

    private String readEndpointTemplateFromStorage(String templateKey) throws IOException {
        String safeTemplateKey = normalizeEndpointTemplateKey(templateKey, "blank");
        File templateFile = new File(getTemplatesDir(), safeTemplateKey);
        if (!templateFile.exists()) {
            throw new IOException("endpoint template file not found at ./templates/" + safeTemplateKey);
        }
        return readTextFile(templateFile);
    }

    private void ensureEndpointTemplatesPresent() {
        File templatesDir = getTemplatesDir();
        for (String key : ALLOWED_ENDPOINT_TEMPLATE_KEYS) {
            File target = new File(templatesDir, key);
            try {
                String content = readEndpointTemplateFromAssets(key);
                writeTextFile(target, content);
            } catch (Exception error) {
                Log.w(TAG, "Unable to sync endpoint template " + key + " from assets", error);
            }
        }
    }

    private String createExecutionStartEntry(String endpointName, String endpointPath, String endpointState, String scope, String trigger, String event) {
        String timestamp = Instant.now().toString();
        String safeEndpointName = String.valueOf(endpointName == null ? "" : endpointName).trim();
        if (safeEndpointName.isEmpty()) {
            safeEndpointName = "unknown";
        }
        String safeTrigger = String.valueOf(trigger == null ? "" : trigger).trim();
        if (safeTrigger.isEmpty()) {
            safeTrigger = "unknown";
        }
        String safeEvent = String.valueOf(event == null ? "" : event).trim();
        if (safeEvent.isEmpty()) {
            safeEvent = "unknown";
        }
        return timestamp + " [ENDPOINT_EXECUTION] phase=START scope=" + String.valueOf(scope)
                + " endpoint=" + safeEndpointName
                + " trigger=" + safeTrigger
                + " event=" + safeEvent;
    }

    private String detectEndpointState(File endpointFile) {
        try {
            String source = readTextFile(endpointFile);
            String[] lines = source.split("\\r?\\n", -1);
            for (String line : lines) {
                String trimmed = line.trim();
                if (trimmed.startsWith("// @enabled")) {
                    return trimmed.toUpperCase().contains("TRUE") ? "ENABLED" : "DISABLED";
                }
            }
        } catch (Exception ignored) {
            // Keep fallback state.
        }
        return "DISABLED";
    }

    private boolean isAllowedPath(File target) {
        try {
            String canonicalTarget = target.getCanonicalPath();
            String canonicalProjects = getEndpointsDir().getCanonicalPath();
            String canonicalFiles = getContext().getFilesDir().getCanonicalPath();

            return canonicalTarget.startsWith(canonicalProjects + File.separator)
                    || canonicalTarget.equals(canonicalProjects)
                    || canonicalTarget.startsWith(canonicalFiles + File.separator)
                    || canonicalTarget.equals(canonicalFiles);
        } catch (IOException e) {
            return false;
        }
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

    private int readEndpointPosition(File projectDir) {
        if (projectDir == null) {
            return Integer.MAX_VALUE;
        }

        File positionFile = new File(projectDir, "position");
        if (!positionFile.exists()) {
            return Integer.MAX_VALUE;
        }

        try {
            String raw = readTextFile(positionFile).trim();
            int parsed = Integer.parseInt(raw);
            return parsed >= 0 ? parsed : Integer.MAX_VALUE;
        } catch (Exception ignored) {
            return Integer.MAX_VALUE;
        }
    }

    private void writeEndpointPosition(File projectDir, int position) throws IOException {
        if (projectDir == null) {
            throw new IOException("invalid endpoint project");
        }
        int safePosition = Math.max(0, position);
        writeTextFile(new File(projectDir, "position"), safePosition + "\n");
    }

    private String canonicalPathKey(File file) {
        if (file == null) {
            return "";
        }

        try {
            return file.getCanonicalPath();
        } catch (Exception ignored) {
            return file.getAbsolutePath();
        }
    }

    private JSObject buildEndpointInfo(File endpointFile, String projectName) {
        JSObject endpoint = new JSObject();
        endpoint.put("name", projectName + ".ts");
        endpoint.put("path", endpointFile.getAbsolutePath());
        int position = readEndpointPosition(endpointFile.getParentFile());
        endpoint.put("position", position == Integer.MAX_VALUE ? JSONObject.NULL : position);
        File uuidFile = new File(endpointFile.getParentFile(), "uuid");
        String endpointId = "";
        try {
            if (uuidFile.exists()) {
                endpointId = readTextFile(uuidFile).trim().toLowerCase();
            }
        } catch (Exception ignored) {
            endpointId = "";
        }
        endpoint.put("endpointId", endpointId.isEmpty() ? null : endpointId);
        endpoint.put("eventLogPath", new File(endpointFile.getParentFile(), "activity.log").getAbsolutePath());
        endpoint.put("state", "DISABLED");
        endpoint.put("enabled", false);
        endpoint.put("schedule", "");
        endpoint.put("events", new JSArray());
        endpoint.put("triggers", new JSArray());
        endpoint.put("messageSenders", new JSArray());
        endpoint.put("messageFromAnySender", false);
        endpoint.put("debug", false);
        endpoint.put("mutex", false);
        endpoint.put("watch", new JSArray());

        JSArray events = endpoint.opt("events") instanceof JSArray ? (JSArray) endpoint.opt("events") : new JSArray();
        JSArray triggers = endpoint.opt("triggers") instanceof JSArray ? (JSArray) endpoint.opt("triggers") : new JSArray();
        endpoint.put("events", events);
        endpoint.put("triggers", triggers);
        Set<String> seenTriggers = new LinkedHashSet<>();

        try {
            List<String> lines = Files.readAllLines(endpointFile.toPath(), StandardCharsets.UTF_8);
            for (String rawLine : lines) {
                String line = rawLine.trim();
                if (!line.startsWith("// @")) {
                    continue;
                }

                if (line.startsWith("// @enabled")) {
                    boolean enabled = line.toUpperCase().contains("TRUE");
                    endpoint.put("enabled", enabled);
                    endpoint.put("state", enabled ? "ENABLED" : "DISABLED");
                } else if (line.startsWith("// @mutex")) {
                    String mutexUpper = line.toUpperCase();
                    boolean mutex = mutexUpper.contains("TRUE");
                    endpoint.put("mutex", mutex);
                } else if (line.startsWith("// @debug")) {
                    boolean debug = line.toUpperCase().contains("TRUE");
                    endpoint.put("debug", debug);
                } else if (line.startsWith("// @schedule")) {
                    endpoint.put("schedule", line.replace("// @schedule", "").trim());
                } else if (line.startsWith("// @watch")) {
                    JSArray watch = endpoint.opt("watch") instanceof JSArray ? (JSArray) endpoint.opt("watch") : new JSArray();
                    endpoint.put("watch", watch);
                    watch.put(line.replace("// @watch", "").trim());
                } else if (line.startsWith("// @on")) {
                    String rawTrigger = line.replace("// @on", "").trim();
                    if (rawTrigger.isEmpty()) {
                        continue;
                    }

                    int separator = rawTrigger.indexOf('(');
                    if (separator < 0) {
                        separator = rawTrigger.indexOf(' ');
                    }

                    String trigger = (separator >= 0 ? rawTrigger.substring(0, separator) : rawTrigger)
                            .trim()
                            .toUpperCase(Locale.ROOT);
                    if (trigger.isEmpty() || seenTriggers.contains(trigger)) {
                        continue;
                    }

                    seenTriggers.add(trigger);
                    events.put(trigger);
                    triggers.put(trigger);
                }
            }
        } catch (Exception ignored) {
            // Keep defaults if parsing fails.
        }

        return endpoint;
    }

    @PluginMethod
    public void getEndpointsInfo(PluginCall call) {
        try {
            File projectsDir = getEndpointsDir();
            JSArray endpoints = new JSArray();
            File[] children = projectsDir.listFiles();
            if (children != null) {
                List<File> sortedProjects = new ArrayList<>();
                for (File child : children) {
                    if (!child.isDirectory()) {
                        continue;
                    }

                    sortedProjects.add(child);
                }

                sortedProjects.sort((left, right) -> {
                    int leftPosition = readEndpointPosition(left);
                    int rightPosition = readEndpointPosition(right);
                    if (leftPosition != rightPosition) {
                        return Integer.compare(leftPosition, rightPosition);
                    }
                    return String.valueOf(left.getName()).compareToIgnoreCase(String.valueOf(right.getName()));
                });

                for (File child : sortedProjects) {
                    File endpointFile = resolveEndpointFileFromProject(child);
                    if (endpointFile == null) {
                        continue;
                    }

                    endpoints.put(buildEndpointInfo(endpointFile, child.getName()));
                }
            }

            JSObject result = new JSObject();
            result.put("path", projectsDir.getAbsolutePath());
            result.put("endpoints", endpoints);
            call.resolve(result);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void reorderEndpoints(PluginCall call) {
        try {
            JSArray inputPaths = call != null ? call.getArray("paths", new JSArray()) : new JSArray();
            File projectsDir = getEndpointsDir();
            File[] children = projectsDir.listFiles();
            List<File> projectDirs = new ArrayList<>();
            Map<String, File> projectByEndpointPath = new HashMap<>();

            if (children != null) {
                for (File child : children) {
                    if (!child.isDirectory()) {
                        continue;
                    }

                    File endpointFile = resolveEndpointFileFromProject(child);
                    if (endpointFile == null) {
                        continue;
                    }

                    projectDirs.add(child);
                    projectByEndpointPath.put(canonicalPathKey(endpointFile), child);
                }
            }

            List<File> orderedProjects = new ArrayList<>();
            Set<String> seenProjectKeys = new LinkedHashSet<>();

            for (int index = 0; index < inputPaths.length(); index++) {
                String rawPath = String.valueOf(inputPaths.optString(index, "")).trim();
                if (rawPath.isEmpty()) {
                    continue;
                }

                File projectDir = projectByEndpointPath.get(canonicalPathKey(new File(rawPath)));
                if (projectDir == null) {
                    continue;
                }

                String projectKey = canonicalPathKey(projectDir);
                if (seenProjectKeys.contains(projectKey)) {
                    continue;
                }

                seenProjectKeys.add(projectKey);
                orderedProjects.add(projectDir);
            }

            List<File> remainingProjects = new ArrayList<>();
            for (File projectDir : projectDirs) {
                String projectKey = canonicalPathKey(projectDir);
                if (seenProjectKeys.contains(projectKey)) {
                    continue;
                }
                remainingProjects.add(projectDir);
            }

            remainingProjects.sort((left, right) -> {
                int leftPosition = readEndpointPosition(left);
                int rightPosition = readEndpointPosition(right);
                if (leftPosition != rightPosition) {
                    return Integer.compare(leftPosition, rightPosition);
                }
                return String.valueOf(left.getName()).compareToIgnoreCase(String.valueOf(right.getName()));
            });

            for (File projectDir : remainingProjects) {
                String projectKey = canonicalPathKey(projectDir);
                seenProjectKeys.add(projectKey);
                orderedProjects.add(projectDir);
            }

            for (int index = 0; index < orderedProjects.size(); index++) {
                writeEndpointPosition(orderedProjects.get(index), index);
            }

            notifyExchangeProfileUpdated("endpoints-reordered");
            call.resolve(new JSObject().put("ok", true).put("updated", orderedProjects.size()));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void createEndpointFile(PluginCall call) {
        String templateKey = call.getString("templateKey", "blank");
        String requestedName = call.getString("endpointName", "");

        try {
            ensureEndpointTemplatesPresent();
            String safeTemplate = normalizeEndpointTemplateKey(templateKey, "blank");
            String safeRequestedName = String.valueOf(requestedName)
                    .trim()
                    .replaceAll("[^a-zA-Z0-9._-]", "-")
                    .replaceAll("^[._-]+", "")
                    .replaceAll("[._-]+$", "");

            String projectName = safeRequestedName.isEmpty()
                    ? "endpoint-" + safeTemplate + "-" + System.currentTimeMillis()
                    : safeRequestedName;
            File projectDir = new File(getEndpointsDir(), projectName);
            if (projectDir.exists()) {
                throw new IOException("endpoint project already exists");
            }
            if (!projectDir.mkdirs()) {
                throw new IOException("unable to create project directory");
            }

            File uuidFile = new File(projectDir, "uuid");
            File bootFile = new File(projectDir, "boot.ts");
            File contextFile = new File(projectDir, "event.ts");
            File packageJsonFile = new File(projectDir, "package.json");
            File eventLogFile = new File(projectDir, "activity.log");
            String source = readEndpointTemplateFromStorage(safeTemplate);

            String npmSafeName = projectName
                    .toLowerCase()
                    .replaceAll("[^a-z0-9._-]", "-")
                    .replaceAll("^[._-]+", "");
            if (npmSafeName.isEmpty()) {
                npmSafeName = "reactor-endpoint";
            }

            JSONObject packageJson = new JSONObject();
            packageJson.put("name", npmSafeName);
            packageJson.put("version", "1.0.0");
            packageJson.put("private", true);
            packageJson.put("type", "commonjs");
            packageJson.put("main", "boot.ts");
            packageJson.put("description", "Reactor endpoint project: " + projectName);

            writeTextFile(uuidFile, UUID.randomUUID().toString().toLowerCase() + "\n");
            writeTextFile(bootFile, source);
            writeTextFile(contextFile, "export type { Event, ReactorEvent, WatchEvent, MessageEvent, StreamEvent, StreamEndEvent, ScheduleEvent, RuntimeEvent, ManualEvent } from 'core';\n");
            writeTextFile(packageJsonFile, packageJson.toString(2) + "\n");
            writeTextFile(eventLogFile, "");

            String verifyContent = readTextFile(bootFile);
            if (verifyContent.trim().isEmpty()) {
                throw new IOException("endpoint template content not written");
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("path", bootFile.getAbsolutePath());
            result.put("name", projectName + ".ts");
            result.put("storagePath", projectDir.getAbsolutePath());
            notifyExchangeProfileUpdated("endpoint-created");
            call.resolve(result);
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void readEndpointContent(PluginCall call) {
        String filePath = call.getString("filePath");
        if (filePath == null || filePath.isEmpty()) {
            call.resolve(new JSObject().put("ok", false).put("error", "invalid request"));
            return;
        }

        try {
            File file = new File(filePath);
            if (!isAllowedPath(file)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            String lower = file.getName().toLowerCase();
            if (!(lower.endsWith(".ts") || lower.endsWith(".js") || lower.endsWith(".log"))) {
                call.resolve(new JSObject().put("ok", false).put("error", "unsupported file type"));
                return;
            }

            if (!file.exists()) {
                if (lower.endsWith(".log")) {
                    writeTextFile(file, "");
                } else {
                    call.resolve(new JSObject().put("ok", false).put("error", "endpoint file not found"));
                    return;
                }
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("path", file.getAbsolutePath());
            result.put("content", readTextFile(file));
            call.resolve(result);
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void saveEndpointContent(PluginCall call) {
        String filePath = call.getString("filePath");
        String content = call.getString("content", "");

        if (filePath == null || filePath.isEmpty()) {
            call.resolve(new JSObject().put("ok", false).put("error", "invalid request"));
            return;
        }

        try {
            File file = new File(filePath);
            if (!isAllowedPath(file)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            String lower = file.getName().toLowerCase();
            if (!(lower.endsWith(".ts") || lower.endsWith(".js") || lower.endsWith(".log"))) {
                call.resolve(new JSObject().put("ok", false).put("error", "unsupported file type"));
                return;
            }

            writeTextFile(file, content);
            notifyExchangeProfileUpdated("endpoint-saved");

            // Compile TypeScript → boot.compiled.js in background so it's ready on next trigger
            if (lower.endsWith(".ts")) {
                final File tsFile = file;
                final android.content.Context appCtx = getActivity() != null
                    ? getActivity().getApplicationContext() : null;
                if (appCtx != null) {
                    new Thread(() ->
                        ReactorScriptEngine.create(appCtx).compileAndCache(tsFile),
                        "reactor-ts-compile"
                    ).start();
                }
            }

            call.resolve(new JSObject().put("ok", true).put("path", file.getAbsolutePath()));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void resolveEventLogPath(PluginCall call) {
        String filePath = call.getString("filePath", "");

        try {
            File logFile;
            if (filePath == null || filePath.isEmpty()) {
                logFile = getGlobalLogFile();
            } else {
                File endpointFile = new File(filePath);
                File parent = endpointFile.getParentFile();
                if (parent == null) {
                    call.resolve(new JSObject().put("ok", false).put("error", "activity.log path unavailable"));
                    return;
                }
                logFile = new File(parent, "activity.log");
            }

            if (!isAllowedPath(logFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            if (!logFile.exists()) {
                writeTextFile(logFile, "");
            }

            call.resolve(new JSObject().put("ok", true).put("path", logFile.getAbsolutePath()).put("name", logFile.getName()));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void openEventLog(PluginCall call) {
        resolveEventLogPath(call);
    }

    @PluginMethod
    public void clearEventLog(PluginCall call) {
        String filePath = call.getString("filePath", "");

        try {
            File logFile;
            if (filePath == null || filePath.isEmpty()) {
                logFile = getGlobalLogFile();
            } else {
                File endpointFile = new File(filePath);
                File parent = endpointFile.getParentFile();
                if (parent == null) {
                    call.resolve(new JSObject().put("ok", false).put("error", "activity.log path unavailable"));
                    return;
                }
                logFile = new File(parent, "activity.log");
            }

            if (!isAllowedPath(logFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            writeTextFile(logFile, "");
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void renameEndpointFile(PluginCall call) {
        String filePath = call.getString("filePath", "");
        String nextName = call.getString("nextName", "");

        try {
            File endpointFile = new File(filePath);
            if (!isAllowedPath(endpointFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            String safeNextName = String.valueOf(nextName)
                    .trim()
                    .replaceAll("[^a-zA-Z0-9._-]", "-")
                    .replaceAll("^[._-]+", "")
                    .replaceAll("[._-]+$", "");

            if (safeNextName.isEmpty()) {
                call.resolve(new JSObject().put("ok", false).put("error", "invalid endpoint name"));
                return;
            }

            File projectDir = endpointFile.getParentFile();
            if (projectDir == null || !projectDir.exists()) {
                call.resolve(new JSObject().put("ok", false).put("error", "endpoint project not found"));
                return;
            }

            File projectsDir = getEndpointsDir();
            File destinationDir = new File(projectsDir, safeNextName);
            if (destinationDir.exists()) {
                call.resolve(new JSObject().put("ok", false).put("error", "endpoint project already exists"));
                return;
            }

            Files.move(projectDir.toPath(), destinationDir.toPath(), StandardCopyOption.ATOMIC_MOVE);

            File movedEndpoint = new File(destinationDir, endpointFile.getName());
            if (!movedEndpoint.exists()) {
                File bootTs = new File(destinationDir, "boot.ts");
                File bootJs = new File(destinationDir, "boot.js");
                movedEndpoint = bootTs.exists() ? bootTs : bootJs;
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("path", movedEndpoint.getAbsolutePath());
            result.put("name", safeNextName + ".ts");
            notifyExchangeProfileUpdated("endpoint-renamed");
            call.resolve(result);
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void deleteEndpointFile(PluginCall call) {
        String filePath = call.getString("filePath", "");

        try {
            File endpointFile = new File(filePath);
            if (!isAllowedPath(endpointFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            File projectDir = endpointFile.getParentFile();
            if (projectDir == null || !projectDir.exists()) {
                call.resolve(new JSObject().put("ok", false).put("error", "endpoint project not found"));
                return;
            }

            deleteRecursively(projectDir.toPath());
            notifyExchangeProfileUpdated("endpoint-deleted");
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void toggleEndpointDirective(PluginCall call) {
        String filePath = call.getString("filePath", "");
        String directive = String.valueOf(call.getString("directive", "")).trim().toLowerCase();

        try {
            File endpointFile = new File(filePath);
            if (!isAllowedPath(endpointFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            String lower = endpointFile.getName().toLowerCase();
            if (!(lower.endsWith(".ts") || lower.endsWith(".js"))) {
                call.resolve(new JSObject().put("ok", false).put("error", "unsupported file type"));
                return;
            }

            String source = readTextFile(endpointFile);
            String[] lines = source.split("\\r?\\n", -1);
            boolean found = false;
            String nextValue;

            if ("state".equals(directive)) {
                nextValue = "TRUE";
                for (int i = 0; i < lines.length; i++) {
                    String trimmed = lines[i].trim();
                    if (trimmed.startsWith("// @enabled")) {
                        found = true;
                        boolean enabled = trimmed.toUpperCase().contains("TRUE");
                        nextValue = enabled ? "FALSE" : "TRUE";
                        lines[i] = "// @enabled " + nextValue;
                        break;
                    }
                }
                if (!found) {
                    source = "// @enabled TRUE\n" + source;
                    nextValue = "TRUE";
                } else {
                    source = String.join("\n", lines);
                }

                writeTextFile(endpointFile, source);
                notifyExchangeProfileUpdated("endpoint-directive-toggled");
                call.resolve(new JSObject().put("ok", true).put("directive", "state").put("value", nextValue));
                return;
            }

            if ("mutex".equals(directive)) {
                nextValue = "TRUE";
                for (int i = 0; i < lines.length; i++) {
                    String trimmed = lines[i].trim();
                    if (trimmed.startsWith("// @mutex")) {
                        found = true;
                        String mutexUpper = trimmed.toUpperCase();
                        boolean on = mutexUpper.contains("TRUE");
                        nextValue = on ? "FALSE" : "TRUE";
                        lines[i] = "// @mutex " + nextValue;
                        break;
                    }
                }
                if (!found) {
                    source = "// @mutex TRUE\n" + source;
                    nextValue = "TRUE";
                } else {
                    source = String.join("\n", lines);
                }

                writeTextFile(endpointFile, source);
                notifyExchangeProfileUpdated("endpoint-directive-toggled");
                call.resolve(new JSObject().put("ok", true).put("directive", "mutex").put("value", nextValue));
                return;
            }

            if ("debug".equals(directive)) {
                nextValue = "TRUE";
                for (int i = 0; i < lines.length; i++) {
                    String trimmed = lines[i].trim();
                    if (trimmed.startsWith("// @debug")) {
                        found = true;
                        String debugUpper = trimmed.toUpperCase();
                        boolean on = debugUpper.contains("TRUE");
                        nextValue = on ? "FALSE" : "TRUE";
                        lines[i] = "// @debug " + nextValue;
                        break;
                    }
                }
                if (!found) {
                    source = "// @debug TRUE\n" + source;
                    nextValue = "TRUE";
                } else {
                    source = String.join("\n", lines);
                }

                writeTextFile(endpointFile, source);
                notifyExchangeProfileUpdated("endpoint-directive-toggled");
                call.resolve(new JSObject().put("ok", true).put("directive", "debug").put("value", nextValue));
                return;
            }

            call.resolve(new JSObject().put("ok", false).put("error", "invalid directive"));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void runEndpointNow(PluginCall call) {
        String filePath = call.getString("filePath", "");

        if (filePath == null || filePath.isEmpty()) {
            call.resolve(new JSObject().put("ok", false).put("error", "invalid request"));
            return;
        }

        try {
            File endpointFile = new File(filePath);
            if (!isAllowedPath(endpointFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            String lower = endpointFile.getName().toLowerCase();
            if (!(lower.endsWith(".ts") || lower.endsWith(".js"))) {
                call.resolve(new JSObject().put("ok", false).put("error", "unsupported file type"));
                return;
            }

            if (!endpointFile.exists()) {
                call.resolve(new JSObject().put("ok", false).put("error", "endpoint file not found"));
                return;
            }
            JSObject result = ReactorHttpService.runEndpointNowByPath(endpointFile.getAbsolutePath());
            call.resolve(result != null ? result : new JSObject().put("ok", false).put("error", "runtime not ready"));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    private void deleteRecursively(Path target) throws IOException {
        if (!Files.exists(target)) {
            return;
        }

        try (Stream<Path> stream = Files.walk(target)) {
            stream.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // Ignore partial delete failures.
                }
            });
        }
    }

    @PluginMethod
    public void getUiSettings(PluginCall call) {
        JSObject result = new JSObject();
        result.put("defaultProgramPath", "");
        result.put("httpServerPort", getConfiguredHttpPort());
        call.resolve(result);
    }

    @PluginMethod
    public void getHttpServerConfig(PluginCall call) {
        ensureHttpServerRunning();

        JSObject config = new JSObject();
        config.put("port", ReactorHttpService.getCurrentPort());
        config.put("active", ReactorHttpService.isRunning());
        config.put("reactorName", getConfiguredReactorName());
        call.resolve(new JSObject().put("ok", true).put("config", config));
    }

    @PluginMethod
    public void stopBackgroundProcess(PluginCall call) {
        try {
            ReactorServiceWatchdogWorker.cancel(getContext());
            stopHttpService();
            call.resolve(new JSObject()
                    .put("ok", true)
                    .put("platform", "android")
                    .put("stopped", true));
        } catch (Exception e) {
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("error", e.getMessage() != null ? e.getMessage() : "unable to stop background process"));
        }
    }

    @PluginMethod
    public void copyTextToClipboard(PluginCall call) {
        String text = call.getString("text", "");
        try {
            ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null) {
                call.resolve(new JSObject().put("ok", false).put("error", "clipboard unavailable"));
                return;
            }

            ClipData clip = ClipData.newPlainText("Reactor", text != null ? text : "");
            clipboard.setPrimaryClip(clip);
            call.resolve(new JSObject().put("ok", true).put("copied", true));
        } catch (Exception e) {
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("error", e.getMessage() != null ? e.getMessage() : "unable to copy text"));
        }
    }

    @PluginMethod
    public void setHttpServerPort(PluginCall call) {
        int port = call.getInt("port", DEFAULT_HTTP_PORT);
        if (port < 1 || port > 65535) {
            call.resolve(new JSObject().put("ok", false).put("error", "invalid HTTP server port"));
            return;
        }

        try {
            setConfiguredHttpPort(port);
            stopHttpService();
            startHttpService(port);

            JSObject config = new JSObject();
            config.put("port", port);
            config.put("active", true);
            config.put("reactorName", getConfiguredReactorName());
            call.resolve(new JSObject().put("ok", true).put("config", config));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void openServerStatus(PluginCall call) {
        ensureHttpServerRunning();

        int port = ReactorHttpService.getCurrentPort();
        if (port < 1 || port > 65535) {
            port = getConfiguredHttpPort();
        }
        if (port < 1 || port > 65535) {
            port = DEFAULT_HTTP_PORT;
        }

        String targetUrl = "http://127.0.0.1:" + port;
        boolean opened = false;
        String openError = null;

        try {
            Intent viewIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl));
            viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(viewIntent);
            opened = true;
        } catch (Exception error) {
            openError = error.getMessage();
            Log.e(TAG, "Unable to open server status URL", error);
        }

        JSObject config = new JSObject();
        config.put("port", port);
        config.put("active", ReactorHttpService.isRunning());
        config.put("reactorName", getConfiguredReactorName());

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("url", targetUrl);
        result.put("opened", opened);
        result.put("config", config);
        if (openError != null && !openError.isEmpty()) {
            result.put("warning", openError);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void getReactorName(PluginCall call) {
        call.resolve(new JSObject().put("ok", true).put("name", getConfiguredReactorName()));
    }

    @PluginMethod
    public void setReactorName(PluginCall call) {
        String name = call.getString("name", "mobile-reactor");
        setConfiguredReactorName(name);
        ReactorHttpService.refreshExchangeClientProfile("reactor-name-updated");
        ReactorHttpService.reconnectExchangeClient("reactor-name-updated");
        call.resolve(new JSObject().put("ok", true).put("name", name));
    }

    @PluginMethod
    public void getMessageQueueStatus(PluginCall call) {
        try {
            JSObject queue = ReactorHttpService.getOutgoingQueueStatus();
            call.resolve(new JSObject().put("ok", true).put("queue", queue));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void setMessageQueueTtlDays(PluginCall call) {
        double ttlDays = call.getDouble("ttlDays", 7.0);
        try {
            ReactorHttpService.setOutgoingQueueTtlDays(ttlDays);
            JSObject queue = ReactorHttpService.getOutgoingQueueStatus();
            call.resolve(new JSObject().put("ok", true).put("queue", queue));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void flushMessageQueue(PluginCall call) {
        try {
            ReactorHttpService.flushOutgoingQueueNow();
            JSObject queue = ReactorHttpService.getOutgoingQueueStatus();
            call.resolve(new JSObject().put("ok", true).put("queue", queue));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void clearMessageQueue(PluginCall call) {
        try {
            ReactorHttpService.clearOutgoingQueueNow();
            JSObject queue = ReactorHttpService.getOutgoingQueueStatus();
            call.resolve(new JSObject().put("ok", true).put("queue", queue));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    private JSObject buildExchangeConnectionStatus(String mode, String host) {
        String safeMode = String.valueOf(mode != null ? mode : "node").trim();
        String safeHost = String.valueOf(host != null ? host : "").trim();

        JSObject connection = new JSObject();
        connection.put("mode", safeMode);

        if ("exchange".equals(safeMode)) {
            boolean connected = ReactorHttpService.isExchangeServerActive();
            connection.put("state", connected ? "connected" : "disconnected");
            connection.put("connected", connected);
            connection.put("authenticated", true);
            connection.put("reason", "");
            connection.put("errorType", "");
            return connection;
        }

        if ("node".equals(safeMode)) {
            boolean socketConnected = ReactorHttpService.isExchangeClientConnected();
            boolean connected = ReactorHttpService.isExchangeClientAuthenticated();
            boolean connecting = ReactorHttpService.isExchangeClientConnecting();
            String reason = String.valueOf(ReactorHttpService.getExchangeClientLastError()).trim();
            if (reason.isEmpty()) {
                reason = String.valueOf(ReactorHttpService.getExchangeClientLastCloseReason()).trim();
            }
            String errorType = classifyExchangeFailureType(reason, ReactorHttpService.getExchangeClientLastCloseCode());
            String state = connected
                    ? "connected"
                    : (socketConnected
                        ? ("authentication".equals(errorType) ? "auth-failed" : "connecting")
                        : (connecting ? "connecting" : ("authentication".equals(errorType) ? "auth-failed" : "disconnected")));
            if (reason.isEmpty()) {
                reason = connected ? "" : (socketConnected ? "waiting for exchange registration" : (connecting ? "Connecting to Exchange" : "Exchange connection unavailable"));
            }
            connection.put("state", state);
            connection.put("connected", connected);
            connection.put("authenticated", connected);
            connection.put("reason", reason);
            connection.put("errorType", connected ? "" : errorType);
            return connection;
        }

        connection.put("state", "disconnected");
        connection.put("connected", false);
        connection.put("authenticated", false);
        connection.put("reason", "Exchange connection unavailable");
        connection.put("errorType", "connection");
        return connection;
    }

    @PluginMethod
    public void getExchangeConfig(PluginCall call) {
        JSObject workingMode = readWorkingModeConfig();
        String mode = workingMode.getString("mode", "node");
        String host = workingMode.getString("host", "");
        int port = workingMode.getInteger("port", ReactorHttpService.DEFAULT_PORT);
        boolean tls = workingMode.has("tls") && workingMode.getBool("tls");
        String token = workingMode.getString("token", "");
        boolean discovery = workingMode.has("discovery") && workingMode.getBool("discovery");

        JSObject connection = buildExchangeConnectionStatus(ReactorHttpService.getCurrentExchangeMode(), host);
        boolean active = connection.getBool("connected");

        JSArray connectedClients = new JSArray();
        for (String clientName : ReactorHttpService.getExchangeConnectedClients()) {
            connectedClients.put(clientName);
        }

        JSObject config = new JSObject();
        config.put("mode", mode);
        config.put("host", host);
        config.put("port", port);
        config.put("tls", tls);
        config.put("token", token);
        config.put("discovery", discovery);
        config.put("stun", normalizeRelayConfigFromJson(workingMode, "stun", 3478, false));
        config.put("turn", normalizeRelayConfigFromJson(workingMode, "turn", 3478, true));
        config.put("p2p", ReactorHttpService.getP2PStatus());
        config.put("active", active);
        config.put("connection", connection);
        config.put("connectedClients", connectedClients);

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("config", config);
        call.resolve(result);
    }

    private JSObject fetchExchangeLinkedNodesSnapshot() {
        JSObject workingMode = readWorkingModeConfig();
        String mode = workingMode.getString("mode", "node");
        String host = workingMode.getString("host", "").trim();
        int port = workingMode.getInteger("port", ReactorHttpService.DEFAULT_PORT);
        boolean tls = workingMode.has("tls") && workingMode.getBool("tls");
        String token = workingMode.getString("token", "").trim();

        if (!"node".equals(mode)) {
            return new JSObject().put("ok", false).put("error", "available only in node mode").put("nodes", new JSArray()).put("total", 0);
        }

        if (host.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "exchange host is not configured").put("nodes", new JSArray()).put("total", 0);
        }

        if (token.isEmpty()) {
            return new JSObject().put("ok", false).put("error", "exchange token is not configured").put("nodes", new JSArray()).put("total", 0);
        }

        if (port < 1 || port > 65535) {
            port = ReactorHttpService.DEFAULT_PORT;
        }

        String endpointUrl = (tls ? "https" : "http") + "://" + host + ":" + port + "/nodes";
        HttpURLConnection connection = null;
        try {
            URL url = new URL(endpointUrl);
            connection = (HttpURLConnection) url.openConnection();

            connection.setRequestMethod("GET");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);

            int status = connection.getResponseCode();
            String body = readHttpResponseBody(connection, status);

            JSONObject parsed = null;
            try {
                parsed = body == null || body.isEmpty() ? null : new JSONObject(body);
            } catch (Exception ignored) {
                parsed = null;
            }

            if (status != 200 || parsed == null || !parsed.optBoolean("ok", false)) {
                String error = parsed != null ? parsed.optString("error", "") : "";
                if (error == null || error.trim().isEmpty()) {
                    error = "exchange discovery request failed (" + status + ")";
                }
                return new JSObject().put("ok", false).put("error", error).put("nodes", new JSArray()).put("total", 0);
            }

            JSONArray parsedNodes = parsed.optJSONArray("nodes");
            JSArray filteredNodes = new JSArray();
            int total = 0;

            if (parsedNodes != null) {
                for (int index = 0; index < parsedNodes.length(); index += 1) {
                    JSONObject node = parsedNodes.optJSONObject(index);
                    if (node == null) {
                        continue;
                    }

                    filteredNodes.put(node);
                    total += 1;
                }
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("mode", mode);
            result.put("endpoint", endpointUrl);
            result.put("generatedAt", parsed.optString("generatedAt", Instant.now().toString()));
            result.put("total", total);
            result.put("nodes", filteredNodes);
            return result;
        } catch (Exception error) {
            String detail = error.getMessage() != null ? error.getMessage() : "exchange discovery request failed";
            if (tls) {
                detail = formatTlsCertificateError(error);
            }
            return new JSObject().put("ok", false).put("error", detail).put("nodes", new JSArray()).put("total", 0);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    @PluginMethod
    public void getExchangeLinkedNodes(PluginCall call) {
        call.resolve(fetchExchangeLinkedNodesSnapshot());
    }

    @PluginMethod
    public void setExchangeConfig(PluginCall call) {
        String mode = sanitizeWorkingMode(call.getString("mode", "node"));
        String host = call.getString("host", "");
        int port = call.getInt("port", ReactorHttpService.DEFAULT_PORT);
        boolean tls = call.getBoolean("tls", false);
        String token = call.getString("token", "");
        boolean discovery = call.getBoolean("discovery", false);
        JSObject stun = normalizeRelayConfig(call.getObject("stun"), 3478, false);
        JSObject turn = normalizeRelayConfig(call.getObject("turn"), 3478, true);

        if ("client".equals(mode)) {
            mode = "node";
        }

        if (!mode.equals("node") && !mode.equals("exchange")) {
            JSObject err = new JSObject();
            err.put("ok", false);
            err.put("error", "invalid mode: use node or exchange");
            call.resolve(err);
            return;
        }
        if (port < 1 || port > 65535) {
            port = ReactorHttpService.DEFAULT_PORT;
        }

        SharedPreferences.Editor editor = getContext()
                .getSharedPreferences(ReactorHttpService.PREFS_NAME, Context.MODE_PRIVATE).edit();
        editor.putString(ReactorHttpService.PREF_EXCHANGE_MODE, mode);
        editor.putString(ReactorHttpService.PREF_EXCHANGE_HOST, host != null ? host : "");
        editor.putInt(ReactorHttpService.PREF_EXCHANGE_PORT, port);
        editor.putBoolean(ReactorHttpService.PREF_EXCHANGE_TLS, tls);
        editor.putString(ReactorHttpService.PREF_EXCHANGE_TOKEN, token != null ? token : "");
        editor.apply();

        try {
            writeWorkingModeConfig(mode, host, port, tls, token, discovery, stun, turn);
        } catch (Exception ignored) {
            // Keep prefs as fallback cache even if file write fails.
        }

		startHttpService(getConfiguredHttpPort());

        JSObject connectionTest = waitForExchangeClientConnection(12000L);

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("config", new JSObject()
                .put("mode", mode)
                .put("host", host)
                .put("port", port)
                .put("tls", tls)
                .put("token", token)
                .put("discovery", discovery)
                .put("stun", stun)
                .put("turn", turn)
        .put("active", ReactorHttpService.isExchangeClientAuthenticated()));
		result.put("connectionTest", connectionTest);
        call.resolve(result);
    }

    @PluginMethod
    public void saveRelayConfig(PluginCall call) {
        String kind = String.valueOf(call.getString("kind", "")).trim().toLowerCase();
        JSObject input = call.getObject("config");
        if (!"stun".equals(kind) && !"turn".equals(kind)) {
            call.resolve(new JSObject().put("ok", false).put("error", "invalid relay kind"));
            return;
        }

        JSObject nextRelay = normalizeRelayConfig(input, 3478, "turn".equals(kind));
        if ("stun".equals(kind)) {
            nextRelay.put("tls", false);
        }

        try {
            JSObject current = readWorkingModeConfig();
            JSObject stun = "stun".equals(kind)
                    ? nextRelay
                    : normalizeRelayConfigFromJson(current, "stun", 3478, false);
            JSObject turn = "turn".equals(kind)
                    ? nextRelay
                    : normalizeRelayConfigFromJson(current, "turn", 3478, true);

            writeWorkingModeConfig(
                    current.getString("mode", "node"),
                    current.getString("host", ""),
                    current.getInteger("port", ReactorHttpService.DEFAULT_PORT),
                    current.optBoolean("tls", false),
                    current.getString("token", ""),
                    current.optBoolean("discovery", false),
                    stun,
                    turn
            );

            JSObject test = testRelayEndpoint(kind, nextRelay);
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("kind", kind);
            result.put("config", nextRelay);
            result.put("test", test);
            call.resolve(result);
        } catch (Exception error) {
            call.resolve(new JSObject().put("ok", false).put("error", error.getMessage() != null ? error.getMessage() : "unable to save relay config"));
        }
    }

    @PluginMethod
    public void getP2PStatus(PluginCall call) {
        call.resolve(new JSObject().put("ok", true).put("p2p", ReactorHttpService.getP2PStatus()));
    }

    @PluginMethod
    public void sendP2PSignal(PluginCall call) {
        String target = call.getString("target", "");
        String signalType = call.getString("signalType", "");
        String sessionId = call.getString("sessionId", "");
        JSObject payload = call.getObject("payload");
        JSObject result = ReactorHttpService.sendP2PSignal(target, signalType, payload, sessionId);
        call.resolve(result);
    }

    @PluginMethod
    public void startP2PSession(PluginCall call) {
        String target = call.getString("target", "");
        boolean initiator = call.getBoolean("initiator", true);
        JSObject workingMode = readWorkingModeConfig();

        if (nativeP2PManager == null) {
            nativeP2PManager = AndroidP2PWebRtcManager.getInstance(getContext());
            nativeP2PManager.initialize();
        }

        AndroidP2PWebRtcManager.RelayConfig relayConfig = AndroidP2PWebRtcManager.fromWorkingMode(workingMode);
        JSObject result = nativeP2PManager.startSession(target, initiator, relayConfig);
        call.resolve(result);
    }

    @PluginMethod
    public void sendP2PData(PluginCall call) {
        String target = call.getString("target", "");
        String text = call.getString("text", "");

        if (nativeP2PManager == null) {
            nativeP2PManager = AndroidP2PWebRtcManager.getInstance(getContext());
            nativeP2PManager.initialize();
        }

        JSObject result = nativeP2PManager.sendData(target, text);
        call.resolve(result);
    }

    @PluginMethod
    public void requestRemoteEndpointsP2P(PluginCall call) {
        String target = call.getString("target", "");
        long timeoutMs = call.getLong("timeoutMs", (long) resolveTimeoutFromEnv(ENV_P2P_REMOTE_ENDPOINTS_TIMEOUT_MS, P2P_REMOTE_ENDPOINTS_TIMEOUT_MS));
        JSObject workingMode = readWorkingModeConfig();
        String safeTarget = String.valueOf(target == null ? "" : target).trim().toLowerCase(Locale.ROOT);

        if (safeTarget.isEmpty()) {
            call.resolve(new JSObject().put("ok", false).put("error", "invalid p2p target"));
            return;
        }

        if (nativeP2PManager == null) {
            nativeP2PManager = AndroidP2PWebRtcManager.getInstance(getContext());
            nativeP2PManager.initialize();
        }

        AndroidP2PWebRtcManager.RelayConfig relayConfig = AndroidP2PWebRtcManager.fromWorkingMode(workingMode);
        JSObject p2pResult = nativeP2PManager.requestRemoteEndpoints(safeTarget, relayConfig, timeoutMs);
        if (p2pResult != null && p2pResult.optBoolean("ok", false)) {
            p2pResult.put("source", "p2p-datachannel");
            call.resolve(p2pResult);
            return;
        }

        String p2pError = p2pResult != null
                ? String.valueOf(p2pResult.optString("error", "p2p endpoints request failed"))
                : "p2p endpoints request failed";

        JSObject exchangeSnapshot = fetchExchangeLinkedNodesSnapshot();
        if (exchangeSnapshot == null || !exchangeSnapshot.optBoolean("ok", false)) {
            String fallbackError = exchangeSnapshot != null
                    ? String.valueOf(exchangeSnapshot.optString("error", "exchange fallback unavailable"))
                    : "exchange fallback unavailable";
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("error", p2pError)
                    .put("fallbackError", fallbackError));
            return;
        }

        JSONArray nodes = exchangeSnapshot.optJSONArray("nodes");
        JSONObject targetNode = null;
        if (nodes != null) {
            for (int index = 0; index < nodes.length(); index += 1) {
                JSONObject node = nodes.optJSONObject(index);
                if (node == null) {
                    continue;
                }

                String nodeName = String.valueOf(node.optString("name", "")).trim().toLowerCase(Locale.ROOT);
                if (safeTarget.equals(nodeName)) {
                    targetNode = node;
                    break;
                }
            }
        }

        if (targetNode == null) {
            call.resolve(new JSObject()
                    .put("ok", false)
                    .put("error", "target node not found on exchange discovery: " + safeTarget)
                    .put("p2pError", p2pError));
            return;
        }

        JSONArray rawEndpoints = targetNode.optJSONArray("endpoints");
        JSArray endpoints = new JSArray();
        if (rawEndpoints != null) {
            for (int index = 0; index < rawEndpoints.length(); index += 1) {
                Object endpoint = rawEndpoints.opt(index);
                if (endpoint == null) {
                    continue;
                }
                endpoints.put(endpoint);
            }
        }

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("target", safeTarget);
        result.put("node", safeTarget);
        result.put("source", "exchange-discovery");
        result.put("endpoints", endpoints);
        result.put("generatedAt", exchangeSnapshot.optString("generatedAt", Instant.now().toString()));
        result.put("fallback", true);
        result.put("p2pError", p2pError);
        call.resolve(result);
    }

    @PluginMethod
    public void closeP2PSession(PluginCall call) {
        String target = call.getString("target", "");
        String sessionId = call.getString("sessionId", "");
        JSObject payload = call.getObject("payload");
        JSObject nativeResult = null;
        if (nativeP2PManager != null) {
            nativeResult = nativeP2PManager.closeSession(target);
        }
        JSObject result = ReactorHttpService.closeP2PSession(target, sessionId, payload);
        result.put("native", nativeResult != null ? nativeResult : JSONObject.NULL);
        call.resolve(result);
    }

    @PluginMethod
    public void getExchangeToken(PluginCall call) {
        JSObject config = readWorkingModeConfig();
        String token = config.getString("token", "");
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("exchangeToken", new JSObject()
                .put("exists", token != null && !token.isEmpty())
                .put("token", token)
                .put("path", getWorkingModeFile().getAbsolutePath()));
        call.resolve(result);
    }

    @PluginMethod
    public void generateExchangeToken(PluginCall call) {
        try {
            byte[] randomBytes = new byte[32];
            new SecureRandom().nextBytes(randomBytes);
            String token = Base64.encodeToString(randomBytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);

            JSObject currentConfig = readWorkingModeConfig();
            writeWorkingModeConfig(
                currentConfig.getString("mode", "node"),
                currentConfig.getString("host", ""),
                currentConfig.getInteger("port", ReactorHttpService.DEFAULT_PORT),
                currentConfig.has("tls") && currentConfig.getBool("tls"),
                token,
                currentConfig.has("discovery") && currentConfig.getBool("discovery")
            );

            SharedPreferences.Editor editor = getContext()
                    .getSharedPreferences(ReactorHttpService.PREFS_NAME, Context.MODE_PRIVATE).edit();
            editor.putString(ReactorHttpService.PREF_EXCHANGE_TOKEN, token);
            editor.apply();

            startHttpService(getConfiguredHttpPort());

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("exchangeToken", new JSObject()
                    .put("exists", true)
                    .put("token", token)
                    .put("path", getWorkingModeFile().getAbsolutePath()));
            call.resolve(result);
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void exportBackup(PluginCall call) {
        try {
            writeUiSettingsSnapshot();

            boolean includeConnections = call.getBoolean("includeConnections", true);
            boolean includeEndpoints = call.getBoolean("includeEndpoints", true);
            boolean endpointSelectionProvided = call.getBoolean("endpointSelectionProvided", false);
            List<String> requestedEndpointPaths = getRequestedBackupEndpointPaths(call);
            List<File> selectedEndpointDirs = resolveSelectedEndpointExportDirs(requestedEndpointPaths);

            String timestamp = String.valueOf(System.currentTimeMillis());
            File target = new File(getContext().getCacheDir(), "reactor-backup-" + timestamp + ".zip");

            try (ZipOutputStream output = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(target)))) {
                for (File source : getBackupSourceEntries(includeConnections, includeEndpoints, endpointSelectionProvided, selectedEndpointDirs)) {
                    addPathToZip(output, source);
                }

                String meta = new JSObject()
                        .put("createdAt", Instant.now().toString())
                        .put("format", "reactor-backup-v1")
                        .toString();
                output.putNextEntry(new ZipEntry("backup-meta.json"));
                output.write(meta.getBytes(StandardCharsets.UTF_8));
                output.closeEntry();
            }

            pendingBackupExportFile = target;

            Intent pickerIntent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            pickerIntent.addCategory(Intent.CATEGORY_OPENABLE);
            pickerIntent.setType("application/zip");
            pickerIntent.putExtra(Intent.EXTRA_TITLE, target.getName());
            pickerIntent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            pickerIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            pickerIntent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(call, pickerIntent, "handleBackupExportPicker");
        } catch (Exception e) {
            if (pendingBackupExportFile != null && pendingBackupExportFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                pendingBackupExportFile.delete();
            }
            pendingBackupExportFile = null;
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @ActivityCallback
    private void handleBackupExportPicker(PluginCall call, ActivityResult activityResult) {
        if (call == null) {
            cleanupPendingExportBackup();
            return;
        }

        if (activityResult == null || activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null) {
            cleanupPendingExportBackup();
            call.resolve(new JSObject().put("ok", false).put("canceled", true));
            return;
        }

        Uri pickedUri = activityResult.getData().getData();
        if (pickedUri == null) {
            cleanupPendingExportBackup();
            call.resolve(new JSObject().put("ok", false).put("error", "invalid export destination"));
            return;
        }

        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    pickedUri,
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (Exception ignored) {
            // Some providers don't support persisted permissions.
        }

        File exportFile = pendingBackupExportFile;
        if (exportFile == null || !exportFile.exists() || !exportFile.isFile()) {
            cleanupPendingExportBackup();
            call.resolve(new JSObject().put("ok", false).put("error", "backup ZIP not found"));
            return;
        }

        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(exportFile))) {
            try (java.io.OutputStream output = getContext().getContentResolver().openOutputStream(pickedUri, "w")) {
                if (output == null) {
                    call.resolve(new JSObject().put("ok", false).put("error", "unable to open export destination"));
                    return;
                }

                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                }
                output.flush();
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("path", pickedUri.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        } finally {
            cleanupPendingExportBackup();
        }
    }

    @PluginMethod
    public void importBackup(PluginCall call) {
        Intent pickerIntent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pickerIntent.addCategory(Intent.CATEGORY_OPENABLE);
        pickerIntent.setType("*/*");
        pickerIntent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/zip", "application/x-zip-compressed"});
        pickerIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        pickerIntent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, pickerIntent, "handleBackupImportPicker");
    }

    @ActivityCallback
    private void handleBackupImportPicker(PluginCall call, ActivityResult activityResult) {
        if (call == null) {
            return;
        }

        if (activityResult == null || activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null) {
            call.resolve(new JSObject().put("ok", false).put("canceled", true));
            return;
        }

        Uri pickedUri = activityResult.getData().getData();
        if (pickedUri == null) {
            call.resolve(new JSObject().put("ok", false).put("error", "invalid backup selection"));
            return;
        }

        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    pickedUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (Exception ignored) {
            // Some providers don't support persisted permissions.
        }

        File importedZip = null;
        try {
            importedZip = File.createTempFile("reactor-backup-import-", ".zip", getContext().getCacheDir());
            try (BufferedInputStream input = new BufferedInputStream(getContext().getContentResolver().openInputStream(pickedUri));
                 FileOutputStream output = new FileOutputStream(importedZip, false)) {
                if (input == null) {
                    call.resolve(new JSObject().put("ok", false).put("error", "unable to read selected ZIP"));
                    return;
                }

                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                }
            }

            JSObject result = importBackupFromZip(importedZip);
            call.resolve(result);
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        } finally {
            if (importedZip != null && importedZip.exists()) {
                //noinspection ResultOfMethodCallIgnored
                importedZip.delete();
            }
        }
    }

    private JSObject importBackupFromZip(File zipFile) {
        try {
            if (!zipFile.exists() || !zipFile.isFile()) {
                return new JSObject().put("ok", false).put("error", "backup ZIP not found");
            }

            List<String> clearedRoots = new ArrayList<>();
            try (ZipInputStream input = new ZipInputStream(new BufferedInputStream(new FileInputStream(zipFile)))) {
                ZipEntry entry;
                byte[] buffer = new byte[8192];

                while ((entry = input.getNextEntry()) != null) {
                    if (entry.isDirectory()) {
                        input.closeEntry();
                        continue;
                    }

                    File target = resolveSafeBackupTarget(entry.getName());
                    if (target == null) {
                        input.closeEntry();
                        continue;
                    }

                    String root = entry.getName().replace('\\', '/').replaceAll("^/+", "").split("/")[0];
                    if (!clearedRoots.contains(root)) {
                        File rootTarget = new File(getContext().getFilesDir(), root);
                        if (rootTarget.exists()) {
                            deleteRecursively(rootTarget.toPath());
                        }
                        clearedRoots.add(root);
                    }

                    File parent = target.getParentFile();
                    if (parent != null && !parent.exists()) {
                        parent.mkdirs();
                    }

                    try (FileOutputStream output = new FileOutputStream(target, false)) {
                        int read;
                        while ((read = input.read(buffer)) != -1) {
                            output.write(buffer, 0, read);
                        }
                    }

                    input.closeEntry();
                }
            }

            applyRuntimeStateAfterBackupImport();

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("path", zipFile.getAbsolutePath());
            return result;
        } catch (Exception e) {
            return new JSObject().put("ok", false).put("error", e.getMessage());
        }
    }

    private void cleanupPendingExportBackup() {
        if (pendingBackupExportFile != null && pendingBackupExportFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            pendingBackupExportFile.delete();
        }
        pendingBackupExportFile = null;
    }
}
