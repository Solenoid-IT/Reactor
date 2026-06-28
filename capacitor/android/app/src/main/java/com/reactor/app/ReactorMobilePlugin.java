package com.reactor.app;

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
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Base64;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.time.Instant;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;
import org.json.JSONObject;

@CapacitorPlugin(name = "ReactorMobile")
public class ReactorMobilePlugin extends Plugin {

    private static final int DEFAULT_HTTP_PORT = 7070;
    private static final String TAG = "ReactorMobilePlugin";
    private static final String WORKING_MODE_FILE = "working-mode.json";

    @Override
    public void load() {
        super.load();
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
        return String.valueOf(getPrefs().getString(ReactorHttpService.PREF_REACTOR_NAME, "mobile-reactor"));
    }

    private void setConfiguredReactorName(String name) {
        getPrefs().edit().putString(ReactorHttpService.PREF_REACTOR_NAME, name).apply();
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

    private JSObject getDefaultWorkingModeConfig() {
        JSObject config = new JSObject();
        config.put("mode", "node");
        config.put("host", "");
        config.put("port", ReactorHttpService.DEFAULT_PORT);
        config.put("tls", false);
        config.put("token", "");
        return config;
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
            config.put("mode", String.valueOf(parsed.optString("mode", "node")));
            config.put("host", String.valueOf(parsed.optString("host", "")));
            config.put("port", parsed.optInt("port", ReactorHttpService.DEFAULT_PORT));
            config.put("tls", parsed.optBoolean("tls", false));
            config.put("token", String.valueOf(parsed.optString("token", "")));
            return config;
        } catch (Exception ignored) {
            return getDefaultWorkingModeConfig();
        }
    }

    private JSObject writeWorkingModeConfig(String mode, String host, int port, boolean tls, String token) throws IOException {
        JSObject config = new JSObject();
        config.put("mode", mode);
        config.put("host", host != null ? host : "");
        config.put("port", port);
        config.put("tls", tls);
        config.put("token", token != null ? token : "");
        writeTextFile(getWorkingModeFile(), config.toString() + "\n");
        return config;
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
    public void getExchangeConfig(PluginCall call) {
        JSObject workingMode = readWorkingModeConfig();
        String mode = workingMode.getString("mode", "node");
        String host = workingMode.getString("host", "");
        int port = workingMode.getInteger("port", ReactorHttpService.DEFAULT_PORT);
        boolean tls = workingMode.has("tls") && workingMode.getBool("tls");
        String token = workingMode.getString("token", "");

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
        config.put("active", active);
        config.put("connectedClients", connectedClients);

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("config", config);
        call.resolve(result);
    }

    @PluginMethod
    public void setExchangeConfig(PluginCall call) {
        String mode = call.getString("mode", "node");
        String host = call.getString("host", "");
        int port = call.getInt("port", ReactorHttpService.DEFAULT_PORT);
        boolean tls = call.getBoolean("tls", false);
        String token = call.getString("token", "");

        if ("client".equals(mode) || "disabled".equals(mode)) {
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
            writeWorkingModeConfig(mode, host, port, tls, token);
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
        .put("active", ReactorHttpService.isExchangeClientConnected()));
		result.put("connectionTest", connectionTest);
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
                token
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
}
