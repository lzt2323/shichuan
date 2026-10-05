package app.pickdrop.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.util.ArrayDeque

/** NSD runs through Android's system mDNS daemon; no Wi-Fi/location scan permission. */
class PickDropDiscoveryModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var manager: NsdManager? = null
  private var listener: NsdManager.DiscoveryListener? = null
  private var session: String? = null
  private var resolving = false
  private var resolveGeneration = 0
  private var resolver: NsdManager.ResolveListener? = null
  private var watchdog: Runnable? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private val attempts = mutableMapOf<String, Int>()
  private val retries = mutableSetOf<Runnable>()
  private val waiting = ArrayDeque<NsdServiceInfo>()
  private val present = mutableSetOf<String>()
  private val resolved = mutableSetOf<String>()

  override fun definition() = ModuleDefinition {
    Name("PickDropDiscovery")
    Events("onService", "onLost", "onState")
    AsyncFunction("start") { id: String, promise: Promise ->
      main.post {
        stop()
        val context = appContext.reactContext
        if (context == null) { promise.reject("ERR_DISCOVERY_UNAVAILABLE", "应用尚未准备好，请重试", null) }
        else {
          manager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
          val nsd = manager
          if (nsd == null) { promise.reject("ERR_DISCOVERY_UNAVAILABLE", "这台设备不支持附近发现", null) }
          else {
            session = id
            val discovery = discoveryListener(id)
            listener = discovery
            try {
              // Older Android NSD implementations need Wi-Fi multicast delivery enabled.
              if (Build.VERSION.SDK_INT < 34) {
                val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                multicastLock = wifi?.createMulticastLock("pickdrop-nearby")?.apply { setReferenceCounted(false); acquire() }
              }
              nsd.discoverServices("_pickdrop._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery)
              promise.resolve(null)
            } catch (error: SecurityException) {
              emitState(id, "permission-denied", "系统阻止了本地网络发现，请在应用设置中检查网络权限")
              stop(); promise.reject("ERR_DISCOVERY_PERMISSION", error.message, error)
            } catch (error: Exception) {
              emitState(id, "error", "无法开始查找，请检查 Wi-Fi 后重试")
              stop(); promise.reject("ERR_DISCOVERY_START", error.message, error)
            }
          }
        }
      }
    }
    AsyncFunction("stop") { id: String, promise: Promise ->
      main.post { if (session == id) stop(); promise.resolve(null) }
    }
    OnActivityEntersBackground { main.post { stop() } }
    OnDestroy { main.post { stop() } }
  }

  private fun key(service: NsdServiceInfo) = "${service.serviceName}|${service.serviceType}"
  private fun emitState(id: String, state: String, message: String = "") {
    if (session == id) sendEvent("onState", mapOf("sessionId" to id, "state" to state, "message" to message))
  }
  private fun discoveryListener(id: String) = object : NsdManager.DiscoveryListener {
    override fun onDiscoveryStarted(type: String) { main.post { emitState(id, "scanning") } }
    override fun onDiscoveryStopped(type: String) { main.post { emitState(id, "stopped") } }
    override fun onStartDiscoveryFailed(type: String, error: Int) { main.post {
      if (session == id) { emitState(id, "error", "附近发现暂不可用（$error），请重试或扫码加入"); stop() }
    } }
    override fun onStopDiscoveryFailed(type: String, error: Int) { main.post {
      if (session == id) emitState(id, "error", "停止发现失败（$error）")
    } }
    override fun onServiceFound(service: NsdServiceInfo) { main.post {
      if (session == id && service.serviceType.trimEnd('.') == "_pickdrop._tcp") {
        val serviceKey = key(service)
        if (present.size < 100 && present.add(serviceKey)) { waiting.addLast(service); resolveNext(id) }
      }
    } }
    override fun onServiceLost(service: NsdServiceInfo) { main.post {
      if (session == id) {
        val serviceKey = key(service)
        present.remove(serviceKey); resolved.remove(serviceKey); attempts.remove(serviceKey)
        sendEvent("onLost", mapOf("sessionId" to id, "serviceId" to serviceKey))
      }
    } }
  }

  @Suppress("DEPRECATION")
  private fun resolveNext(id: String) {
    if (session != id || resolving) return
    while (waiting.isNotEmpty()) {
      val service = waiting.removeFirst()
      val serviceKey = key(service)
      if (!present.contains(serviceKey) || resolved.contains(serviceKey)) continue
      resolving = true
      attempts[serviceKey] = (attempts[serviceKey] ?: 0) + 1
      val attempt = ++resolveGeneration
      fun finish(retry: Boolean) {
        if (session != id || resolveGeneration != attempt) return
        resolveGeneration++
        watchdog?.let { main.removeCallbacks(it) }; watchdog = null
        resolving = false; resolver = null
        if (retry && present.contains(serviceKey) && (attempts[serviceKey] ?: 0) < 3) {
          lateinit var deferred: Runnable
          deferred = Runnable {
            retries.remove(deferred)
            if (session == id && present.contains(serviceKey) && !resolved.contains(serviceKey)) { waiting.addLast(service); resolveNext(id) }
          }
          retries.add(deferred); main.postDelayed(deferred, 900L)
        }
        resolveNext(id)
      }
      val callback = object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, error: Int) { main.post {
          finish(true)
        } }
        override fun onServiceResolved(info: NsdServiceInfo) { main.post {
          if (session == id && resolveGeneration == attempt) {
            if (present.contains(serviceKey)) {
              val hosts = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host)
              val ipv4 = hosts.filterIsInstance<Inet4Address>().mapNotNull { it.hostAddress }.distinct()
              if (ipv4.isNotEmpty() && info.port in 1..65535) {
                val txt = info.attributes.mapValues { (_, value) -> String(value, Charsets.UTF_8) }
                resolved.add(serviceKey)
                sendEvent("onService", mapOf("sessionId" to id, "serviceId" to serviceKey, "addresses" to ipv4, "port" to info.port, "txt" to txt))
              }
            }
            finish(!resolved.contains(serviceKey))
          }
        } }
      }
      resolver = callback
      val timeout = Runnable {
        if (session == id && resolveGeneration == attempt) {
          if (Build.VERSION.SDK_INT >= 34) try { manager?.stopServiceResolution(callback) } catch (_: Exception) {}
          finish(true)
        }
      }
      watchdog = timeout; main.postDelayed(timeout, 8000L)
      try { manager?.resolveService(service, callback) }
      catch (error: Exception) { finish(true) }
      return
    }
  }

  private fun stop() {
    val oldListener = listener
    session = null; listener = null; waiting.clear(); present.clear(); resolved.clear(); attempts.clear(); resolving = false; resolveGeneration++
    watchdog?.let { main.removeCallbacks(it) }; watchdog = null
    for (retry in retries) main.removeCallbacks(retry)
    retries.clear()
    if (Build.VERSION.SDK_INT >= 34) resolver?.let { try { manager?.stopServiceResolution(it) } catch (_: Exception) {} }
    resolver = null
    multicastLock?.let { if (it.isHeld) try { it.release() } catch (_: Exception) {} }; multicastLock = null
    if (oldListener != null) try { manager?.stopServiceDiscovery(oldListener) } catch (_: Exception) {}
  }
}
