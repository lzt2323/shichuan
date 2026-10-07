package app.pickdrop.peer

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.Uri
import android.util.AtomicFile
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedInputStream
import java.io.File
import java.net.Inet4Address
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Foreground-only HTTP transport. Authorization is decided by the peer protocol
 * before a file path is returned; only owned blob files can ever be streamed. */
class PickDropPeerModule : Module() {
  private data class Reply(val status: Int, val body: String, val file: String?)
  private data class Pending(val latch: CountDownLatch = CountDownLatch(1), var reply: Reply? = null)
  private val requests = ConcurrentHashMap<String, Pending>()
  private val sockets = ConcurrentHashMap.newKeySet<Socket>()
  private val streaming = ConcurrentHashMap.newKeySet<String>()
  private var server: ServerSocket? = null
  private var address: String? = null
  private var pool: ThreadPoolExecutor? = null
  private val advertisements = mutableListOf<NsdManager.RegistrationListener>()
  private fun clearAdvertisements() {
    val nsd = appContext.reactContext?.getSystemService(Context.NSD_SERVICE) as? NsdManager
    synchronized(advertisements) { advertisements.forEach { runCatching { nsd?.unregisterService(it) } }; advertisements.clear() }
  }
  private fun root(): File = File((appContext.reactContext ?: error("应用暂不可用")).filesDir, "PickDropPeer").apply { mkdirs() }
  private fun checkedKey(key: String): String { require(key.matches(Regex("[a-zA-Z0-9_-]{1,100}"))) { "Invalid storage key" }; return key }
  private fun stop() {
    clearAdvertisements()
    val current = server; server = null; address = null
    runCatching { current?.close() }
    requests.values.forEach { it.latch.countDown() }; requests.clear()
    sockets.toList().forEach { runCatching { it.close() } }; sockets.clear()
    pool?.shutdownNow(); pool = null
  }
  override fun definition() = ModuleDefinition {
    Name("PickDropPeer")
    Events("request", "diagnostic")
    AsyncFunction("start") {
      val context = appContext.reactContext ?: error("应用暂不可用")
      val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val network = connectivity.activeNetwork ?: error("请连接 Wi-Fi 或有线局域网")
      val caps = connectivity.getNetworkCapabilities(network)
      require(caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) { "请连接 Wi-Fi 或有线局域网" }
      val ip = connectivity.getLinkProperties(network)?.linkAddresses?.map { it.address }?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress }?.hostAddress ?: error("当前网络没有 IPv4 地址")
      if (server == null || address != ip) {
        stop()
        val listener = try { ServerSocket(47325, 16, InetAddress.getByName(ip)) } catch (_: Exception) { ServerSocket(0, 16, InetAddress.getByName(ip)) }
        server = listener; address = ip
        val executor = ThreadPoolExecutor(2, 8, 30L, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(16))
        pool = executor
        Thread {
          while (!listener.isClosed) {
            val socket = try { listener.accept() } catch (_: Exception) { break }
            sockets.add(socket)
            try { executor.execute { try { handle(socket) } finally { sockets.remove(socket); runCatching { socket.close() } } } }
            catch (_: Exception) { sockets.remove(socket); runCatching { socket.close() } }
          }
        }.apply { name = "pickdrop-peer-http"; isDaemon = true; start() }
      }
      mapOf("baseUrl" to "http://$ip:${server!!.localPort}", "address" to ip, "port" to server!!.localPort)
    }
    AsyncFunction("stop") { stop() }
    AsyncFunction("advertise") { groups: List<Map<String, String>> ->
      clearAdvertisements()
      val nsd = appContext.reactContext?.getSystemService(Context.NSD_SERVICE) as? NsdManager
      val port = server?.localPort ?: 0
      if (nsd != null && port > 0) groups.take(50).forEach { group ->
        val groupId = group["groupId"] ?: error("Missing group")
        val deviceId = group["hostDeviceId"] ?: error("Missing device")
        val info = NsdServiceInfo().apply {
          serviceName = "pickdrop-" + MessageDigest.getInstance("SHA-256").digest("$groupId:$deviceId".toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }.take(40); serviceType = "_pickdrop._tcp."; setPort(port)
          setAttribute("protocol", "pickdrop"); setAttribute("version", "1"); setAttribute("groupId", groupId)
          setAttribute("hostDeviceId", deviceId); setAttribute("name", group["name"] ?: "传输群"); setAttribute("peerProtocol", "pickdrop-peer-v1")
        }
        val registration = object : NsdManager.RegistrationListener {
          override fun onServiceRegistered(service: NsdServiceInfo) {}
          override fun onRegistrationFailed(service: NsdServiceInfo, code: Int) { sendEvent("diagnostic", mapOf("message" to "附近广播失败（$code），可使用邀请链接中的地址连接")) }
          override fun onServiceUnregistered(service: NsdServiceInfo) {}
          override fun onUnregistrationFailed(service: NsdServiceInfo, code: Int) {}
        }
        synchronized(advertisements) { advertisements.add(registration) }
        runCatching { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration) }
      }
    }
    AsyncFunction("respond") { id: String, status: Int, body: String, fileUri: String? ->
      require(status in 200..599 && body.toByteArray().size <= 16 * 1024 * 1024)
      requests[id]?.let { it.reply = Reply(status, body, fileUri); it.latch.countDown() }
    }
    AsyncFunction("readRecord") { key: String ->
      val file = AtomicFile(File(root(), checkedKey(key) + ".json"))
      try { file.openRead().bufferedReader().use { it.readText() } } catch (_: java.io.FileNotFoundException) { null }
    }
    AsyncFunction("writeRecord") { key: String, value: String ->
      require(value.toByteArray().size <= 64 * 1024 * 1024) { "群记录超过存储上限" }
      val file = AtomicFile(File(root(), checkedKey(key) + ".json")); val output = file.startWrite()
      try { output.write(value.toByteArray()); file.finishWrite(output) } catch (error: Exception) { file.failWrite(output); throw error }
    }
    AsyncFunction("deleteRecord") { key: String -> AtomicFile(File(root(), checkedKey(key) + ".json")).delete() }
    AsyncFunction("importFile") { uri: String ->
      val context = appContext.reactContext ?: error("应用暂不可用")
      val parsed = Uri.parse(uri); require(parsed.scheme == "file" || parsed.scheme == "content")
      val folder = File(root(), "blobs").apply { mkdirs() }; val temp = File(folder, ".${UUID.randomUUID()}.partial")
      val digest = MessageDigest.getInstance("SHA-256"); var size = 0L
      try {
        context.contentResolver.openInputStream(parsed)?.use { input -> temp.outputStream().use { output ->
          val buffer = ByteArray(256 * 1024)
          while (true) { val count = input.read(buffer); if (count < 0) break; size += count; require(size <= 8L * 1024 * 1024 * 1024) { "文件超过 8 GiB" }; digest.update(buffer, 0, count); output.write(buffer, 0, count) }
          output.fd.sync()
        } } ?: error("无法读取文件")
        val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }; val target = File(folder, hash)
        if (target.exists()) temp.delete() else check(temp.renameTo(target)) { "无法保存文件" }
        mapOf("uri" to Uri.fromFile(target).toString(), "sha256" to hash, "size" to size)
      } finally { temp.delete() }
    }
    AsyncFunction("hasFile") { hash: String ->
      require(hash.matches(Regex("[a-f0-9]{64}")))
      val file = File(File(root(), "blobs"), hash)
      if (file.isFile) mapOf("uri" to Uri.fromFile(file).toString(), "size" to file.length()) else null
    }
    AsyncFunction("removeFile") { hash: String -> require(hash.matches(Regex("[a-f0-9]{64}"))); File(File(root(), "blobs"), hash).delete() }
    AsyncFunction("fileStats") {
      val files = File(root(), "blobs").listFiles()?.filter { it.isFile && it.name.matches(Regex("[a-f0-9]{64}")) } ?: emptyList()
      mapOf("count" to files.size, "bytes" to files.sumOf { it.length() })
    }
    AsyncFunction("clearFiles") {
      var count = 0
      File(root(), "blobs").listFiles()?.forEach { file ->
        if (file.name.matches(Regex("[a-f0-9]{64}")) && !streaming.contains(file.canonicalPath) && file.delete()) count++
      }
      mapOf("removed" to count)
    }
    OnActivityEntersBackground { stop() }
    OnDestroy { stop() }
  }
  private fun line(input: BufferedInputStream, max: Int): String {
    val bytes = java.io.ByteArrayOutputStream()
    while (true) { val n = input.read(); if (n < 0) error("Incomplete request"); if (n == 10) break; if (n != 13) bytes.write(n); require(bytes.size() <= max) { "Header too large" } }
    return bytes.toString("UTF-8")
  }
  private fun handle(socket: Socket) {
    try {
      socket.soTimeout = 10000
      val input = BufferedInputStream(socket.getInputStream()); val first = line(input, 4096).split(" ")
      require(first.size == 3 && first[0] in listOf("GET", "POST") && first[1].startsWith("/api/"))
      val headers = mutableMapOf<String, String>(); var headerBytes = 0
      while (true) { val text = line(input, 8192); if (text.isEmpty()) break; headerBytes += text.length; require(headerBytes <= 32768); val split = text.indexOf(':'); require(split > 0); val key = text.substring(0, split).lowercase(); require(!headers.containsKey(key)); headers[key] = text.substring(split + 1).trim() }
      require(!headers.containsKey("transfer-encoding"))
      val count = headers["content-length"]?.toIntOrNull() ?: 0; require(count in 0..(16 * 1024 * 1024))
      val bytes = ByteArray(count); var read = 0
      while (read < count) { val n = input.read(bytes, read, count - read); require(n > 0); read += n }
      val id = UUID.randomUUID().toString(); val pending = Pending(); requests[id] = pending
      val reply = try {
        sendEvent("request", mapOf("id" to id, "method" to first[0], "path" to first[1], "headers" to headers, "body" to bytes.toString(Charsets.UTF_8), "remoteAddress" to socket.inetAddress.hostAddress))
        if (pending.latch.await(10, TimeUnit.SECONDS)) pending.reply else null
      } finally { requests.remove(id) }
      if (reply == null) { write(socket, 503, "{\"error\":\"手机节点已暂停，请返回应用\"}"); return }
      if (reply.file != null && reply.status == 200) {
        val file = File(Uri.parse(reply.file).path ?: error("Invalid file")); val base = File(root(), "blobs").canonicalFile
        require(file.canonicalFile.parentFile == base && file.name.matches(Regex("[a-f0-9]{64}")))
        if (!file.isFile) { write(socket, 404, "{\"error\":\"此设备尚未持有文件\"}"); return }
        streaming.add(file.canonicalPath)
        try {
          val output = socket.getOutputStream(); output.write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${file.length()}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".toByteArray()); file.inputStream().use { it.copyTo(output, 256 * 1024) }; output.flush()
        } finally { streaming.remove(file.canonicalPath) }
      } else write(socket, reply.status, reply.body)
    } catch (_: Exception) { runCatching { write(socket, 400, "{\"error\":\"请求无效或已中断\"}") } }
  }
  private fun write(socket: Socket, status: Int, body: String) {
    val bytes = body.toByteArray(); val output = socket.getOutputStream()
    output.write("HTTP/1.1 $status Response\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".toByteArray()); output.write(bytes); output.flush()
  }
}
