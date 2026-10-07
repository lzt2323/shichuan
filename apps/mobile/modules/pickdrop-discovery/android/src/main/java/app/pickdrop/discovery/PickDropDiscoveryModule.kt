package app.pickdrop.discovery

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkRequest
import android.net.NetworkCapabilities
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
import java.net.MulticastSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.DatagramPacket
import org.json.JSONObject
import java.util.ArrayDeque

/** NSD runs through Android's system mDNS daemon; no Wi-Fi/location scan permission. */
class PickDropDiscoveryModule : Module() {
  private val udpGuard = Any()
  private var udpSocket: MulticastSocket? = null
  private var connectivity: ConnectivityManager? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private val infoCallbacks = mutableMapOf<String, NsdManager.ServiceInfoCallback>()
  private val main = Handler(Looper.getMainLooper())
  private var manager: NsdManager? = null
  private var listener: NsdManager.DiscoveryListener? = null
  @Volatile private var session: String? = null
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
    Events("onService", "onLost", "onState", "onNetworkChanged")
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
              run {
                val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                multicastLock = wifi?.createMulticastLock("pickdrop-nearby")?.apply { setReferenceCounted(false); acquire() }
              }
              nsd.discoverServices("_pickdrop._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery)
              startNetworkMonitor(context, id)
              startUdp(id)
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
      if (session == id) { emitState(id, "error", "系统发现暂不可用（$error），正在尝试已配对设备广播") }
    } }
    override fun onStopDiscoveryFailed(type: String, error: Int) { main.post {
      if (session == id) emitState(id, "error", "停止发现失败（$error）")
    } }
    override fun onServiceFound(service: NsdServiceInfo) { main.post {
      if (session == id && service.serviceType.trimEnd('.') == "_pickdrop._tcp") {
        val serviceKey = key(service)
        if (present.size < 100 && present.add(serviceKey)) {
          if (Build.VERSION.SDK_INT >= 34) watchInfo(id, service, serviceKey)
          else { waiting.addLast(service); resolveNext(id) }
        }
      }
    } }
    override fun onServiceLost(service: NsdServiceInfo) { main.post {
      if (session == id) {
        val serviceKey = key(service)
        present.remove(serviceKey); resolved.remove(serviceKey); attempts.remove(serviceKey)
        if (Build.VERSION.SDK_INT >= 34) infoCallbacks.remove(serviceKey)?.let { try { manager?.unregisterServiceInfoCallback(it) } catch (_: Exception) {} }
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
                val txt = info.attributes.mapValues { (_, value) -> value?.let { String(it, Charsets.UTF_8) } ?: "" }
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

  @android.annotation.TargetApi(34)
  private fun watchInfo(id: String, service: NsdServiceInfo, serviceKey: String) {
    val callback = object : NsdManager.ServiceInfoCallback {
      override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) { main.post {
        if (session == id) { infoCallbacks.remove(serviceKey); waiting.addLast(service); resolveNext(id) }
      } }
      override fun onServiceUpdated(info: NsdServiceInfo) { main.post {
        if (session == id && present.contains(serviceKey)) {
          val addresses = info.hostAddresses.filterIsInstance<Inet4Address>().mapNotNull { it.hostAddress }
          val txt = info.attributes.mapValues { (_, value) -> value?.let { String(it, Charsets.UTF_8) } ?: "" }
          sendEvent("onService", mapOf("sessionId" to id, "serviceId" to serviceKey, "addresses" to addresses, "port" to info.port, "txt" to txt))
        }
      } }
      override fun onServiceLost() { main.post { if (session == id) sendEvent("onLost", mapOf("sessionId" to id, "serviceId" to serviceKey)) } }
      override fun onServiceInfoCallbackUnregistered() {}
    }
    infoCallbacks[serviceKey] = callback
    try { manager?.registerServiceInfoCallback(service, appContext.reactContext!!.mainExecutor, callback) }
    catch (_: Exception) { infoCallbacks.remove(serviceKey); waiting.addLast(service); resolveNext(id) }
  }

  private fun startNetworkMonitor(context: Context, id: String) {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    connectivity = cm
    val seen = cm.allNetworks.associateWith { cm.getLinkProperties(it)?.linkAddresses.toString() }.toMutableMap()
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) { if (!seen.containsKey(network)) main.post { if (session == id) sendEvent("onNetworkChanged", mapOf("sessionId" to id)) } }
      override fun onLinkPropertiesChanged(network: Network, properties: android.net.LinkProperties) {
        val signature = properties.linkAddresses.toString()
        val previous = seen.put(network, signature)
        if (previous != null && previous != signature) main.post { if (session == id) sendEvent("onNetworkChanged", mapOf("sessionId" to id)) }
      }
      override fun onLost(network: Network) { seen.remove(network); main.post { if (session == id) sendEvent("onNetworkChanged", mapOf("sessionId" to id)) } }
    }
    networkCallback = callback
    cm.registerNetworkCallback(NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET).build(), callback)
  }

  private fun startUdp(id: String) {
    Thread {
      var socket: MulticastSocket? = null
      try {
        val activeSocket = MulticastSocket(null)
        socket = activeSocket // Retain ownership before configuration or bind can throw.
        activeSocket.apply { reuseAddress = true; bind(InetSocketAddress(47320)); soTimeout = 1000; timeToLive = 1 }
        synchronized(udpGuard) { if (session != id) { activeSocket.close(); return@Thread }; udpSocket = activeSocket }
        val cm = connectivity
        val network = cm?.allNetworks?.firstOrNull { val caps = cm?.getNetworkCapabilities(it); caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true || caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true }
        val ifaceName = network?.let { cm?.getLinkProperties(it)?.interfaceName }
        val iface = ifaceName?.let { NetworkInterface.getByName(it) }
        if (iface != null) { activeSocket.networkInterface = iface; activeSocket.joinGroup(InetSocketAddress("239.255.47.32", 47320), iface) }
        else return@Thread
        val query = "{\"protocol\":\"pickdrop-discover-v1\"}".toByteArray()
        var lastQuery = 0L
        var window = 0L; var packets = 0
        while (session == id && !activeSocket.isClosed) {
          val now = System.currentTimeMillis()
          if (now - lastQuery >= 5000) { activeSocket.send(DatagramPacket(query, query.size, InetAddress.getByName("239.255.47.32"), 47320)); lastQuery = now }
          val packet = DatagramPacket(ByteArray(1025), 1025)
          try { activeSocket.receive(packet) } catch (_: java.net.SocketTimeoutException) { continue }
          if (now - window >= 1000) { window = now; packets = 0 }
          if (++packets > 64 || packet.length > 1024 || packet.address !is Inet4Address) continue
          try {
            val data = JSONObject(String(packet.data, 0, packet.length, Charsets.UTF_8))
            if (data.optString("protocol") != "pickdrop-groups-v1") continue
            val groupId = data.optString("groupId"); val hostId = data.optString("hostDeviceId"); val port = data.optInt("port")
            if (port !in 1..65535 || groupId.length != 36 || hostId.length != 36) continue
            val address = packet.address.hostAddress ?: continue
            main.post { if (session == id) sendEvent("onService", mapOf("sessionId" to id, "serviceId" to "udp:$groupId:$address", "addresses" to listOf(address), "port" to port, "txt" to mapOf("protocol" to "pickdrop", "version" to "1", "groupId" to groupId, "hostDeviceId" to hostId, "name" to data.optString("name").take(40)))) }
          } catch (_: Exception) {}
        }
      } catch (_: Exception) { /* NSD remains available if multicast is blocked. */ }
      finally { socket?.close() }
    }.apply { name = "pickdrop-udp-discovery"; isDaemon = true; start() }
  }

  private fun stop() {
    val oldListener = listener
    session = null
    synchronized(udpGuard) { udpSocket?.close(); udpSocket = null }
    networkCallback?.let { try { connectivity?.unregisterNetworkCallback(it) } catch (_: Exception) {} }; networkCallback = null
    if (Build.VERSION.SDK_INT >= 34) for (callback in infoCallbacks.values) try { manager?.unregisterServiceInfoCallback(callback) } catch (_: Exception) {}
    infoCallbacks.clear()
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
