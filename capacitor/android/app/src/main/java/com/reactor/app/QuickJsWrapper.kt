package com.reactor.app

/**
 * Wrapper per QuickJS runtime via JNI
 * Carica libquickjs.so (compilata manualmente per arm64-v8a)
 */
class QuickJsWrapper {
    companion object {
        init {
            System.loadLibrary("quickjs")
        }
    }

    private var runtimePtr: Long = 0
    private var contextPtr: Long = 0

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
    fun initialize(): Boolean {
        return try {
            runtimePtr = createRuntime()
            contextPtr = createContext(runtimePtr)
            runtimePtr > 0 && contextPtr > 0
        } catch (e: Exception) {
            android.util.Log.e("QuickJsWrapper", "Failed to initialize: ${e.message}")
            false
        }
    }

    fun execute(script: String): String? {
        return if (contextPtr > 0) evaluateScript(contextPtr, script) else null
    }

    fun call(functionName: String, args: String = "{}"): String? {
        return if (contextPtr > 0) callFunction(contextPtr, functionName, args) else null
    }

    fun cleanup() {
        if (contextPtr > 0) {
            freeContext(contextPtr)
            contextPtr = 0
        }
        if (runtimePtr > 0) {
            freeRuntime(runtimePtr)
            runtimePtr = 0
        }
    }
}
