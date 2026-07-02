#include <jni.h>
#include <android/log.h>
#include <quickjs.h>
#include <quickjs-libc.h>
#include <string.h>
#include <stdlib.h>

#define LOG_TAG "QuickJsJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" {

/**
 * Crea un nuovo runtime QuickJS
 */
JNIEXPORT jlong JNICALL
Java_com_reactor_app_QuickJsWrapper_createRuntime(JNIEnv *env, jobject thiz) {
    JSRuntime *rt = JS_NewRuntime();
    if (!rt) {
        LOGE("Failed to create QuickJS runtime");
        return 0;
    }
    LOGI("QuickJS runtime created");
    return (jlong)rt;
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
    
    // Initialize standard objects (console, etc) - commented out as quickjs-libc not compiled
    // js_std_add_helpers(ctx, 0, NULL);
    
    LOGI("QuickJS context created");
    return (jlong)ctx;
}

/**
 * Esegue uno script JavaScript
 */
JNIEXPORT jstring JNICALL
Java_com_reactor_app_QuickJsWrapper_evaluateScript(JNIEnv *env, jobject thiz, 
                                                   jlong context_ptr, jstring script_java) {
    JSContext *ctx = (JSContext *)context_ptr;
    if (!ctx) {
        LOGE("Invalid context pointer");
        return NULL;
    }
    
    const char *script = env->GetStringUTFChars(script_java, NULL);
    if (!script) {
        LOGE("Failed to get script string");
        return NULL;
    }
    
    // Evalua lo script
    JSValue result = JS_Eval(ctx, script, strlen(script), "<script>", JS_EVAL_TYPE_MODULE);
    
    env->ReleaseStringUTFChars(script_java, script);
    
    // Converti il risultato a stringa
    jstring result_str = NULL;
    if (JS_IsException(result)) {
        // Leggi l'errore
        JSValue exception = JS_GetException(ctx);
        const char *error = JS_ToCString(ctx, exception);
        result_str = env->NewStringUTF(error ? error : "Unknown error");
        JS_FreeCString(ctx, error);
        JS_FreeValue(ctx, exception);
        LOGE("Script evaluation failed");
    } else {
        // Converti il risultato a stringa
        const char *result_cstr = JS_ToCString(ctx, result);
        result_str = env->NewStringUTF(result_cstr ? result_cstr : "undefined");
        JS_FreeCString(ctx, result_cstr);
        LOGI("Script executed successfully");
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
        LOGE("Invalid context pointer");
        return NULL;
    }
    
    const char *func_name = env->GetStringUTFChars(func_name_java, NULL);
    const char *args_json = env->GetStringUTFChars(args_java, NULL);
    
    if (!func_name || !args_json) {
        if (func_name) env->ReleaseStringUTFChars(func_name_java, func_name);
        if (args_json) env->ReleaseStringUTFChars(args_java, args_json);
        LOGE("Failed to get function name or args");
        return NULL;
    }
    
    // Get the global object
    JSValue global = JS_GetGlobalObject(ctx);
    
    // Get the function from global
    JSValue func = JS_GetPropertyStr(ctx, global, func_name);
    
    env->ReleaseStringUTFChars(func_name_java, func_name);
    env->ReleaseStringUTFChars(args_java, args_json);
    
    // Parse JSON args
    JSValue parsed_args = JS_Eval(ctx, args_json, strlen(args_json), "<args>", 0);
    
    jstring result_str = NULL;
    
    if (JS_IsFunction(ctx, func) && !JS_IsException(parsed_args)) {
        // Chiama la funzione con gli argomenti
        JSValue result = JS_Call(ctx, func, JS_UNDEFINED, 1, &parsed_args);
        
        if (JS_IsException(result)) {
            JSValue exception = JS_GetException(ctx);
            const char *error = JS_ToCString(ctx, exception);
            result_str = env->NewStringUTF(error ? error : "Function call failed");
            JS_FreeCString(ctx, error);
            JS_FreeValue(ctx, exception);
            LOGE("Function call failed");
        } else {
            const char *result_cstr = JS_ToCString(ctx, result);
            result_str = env->NewStringUTF(result_cstr ? result_cstr : "undefined");
            JS_FreeCString(ctx, result_cstr);
            LOGI("Function called successfully");
            JS_FreeValue(ctx, result);
        }
    } else {
        result_str = env->NewStringUTF("Function not found or invalid args");
        LOGE("Function not found or args parsing failed");
    }
    
    JS_FreeValue(ctx, parsed_args);
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
    
    // Parse JSON value
    JSValue parsed_value = JS_Eval(ctx, value_json, strlen(value_json), "<value>", 0);
    
    bool success = false;
    if (!JS_IsException(parsed_value)) {
        // Set nella global object
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
}

}  // extern "C"
