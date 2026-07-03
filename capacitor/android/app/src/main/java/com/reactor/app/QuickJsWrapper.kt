package com.reactor.app

import org.json.JSONObject

/**
 * Wrapper per QuickJS runtime via JNI
 * Carica libquickjs_jni.so (compilata da CMake, che linka libquickjs.so)
 */
class QuickJsWrapper {
    companion object {
        init {
            System.loadLibrary("quickjs_jni")
        }
    }

    private var runtimePtr: Long = 0
    private var contextPtr: Long = 0
    private var ops: ReactorScriptOps? = null
    private var context: android.content.Context? = null

    /**
     * Crea un nuovo runtime QuickJS
     */
    external fun createRuntime(): Long

    /**
     * Crea un nuovo context nel runtime
     */
    external fun createContext(runtimePtr: Long): Long

    /**
     * Esegue uno script JavaScript
     * @param contextPtr pointer al context QuickJS
     * @param script codice JavaScript
     * @return risultato dell'esecuzione oppure null se errore
     */
    external fun evaluateScript(contextPtr: Long, script: String): String?

    /**
     * Chiama una funzione JavaScript esportata
     * @param contextPtr pointer al context
     * @param functionName nome della funzione
     * @param args argomenti (JSON stringify)
     * @return risultato come stringa
     */
    external fun callFunction(contextPtr: Long, functionName: String, args: String): String?

    /**
     * Inietta un oggetto global nel context
     * @param contextPtr pointer al context
     * @param name nome della variabile globale
     * @param jsonValue valore come JSON string
     */
    external fun injectGlobal(contextPtr: Long, name: String, jsonValue: String): Boolean

    /**
     * Registra le funzioni native che JavaScript può richiamare
     * @param contextPtr pointer al context
     * @param opsObject oggetto Kotlin che implementa ReactorScriptOps
     */
    external fun registerNativeOps(contextPtr: Long, opsObject: ReactorScriptOps): Boolean

    /**
     * Inizializza il transpiler JavaScript nel context
     * @param contextPtr pointer al context
     * @param transpilerCode codice JavaScript del transpiler
     */
    external fun initializeTranspiler(contextPtr: Long, transpilerCode: String): Boolean

    /**
     * Libera il memory del context
     */
    external fun freeContext(contextPtr: Long)

    /**
     * Libera il memory del runtime
     */
    external fun freeRuntime(runtimePtr: Long)

    /**
     * API pubblica: esecuzione di script
     */
    fun initialize(context: android.content.Context): Boolean {
        return try {
            this.context = context
            android.util.Log.d("QuickJsWrapper", "INIT_STEP_1_CREATE_RUNTIME")
            runtimePtr = createRuntime()
            
            if (runtimePtr == 0L) {
                android.util.Log.e("QuickJsWrapper", "INIT_STEP_1_FAILED createRuntime returned 0 (NULL)")
                return false
            }
            android.util.Log.d("QuickJsWrapper", "INIT_STEP_1_SUCCESS runtimePtr=$runtimePtr (0x${runtimePtr.toString(16)})")
            
            android.util.Log.d("QuickJsWrapper", "INIT_STEP_2_CREATE_CONTEXT")
            contextPtr = createContext(runtimePtr)
            
            if (contextPtr == 0L) {
                android.util.Log.e("QuickJsWrapper", "INIT_STEP_2_FAILED createContext returned 0 (NULL)")
                return false
            }
            android.util.Log.d("QuickJsWrapper", "INIT_STEP_2_SUCCESS contextPtr=$contextPtr (0x${contextPtr.toString(16)})")
            
            android.util.Log.d("QuickJsWrapper", "INIT_STEP_3_LOAD_TRANSPILER")
            
            // Load and initialize transpiler
            val transpilerCode = loadTranspilerFromAssets(context)
            if (transpilerCode.isNullOrEmpty()) {
                android.util.Log.e("QuickJsWrapper", "INIT_STEP_3_FAILED transpiler is null or empty")
                return false
            }
            android.util.Log.d("QuickJsWrapper", "INIT_STEP_4_INIT_TRANSPILER transpiler size=${transpilerCode.length}")
            
            val initResult = initializeTranspiler(contextPtr, transpilerCode)
            if (!initResult) {
                android.util.Log.e("QuickJsWrapper", "INIT_STEP_4_FAILED initializeTranspiler returned false")
                return false
            }
            
            android.util.Log.d("QuickJsWrapper", "INIT_SUCCESS runtimePtr=$runtimePtr contextPtr=$contextPtr")
            true  // Success - both runtime and context created
        } catch (e: Exception) {
            android.util.Log.e("QuickJsWrapper", "INIT_EXCEPTION: ${e.message}", e)
            false
        }
    }

    private fun loadTranspilerFromAssets(context: android.content.Context): String? {
        return try {
            android.util.Log.d("QuickJsWrapper", "LOAD_TRANSPILER_START")
            val assetManager = context.assets
            val inputStream = assetManager.open("transpiler.js")
            android.util.Log.d("QuickJsWrapper", "LOAD_TRANSPILER_OPENED")
            val buffer = ByteArray(inputStream.available())
            inputStream.read(buffer)
            inputStream.close()
            android.util.Log.d("QuickJsWrapper", "LOAD_TRANSPILER_SUCCESS size=${buffer.size}")
            String(buffer, Charsets.UTF_8)
        } catch (e: Exception) {
            android.util.Log.e("QuickJsWrapper", "LOAD_TRANSPILER_FAILED: ${e.message}", e)
            null
        }
    }

    fun setNativeOps(newOps: ReactorScriptOps): Boolean {
        ops = newOps
        return if (contextPtr != 0L) {
            registerNativeOps(contextPtr, newOps)
        } else {
            false
        }
    }

    fun execute(script: String): String? {
        return if (contextPtr != 0L) evaluateScript(contextPtr, script) else null
    }

    fun call(functionName: String, args: String = "{}"): String? {
        return if (contextPtr != 0L) callFunction(contextPtr, functionName, args) else null
    }

    /**
     * Transpila TypeScript code usando il transpiler JavaScript nel context
     */
    fun transpile(code: String): String? {
        if (contextPtr == 0L) {
            android.util.Log.e("QuickJsWrapper", "transpile: contextPtr is 0 (NULL)")
            return null
        }
        
        android.util.Log.d("QuickJsWrapper", "transpile: START code.length=${code.length}")
        
        // Use JSON quoting to safely embed any TS source in JS code.
        val quotedCode = JSONObject.quote(code)
        android.util.Log.d("QuickJsWrapper", "transpile: QUOTED quoted.length=${quotedCode.length}")
        
        val transpileCall = """
            (function() {
                try {
                    return transpile($quotedCode);
                } catch (e) {
                    return "Error: " + e.message;
                }
            })()
        """.trimIndent()
        
        android.util.Log.d("QuickJsWrapper", "transpile: EXECUTE")
        val result = execute(transpileCall)
        if (result == null) {
            android.util.Log.e("QuickJsWrapper", "transpile: RESULT null")
        } else {
            android.util.Log.d("QuickJsWrapper", "transpile: RESULT_FULL len=${result.length}")
            logLongScript("QuickJsWrapper", "TRANSPILED_JS_FULL", result)
        }
        
        return result
    }

    private fun logLongScript(tag: String, label: String, script: String, chunkSize: Int = 1500) {
        if (script.isEmpty()) {
            android.util.Log.v(tag, "$label [empty]")
            return
        }

        var offset = 0
        var index = 1
        val totalChunks = (script.length + chunkSize - 1) / chunkSize
        while (offset < script.length) {
            val end = minOf(offset + chunkSize, script.length)
            val chunk = script.substring(offset, end)
            android.util.Log.v(tag, "$label part $index/$totalChunks:\n$chunk")
            offset = end
            index += 1
        }
    }

    fun cleanup() {
        if (contextPtr != 0L) {
            freeContext(contextPtr)
            contextPtr = 0
        }
        if (runtimePtr != 0L) {
            freeRuntime(runtimePtr)
            runtimePtr = 0
        }
    }
}
