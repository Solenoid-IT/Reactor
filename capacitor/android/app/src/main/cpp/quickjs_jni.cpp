#include <jni.h>
#include <android/log.h>
#include <quickjs.h>
#include <quickjs-libc.h>
#include <string.h>
#include <stdlib.h>
#include <pthread.h>

#define LOG_TAG "QuickJsJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// Global JNI references for native ops callbacks
static JavaVM *jvm = nullptr;
static jobject opsObject = nullptr;
static jmethodID logMethod = nullptr;
static jmethodID deviceNotifyMethod = nullptr;
static jmethodID copyStreamMethod = nullptr;
static jmethodID getHomeDirectoryMethod = nullptr;
static jmethodID getNetworkStatusMethod = nullptr;
static jmethodID getGeoLocationMethod = nullptr;
static jmethodID getEnvConfigMethod = nullptr;
static jmethodID nodeStreamMethod = nullptr;
static jmethodID nodeSendMessageMethod = nullptr;
static jmethodID sendHttpRequestMethod = nullptr;
static jmethodID spawnProcessMethod = nullptr;
static jmethodID fsStatMethod = nullptr;
static jmethodID fsDeleteMethod = nullptr;
static jmethodID fsListMethod = nullptr;
static jmethodID fsCalcSizeMethod = nullptr;
static jmethodID tenantHashMethod = nullptr;
static jmethodID encryptFileMethod = nullptr;
static jmethodID decryptFileMethod = nullptr;
static pthread_mutex_t opsLock = PTHREAD_MUTEX_INITIALIZER;

// Helper to get JNIEnv
static JNIEnv* getJniEnv() {
    JNIEnv *env = nullptr;
    if (jvm && jvm->GetEnv((void**)&env, JNI_VERSION_1_6) == JNI_EDETACHED) {
        jvm->AttachCurrentThread(&env, nullptr);
    }
    return env;
}

// Helper to release JNIEnv thread attachment
static void releaseJniEnv(JNIEnv *env) {
    if (jvm) {
        jvm->DetachCurrentThread();
    }
}

// Run pending QuickJS jobs (Promise microtasks) so async/await can progress.
static bool drainPendingJobs(JSContext *ctx) {
    if (!ctx) {
        return false;
    }

    JSRuntime *rt = JS_GetRuntime(ctx);
    if (!rt) {
        return false;
    }

    int executed = 0;
    while (JS_IsJobPending(rt)) {
        JSContext *jobCtx = nullptr;
        int rc = JS_ExecutePendingJob(rt, &jobCtx);
        if (rc < 0) {
            JSContext *errCtx = jobCtx ? jobCtx : ctx;
            JSValue exception = JS_GetException(errCtx);
            const char *error_msg = JS_ToCString(errCtx, exception);
            LOGE("drainPendingJobs: Error: %s", error_msg ? error_msg : "unknown");
            if (error_msg) {
                JS_FreeCString(errCtx, error_msg);
            }
            JS_FreeValue(errCtx, exception);
            return false;
        }

        executed += 1;
        if (executed > 10000) {
            LOGE("drainPendingJobs: Aborted after too many jobs");
            break;
        }
    }

    return true;
}

// ============ Native Functions for JavaScript ============

static JSValue nativeLog(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_NULL;
    
    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !logMethod) {
        LOGE("nativeLog: Missing JNI context");
        return JS_NULL;
    }
    
    pthread_mutex_lock(&opsLock);
    
    const char *msg = JS_ToCString(ctx, argv[0]);
    if (msg) {
        jstring jmsg = env->NewStringUTF(msg);
        env->CallVoidMethod(opsObject, logMethod, jmsg);
        env->DeleteLocalRef(jmsg);
        JS_FreeCString(ctx, msg);
    }
    
    pthread_mutex_unlock(&opsLock);
    return JS_NULL;
}

static JSValue nativeDeviceNotify(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_FALSE;
    
    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !deviceNotifyMethod) {
        LOGE("nativeDeviceNotify: Missing JNI context");
        return JS_FALSE;
    }
    
    pthread_mutex_lock(&opsLock);
    
    const char *msg = JS_ToCString(ctx, argv[0]);
    jboolean result = JNI_FALSE;
    if (msg) {
        jstring jmsg = env->NewStringUTF(msg);
        result = env->CallBooleanMethod(opsObject, deviceNotifyMethod, jmsg);
        env->DeleteLocalRef(jmsg);
        JS_FreeCString(ctx, msg);
    }
    
    pthread_mutex_unlock(&opsLock);
    return result ? JS_TRUE : JS_FALSE;
}

static JSValue nativeCopyStream(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 2) return JS_FALSE;
    
    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !copyStreamMethod) {
        LOGE("nativeCopyStream: Missing JNI context");
        return JS_FALSE;
    }
    
    pthread_mutex_lock(&opsLock);
    
    const char *src = JS_ToCString(ctx, argv[0]);
    const char *dst = JS_ToCString(ctx, argv[1]);
    jboolean result = JNI_FALSE;
    
    if (src && dst) {
        jstring jsrc = env->NewStringUTF(src);
        jstring jdst = env->NewStringUTF(dst);
        result = env->CallBooleanMethod(opsObject, copyStreamMethod, jsrc, jdst);
        env->DeleteLocalRef(jsrc);
        env->DeleteLocalRef(jdst);
    }
    
    if (src) JS_FreeCString(ctx, src);
    if (dst) JS_FreeCString(ctx, dst);
    
    pthread_mutex_unlock(&opsLock);
    return result ? JS_TRUE : JS_FALSE;
}

static JSValue nativeGetHomeDirectory(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !getHomeDirectoryMethod) {
        LOGE("nativeGetHomeDirectory: Missing JNI context");
        return JS_NULL;
    }
    
    pthread_mutex_lock(&opsLock);
    
    jstring result = (jstring)env->CallObjectMethod(opsObject, getHomeDirectoryMethod);
    const char *path = result ? env->GetStringUTFChars(result, NULL) : "";
    JSValue ret = JS_NewString(ctx, path ? path : "");
    
    if (result && path) {
        env->ReleaseStringUTFChars(result, path);
        env->DeleteLocalRef(result);
    }
    
    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeGetNetworkStatus(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !getNetworkStatusMethod) {
        LOGE("nativeGetNetworkStatus: Missing JNI context");
        return JS_NULL;
    }
    
    pthread_mutex_lock(&opsLock);
    
    jstring result = (jstring)env->CallObjectMethod(opsObject, getNetworkStatusMethod);
    const char *status = result ? env->GetStringUTFChars(result, NULL) : "{}";
    JSValue ret = JS_NewString(ctx, status ? status : "{}");
    
    if (result && status) {
        env->ReleaseStringUTFChars(result, status);
        env->DeleteLocalRef(result);
    }
    
    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeGetGeoLocation(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !getGeoLocationMethod) {
        LOGE("nativeGetGeoLocation: Missing JNI context");
        return JS_NewString(ctx, "{\"lat\":null,\"lon\":null,\"available\":false}");
    }

    pthread_mutex_lock(&opsLock);

    jstring result = (jstring)env->CallObjectMethod(opsObject, getGeoLocationMethod);
    const char *status = result ? env->GetStringUTFChars(result, NULL) : "{\"lat\":null,\"lon\":null,\"available\":false}";
    JSValue ret = JS_NewString(ctx, status ? status : "{\"lat\":null,\"lon\":null,\"available\":false}");

    if (result && status) {
        env->ReleaseStringUTFChars(result, status);
        env->DeleteLocalRef(result);
    }

    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeGetEnvConfig(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !getEnvConfigMethod) {
        LOGE("nativeGetEnvConfig: Missing JNI context");
        return JS_NewString(ctx, "{\"envs\":{}}");
    }

    pthread_mutex_lock(&opsLock);

    jstring result = (jstring)env->CallObjectMethod(opsObject, getEnvConfigMethod);
    const char *status = result ? env->GetStringUTFChars(result, NULL) : "{\"envs\":{}}";
    JSValue ret = JS_NewString(ctx, status ? status : "{\"envs\":{}}");

    if (result && status) {
        env->ReleaseStringUTFChars(result, status);
        env->DeleteLocalRef(result);
    }

    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeNodeStream(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 2) return JS_NULL;
    
    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !nodeStreamMethod) {
        LOGE("nativeNodeStream: Missing JNI context");
        return JS_NULL;
    }
    
    pthread_mutex_lock(&opsLock);
    
    const char *target = JS_ToCString(ctx, argv[0]);
    const char *filePath = JS_ToCString(ctx, argv[1]);
    const char *meta = argc > 2 ? JS_ToCString(ctx, argv[2]) : "{}";
    
    jstring result = NULL;
    if (target && filePath && meta) {
        jstring jtarget = env->NewStringUTF(target);
        jstring jfilePath = env->NewStringUTF(filePath);
        jstring jmeta = env->NewStringUTF(meta);
        result = (jstring)env->CallObjectMethod(opsObject, nodeStreamMethod, jtarget, jfilePath, jmeta);
        env->DeleteLocalRef(jtarget);
        env->DeleteLocalRef(jfilePath);
        env->DeleteLocalRef(jmeta);
    }
    
    const char *result_str = result ? env->GetStringUTFChars(result, NULL) : "{}";
    JSValue ret = JS_NewString(ctx, result_str ? result_str : "{}");
    
    if (result && result_str) {
        env->ReleaseStringUTFChars(result, result_str);
        env->DeleteLocalRef(result);
    }
    
    if (target) JS_FreeCString(ctx, target);
    if (filePath) JS_FreeCString(ctx, filePath);
    if (meta && argc > 2) JS_FreeCString(ctx, meta);
    
    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeNodeSendMessage(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 2) return JS_NULL;
    
    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !nodeSendMessageMethod) {
        LOGE("nativeNodeSendMessage: Missing JNI context");
        return JS_NULL;
    }
    
    pthread_mutex_lock(&opsLock);
    
    const char *target = JS_ToCString(ctx, argv[0]);
    const char *body = JS_ToCString(ctx, argv[1]);
    const char *contentType = argc > 2 ? JS_ToCString(ctx, argv[2]) : "text/plain";
    
    jstring result = NULL;
    if (target && body && contentType) {
        jstring jtarget = env->NewStringUTF(target);
        jstring jbody = env->NewStringUTF(body);
        jstring jct = env->NewStringUTF(contentType);
        result = (jstring)env->CallObjectMethod(opsObject, nodeSendMessageMethod, jtarget, jbody, jct);
        env->DeleteLocalRef(jtarget);
        env->DeleteLocalRef(jbody);
        env->DeleteLocalRef(jct);
    }
    
    const char *result_str = result ? env->GetStringUTFChars(result, NULL) : "{}";
    JSValue ret = JS_NewString(ctx, result_str ? result_str : "{}");
    
    if (result && result_str) {
        env->ReleaseStringUTFChars(result, result_str);
        env->DeleteLocalRef(result);
    }
    
    if (target) JS_FreeCString(ctx, target);
    if (body) JS_FreeCString(ctx, body);
    if (contentType && argc > 2) JS_FreeCString(ctx, contentType);
    
    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeSendHttpRequest(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 5) return JS_NewString(ctx, "{\"status\":0,\"headers\":{},\"body\":\"invalid request\"}");

    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !sendHttpRequestMethod) {
        LOGE("nativeSendHttpRequest: Missing JNI context");
        return JS_NewString(ctx, "{\"status\":0,\"headers\":{},\"body\":\"native unavailable\"}");
    }

    pthread_mutex_lock(&opsLock);

    const char *url = JS_ToCString(ctx, argv[0]);
    const char *method = JS_ToCString(ctx, argv[1]);
    const char *headers = JS_ToCString(ctx, argv[2]);
    const char *body = JS_ToCString(ctx, argv[3]);
    int64_t timeoutMs = 0;
    JS_ToInt64(ctx, &timeoutMs, argv[4]);

    jstring result = NULL;
    if (url && method && headers && body) {
        jstring jurl = env->NewStringUTF(url);
        jstring jmethod = env->NewStringUTF(method);
        jstring jheaders = env->NewStringUTF(headers);
        jstring jbody = env->NewStringUTF(body);
        result = (jstring)env->CallObjectMethod(opsObject, sendHttpRequestMethod, jurl, jmethod, jheaders, jbody, (jlong)timeoutMs);
        env->DeleteLocalRef(jurl);
        env->DeleteLocalRef(jmethod);
        env->DeleteLocalRef(jheaders);
        env->DeleteLocalRef(jbody);
    }

    const char *result_str = result ? env->GetStringUTFChars(result, NULL) : "{\"status\":0,\"headers\":{},\"body\":\"request failed\"}";
    JSValue ret = JS_NewString(ctx, result_str ? result_str : "{\"status\":0,\"headers\":{},\"body\":\"request failed\"}");

    if (result && result_str) {
        env->ReleaseStringUTFChars(result, result_str);
        env->DeleteLocalRef(result);
    }

    if (url) JS_FreeCString(ctx, url);
    if (method) JS_FreeCString(ctx, method);
    if (headers) JS_FreeCString(ctx, headers);
    if (body) JS_FreeCString(ctx, body);

    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeSpawnProcess(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_FALSE;

    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !spawnProcessMethod) {
        LOGE("nativeSpawnProcess: Missing JNI context");
        return JS_FALSE;
    }

    pthread_mutex_lock(&opsLock);

    const char *command = JS_ToCString(ctx, argv[0]);
    jboolean result = JNI_FALSE;
    if (command) {
        jstring jcommand = env->NewStringUTF(command);
        result = env->CallBooleanMethod(opsObject, spawnProcessMethod, jcommand);
        env->DeleteLocalRef(jcommand);
        JS_FreeCString(ctx, command);
    }

    pthread_mutex_unlock(&opsLock);
    return result ? JS_TRUE : JS_FALSE;
}

static JSValue nativeFsStat(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_NewString(ctx, "{}");

    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !fsStatMethod) {
        LOGE("nativeFsStat: Missing JNI context");
        return JS_NewString(ctx, "{}");
    }

    pthread_mutex_lock(&opsLock);

    const char *path = JS_ToCString(ctx, argv[0]);
    jstring result = NULL;
    if (path) {
        jstring jpath = env->NewStringUTF(path);
        result = (jstring)env->CallObjectMethod(opsObject, fsStatMethod, jpath);
        env->DeleteLocalRef(jpath);
    }

    const char *result_str = result ? env->GetStringUTFChars(result, NULL) : "{}";
    JSValue ret = JS_NewString(ctx, result_str ? result_str : "{}");

    if (result && result_str) {
        env->ReleaseStringUTFChars(result, result_str);
        env->DeleteLocalRef(result);
    }

    if (path) JS_FreeCString(ctx, path);

    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeFsDelete(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_FALSE;

    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !fsDeleteMethod) {
        LOGE("nativeFsDelete: Missing JNI context");
        return JS_FALSE;
    }

    pthread_mutex_lock(&opsLock);

    const char *path = JS_ToCString(ctx, argv[0]);
    jboolean result = JNI_FALSE;
    if (path) {
        jstring jpath = env->NewStringUTF(path);
        result = env->CallBooleanMethod(opsObject, fsDeleteMethod, jpath);
        env->DeleteLocalRef(jpath);
        JS_FreeCString(ctx, path);
    }

    pthread_mutex_unlock(&opsLock);
    return result ? JS_TRUE : JS_FALSE;
}

static JSValue nativeFsList(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 2) return JS_NewString(ctx, "[]");

    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !fsListMethod) {
        LOGE("nativeFsList: Missing JNI context");
        return JS_NewString(ctx, "[]");
    }

    pthread_mutex_lock(&opsLock);

    const char *path = JS_ToCString(ctx, argv[0]);
    int recursive = JS_ToBool(ctx, argv[1]);
    jstring result = NULL;
    if (path) {
        jstring jpath = env->NewStringUTF(path);
        result = (jstring)env->CallObjectMethod(opsObject, fsListMethod, jpath, recursive ? JNI_TRUE : JNI_FALSE);
        env->DeleteLocalRef(jpath);
    }

    const char *result_str = result ? env->GetStringUTFChars(result, NULL) : "[]";
    JSValue ret = JS_NewString(ctx, result_str ? result_str : "[]");

    if (result && result_str) {
        env->ReleaseStringUTFChars(result, result_str);
        env->DeleteLocalRef(result);
    }

    if (path) JS_FreeCString(ctx, path);

    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeFsCalcSize(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_NewInt64(ctx, 0);

    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !fsCalcSizeMethod) {
        LOGE("nativeFsCalcSize: Missing JNI context");
        return JS_NewInt64(ctx, 0);
    }

    pthread_mutex_lock(&opsLock);

    const char *path = JS_ToCString(ctx, argv[0]);
    jlong size = 0;
    if (path) {
        jstring jpath = env->NewStringUTF(path);
        size = env->CallLongMethod(opsObject, fsCalcSizeMethod, jpath);
        env->DeleteLocalRef(jpath);
        JS_FreeCString(ctx, path);
    }

    pthread_mutex_unlock(&opsLock);
    return JS_NewInt64(ctx, (int64_t)size);
}

static JSValue nativeEncryptFile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 2) return JS_NewString(ctx, "{\"ok\":false,\"error\":\"invalid args\"}");

    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !encryptFileMethod) {
        LOGE("nativeEncryptFile: Missing JNI context");
        return JS_NewString(ctx, "{\"ok\":false,\"error\":\"native unavailable\"}");
    }

    pthread_mutex_lock(&opsLock);

    const char *filePath = JS_ToCString(ctx, argv[0]);
    const char *publicKey = JS_ToCString(ctx, argv[1]);
    jstring result = NULL;

    if (filePath && publicKey) {
        jstring jfilePath = env->NewStringUTF(filePath);
        jstring jpublicKey = env->NewStringUTF(publicKey);
        result = (jstring)env->CallObjectMethod(opsObject, encryptFileMethod, jfilePath, jpublicKey);
        env->DeleteLocalRef(jfilePath);
        env->DeleteLocalRef(jpublicKey);
    }

    const char *result_str = result ? env->GetStringUTFChars(result, NULL) : "{\"ok\":false,\"error\":\"encryption failed\"}";
    JSValue ret = JS_NewString(ctx, result_str ? result_str : "{\"ok\":false,\"error\":\"encryption failed\"}");

    if (result && result_str) {
        env->ReleaseStringUTFChars(result, result_str);
        env->DeleteLocalRef(result);
    }

    if (filePath) JS_FreeCString(ctx, filePath);
    if (publicKey) JS_FreeCString(ctx, publicKey);

    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeTenantHash(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 2) return JS_NewString(ctx, "{\"ok\":false,\"error\":\"invalid args\"}");

    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !tenantHashMethod) {
        LOGE("nativeTenantHash: Missing JNI context");
        return JS_NewString(ctx, "{\"ok\":false,\"error\":\"native unavailable\"}");
    }

    pthread_mutex_lock(&opsLock);

    const char *filePath = JS_ToCString(ctx, argv[0]);
    const char *tenantUuid = JS_ToCString(ctx, argv[1]);
    jstring result = NULL;

    if (filePath && tenantUuid) {
        jstring jfilePath = env->NewStringUTF(filePath);
        jstring jtenantUuid = env->NewStringUTF(tenantUuid);
        result = (jstring)env->CallObjectMethod(opsObject, tenantHashMethod, jfilePath, jtenantUuid);
        env->DeleteLocalRef(jfilePath);
        env->DeleteLocalRef(jtenantUuid);
    }

    const char *result_str = result ? env->GetStringUTFChars(result, NULL) : "{\"ok\":false,\"error\":\"tenant hash failed\"}";
    JSValue ret = JS_NewString(ctx, result_str ? result_str : "{\"ok\":false,\"error\":\"tenant hash failed\"}");

    if (result && result_str) {
        env->ReleaseStringUTFChars(result, result_str);
        env->DeleteLocalRef(result);
    }

    if (filePath) JS_FreeCString(ctx, filePath);
    if (tenantUuid) JS_FreeCString(ctx, tenantUuid);

    pthread_mutex_unlock(&opsLock);
    return ret;
}

static JSValue nativeDecryptFile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 3) return JS_NewString(ctx, "{\"ok\":false,\"error\":\"invalid args\"}");

    JNIEnv *env = getJniEnv();
    if (!env || !opsObject || !decryptFileMethod) {
        LOGE("nativeDecryptFile: Missing JNI context");
        return JS_NewString(ctx, "{\"ok\":false,\"error\":\"native unavailable\"}");
    }

    pthread_mutex_lock(&opsLock);

    const char *filePath = JS_ToCString(ctx, argv[0]);
    const char *cryptoPayload = JS_ToCString(ctx, argv[1]);
    const char *privateKey = JS_ToCString(ctx, argv[2]);
    jstring result = NULL;

    if (filePath && cryptoPayload && privateKey) {
        jstring jfilePath = env->NewStringUTF(filePath);
        jstring jcryptoPayload = env->NewStringUTF(cryptoPayload);
        jstring jprivateKey = env->NewStringUTF(privateKey);
        result = (jstring)env->CallObjectMethod(opsObject, decryptFileMethod, jfilePath, jcryptoPayload, jprivateKey);
        env->DeleteLocalRef(jfilePath);
        env->DeleteLocalRef(jcryptoPayload);
        env->DeleteLocalRef(jprivateKey);
    }

    const char *result_str = result ? env->GetStringUTFChars(result, NULL) : "{\"ok\":false,\"error\":\"decryption failed\"}";
    JSValue ret = JS_NewString(ctx, result_str ? result_str : "{\"ok\":false,\"error\":\"decryption failed\"}");

    if (result && result_str) {
        env->ReleaseStringUTFChars(result, result_str);
        env->DeleteLocalRef(result);
    }

    if (filePath) JS_FreeCString(ctx, filePath);
    if (cryptoPayload) JS_FreeCString(ctx, cryptoPayload);
    if (privateKey) JS_FreeCString(ctx, privateKey);

    pthread_mutex_unlock(&opsLock);
    return ret;
}

// ============ JNI Exported Functions ============

extern "C" {

/**
 * Initialize JVM reference (called once at startup)
 */
JNIEXPORT void JNICALL
JNI_OnLoad_quickjs_jni(JavaVM *vm, void *reserved) {
    jvm = vm;
    LOGI("JVM reference initialized");
}

/**
 * Crea un nuovo runtime QuickJS
 */
JNIEXPORT jlong JNICALL
Java_com_reactor_app_QuickJsWrapper_createRuntime(JNIEnv *env, jobject thiz) {
    LOGI("createRuntime: Starting...");
    
    JSRuntime *rt = JS_NewRuntime();
    LOGI("createRuntime: JS_NewRuntime returned %p", rt);
    
    if (!rt) {
        LOGE("createRuntime: Failed to create QuickJS runtime (rt == NULL)");
        return 0;
    }
    
    if (!jvm) {
        env->GetJavaVM(&jvm);
        LOGI("createRuntime: Got JavaVM reference");
    }
    
    jlong result = (jlong)rt;
    LOGI("createRuntime: Returning jlong=%lld (0x%llx)", result, (unsigned long long)result);
    return result;
}

/**
 * Crea un nuovo context nel runtime
 */
JNIEXPORT jlong JNICALL
Java_com_reactor_app_QuickJsWrapper_createContext(JNIEnv *env, jobject thiz, jlong runtime_ptr) {
    JSRuntime *rt = (JSRuntime *)runtime_ptr;
    if (!rt) {
        LOGE("Invalid runtime pointer");
        return 0;
    }
    
    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) {
        LOGE("Failed to create QuickJS context");
        return 0;
    }
    
    LOGI("QuickJS context created");
    return (jlong)ctx;
}

/**
 * Inizializza il transpiler JavaScript nel context
 */
JNIEXPORT jboolean JNICALL
Java_com_reactor_app_QuickJsWrapper_initializeTranspiler(JNIEnv *env, jobject thiz, 
                                                         jlong context_ptr, jstring transpiler_code_java) {
    JSContext *ctx = (JSContext *)context_ptr;
    if (!ctx) {
        LOGE("initializeTranspiler: Invalid context pointer");
        return false;
    }
    
    const char *transpiler_code = env->GetStringUTFChars(transpiler_code_java, NULL);
    if (!transpiler_code) {
        LOGE("initializeTranspiler: Failed to get transpiler code");
        return false;
    }
    
    LOGI("initializeTranspiler: Loading transpiler (%zu bytes)", strlen(transpiler_code));
    
    // Execute the transpiler code
    JSValue result = JS_Eval(ctx, transpiler_code, strlen(transpiler_code), "<transpiler.js>", 0);
    
    env->ReleaseStringUTFChars(transpiler_code_java, transpiler_code);
    
    bool success = false;
    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(ctx);
        const char *error = JS_ToCString(ctx, exception);
        LOGE("initializeTranspiler: Error loading transpiler: %s", error ? error : "unknown");
        if (error) JS_FreeCString(ctx, error);
        JS_FreeValue(ctx, exception);
    } else {
        LOGI("initializeTranspiler: Transpiler loaded successfully");
        success = true;
    }
    
    JS_FreeValue(ctx, result);
    return success;
}

/**
 * Registra le funzioni native che JavaScript può richiamare
 */
JNIEXPORT jboolean JNICALL
Java_com_reactor_app_QuickJsWrapper_registerNativeOps(JNIEnv *env, jobject thiz, jlong context_ptr, jobject ops) {
    JSContext *ctx = (JSContext *)context_ptr;
    if (!ctx || !ops) {
        LOGE("Invalid context or ops object");
        return false;
    }
    
    pthread_mutex_lock(&opsLock);
    
    // Clear previous ops
    if (opsObject) {
        env->DeleteGlobalRef(opsObject);
        opsObject = nullptr;
    }
    
    // Store new ops reference
    opsObject = env->NewGlobalRef(ops);
    if (!opsObject) {
        LOGE("Failed to create global ref for ops");
        pthread_mutex_unlock(&opsLock);
        return false;
    }
    
    // Get method IDs from ReactorScriptOps interface
    jclass opsClass = env->GetObjectClass(ops);
    
    logMethod = env->GetMethodID(opsClass, "log", "(Ljava/lang/String;)V");
    if (!logMethod) LOGE("Missing method: log");
    
    deviceNotifyMethod = env->GetMethodID(opsClass, "deviceNotify", "(Ljava/lang/String;)Z");
    if (!deviceNotifyMethod) LOGE("Missing method: deviceNotify");
    
    copyStreamMethod = env->GetMethodID(opsClass, "copyStream", "(Ljava/lang/String;Ljava/lang/String;)Z");
    if (!copyStreamMethod) LOGE("Missing method: copyStream");
    
    getHomeDirectoryMethod = env->GetMethodID(opsClass, "getHomeDirectory", "()Ljava/lang/String;");
    if (!getHomeDirectoryMethod) LOGE("Missing method: getHomeDirectory");
    
    getNetworkStatusMethod = env->GetMethodID(opsClass, "getNetworkStatus", "()Ljava/lang/String;");
    if (!getNetworkStatusMethod) LOGE("Missing method: getNetworkStatus");

    getGeoLocationMethod = env->GetMethodID(opsClass, "getGeoLocation", "()Ljava/lang/String;");
    if (!getGeoLocationMethod) LOGE("Missing method: getGeoLocation");

    getEnvConfigMethod = env->GetMethodID(opsClass, "getEnvConfig", "()Ljava/lang/String;");
    if (!getEnvConfigMethod) LOGE("Missing method: getEnvConfig");
    
    nodeStreamMethod = env->GetMethodID(opsClass, "nodeStream", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
    if (!nodeStreamMethod) LOGE("Missing method: nodeStream");
    
    nodeSendMessageMethod = env->GetMethodID(opsClass, "nodeSendMessage", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
    if (!nodeSendMessageMethod) LOGE("Missing method: nodeSendMessage");
    
    sendHttpRequestMethod = env->GetMethodID(opsClass, "sendHttpRequest", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;J)Ljava/lang/String;");
    if (!sendHttpRequestMethod) LOGE("Missing method: sendHttpRequest");
    
    spawnProcessMethod = env->GetMethodID(opsClass, "spawnProcess", "(Ljava/lang/String;)Z");
    if (!spawnProcessMethod) LOGE("Missing method: spawnProcess");

    fsStatMethod = env->GetMethodID(opsClass, "fsStat", "(Ljava/lang/String;)Ljava/lang/String;");
    if (!fsStatMethod) LOGE("Missing method: fsStat");

    fsDeleteMethod = env->GetMethodID(opsClass, "fsDelete", "(Ljava/lang/String;)Z");
    if (!fsDeleteMethod) LOGE("Missing method: fsDelete");

    fsListMethod = env->GetMethodID(opsClass, "fsList", "(Ljava/lang/String;Z)Ljava/lang/String;");
    if (!fsListMethod) LOGE("Missing method: fsList");

    fsCalcSizeMethod = env->GetMethodID(opsClass, "fsCalcSize", "(Ljava/lang/String;)J");
    if (!fsCalcSizeMethod) LOGE("Missing method: fsCalcSize");

    tenantHashMethod = env->GetMethodID(opsClass, "tenantHash", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
    if (!tenantHashMethod) LOGE("Missing method: tenantHash");

    encryptFileMethod = env->GetMethodID(opsClass, "encryptFile", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
    if (!encryptFileMethod) LOGE("Missing method: encryptFile");

    decryptFileMethod = env->GetMethodID(opsClass, "decryptFile", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
    if (!decryptFileMethod) LOGE("Missing method: decryptFile");
    
    env->DeleteLocalRef(opsClass);
    
    // Create __native object with methods
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue nativeObj = JS_NewObject(ctx);
    
    JS_SetPropertyStr(ctx, nativeObj, "log", JS_NewCFunction(ctx, nativeLog, "log", 1));
    JS_SetPropertyStr(ctx, nativeObj, "deviceNotify", JS_NewCFunction(ctx, nativeDeviceNotify, "deviceNotify", 1));
    JS_SetPropertyStr(ctx, nativeObj, "copyStream", JS_NewCFunction(ctx, nativeCopyStream, "copyStream", 2));
    JS_SetPropertyStr(ctx, nativeObj, "getHomeDirectory", JS_NewCFunction(ctx, nativeGetHomeDirectory, "getHomeDirectory", 0));
    JS_SetPropertyStr(ctx, nativeObj, "getNetworkStatus", JS_NewCFunction(ctx, nativeGetNetworkStatus, "getNetworkStatus", 0));
    JS_SetPropertyStr(ctx, nativeObj, "getGeoLocation", JS_NewCFunction(ctx, nativeGetGeoLocation, "getGeoLocation", 0));
    JS_SetPropertyStr(ctx, nativeObj, "getEnvConfig", JS_NewCFunction(ctx, nativeGetEnvConfig, "getEnvConfig", 0));
    JS_SetPropertyStr(ctx, nativeObj, "nodeStream", JS_NewCFunction(ctx, nativeNodeStream, "nodeStream", 3));
    JS_SetPropertyStr(ctx, nativeObj, "nodeSendMessage", JS_NewCFunction(ctx, nativeNodeSendMessage, "nodeSendMessage", 3));
    JS_SetPropertyStr(ctx, nativeObj, "sendHttpRequest", JS_NewCFunction(ctx, nativeSendHttpRequest, "sendHttpRequest", 5));
    JS_SetPropertyStr(ctx, nativeObj, "spawnProcess", JS_NewCFunction(ctx, nativeSpawnProcess, "spawnProcess", 1));
    JS_SetPropertyStr(ctx, nativeObj, "fsStat", JS_NewCFunction(ctx, nativeFsStat, "fsStat", 1));
    JS_SetPropertyStr(ctx, nativeObj, "fsDelete", JS_NewCFunction(ctx, nativeFsDelete, "fsDelete", 1));
    JS_SetPropertyStr(ctx, nativeObj, "fsList", JS_NewCFunction(ctx, nativeFsList, "fsList", 2));
    JS_SetPropertyStr(ctx, nativeObj, "fsCalcSize", JS_NewCFunction(ctx, nativeFsCalcSize, "fsCalcSize", 1));
    JS_SetPropertyStr(ctx, nativeObj, "tenantHash", JS_NewCFunction(ctx, nativeTenantHash, "tenantHash", 2));
    JS_SetPropertyStr(ctx, nativeObj, "encryptFile", JS_NewCFunction(ctx, nativeEncryptFile, "encryptFile", 2));
    JS_SetPropertyStr(ctx, nativeObj, "decryptFile", JS_NewCFunction(ctx, nativeDecryptFile, "decryptFile", 3));
    
    JS_SetPropertyStr(ctx, global, "__native", nativeObj);
    JS_FreeValue(ctx, global);
    
    pthread_mutex_unlock(&opsLock);
    
    LOGI("Native ops registered successfully");
    return true;
}

/**
 * Esegue uno script JavaScript
 */
JNIEXPORT jstring JNICALL
Java_com_reactor_app_QuickJsWrapper_evaluateScript(JNIEnv *env, jobject thiz, 
                                                   jlong context_ptr, jstring script_java) {
    JSContext *ctx = (JSContext *)context_ptr;
    if (!ctx) {
        LOGE("evaluateScript: Invalid context pointer");
        return NULL;
    }
    
    const char *script = env->GetStringUTFChars(script_java, NULL);
    if (!script) {
        LOGE("evaluateScript: Failed to get script string");
        return NULL;
    }
    
    size_t script_len = strlen(script);
    LOGI("evaluateScript: Executing %zu bytes", script_len);
    if (script_len < 200) {
        LOGI("evaluateScript: CODE: %.200s", script);
    }
    
    JSValue result = JS_Eval(ctx, script, script_len, "<script>", 0);
    env->ReleaseStringUTFChars(script_java, script);
    
    jstring result_str = NULL;
    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(ctx);
        
        // Try to get error message
        const char *error_msg = NULL;
        if (JS_IsObject(exception)) {
            JSValue msg_val = JS_GetPropertyStr(ctx, exception, "message");
            error_msg = JS_ToCString(ctx, msg_val);
            JS_FreeValue(ctx, msg_val);
        }
        if (!error_msg) {
            error_msg = JS_ToCString(ctx, exception);
        }
        
        LOGE("evaluateScript: Error: %s", error_msg ? error_msg : "unknown");
        result_str = env->NewStringUTF(error_msg ? error_msg : "Unknown error");
        
        if (error_msg) JS_FreeCString(ctx, error_msg);
        JS_FreeValue(ctx, exception);
    } else {
        const char *result_cstr = JS_ToCString(ctx, result);
        bool jobsOk = drainPendingJobs(ctx);
        result_str = env->NewStringUTF(jobsOk ? (result_cstr ? result_cstr : "undefined") : "Error: pending job failed");
        if (result_cstr) {
            if (strlen(result_cstr) < 100) {
                LOGI("evaluateScript: Success - result: %s", result_cstr);
            } else {
                LOGI("evaluateScript: Success - result length: %zu", strlen(result_cstr));
            }
            JS_FreeCString(ctx, result_cstr);
        }
    }
    
    JS_FreeValue(ctx, result);
    return result_str;
}

/**
 * Chiama una funzione JavaScript esportata
 */
JNIEXPORT jstring JNICALL
Java_com_reactor_app_QuickJsWrapper_callFunction(JNIEnv *env, jobject thiz, 
                                                 jlong context_ptr, jstring func_name_java, 
                                                 jstring args_java) {
    JSContext *ctx = (JSContext *)context_ptr;
    if (!ctx) {
        LOGE("callFunction: Invalid context pointer");
        return NULL;
    }
    
    const char *func_name = env->GetStringUTFChars(func_name_java, NULL);
    const char *args_json = env->GetStringUTFChars(args_java, NULL);
    
    if (!func_name || !args_json) {
        if (func_name) env->ReleaseStringUTFChars(func_name_java, func_name);
        if (args_json) env->ReleaseStringUTFChars(args_java, args_json);
        LOGE("callFunction: Failed to get function name or args");
        return NULL;
    }
    
    LOGI("callFunction: Calling %s with args: %.50s...", func_name, args_json);
    
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue func = JS_GetPropertyStr(ctx, global, func_name);
    
    if (!JS_IsFunction(ctx, func)) {
        LOGE("callFunction: %s is not a function", func_name);
        JS_FreeValue(ctx, func);
        JS_FreeValue(ctx, global);
        env->ReleaseStringUTFChars(func_name_java, func_name);
        env->ReleaseStringUTFChars(args_java, args_json);
        return env->NewStringUTF("Function not found");
    }
    
    JSValue parsed_args = JS_Eval(ctx, args_json, strlen(args_json), "<args>", 0);
    
    env->ReleaseStringUTFChars(func_name_java, func_name);
    env->ReleaseStringUTFChars(args_java, args_json);
    
    jstring result_str = NULL;
    
    if (JS_IsException(parsed_args)) {
        JSValue exception = JS_GetException(ctx);
        const char *error = JS_ToCString(ctx, exception);
        LOGE("callFunction: Failed to parse args: %s", error ? error : "unknown");
        result_str = env->NewStringUTF(error ? error : "Failed to parse args");
        if (error) JS_FreeCString(ctx, error);
        JS_FreeValue(ctx, exception);
    } else {
        JSValue result = JS_Call(ctx, func, JS_UNDEFINED, 1, &parsed_args);
        
        if (JS_IsException(result)) {
            JSValue exception = JS_GetException(ctx);
            const char *error_msg = NULL;
            if (JS_IsObject(exception)) {
                JSValue msg_val = JS_GetPropertyStr(ctx, exception, "message");
                error_msg = JS_ToCString(ctx, msg_val);
                JS_FreeValue(ctx, msg_val);
            }
            if (!error_msg) {
                error_msg = JS_ToCString(ctx, exception);
            }
            LOGE("callFunction: Function call failed: %s", error_msg ? error_msg : "unknown");
            result_str = env->NewStringUTF(error_msg ? error_msg : "Function call failed");
            if (error_msg) JS_FreeCString(ctx, error_msg);
            JS_FreeValue(ctx, exception);
        } else {
            const char *result_cstr = JS_ToCString(ctx, result);
            bool jobsOk = drainPendingJobs(ctx);
            result_str = env->NewStringUTF(jobsOk ? (result_cstr ? result_cstr : "undefined") : "Error: pending job failed");
            LOGI("callFunction: Success - result: %.100s", result_cstr ? result_cstr : "undefined");
            if (result_cstr) JS_FreeCString(ctx, result_cstr);
            JS_FreeValue(ctx, result);
        }
        JS_FreeValue(ctx, parsed_args);
    }
    
    JS_FreeValue(ctx, func);
    JS_FreeValue(ctx, global);
    
    return result_str;
}

/**
 * Inietta un oggetto globale nel context
 */
JNIEXPORT jboolean JNICALL
Java_com_reactor_app_QuickJsWrapper_injectGlobal(JNIEnv *env, jobject thiz, 
                                                 jlong context_ptr, jstring name_java, 
                                                 jstring value_java) {
    JSContext *ctx = (JSContext *)context_ptr;
    if (!ctx) {
        LOGE("Invalid context pointer");
        return false;
    }
    
    const char *name = env->GetStringUTFChars(name_java, NULL);
    const char *value_json = env->GetStringUTFChars(value_java, NULL);
    
    if (!name || !value_json) {
        if (name) env->ReleaseStringUTFChars(name_java, name);
        if (value_json) env->ReleaseStringUTFChars(value_java, value_json);
        LOGE("Failed to get name or value");
        return false;
    }
    
    JSValue parsed_value = JS_Eval(ctx, value_json, strlen(value_json), "<value>", 0);
    
    bool success = false;
    if (!JS_IsException(parsed_value)) {
        JSValue global = JS_GetGlobalObject(ctx);
        int ret = JS_SetPropertyStr(ctx, global, name, parsed_value);
        success = (ret == 1);
        JS_FreeValue(ctx, global);
        LOGI("Injected global: %s", name);
    } else {
        JS_FreeValue(ctx, parsed_value);
        LOGE("Failed to parse JSON value for: %s", name);
    }
    
    env->ReleaseStringUTFChars(name_java, name);
    env->ReleaseStringUTFChars(value_java, value_json);
    
    return success;
}

/**
 * Libera il memory del context
 */
JNIEXPORT void JNICALL
Java_com_reactor_app_QuickJsWrapper_freeContext(JNIEnv *env, jobject thiz, jlong context_ptr) {
    JSContext *ctx = (JSContext *)context_ptr;
    if (ctx) {
        JS_FreeContext(ctx);
        LOGI("QuickJS context freed");
    }
}

/**
 * Libera il memory del runtime
 */
JNIEXPORT void JNICALL
Java_com_reactor_app_QuickJsWrapper_freeRuntime(JNIEnv *env, jobject thiz, jlong runtime_ptr) {
    JSRuntime *rt = (JSRuntime *)runtime_ptr;
    if (rt) {
        JS_FreeRuntime(rt);
        LOGI("QuickJS runtime freed");
    }
    
    pthread_mutex_lock(&opsLock);
    if (opsObject) {
        // Cannot delete global ref here without JNIEnv, so just clear
        opsObject = nullptr;
    }
    pthread_mutex_unlock(&opsLock);
}

}  // extern "C"
