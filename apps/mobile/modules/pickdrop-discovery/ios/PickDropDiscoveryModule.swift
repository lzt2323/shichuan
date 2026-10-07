import ExpoModulesCore
import Foundation
import Darwin
import Network

public final class PickDropDiscoveryModule: Module {
  private var scanner: BonjourScanner?

  public func definition() -> ModuleDefinition {
    Name("PickDropDiscovery")
    Events("onService", "onLost", "onState", "onNetworkChanged")
    AsyncFunction("start") { (sessionId: String) in
      self.scanner?.stop()
      let scanner = BonjourScanner(sessionId: sessionId) { [weak self] name, body in
        self?.sendEvent(name, body)
      }
      self.scanner = scanner
      scanner.start()
    }.runOnQueue(.main)
    AsyncFunction("stop") { (sessionId: String) in
      if self.scanner?.sessionId == sessionId { self.scanner?.stop(); self.scanner = nil }
    }.runOnQueue(.main)
    OnAppEntersBackground { DispatchQueue.main.async { self.scanner?.stop(); self.scanner = nil } }
    OnDestroy { DispatchQueue.main.async { self.scanner?.stop(); self.scanner = nil } }
  }
}

private final class BonjourScanner: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  let sessionId: String
  private let emit: (String, [String: Any]) -> Void
  private let browser = NetServiceBrowser()
  private var services: [String: NetService] = [:]
  private var active = true
  private let pathMonitor = NWPathMonitor()
  private var pathSignature: String?
  private var attempts: [String: Int] = [:]
  private var retries: [String: DispatchWorkItem] = [:]

  init(sessionId: String, emit: @escaping (String, [String: Any]) -> Void) {
    self.sessionId = sessionId; self.emit = emit
    super.init()
  }
  func start() {
    pathMonitor.pathUpdateHandler = { [weak self] path in
      let signature = "\(path.status)|\(self?.localAddresses() ?? "")"
      DispatchQueue.main.async {
        guard let self = self, self.active else { return }
        if let previous = self.pathSignature, previous != signature {
          self.emit("onNetworkChanged", ["sessionId": self.sessionId])
        }
        self.pathSignature = signature
      }
    }
    pathMonitor.start(queue: DispatchQueue(label: "pickdrop-network-path"))
    browser.delegate = self
    browser.searchForServices(ofType: "_pickdrop._tcp.", inDomain: "local.")
  }
  private func localAddresses() -> String {
    var first: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&first) == 0 else { return "" }
    defer { freeifaddrs(first) }
    var cursor = first, values: [String] = []
    while let item = cursor {
      if let address = item.pointee.ifa_addr, address.pointee.sa_family == sa_family_t(AF_INET) {
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
          values.append("\(String(cString: item.pointee.ifa_name)):\(String(cString: host))")
        }
      }
      cursor = item.pointee.ifa_next
    }
    return values.sorted().joined(separator: ",")
  }
  func stop() {
    active = false; pathMonitor.cancel(); pathMonitor.pathUpdateHandler = nil
    for retry in retries.values { retry.cancel() }; retries.removeAll(); attempts.removeAll()
    browser.delegate = nil; browser.stop()
    for service in services.values { service.delegate = nil; service.stop() }
    services.removeAll()
  }
  private func key(_ service: NetService) -> String { "\(service.name)|\(service.type)" }
  private func state(_ value: String, _ message: String = "") {
    if active { emit("onState", ["sessionId": sessionId, "state": value, "message": message]) }
  }
  func netServiceBrowserWillSearch(_ browser: NetServiceBrowser) { state("scanning") }
  func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) { state("stopped") }
  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
    let code = errorDict[NetService.errorCode]?.intValue ?? 0
    if code == -65570 {
      state("permission-denied", "请在系统设置中允许拾传访问本地网络")
    } else if code == NetService.ErrorCode.missingRequiredConfigurationError.rawValue {
      state("error", "应用的 Bonjour 配置缺失，请更新或重新安装客户端（\(code)）")
    } else {
      state("error", "无法查找附近设备，请检查 Wi-Fi 后重试（\(code)）")
    }
    stop()
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    guard active else { return }
    let id = key(service)
    guard services[id] == nil, services.count < 100 else { return }
    services[id] = service; attempts[id] = 0; resolve(service)
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    guard active else { return }
    let id = key(service)
    retries.removeValue(forKey: id)?.cancel(); attempts.removeValue(forKey: id)
    services[id]?.delegate = nil; services[id]?.stop(); services.removeValue(forKey: id)
    emit("onLost", ["sessionId": sessionId, "serviceId": id])
  }
  func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
    guard active, services[key(sender)] === sender else { return }
    let id = key(sender), attempt = attempts[id] ?? 0
    sender.delegate = nil; sender.stop()
    // Keep retrying a present service, with at most one timer and a 60s ceiling.
    retries.removeValue(forKey: id)?.cancel()
    let delay = min(60.0, pow(2.0, Double(max(0, attempt - 1))))
    let retry = DispatchWorkItem { [weak self, weak sender] in
      guard let self = self, let sender = sender, self.active, self.services[id] === sender else { return }
      self.retries.removeValue(forKey: id)
      self.resolve(sender)
    }
    retries[id] = retry
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: retry)
  }
  private func resolve(_ service: NetService) {
    let id = key(service)
    attempts[id] = min(7, (attempts[id] ?? 0) + 1)
    service.delegate = self; service.resolve(withTimeout: 6)
  }
  func netServiceDidResolveAddress(_ sender: NetService) {
    guard active, services[key(sender)] === sender, sender.port > 0, sender.port <= 65535 else { return }
    let addresses: [String] = (sender.addresses ?? []).compactMap { data in
      data.withUnsafeBytes { raw -> String? in
        guard let base = raw.baseAddress, data.count >= MemoryLayout<sockaddr_in>.size else { return nil }
        let address = base.assumingMemoryBound(to: sockaddr.self)
        guard address.pointee.sa_family == sa_family_t(AF_INET) else { return nil }
        var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        guard getnameinfo(address, socklen_t(data.count), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
        return String(cString: buffer)
      }
    }
    guard !addresses.isEmpty else { netService(sender, didNotResolve: [:]); return }
    let id = key(sender)
    retries.removeValue(forKey: id)?.cancel(); attempts[id] = 0
    var txt: [String: String] = [:]
    if let data = sender.txtRecordData() {
      for (name, value) in NetService.dictionary(fromTXTRecord: data) { txt[name] = String(data: value, encoding: .utf8) }
    }
    emit("onService", ["sessionId": sessionId, "serviceId": key(sender), "addresses": Array(Set(addresses)), "port": sender.port, "txt": txt])
  }
}
