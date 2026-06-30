package com.reactor.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.activity.result.ActivityResult;

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
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.net.HttpURLConnection;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "ReactorMobile")
public class ReactorMobilePlugin extends Plugin {

    private static final int DEFAULT_HTTP_PORT = 7070;
    private static final String TAG = "ReactorMobilePlugin";
    private static final String WORKING_MODE_FILE = "working-mode.json";
    private static final String REACTOR_NAME_FILE = "name";
    private File pendingBackupExportFile = null;
    private AndroidP2PWebRtcManager nativeP2PManager;

    @Override
    public void load() {
        super.load();
        nativeP2PManager = AndroidP2PWebRtcManager.getInstance(getContext());
        nativeP2PManager.initialize();
        ensureHttpServerRunning();
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
        getPrefs().edit().putString(ReactorHttpService.PREF_REACTOR_NAME, name).apply();
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
        config.put("stun", new JSObject().put("host", "").put("port", 3478).put("tls", false));
        config.put("turn", new JSObject().put("host", "").put("port", 3478).put("tls", false));
        return config;
    }

    private JSObject normalizeRelayConfig(JSObject source, int defaultPort, boolean allowTls) {
        JSObject input = source != null ? source : new JSObject();
        String host = String.valueOf(input.optString("host", "")).trim();

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
        return new JSObject().put("host", host).put("port", port).put("tls", tls);
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
        JSObject stun = normalizeRelayConfigFromJson(new JSONObject().put("stun", stunRaw != null ? stunRaw : new JSONObject()), "stun", 3478, false);
        JSObject turn = normalizeRelayConfigFromJson(new JSONObject().put("turn", turnRaw != null ? turnRaw : new JSONObject()), "turn", 3478, true);
        return writeWorkingModeConfig(mode, host, port, tls, token, discovery, stun, turn);
    }

    private JSObject testUdpRelay(String host, int port, String label) {
        if (host == null || host.trim().isEmpty()) {
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

            InetAddress address = InetAddress.getByName(host.trim());
            socket = new DatagramSocket();
            socket.setSoTimeout(2500);
            socket.connect(address, port);

            DatagramPacket out = new DatagramPacket(request, request.length, address, port);
            socket.send(out);

            byte[] response = new byte[1024];
            DatagramPacket in = new DatagramPacket(response, response.length);
            socket.receive(in);

            if (in.getLength() < 20) {
                return new JSObject().put("ok", false).put("error", label + " response too short");
            }

            return new JSObject()
                    .put("ok", true)
                    .put("protocol", "udp")
                    .put("elapsedMs", Math.max(0L, System.currentTimeMillis() - startedAt));
        } catch (Exception error) {
            return new JSObject().put("ok", false).put("error", error.getMessage() != null ? error.getMessage() : (label + " udp test failed"));
        } finally {
            if (socket != null) {
                socket.close();
            }
        }
    }

    private JSObject testTcpRelay(String host, int port, String label) {
        if (host == null || host.trim().isEmpty()) {
            return new JSObject().put("ok", false).put("error", label + " host is empty");
        }

        long startedAt = System.currentTimeMillis();
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host.trim(), port), 2500);
            return new JSObject()
                    .put("ok", true)
                    .put("protocol", "tcp")
                    .put("elapsedMs", Math.max(0L, System.currentTimeMillis() - startedAt));
        } catch (Exception error) {
            return new JSObject().put("ok", false).put("error", error.getMessage() != null ? error.getMessage() : (label + " tcp test failed"));
        }
    }

    private JSObject testRelayEndpoint(String kind, JSObject relayConfig) {
        String safeKind = String.valueOf(kind == null ? "" : kind).trim().toLowerCase();
        JSObject safeConfig = normalizeRelayConfig(relayConfig, 3478, "turn".equals(safeKind));
        String host = safeConfig.optString("host", "").trim();
        int port = safeConfig.optInt("port", 3478);
        boolean tls = safeConfig.optBoolean("tls", false);

        if (host.isEmpty()) {
            return new JSObject().put("ok", false).put("error", safeKind + " host is empty");
        }

        if ("stun".equals(safeKind)) {
            return testUdpRelay(host, port, "stun");
        }

        if ("turn".equals(safeKind)) {
            if (tls) {
                return testTcpRelay(host, port, "turn");
            }
            return testUdpRelay(host, port, "turn");
        }

        return new JSObject().put("ok", false).put("error", "unsupported relay kind");
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
                // Intentionally permissive for Exchange discovery over self-signed certs.
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {
                // Intentionally permissive for Exchange discovery over self-signed certs.
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

        if (!"node".equals(ReactorHttpService.getCurrentExchangeMode())) {
            return new JSObject()
                    .put("connected", false)
                    .put("skipped", true)
                    .put("reason", "exchange mode is not node/client")
                    .put("elapsedMs", 0);
        }

        long startedAt = System.currentTimeMillis();
        while (System.currentTimeMillis() - startedAt <= safeTimeoutMs) {
            if (ReactorHttpService.isExchangeClientConnected()) {
                return new JSObject()
                        .put("connected", true)
                        .put("skipped", false)
                        .put("reason", "")
                        .put("elapsedMs", System.currentTimeMillis() - startedAt);
            }

            try {
                Thread.sleep(150L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }

        return new JSObject()
                .put("connected", ReactorHttpService.isExchangeClientConnected())
                .put("skipped", false)
                .put("reason", "timeout waiting for connection")
                .put("elapsedMs", System.currentTimeMillis() - startedAt);
    }

    private File getProjectsDir() {
        File projectsDir = new File(getContext().getFilesDir(), "projects");
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

    private File getBackupsDir() {
        File externalDir = getContext().getExternalFilesDir("backups");
        File backupsDir = externalDir != null ? externalDir : new File(getContext().getFilesDir(), "backups");
        if (!backupsDir.exists()) {
            backupsDir.mkdirs();
        }
        return backupsDir;
    }

    private List<File> getBackupSourceEntries() {
        return Arrays.asList(
                getProjectsDir(),
                getWorkingModeFile(),
                getReactorNameFile(),
                getUiSettingsFile(),
                getWorkflowFile(),
                getGlobalLogFile(),
                getTlsDir()
        );
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
                "projects",
                "working-mode.json",
                "name",
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

    private void appendTextFile(File file, String content) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }
        try (FileOutputStream stream = new FileOutputStream(file, true)) {
            stream.write(content.getBytes(StandardCharsets.UTF_8));
        }
    }

    private JSObject createExecutionStartEntry(String scriptName, String scriptPath, String scriptState, String scope, String trigger, String event) {
        JSObject script = new JSObject();
        script.put("name", scriptName);
        script.put("path", scriptPath);
        script.put("state", scriptState);

        JSObject entry = new JSObject();
        entry.put("timestamp", Instant.now().toString());
        entry.put("type", "SCRIPT_EXECUTION");
        entry.put("scope", scope);
        entry.put("phase", "START");
        entry.put("script", script);
        entry.put("trigger", trigger);
        entry.put("event", event == null ? JSONObject.NULL : event);
        entry.put("expression", JSONObject.NULL);
        entry.put("watchPath", JSONObject.NULL);
        entry.put("watchType", JSONObject.NULL);
        entry.put("durationMs", JSONObject.NULL);
        entry.put("output", JSONObject.NULL);
        entry.put("error", JSONObject.NULL);
        return entry;
    }

    private String detectScriptState(File scriptFile) {
        try {
            String source = readTextFile(scriptFile);
            String[] lines = source.split("\\r?\\n", -1);
            for (String line : lines) {
                String trimmed = line.trim();
                if (trimmed.startsWith("// @state")) {
                    return trimmed.toUpperCase().contains("ENABLED") ? "ENABLED" : "DISABLED";
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
            String canonicalProjects = getProjectsDir().getCanonicalPath();
            String canonicalFiles = getContext().getFilesDir().getCanonicalPath();

            return canonicalTarget.startsWith(canonicalProjects + File.separator)
                    || canonicalTarget.equals(canonicalProjects)
                    || canonicalTarget.startsWith(canonicalFiles + File.separator)
                    || canonicalTarget.equals(canonicalFiles);
        } catch (IOException e) {
            return false;
        }
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

    private JSObject buildScriptInfo(File scriptFile, String projectName) {
        JSObject script = new JSObject();
        script.put("name", projectName + ".ts");
        script.put("path", scriptFile.getAbsolutePath());
        File uuidFile = new File(scriptFile.getParentFile(), "uuid");
        String scriptId = "";
        try {
            if (uuidFile.exists()) {
                scriptId = readTextFile(uuidFile).trim().toLowerCase();
            }
        } catch (Exception ignored) {
            scriptId = "";
        }
        script.put("scriptId", scriptId.isEmpty() ? null : scriptId);
        script.put("eventLogPath", new File(scriptFile.getParentFile(), "activity.log").getAbsolutePath());
        script.put("state", "DISABLED");
        script.put("enabled", false);
        script.put("schedule", "");
        script.put("events", new JSArray());
        script.put("messageSenders", new JSArray());
        script.put("messageFromAnySender", false);
        script.put("mutex", false);
        script.put("watch", new JSArray());

        try {
            List<String> lines = Files.readAllLines(scriptFile.toPath(), StandardCharsets.UTF_8);
            for (String rawLine : lines) {
                String line = rawLine.trim();
                if (!line.startsWith("// @")) {
                    continue;
                }

                if (line.startsWith("// @state")) {
                    boolean enabled = line.toUpperCase().contains("ENABLED");
                    script.put("enabled", enabled);
                    script.put("state", enabled ? "ENABLED" : "DISABLED");
                } else if (line.startsWith("// @mutex")) {
                    boolean mutex = line.toUpperCase().contains("ON");
                    script.put("mutex", mutex);
                } else if (line.startsWith("// @schedule")) {
                    script.put("schedule", line.replace("// @schedule", "").trim());
                } else if (line.startsWith("// @watch")) {
                    JSArray watch = (JSArray) script.get("watch");
                    watch.put(line.replace("// @watch", "").trim());
                }
            }
        } catch (Exception ignored) {
            // Keep defaults if parsing fails.
        }

        return script;
    }

    @PluginMethod
    public void getScriptsInfo(PluginCall call) {
        try {
            File projectsDir = getProjectsDir();
            JSArray scripts = new JSArray();
            File[] children = projectsDir.listFiles();
            if (children != null) {
                for (File child : children) {
                    if (!child.isDirectory()) {
                        continue;
                    }

                    File scriptFile = resolveScriptFileFromProject(child);
                    if (scriptFile == null) {
                        continue;
                    }

                    scripts.put(buildScriptInfo(scriptFile, child.getName()));
                }
            }

            JSObject result = new JSObject();
            result.put("path", projectsDir.getAbsolutePath());
            result.put("scripts", scripts);
            call.resolve(result);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void createScriptFile(PluginCall call) {
        String templateKey = call.getString("templateKey", "blank");
        String requestedName = call.getString("scriptName", "");

        try {
            String safeTemplate = templateKey.replaceAll("[^a-zA-Z0-9_-]", "");
            String safeRequestedName = String.valueOf(requestedName)
                    .trim()
                    .replaceAll("[^a-zA-Z0-9._-]", "-")
                    .replaceAll("^[._-]+", "")
                    .replaceAll("[._-]+$", "");

            String projectName = safeRequestedName.isEmpty()
                    ? "script-" + safeTemplate + "-" + System.currentTimeMillis()
                    : safeRequestedName;
            File projectDir = new File(getProjectsDir(), projectName);
            if (!projectDir.exists() && !projectDir.mkdirs()) {
                throw new IOException("unable to create project directory");
            }

            File uuidFile = new File(projectDir, "uuid");
            File bootFile = new File(projectDir, "boot.ts");
            String source;
            switch (templateKey) {
                case "schedule":
                    source = "// @state DISABLED\n// @mutex OFF\n// @schedule EVERY 30 SECOND\n\nimport { log } from 'core';\nimport type { Context } from 'core';\n\nexport async function run(ctx: Context) {\n\tawait log('scheduled script tick');\n}\n";
                    break;
                case "event":
                    source = "// @state DISABLED\n// @mutex ON\n// @on MESSAGE\n\nimport { log } from 'core';\nimport type { Context } from 'core';\n\nexport async function run(ctx: Context) {\n\tawait log('event received');\n}\n";
                    break;
                case "watch":
                    source = "// @state DISABLED\n// @mutex ON\n// @watch ./inbox [file:created, file:moved]\n\nimport { log } from 'core';\nimport type { Context } from 'core';\n\nexport async function run(ctx: Context) {\n\tawait log('watch event: ' + (ctx.watchPath || ''));\n}\n";
                    break;
                default:
                    source = "// @state DISABLED\n// @mutex OFF\n\nimport { log } from 'core';\nimport type { Context } from 'core';\n\nexport async function run(ctx: Context) {\n\tawait log('new blank script');\n}\n";
                    break;
            }

                        writeTextFile(uuidFile, UUID.randomUUID().toString().toLowerCase() + "\n");
            writeTextFile(bootFile, source);
            writeTextFile(new File(projectDir, "context.ts"), "export {};\n");
            writeTextFile(new File(projectDir, "activity.log"), "");

            String verifyContent = readTextFile(bootFile);
            if (verifyContent.trim().isEmpty()) {
                throw new IOException("script template content not written");
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("path", bootFile.getAbsolutePath());
            result.put("name", projectName + ".ts");
            result.put("storagePath", projectDir.getAbsolutePath());
            call.resolve(result);
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void readScriptContent(PluginCall call) {
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
                    call.resolve(new JSObject().put("ok", false).put("error", "script file not found"));
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
    public void saveScriptContent(PluginCall call) {
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
                File scriptFile = new File(filePath);
                File parent = scriptFile.getParentFile();
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
                File scriptFile = new File(filePath);
                File parent = scriptFile.getParentFile();
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
    public void renameScriptFile(PluginCall call) {
        String filePath = call.getString("filePath", "");
        String nextName = call.getString("nextName", "");

        try {
            File scriptFile = new File(filePath);
            if (!isAllowedPath(scriptFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            String safeNextName = String.valueOf(nextName)
                    .trim()
                    .replaceAll("[^a-zA-Z0-9._-]", "-")
                    .replaceAll("^[._-]+", "")
                    .replaceAll("[._-]+$", "");

            if (safeNextName.isEmpty()) {
                call.resolve(new JSObject().put("ok", false).put("error", "invalid script name"));
                return;
            }

            File projectDir = scriptFile.getParentFile();
            if (projectDir == null || !projectDir.exists()) {
                call.resolve(new JSObject().put("ok", false).put("error", "script project not found"));
                return;
            }

            File projectsDir = getProjectsDir();
            File destinationDir = new File(projectsDir, safeNextName);
            if (destinationDir.exists()) {
                call.resolve(new JSObject().put("ok", false).put("error", "script project already exists"));
                return;
            }

            Files.move(projectDir.toPath(), destinationDir.toPath(), StandardCopyOption.ATOMIC_MOVE);

            File movedScript = new File(destinationDir, scriptFile.getName());
            if (!movedScript.exists()) {
                File bootTs = new File(destinationDir, "boot.ts");
                File bootJs = new File(destinationDir, "boot.js");
                movedScript = bootTs.exists() ? bootTs : bootJs;
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("path", movedScript.getAbsolutePath());
            result.put("name", safeNextName + ".ts");
            call.resolve(result);
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void deleteScriptFile(PluginCall call) {
        String filePath = call.getString("filePath", "");

        try {
            File scriptFile = new File(filePath);
            if (!isAllowedPath(scriptFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            File projectDir = scriptFile.getParentFile();
            if (projectDir == null || !projectDir.exists()) {
                call.resolve(new JSObject().put("ok", false).put("error", "script project not found"));
                return;
            }

            deleteRecursively(projectDir.toPath());
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void toggleScriptDirective(PluginCall call) {
        String filePath = call.getString("filePath", "");
        String directive = String.valueOf(call.getString("directive", "")).trim().toLowerCase();

        try {
            File scriptFile = new File(filePath);
            if (!isAllowedPath(scriptFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            String lower = scriptFile.getName().toLowerCase();
            if (!(lower.endsWith(".ts") || lower.endsWith(".js"))) {
                call.resolve(new JSObject().put("ok", false).put("error", "unsupported file type"));
                return;
            }

            String source = readTextFile(scriptFile);
            String[] lines = source.split("\\r?\\n", -1);
            boolean found = false;
            String nextValue;

            if ("state".equals(directive)) {
                nextValue = "ENABLED";
                for (int i = 0; i < lines.length; i++) {
                    String trimmed = lines[i].trim();
                    if (trimmed.startsWith("// @state")) {
                        found = true;
                        boolean enabled = trimmed.toUpperCase().contains("ENABLED");
                        nextValue = enabled ? "DISABLED" : "ENABLED";
                        lines[i] = "// @state " + nextValue;
                        break;
                    }
                }
                if (!found) {
                    source = "// @state ENABLED\n" + source;
                    nextValue = "ENABLED";
                } else {
                    source = String.join("\n", lines);
                }

                writeTextFile(scriptFile, source);
                call.resolve(new JSObject().put("ok", true).put("directive", "state").put("value", nextValue));
                return;
            }

            if ("mutex".equals(directive)) {
                nextValue = "ON";
                for (int i = 0; i < lines.length; i++) {
                    String trimmed = lines[i].trim();
                    if (trimmed.startsWith("// @mutex")) {
                        found = true;
                        boolean on = trimmed.toUpperCase().contains("ON");
                        nextValue = on ? "OFF" : "ON";
                        lines[i] = "// @mutex " + nextValue;
                        break;
                    }
                }
                if (!found) {
                    source = "// @mutex ON\n" + source;
                    nextValue = "ON";
                } else {
                    source = String.join("\n", lines);
                }

                writeTextFile(scriptFile, source);
                call.resolve(new JSObject().put("ok", true).put("directive", "mutex").put("value", nextValue));
                return;
            }

            call.resolve(new JSObject().put("ok", false).put("error", "invalid directive"));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", e.getMessage()));
        }
    }

    @PluginMethod
    public void runScriptNow(PluginCall call) {
        String filePath = call.getString("filePath", "");

        if (filePath == null || filePath.isEmpty()) {
            call.resolve(new JSObject().put("ok", false).put("error", "invalid request"));
            return;
        }

        try {
            File scriptFile = new File(filePath);
            if (!isAllowedPath(scriptFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            String lower = scriptFile.getName().toLowerCase();
            if (!(lower.endsWith(".ts") || lower.endsWith(".js"))) {
                call.resolve(new JSObject().put("ok", false).put("error", "unsupported file type"));
                return;
            }

            if (!scriptFile.exists()) {
                call.resolve(new JSObject().put("ok", false).put("error", "script file not found"));
                return;
            }

            File projectDir = scriptFile.getParentFile();
            if (projectDir == null) {
                call.resolve(new JSObject().put("ok", false).put("error", "invalid script project"));
                return;
            }

            File logFile = new File(projectDir, "activity.log");
            if (!isAllowedPath(logFile)) {
                call.resolve(new JSObject().put("ok", false).put("error", "path not allowed"));
                return;
            }

            String scriptName = projectDir.getName();
            String scriptState = detectScriptState(scriptFile);
            JSObject projectEntry = createExecutionStartEntry(
                    scriptName,
                    scriptFile.getAbsolutePath(),
                    scriptState,
                    "PROJECT",
                    "MANUAL_TEST",
                    "ON_DEMAND"
            );
            appendTextFile(logFile, projectEntry.toString() + "\\n");

            File globalLogFile = getGlobalLogFile();
            if (isAllowedPath(globalLogFile) && !globalLogFile.getAbsolutePath().equals(logFile.getAbsolutePath())) {
                JSObject globalEntry = createExecutionStartEntry(
                        scriptName,
                        scriptFile.getAbsolutePath(),
                        scriptState,
                        "GLOBAL",
                        "MANUAL_TEST",
                        "ON_DEMAND"
                );
                appendTextFile(globalLogFile, globalEntry.toString() + "\n");
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("started", true);
            result.put("script", scriptName);
            result.put("eventLogPath", logFile.getAbsolutePath());
            call.resolve(result);
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

    @PluginMethod
    public void getExchangeConfig(PluginCall call) {
        JSObject workingMode = readWorkingModeConfig();
        String mode = workingMode.getString("mode", "node");
        String host = workingMode.getString("host", "");
        int port = workingMode.getInteger("port", ReactorHttpService.DEFAULT_PORT);
        boolean tls = workingMode.has("tls") && workingMode.getBool("tls");
        String token = workingMode.getString("token", "");
        boolean discovery = workingMode.has("discovery") && workingMode.getBool("discovery");

        boolean active;
        if ("exchange".equals(ReactorHttpService.getCurrentExchangeMode())) {
            active = ReactorHttpService.isExchangeServerActive();
        } else if ("node".equals(ReactorHttpService.getCurrentExchangeMode())) {
            active = ReactorHttpService.isExchangeClientConnected();
        } else {
            active = false;
        }

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
        config.put("connectedClients", connectedClients);

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("config", config);
        call.resolve(result);
    }

    @PluginMethod
    public void getExchangeLinkedNodes(PluginCall call) {
        JSObject workingMode = readWorkingModeConfig();
        String mode = workingMode.getString("mode", "node");
        String host = workingMode.getString("host", "").trim();
        int port = workingMode.getInteger("port", ReactorHttpService.DEFAULT_PORT);
        boolean tls = workingMode.has("tls") && workingMode.getBool("tls");
        String token = workingMode.getString("token", "").trim();

        if (!"node".equals(mode)) {
            call.resolve(new JSObject().put("ok", false).put("error", "available only in node mode").put("nodes", new JSArray()).put("total", 0));
            return;
        }

        if (host.isEmpty()) {
            call.resolve(new JSObject().put("ok", false).put("error", "exchange host is not configured").put("nodes", new JSArray()).put("total", 0));
            return;
        }

        if (token.isEmpty()) {
            call.resolve(new JSObject().put("ok", false).put("error", "exchange token is not configured").put("nodes", new JSArray()).put("total", 0));
            return;
        }

        if (port < 1 || port > 65535) {
            port = ReactorHttpService.DEFAULT_PORT;
        }

        String endpointUrl = (tls ? "https" : "http") + "://" + host + ":" + port + "/nodes";
        HttpURLConnection connection = null;
        try {
            URL url = new URL(endpointUrl);
            connection = (HttpURLConnection) url.openConnection();
            if (tls && connection instanceof HttpsURLConnection) {
                applyInsecureTls((HttpsURLConnection) connection);
            }

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
                call.resolve(new JSObject().put("ok", false).put("error", error).put("nodes", new JSArray()).put("total", 0));
                return;
            }

            JSONArray parsedNodes = parsed.optJSONArray("nodes");
            JSArray filteredNodes = new JSArray();
            String selfName = getConfiguredReactorName().trim().toLowerCase();
            int total = 0;

            if (parsedNodes != null) {
                for (int index = 0; index < parsedNodes.length(); index += 1) {
                    JSONObject node = parsedNodes.optJSONObject(index);
                    if (node == null) {
                        continue;
                    }

                    String nodeName = node.optString("name", "").trim().toLowerCase();
                    if (!selfName.isEmpty() && selfName.equals(nodeName)) {
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
            call.resolve(result);
        } catch (Exception error) {
            call.resolve(new JSObject().put("ok", false).put("error", error.getMessage()).put("nodes", new JSArray()).put("total", 0));
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
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

		JSObject connectionTest = waitForExchangeClientConnection(5000L);

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
        .put("active", ReactorHttpService.isExchangeClientConnected()));
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

            String timestamp = String.valueOf(System.currentTimeMillis());
            File target = new File(getContext().getCacheDir(), "reactor-backup-" + timestamp + ".zip");

            try (ZipOutputStream output = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(target)))) {
                for (File source : getBackupSourceEntries()) {
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
