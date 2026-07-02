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
    fun nodeStream(target: String, filePath: String, meta: String): String
    fun nodeSendMessage(target: String, stream: String, data: String): String
    fun copyStream(src: String, dst: String): Boolean
    fun getHomeDirectory(): String
    fun getNetworkStatus(): String
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
var module={exports:{}};var exports=module.exports;
var require=function(s){if(s==='core')return __reactorCore;throw new Error('Cannot find module: '+s);};
var process={env:{}};
var _formatArgs=function(){return [].slice.call(arguments).map(function(a){return typeof a==='object'?JSON.stringify(a):String(a);}).join(' ');};
var console={log:function(){__native.log(_formatArgs.apply(null,arguments));},error:function(){__native.log('[E] '+_formatArgs.apply(null,arguments));},warn:function(){__native.log('[W] '+_formatArgs.apply(null,arguments));}};
function Event(type,data,ts){this.type=String(type||'UNKNOWN');this.data=data||{};this.timestamp=ts||new Date().toISOString();}
function WatchEvent(data,ts){Event.call(this,'WATCH',data,ts);var d=data||{};this.watchPath=d.watchPath!=null?String(d.watchPath):'';this.relativePath=d.relativePath!=null?String(d.relativePath):'';this.watchType=d.watchType||null;}WatchEvent.prototype=Object.create(Event.prototype);
function MessageEvent(data,ts){Event.call(this,'MESSAGE',data,ts);var d=data||{};this.sender=d.sender!=null?String(d.sender):null;this.senderName=d.senderName!=null?String(d.senderName):null;this.target=d.target||null;this.targetNode=d.targetNode||null;this.targetEndpoint=d.targetEndpoint||null;this.targetEndpointId=d.targetEndpointId||null;this.content=d.content!=null?String(d.content):'';this.contentType=d.contentType!=null?String(d.contentType):'';this.bodyBase64=d.bodyBase64||'';this.json=d.json!==undefined?d.json:null;this.headers=d.headers||{};}MessageEvent.prototype=Object.create(Event.prototype);
function StreamEvent(data,ts){MessageEvent.call(this,data,ts);this.type='STREAM';this.stream=data&&data.stream?data.stream:null;}StreamEvent.prototype=Object.create(MessageEvent.prototype);
function StreamEndEvent(data,ts){Event.call(this,'STREAMEND',data,ts);var d=data||{};this.sender=d.sender||null;this.content=d.content!=null?String(d.content):'';this.contentType=d.contentType||'';this.json=d.json!==undefined?d.json:null;this.headers=d.headers||{};this.metadata=d.metadata||{};this.tmpPath=d.tmpPath!=null?String(d.tmpPath):'';}StreamEndEvent.prototype=Object.create(Event.prototype);
function ScheduleEvent(data,ts){Event.call(this,'SCHEDULE',data,ts);this.expression=data&&data.expression!=null?data.expression:null;}ScheduleEvent.prototype=Object.create(Event.prototype);
function RuntimeEvent(data,ts){Event.call(this,'EVENT',data,ts);this.name=data&&data.name!=null?String(data.name):null;this.networkChange=data&&data.networkChange!=null?data.networkChange:null;}RuntimeEvent.prototype=Object.create(Event.prototype);
function ManualEvent(data,ts){Event.call(this,'MANUAL_TEST',data,ts);this.reason=data&&data.reason!=null?String(data.reason):null;}ManualEvent.prototype=Object.create(Event.prototype);
var __reactorCore={Event:Event,WatchEvent:WatchEvent,MessageEvent:MessageEvent,StreamEvent:StreamEvent,StreamEndEvent:StreamEndEvent,ScheduleEvent:ScheduleEvent,RuntimeEvent:RuntimeEvent,ManualEvent:ManualEvent,FileSystem:{File:Object.assign(function ReactorFile(p){this.__path=String(p||'');},{open:function(p){return {__type:'FileHandle',__path:String(p||'')};},copyStream:function(input,output){var s=(input&&input.__path)?input.__path:String(input||'');var d=(output&&output.__path)?output.__path:String(output||'');return __native.copyStream(s,d);}}),Directory:function ReactorDir(p){this.__path=String(p||'');}},Node:{getHomeDirectory:function(){return __native.getHomeDirectory();},stream:function(target,source,opts){var fp=(source&&source.__path)?source.__path:String(source||'');var meta=JSON.stringify(opts&&opts.metadata?opts.metadata:{});var r=__native.nodeStream(String(target||''),fp,meta);try{return JSON.parse(r);}catch(e){return {};}},sendMessage:function(target,content,optsOrFlag){var body=typeof content==='object'&&content!==null?JSON.stringify(content):String(content==null?'':content);var ct=typeof content==='object'&&content!==null?'application/json; charset=utf-8':'text/plain; charset=utf-8';var r=__native.nodeSendMessage(String(target||''),body,ct);try{return JSON.parse(r);}catch(e){return {};}},exchange:function(){return{sendMessage:function(t,c){return __reactorCore.Node.sendMessage(t,c);},stream:function(t,s,o){return __reactorCore.Node.stream(t,s,o);}};}},Device:{notify:function(msg){return __native.deviceNotify(String(msg==null?'':msg));},Network:function(){return{getStatus:function(){try{return JSON.parse(__native.getNetworkStatus());}catch(e){return {};}}};},Battery:function(){return{exists:function(){return false;},getLevel:function(){return -1;}};},Power:function(){return{isBattery:function(){return false;}}},Position:{get:function(){return {lat:null,lon:null,available:false};}}},OS:function(){return{getArch:function(){return 'arm64';},isDesktop:function(){return false;},isMobile:function(){return true;},getName:function(){return 'android';},getFullName:function(){return 'Android (Capacitor)';}};},},HttpClient:{Request:function(r,body,hdrs,url){if(typeof r==='string'){this.url=r;this.method='GET';this.body=null;this.headers={};}else{this.url=r.url||url||'';this.method=(r.method||'GET').toUpperCase();this.body=r.body!==undefined?r.body:body!==undefined?body:null;this.headers=r.headers||hdrs||{};}},sendRequest:function(req,timeout){var r=__native.sendHttpRequest(String(req.url||''),String(req.method||'GET'),JSON.stringify(req.headers||{}),req.body!=null?String(typeof req.body==='object'?JSON.stringify(req.body):req.body):'');try{return JSON.parse(r);}catch(e){return {status:0,headers:{},body:''};}},},System:{Process:function(cmd){this.__cmd=cmd;this.spawn=function(){return __native.spawnProcess(String(this.__cmd||''));};},getHomeDirectory:function(){return __native.getHomeDirectory();}},log:function(){__native.log(_formatArgs.apply(null,arguments));}};
var log=__reactorCore.log;
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
            Log.d("SCRIPT_ENGINE", "STEP_3_RESULT compiledJs=${compiledJs?.take(100)}")
            
            if (compiledJs == null || compiledJs.startsWith("Error")) {
                Log.e("SCRIPT_ENGINE", "TRANSPILE_ERROR: $compiledJs")
                engine.cleanup()
                return Result(null, "Transpilation failed: $compiledJs")
            }
            
            Log.d("SCRIPT_ENGINE", "TYPESCRIPT_RESOLVED compiled.length=${compiledJs.length}")
            Log.v("SCRIPT_ENGINE", "COMPILED_CODE:\n${compiledJs.take(500)}")  // Log first 500 chars

            Log.d("SCRIPT_ENGINE", "QUICKJS_INITIALIZED")

            // Register native operations
            if (!engine.setNativeOps(ops)) {
                Log.e("SCRIPT_ENGINE", "Failed to register native ops")
                engine.cleanup()
                return Result(null, "Failed to register native ops")
            }
            Log.d("SCRIPT_ENGINE", "NATIVE_OPS_REGISTERED")

            // Execute bootstrap
            val bootstrapResult = engine.execute(BOOTSTRAP_JS)
            if (bootstrapResult?.startsWith("Error") == true) {
                Log.e("SCRIPT_ENGINE", "BOOTSTRAP_ERROR: $bootstrapResult")
                engine.cleanup()
                return Result(null, "Bootstrap failed: $bootstrapResult")
            }
            Log.d("SCRIPT_ENGINE", "BOOTSTRAP_DONE")

            // Quick sanity check - verify __native is available
            val checkNativeCode = "__native.log('__native available'); true;"
            val checkResult = engine.execute(checkNativeCode)
            Log.d("SCRIPT_ENGINE", "NATIVE_CHECK: $checkResult")

            // Build event object
            val buildEventCode = """
var __eventData = {};
try { __eventData = JSON.parse('$eventContextJson'); } catch (e) { }
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

            engine.execute(buildEventCode)
            Log.d("SCRIPT_ENGINE", "BUILD_EVENT_DONE")

            // Execute user script
            val userScriptResult = engine.execute(compiledJs)
            if (userScriptResult?.startsWith("Error") == true) {
                Log.e("SCRIPT_ENGINE", "USER_SCRIPT_ERROR: $userScriptResult")
                engine.cleanup()
                return Result(null, "User script failed: $userScriptResult")
            }
            Log.d("SCRIPT_ENGINE", "USER_SCRIPT_DONE")

            // Try to call run - but first check if exports.run exists
            val checkRun = "typeof exports.run"
            val runExists = engine.execute(checkRun)
            Log.d("SCRIPT_ENGINE", "exports.run exists? $runExists")

            // Call run function
            val callResult = engine.call("exports.run", "{}")
            if (callResult?.startsWith("Error") == true) {
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
}
