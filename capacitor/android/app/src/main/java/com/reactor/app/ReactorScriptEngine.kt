package com.reactor.app

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Called by ReactorScriptEngine to perform native Android operations.
 */
interface ReactorScriptOps {
    fun log(message: String)
    fun deviceNotify(message: String): Boolean
    fun fsStat(path: String): String
    fun fsDelete(path: String): Boolean
    fun fsList(path: String, recursive: Boolean): String
    fun fsCalcSize(path: String): Long
    fun encryptFile(filePath: String, publicKey: String): String
    fun nodeStream(target: String, filePath: String, meta: String): String
    fun nodeSendMessage(target: String, stream: String, data: String): String
    fun copyStream(src: String, dst: String): Boolean
    fun getHomeDirectory(): String
    fun getNetworkStatus(): String
    fun getGeoLocation(): String
    fun getEnvConfig(): String
    fun sendHttpRequest(url: String, method: String, headers: String, body: String, timeoutMs: Long): String
    fun spawnProcess(command: String): Boolean
}

/**
 * Executes Reactor endpoint scripts using QuickJS JavaScript engine (via JNI).
 * QuickJS is compiled manually for arm64-v8a via NDK.
 */
class ReactorScriptEngine(private val context: Context) {

    companion object {
        @JvmStatic
        fun create(context: Context) = ReactorScriptEngine(context.applicationContext)

        @JvmField
        val BOOTSTRAP_JS = """
var module = { exports: {} };
var exports = module.exports;
var __loadEnvConfig = function () {
    try {
        var parsed = JSON.parse(__native.getEnvConfig());
        if (parsed && parsed.envs && typeof parsed.envs === 'object') {
            return parsed.envs;
        } else if (parsed && typeof parsed === 'object') {
            return parsed;
        } else {
            return {};
        }
    } catch (e) {
        return {};
    }
};
var __envConfig = __loadEnvConfig();
var require = function (s) {
    if (s === 'core') return __reactorCore;
    throw new Error('Cannot find module: ' + s);
};
var process = { env: {} };
var _formatArgs = function () {
    return [].slice.call(arguments).map(function (a) {
        return typeof a === 'object' ? JSON.stringify(a) : String(a);
    }).join(' ');
};
var console = {
    log: function () { __native.log(_formatArgs.apply(null, arguments)); },
    error: function () { __native.log('[E] ' + _formatArgs.apply(null, arguments)); },
    warn: function () { __native.log('[W] ' + _formatArgs.apply(null, arguments)); }
};

function Event(type, data, ts) {
    this.type = String(type || 'UNKNOWN');
    this.data = data || {};
    this.timestamp = ts || new Date().toISOString();
}

function __normalizeEventPath(rawPath) {
    var normalized = String(rawPath == null ? '' : rawPath).replace(/\\/g, '/');
    if (!normalized) return '';
    if (normalized === '/') return normalized;
    return normalized.replace(/\/+$/g, '');
}

function __computeWatchRelativePath(entryPath, watchPath) {
    var normalizedEntryPath = __normalizeEventPath(entryPath);
    var normalizedWatchPath = __normalizeEventPath(watchPath);
    if (!normalizedEntryPath) return '';
    if (!normalizedWatchPath) return normalizedEntryPath;
    if (normalizedEntryPath === normalizedWatchPath) return '';
    var prefix = normalizedWatchPath + '/';
    if (normalizedEntryPath.indexOf(prefix) === 0 && normalizedEntryPath.length > prefix.length) {
        return normalizedEntryPath.slice(prefix.length);
    }
    return normalizedEntryPath;
}

function WatchEvent(data, ts) {
    Event.call(this, 'WATCH', data, ts);
    var d = data || {};
    var watchPath = __normalizeEventPath(d.watchPath);
    var entryPath = __normalizeEventPath(
        d.entryPath != null ? d.entryPath : (watchPath && d.relativePath ? (watchPath + '/' + d.relativePath) : '')
    );
    var computedRelative = __computeWatchRelativePath(entryPath, watchPath);
    this.watchPath = watchPath;
    this.entryPath = entryPath;
    this.relativePath = entryPath ? computedRelative : (d.relativePath != null ? String(d.relativePath) : computedRelative);
    this.watchType = d.watchType || null;
}
WatchEvent.prototype = Object.create(Event.prototype);

function MessageEvent(data, ts) {
    Event.call(this, 'MESSAGE', data, ts);
    var d = data || {};
    this.sender = d.sender != null ? String(d.sender) : null;
    this.senderName = d.senderName != null ? String(d.senderName) : null;
    this.target = d.target || null;
    this.targetNode = d.targetNode || null;
    this.targetEndpoint = d.targetEndpoint || null;
    this.targetEndpointId = d.targetEndpointId || null;
    this.content = d.content != null ? String(d.content) : '';
    this.contentType = d.contentType != null ? String(d.contentType) : '';
    this.bodyBase64 = d.bodyBase64 || '';
    this.json = d.json !== undefined ? d.json : null;
    this.headers = d.headers || {};
}
MessageEvent.prototype = Object.create(Event.prototype);

function StreamEvent(data, ts) {
    MessageEvent.call(this, data, ts);
    this.type = 'STREAM';
    this.stream = data && data.stream ? data.stream : null;
}
StreamEvent.prototype = Object.create(MessageEvent.prototype);

function StreamEndEvent(data, ts) {
    Event.call(this, 'STREAMEND', data, ts);
    var d = data || {};
    this.sender = d.sender || null;
    this.content = d.content != null ? String(d.content) : '';
    this.contentType = d.contentType || '';
    this.json = d.json !== undefined ? d.json : null;
    this.headers = d.headers || {};
    this.metadata = d.metadata || {};
    this.tmpPath = d.tmpPath != null ? String(d.tmpPath) : '';
}
StreamEndEvent.prototype = Object.create(Event.prototype);

function ScheduleEvent(data, ts) {
    Event.call(this, 'SCHEDULE', data, ts);
    this.expression = data && data.expression != null ? data.expression : null;
}
ScheduleEvent.prototype = Object.create(Event.prototype);

function RuntimeEvent(data, ts) {
    Event.call(this, 'EVENT', data, ts);
    this.name = data && data.name != null ? String(data.name) : null;
    this.networkChange = data && data.networkChange != null ? data.networkChange : null;
}
RuntimeEvent.prototype = Object.create(Event.prototype);

function ManualEvent(data, ts) {
    Event.call(this, 'MANUAL_TEST', data, ts);
    this.reason = data && data.reason != null ? String(data.reason) : null;
}
ManualEvent.prototype = Object.create(Event.prototype);

function __parseUnitExpression(input, unitTable) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) throw new Error('Unit conversion requires a value');
    var compact = raw.replace(/,/g, '.').replace(/\s+/g, ' ').trim();
    var tokenMatcher = /([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;
    var total = 0;
    var matched = false;
    var match;

    while ((match = tokenMatcher.exec(compact)) !== null) {
        var amount = Number(match[1]);
        var unit = String(match[2] || '').toLowerCase();
        var multiplier = unitTable[unit];
        if (!Number.isFinite(amount) || !Number.isFinite(multiplier)) {
            throw new Error('Invalid unit token: ' + match[0]);
        }
        total += amount * multiplier;
        matched = true;
    }

    if (matched) {
        var leftover = compact.replace(tokenMatcher, '').replace(/\s+/g, '');
        if (leftover) throw new Error('Invalid unit expression: ' + raw);
        return total;
    }

    var numeric = Number(compact);
    if (Number.isFinite(numeric)) return numeric;
    throw new Error('Invalid unit expression: ' + raw);
}

function __encodeUtf8(input) {
    var value = String(input == null ? '' : input);
    var bytes = [];

    for (var index = 0; index < value.length; index += 1) {
        var codePoint = value.charCodeAt(index);

        if (codePoint >= 0xD800 && codePoint <= 0xDBFF && index + 1 < value.length) {
            var nextCodePoint = value.charCodeAt(index + 1);
            if (nextCodePoint >= 0xDC00 && nextCodePoint <= 0xDFFF) {
                codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + (nextCodePoint - 0xDC00);
                index += 1;
            }
        }

        if (codePoint <= 0x7F) {
            bytes.push(codePoint);
        } else if (codePoint <= 0x7FF) {
            bytes.push(0xC0 | (codePoint >> 6));
            bytes.push(0x80 | (codePoint & 0x3F));
        } else if (codePoint <= 0xFFFF) {
            bytes.push(0xE0 | (codePoint >> 12));
            bytes.push(0x80 | ((codePoint >> 6) & 0x3F));
            bytes.push(0x80 | (codePoint & 0x3F));
        } else {
            bytes.push(0xF0 | (codePoint >> 18));
            bytes.push(0x80 | ((codePoint >> 12) & 0x3F));
            bytes.push(0x80 | ((codePoint >> 6) & 0x3F));
            bytes.push(0x80 | (codePoint & 0x3F));
        }
    }

    return new Uint8Array(bytes);
}

function __decodeUtf8(bytes) {
    var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    var output = '';

    for (var index = 0; index < input.length; ) {
        var byte1 = input[index++];

        if ((byte1 & 0x80) === 0) {
            output += String.fromCharCode(byte1);
            continue;
        }

        if ((byte1 & 0xE0) === 0xC0) {
            var byte2 = index < input.length ? input[index++] : 0;
            var codePoint2 = ((byte1 & 0x1F) << 6) | (byte2 & 0x3F);
            output += String.fromCharCode(codePoint2);
            continue;
        }

        if ((byte1 & 0xF0) === 0xE0) {
            var byte2a = index < input.length ? input[index++] : 0;
            var byte3 = index < input.length ? input[index++] : 0;
            var codePoint3 = ((byte1 & 0x0F) << 12) | ((byte2a & 0x3F) << 6) | (byte3 & 0x3F);
            output += String.fromCharCode(codePoint3);
            continue;
        }

        var byte2b = index < input.length ? input[index++] : 0;
        var byte3b = index < input.length ? input[index++] : 0;
        var byte4 = index < input.length ? input[index++] : 0;
        var codePoint4 = ((byte1 & 0x07) << 18) | ((byte2b & 0x3F) << 12) | ((byte3b & 0x3F) << 6) | (byte4 & 0x3F);
        codePoint4 -= 0x10000;
        output += String.fromCharCode(0xD800 + (codePoint4 >> 10));
        output += String.fromCharCode(0xDC00 + (codePoint4 & 0x3FF));
    }

    return output;
}

var __base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function __encodeBase64(bytes) {
    var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    var output = '';

    for (var index = 0; index < input.length; index += 3) {
        var byte1 = input[index];
        var hasByte2 = index + 1 < input.length;
        var hasByte3 = index + 2 < input.length;
        var byte2 = hasByte2 ? input[index + 1] : 0;
        var byte3 = hasByte3 ? input[index + 2] : 0;
        var triplet = (byte1 << 16) | (byte2 << 8) | byte3;

        output += __base64Alphabet[(triplet >> 18) & 0x3F];
        output += __base64Alphabet[(triplet >> 12) & 0x3F];
        output += hasByte2 ? __base64Alphabet[(triplet >> 6) & 0x3F] : '=';
        output += hasByte3 ? __base64Alphabet[triplet & 0x3F] : '=';
    }

    return output;
}

function __decodeBase64(input) {
    var normalized = String(input == null ? '' : input).replace(/\s+/g, '');
    if (!normalized) {
        return new Uint8Array(0);
    }

    var output = [];
    for (var index = 0; index < normalized.length; index += 4) {
        var char1 = normalized.charAt(index);
        var char2 = normalized.charAt(index + 1);
        var char3 = normalized.charAt(index + 2);
        var char4 = normalized.charAt(index + 3);

        var enc1 = __base64Alphabet.indexOf(char1);
        var enc2 = __base64Alphabet.indexOf(char2);
        var enc3 = char3 === '=' ? -1 : __base64Alphabet.indexOf(char3);
        var enc4 = char4 === '=' ? -1 : __base64Alphabet.indexOf(char4);

        if (enc1 < 0 || enc2 < 0 || (char3 !== '=' && enc3 < 0) || (char4 !== '=' && enc4 < 0)) {
            throw new Error('Invalid base64 string');
        }

        var triplet = (enc1 << 18) | (enc2 << 12) | ((enc3 < 0 ? 0 : enc3) << 6) | (enc4 < 0 ? 0 : enc4);
        output.push((triplet >> 16) & 0xFF);
        if (char3 !== '=') {
            output.push((triplet >> 8) & 0xFF);
        }
        if (char4 !== '=') {
            output.push(triplet & 0xFF);
        }
    }

    return new Uint8Array(output);
}

var __reactorCore = {
    Event: Event,
    WatchEvent: WatchEvent,
    MessageEvent: MessageEvent,
    StreamEvent: StreamEvent,
    StreamEndEvent: StreamEndEvent,
    ScheduleEvent: ScheduleEvent,
    RuntimeEvent: RuntimeEvent,
    ManualEvent: ManualEvent,
    FileSystem: {
        File: Object.assign(function ReactorFile(p) { this.__path = String(p || ''); }, {
            open: function (p) { return { __type: 'FileHandle', __path: String(p || '') }; },
            delete: function (p) { return __native.fsDelete(String(p || '')); },
            copyStream: function (input, output) {
                var s = (input && input.__path) ? input.__path : String(input || '');
                var d = (output && output.__path) ? output.__path : String(output || '');
                return __native.copyStream(s, d);
            }
        }),
        Entry: {
            isFile: function (p) {
                try {
                    var stat = JSON.parse(__native.fsStat(String(p || '')) || '{}');
                    return !!stat.isFile;
                } catch (e) {
                    return false;
                }
            }
        },
        Directory: function ReactorDir(p) {
            this.__path = String(p || '');
            this.path = this.__path;
        }
    },
    Sekrypt: {
        encodeCrypto: function (crypto) {
            var json = JSON.stringify(crypto);
            var bytes = __encodeUtf8(json);
            var binary = '';

            for (var index = 0; index < bytes.length; index += 1) {
                binary += String.fromCharCode(bytes[index]);
            }

            return __encodeBase64(bytes);
        },
        decodeCrypto: function (crypto) {
            var bytes = __decodeBase64(String(crypto == null ? '' : crypto));
            var json = __decodeUtf8(bytes);
            return JSON.parse(json);
        },
        encryptFile: function (stream, publicKey) {
            var filePath = (stream && stream.__path) ? String(stream.__path) : String(stream || '');
            var result = __native.encryptFile(filePath, String(publicKey == null ? '' : publicKey));
            var payload = {};
            try {
                payload = JSON.parse(result || '{}');
            } catch (e) {
                throw new Error('Sekrypt.encryptFile failed: invalid native response');
            }

            if (!payload.ok) {
                throw new Error(payload.error || 'Sekrypt.encryptFile failed');
            }

            var encryptedContent = __reactorCore.FileSystem.File.open(String(payload.contentPath || ''));
            encryptedContent.length = Number(payload.contentSize || 0);

            return {
                content: encryptedContent,
                crypto: payload.crypto || {}
            };
        }
    },
    Node: {
        getHomeDirectory: function () { return __native.getHomeDirectory(); },
        stream: function (target, source, opts) {
            var fp = (source && source.__path) ? source.__path : String(source || '');
            var meta = JSON.stringify(opts && opts.metadata ? opts.metadata : {});
            var r = __native.nodeStream(String(target || ''), fp, meta);
            try { return JSON.parse(r); } catch (e) { return {}; }
        },
        sendMessage: function (target, content, optsOrFlag) {
            var body = typeof content === 'object' && content !== null
                ? JSON.stringify(content)
                : String(content == null ? '' : content);
            var ct = typeof content === 'object' && content !== null
                ? 'application/json; charset=utf-8'
                : 'text/plain; charset=utf-8';
            var r = __native.nodeSendMessage(String(target || ''), body, ct);
            try { return JSON.parse(r); } catch (e) { return {}; }
        },
        exchange: function () {
            return {
                sendMessage: function (t, c) { return __reactorCore.Node.sendMessage(t, c); },
                stream: function (t, s, o) { return __reactorCore.Node.stream(t, s, o); }
            };
        }
    },
    Device: {
        notify: function (msg) { return __native.deviceNotify(String(msg == null ? '' : msg)); },
        Network: function () {
            return {
                getStatus: function () {
                    try { return JSON.parse(__native.getNetworkStatus()); } catch (e) { return {}; }
                }
            };
        },
        Battery: function () { return { exists: function () { return false; }, getLevel: function () { return -1; } }; },
        Power: function () { return { isBattery: function () { return false; } }; },
        Position: {
            get: function () {
                try {
                    var p = JSON.parse(__native.getGeoLocation());
                    var lat = Number(p && p.lat);
                    var lon = Number(p && p.lon);
                    var hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
                    return {
                        lat: hasCoords ? lat : null,
                        lon: hasCoords ? lon : null,
                        available: hasCoords
                    };
                } catch (e) {
                    return { lat: null, lon: null, available: false };
                }
            }
        }
    },
    OS: function () {
        return {
            getArch: function () { return 'arm64'; },
            isDesktop: function () { return false; },
            isMobile: function () { return true; },
            getName: function () { return 'android'; },
            getFullName: function () { return 'Android (Capacitor)'; }
        };
    },
    HttpClient: {
        Request: function (method, url, body, headers) {
            this.method = String(method == null ? 'GET' : method).trim().toUpperCase() || 'GET';
            this.url = String(url == null ? '' : url).trim();
            this.body = body == null ? null : body;
            this.headers = headers && typeof headers === 'object' ? headers : {};
        },
        sendRequest: function (req, timeout) {
            var normalizedBody = '';
            if (req && req.body && typeof req.body === 'object' && req.body.__type === 'FileHandle') {
                normalizedBody = '@file:' + String(req.body.__path || '');
            } else if (req && req.body != null) {
                normalizedBody = String(typeof req.body === 'object' ? JSON.stringify(req.body) : req.body);
            }

            var timeoutSeconds = timeout == null ? null : Number(timeout);
            var timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
                ? Math.floor(timeoutSeconds * 1000)
                : 0;

            var r = __native.sendHttpRequest(
                String(req.url || ''),
                String(req.method || 'GET'),
                JSON.stringify(req.headers || {}),
                normalizedBody,
                timeoutMs
            );
            try {
                var out = JSON.parse(r);
                var status = Number(out && (out.statusCode != null ? out.statusCode : out.status));
                if (!Number.isFinite(status)) status = 0;
                return {
                    statusCode: status,
                    statusText: String(out && out.statusText != null ? out.statusText : ''),
                    headers: out && out.headers ? out.headers : {},
                    body: out && out.body != null ? out.body : ''
                };
            } catch (e) {
                return { statusCode: 0, statusText: '', headers: {}, body: '' };
            }
        }
    },
    Time: {
        now: function () {
            return Math.floor(Date.now() / 1000);
        }
    },
    Unit: {
        Byte: {
            conv: function (value) {
                return __parseUnitExpression(value, {
                    b: 1,
                    byte: 1,
                    bytes: 1,
                    kb: 1024,
                    mb: 1024 * 1024,
                    gb: 1024 * 1024 * 1024,
                    tb: 1024 * 1024 * 1024 * 1024
                });
            }
        },
        Second: {
            conv: function (value) {
                return __parseUnitExpression(value, {
                    s: 1,
                    sec: 1,
                    secs: 1,
                    second: 1,
                    seconds: 1,
                    m: 60,
                    min: 60,
                    mins: 60,
                    minute: 60,
                    minutes: 60,
                    h: 3600,
                    hr: 3600,
                    hrs: 3600,
                    hour: 3600,
                    hours: 3600,
                    d: 86400,
                    day: 86400,
                    days: 86400
                });
            }
        }
    },
    System: {
        Process: function (cmd) {
            this.__cmd = cmd;
            this.spawn = function () { return __native.spawnProcess(String(this.__cmd || '')); };
        },
        getHomeDirectory: function () { return __native.getHomeDirectory(); }
    },
    Env: {
        get: function (name, defaultValue) {
            var safeName = String(name == null ? '' : name).trim();
            if (!safeName) return String(defaultValue == null ? '' : defaultValue);

            var envConfig = __envConfig;
            if (Object.prototype.hasOwnProperty.call(envConfig, safeName)) {
                return String(envConfig[safeName] == null ? '' : envConfig[safeName]).trim();
            }

            var requestedUpper = safeName.toUpperCase();
            for (var key in envConfig) {
                if (!Object.prototype.hasOwnProperty.call(envConfig, key)) continue;
                var normalizedKey = String(key == null ? '' : key).trim().toUpperCase();
                if (normalizedKey === requestedUpper) {
                    return String(envConfig[key] == null ? '' : envConfig[key]).trim();
                }
            }

            return String(defaultValue == null ? '' : defaultValue).trim();
        }
    },
    log: function () { __native.log(_formatArgs.apply(null, arguments)); }
};
var FileSystem = __reactorCore.FileSystem;
var Node = __reactorCore.Node;
var Device = __reactorCore.Device;
var OS = __reactorCore.OS;
var HttpClient = __reactorCore.HttpClient;
var Encryption = __reactorCore.Encryption;
var Sekrypt = __reactorCore.Sekrypt;
var Time = __reactorCore.Time;
var Unit = __reactorCore.Unit;
var System = __reactorCore.System;
var Env = __reactorCore.Env;
var log = __reactorCore.log;

FileSystem.File.prototype.path = '';
FileSystem.File.prototype.getMeta = function () {
    try {
        var stat = JSON.parse(__native.fsStat(String(this.__path || '')) || '{}');
        return {
            path: String(this.__path || ''),
            exists: !!stat.exists,
            size: Number(stat.size || 0),
            mTime: Number(stat.mTime || 0),
            cTime: Number(stat.cTime || 0)
        };
    } catch (e) {
        return { path: String(this.__path || ''), exists: false, size: 0, mTime: 0, cTime: 0 };
    }
};

FileSystem.Directory.prototype.calcSize = function () {
    var result = Number(__native.fsCalcSize(String(this.__path || '')) || 0);
    return Number.isFinite(result) ? result : 0;
};

FileSystem.Directory.prototype.list = function (recursive) {
    try {
        var out = JSON.parse(__native.fsList(String(this.__path || ''), !!recursive) || '[]');
        return Array.isArray(out) ? out : [];
    } catch (e) {
        return [];
    }
};
""".trimIndent()
    }

    fun compileAndCache(tsFile: File) {
        // No-op: QuickJS handles TypeScript transpilation on-demand
    }

    fun executeBlocking(
        trigger: String,
        source: String,
        eventContextJson: String,
        ops: ReactorScriptOps
    ): Result {
        return try {
            Log.d("SCRIPT_ENGINE", "BEFORE_EXECUTE_BLOCKING trigger=$trigger source.length=${source.length}")

            // Transpile TypeScript using QuickJS transpiler function
            Log.d("SCRIPT_ENGINE", "STEP_1_CREATE_ENGINE")
            val engine = QuickJsWrapper()
            
            Log.d("SCRIPT_ENGINE", "STEP_2_INITIALIZE context=$context")
            if (!engine.initialize(context)) {
                Log.e("SCRIPT_ENGINE", "STEP_2_FAILED Failed to initialize QuickJS")
                return Result(null, "QuickJS initialization failed")
            }
            Log.d("SCRIPT_ENGINE", "STEP_2_SUCCESS QuickJS initialized")

            Log.d("SCRIPT_ENGINE", "STEP_3_TRANSPILE source.length=${source.length}")
            val compiledJs = engine.transpile(source)
            Log.d("SCRIPT_ENGINE", "STEP_3_RESULT compiledJs.length=${compiledJs?.length}")
            
            if (isQuickJsError(compiledJs)) {
                Log.e("SCRIPT_ENGINE", "TRANSPILE_ERROR: $compiledJs")
                engine.cleanup()
                return Result(null, "Transpilation failed: $compiledJs")
            }
            val compiledJsCode = requireNotNull(compiledJs)
            
            Log.d("SCRIPT_ENGINE", "TYPESCRIPT_RESOLVED compiled.length=${compiledJsCode.length}")
            logLongScript("SCRIPT_ENGINE", "COMPILED_CODE_FULL", compiledJsCode)

            Log.d("SCRIPT_ENGINE", "QUICKJS_INITIALIZED")

            // Register native operations
            if (!engine.setNativeOps(ops)) {
                Log.e("SCRIPT_ENGINE", "Failed to register native ops")
                engine.cleanup()
                return Result(null, "Failed to register native ops")
            }
            Log.d("SCRIPT_ENGINE", "NATIVE_OPS_REGISTERED")

            // Execute bootstrap
            val bootstrapResult = executeWithTrace(engine, "BOOTSTRAP", BOOTSTRAP_JS)
            if (isQuickJsError(bootstrapResult)) {
                Log.e("SCRIPT_ENGINE", "BOOTSTRAP_ERROR: $bootstrapResult")
                engine.cleanup()
                return Result(null, "Bootstrap failed: $bootstrapResult")
            }
            Log.d("SCRIPT_ENGINE", "BOOTSTRAP_DONE")

            // Quick sanity check - verify __native is available
            val checkNativeCode = "__native.log('__native available'); true;"
            val checkResult = executeWithTrace(engine, "NATIVE_CHECK", checkNativeCode)
            Log.d("SCRIPT_ENGINE", "NATIVE_CHECK: $checkResult")

            // Build event object
            val escapedEventContextJson = JSONObject.quote(eventContextJson)
            val buildEventCode = """
var __eventData = {};
try { __eventData = JSON.parse($escapedEventContextJson); } catch (e) { }
try {
    Object.keys(__eventData).forEach(function (k) {
        if (k.indexOf('event.') === 0) {
            var plainKey = k.substring(6);
            var plainValue = __eventData[plainKey];
            if (plainValue === undefined || plainValue === null || plainValue === '') {
                __eventData[plainKey] = __eventData[k];
            }
        }
    });
} catch (e) { }
var __event = null;
if ('$trigger' === 'WATCH') {
  __event = new WatchEvent(__eventData);
} else if ('$trigger' === 'MESSAGE') {
  __event = new MessageEvent(__eventData);
} else if ('$trigger' === 'STREAM') {
  __event = new StreamEvent(__eventData);
} else if ('$trigger' === 'STREAMEND') {
  __event = new StreamEndEvent(__eventData);
} else if ('$trigger' === 'SCHEDULE') {
  __event = new ScheduleEvent(__eventData);
} else if ('$trigger' === 'EVENT') {
  __event = new RuntimeEvent(__eventData);
} else {
  __event = new ManualEvent(__eventData);
}
""".trimIndent()

            val buildEventResult = executeWithTrace(engine, "BUILD_EVENT", buildEventCode)
            if (isQuickJsError(buildEventResult)) {
                Log.e("SCRIPT_ENGINE", "BUILD_EVENT_ERROR: $buildEventResult")
                engine.cleanup()
                return Result(null, "Build event failed: $buildEventResult")
            }
            Log.d("SCRIPT_ENGINE", "BUILD_EVENT_DONE")

            // Execute user script
            val userScriptResult = executeWithTrace(engine, "USER_SCRIPT", compiledJsCode)
            if (isQuickJsError(userScriptResult)) {
                Log.e("SCRIPT_ENGINE", "USER_SCRIPT_ERROR: $userScriptResult")
                engine.cleanup()
                return Result(null, "User script failed: $userScriptResult")
            }
            Log.d("SCRIPT_ENGINE", "USER_SCRIPT_DONE")

            // Resolve run from CommonJS export or global function.
            val checkRun = "(typeof exports !== 'undefined' && exports && typeof exports.run === 'function') || (typeof run === 'function')"
            val runExists = executeWithTrace(engine, "CHECK_RUN", checkRun)
            Log.d("SCRIPT_ENGINE", "exports.run exists? $runExists")
            if (runExists != "true") {
                engine.cleanup()
                return Result(null, "run() function not found")
            }

            // callFunction supports only global identifiers, so invoke via evaluate.
            val initRunnerResult = executeWithTrace(engine, "RUN_INIT", "var __runner = null;")
            if (isQuickJsError(initRunnerResult)) {
                Log.e("SCRIPT_ENGINE", "RUN_INIT_ERROR: $initRunnerResult")
                engine.cleanup()
                return Result(null, "run() init failed: $initRunnerResult")
            }

            val pickExportsRunnerResult = executeWithTrace(
                engine,
                "RUN_PICK_EXPORTS",
                "if (typeof exports !== 'undefined' && exports && typeof exports.run === 'function') __runner = exports.run;"
            )
            if (isQuickJsError(pickExportsRunnerResult)) {
                Log.e("SCRIPT_ENGINE", "RUN_PICK_EXPORTS_ERROR: $pickExportsRunnerResult")
                engine.cleanup()
                return Result(null, "run() exports resolve failed: $pickExportsRunnerResult")
            }

            val pickGlobalRunnerResult = executeWithTrace(engine, "RUN_PICK_GLOBAL", "if (!__runner && typeof run === 'function') __runner = run;")
            if (isQuickJsError(pickGlobalRunnerResult)) {
                Log.e("SCRIPT_ENGINE", "RUN_PICK_GLOBAL_ERROR: $pickGlobalRunnerResult")
                engine.cleanup()
                return Result(null, "run() global resolve failed: $pickGlobalRunnerResult")
            }

            val ensureRunnerResult = executeWithTrace(engine, "RUN_ENSURE", "if (!__runner) throw new Error('run() function not found');")
            if (isQuickJsError(ensureRunnerResult)) {
                Log.e("SCRIPT_ENGINE", "RUN_RESOLVE_ERROR: $ensureRunnerResult")
                engine.cleanup()
                return Result(null, "run() resolve failed: $ensureRunnerResult")
            }

            val callResult = executeWithTrace(engine, "RUN_CALL", "__runner(__event);")
            if (isQuickJsError(callResult)) {
                Log.e("SCRIPT_ENGINE", "RUN_CALL_ERROR: $callResult")
                engine.cleanup()
                return Result(null, "run() call failed: $callResult")
            }
            Log.d("SCRIPT_ENGINE", "SCRIPT_SUCCESS")

            engine.cleanup()
            Result(callResult, null)

        } catch (e: Exception) {
            Log.e("SCRIPT_ENGINE", "EXECUTE_ERROR: ${e.message}", e)
            Result(null, "Exception: ${e.message}")
        }
    }

    data class Result(
        val output: String?,
        val error: String?
    )

    private fun isQuickJsError(result: String?): Boolean {
        if (result == null) {
            return true
        }
        return result.startsWith("Error") ||
            result.contains("is not defined") ||
            result.contains("not a function") ||
            result.contains("expecting") ||
            result.contains("SyntaxError")
    }

    private fun logLongScript(tag: String, label: String, script: String, chunkSize: Int = 3000) {
        if (script.isEmpty()) {
            Log.v(tag, "$label [empty]")
            return
        }

        var offset = 0
        var index = 1
        val totalChunks = (script.length + chunkSize - 1) / chunkSize
        while (offset < script.length) {
            val end = minOf(offset + chunkSize, script.length)
            val chunk = script.substring(offset, end)
            Log.v(tag, "$label part $index/$totalChunks:\n$chunk")
            offset = end
            index += 1
        }
    }

    private fun executeWithTrace(engine: QuickJsWrapper, label: String, script: String): String? {
        Log.d("SCRIPT_ENGINE", "QJS_INPUT label=$label len=${script.length}")
        logLongScript("SCRIPT_ENGINE", "QJS_INPUT_$label", script)
        val result = engine.execute(script)
        Log.d("SCRIPT_ENGINE", "QJS_OUTPUT label=$label result=$result")
        return result
    }
}
