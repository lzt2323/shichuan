import ExpoModulesCore
import Foundation
import Darwin

public final class PickDropDiscoveryModule: Module {
  private var scanner: BonjourScanner?

  public func definition() -> ModuleDefinition {
    Name("PickDropDiscovery")
    Events("onService", "onLost", "onState")
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

  init(sessionId: String, emit: @escaping (String, [String: Any]) -> Void) {
    self.sessionId = sessionId; self.emit = emit
    super.init()
  }
  func start() {
    browser.delegate = self
    browser.searchForServices(ofType: "_pickdrop._tcp.", inDomain: "local.")
  }
  func stop() {
    active = false; browser.delegate = nil; browser.stop()
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
    state(code == -72008 ? "permission-denied" : "error", code == -72008 ? "请在系统设置中允许拾传访问本地网络" : "无法查找附近设备，请检查 Wi-Fi 后重试")
    stop()
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    guard active else { return }
    let id = key(service)
    guard services[id] == nil else { return }
    services[id] = service; service.delegate = self; service.resolve(withTimeout: 6)
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    guard active else { return }
    let id = key(service)
    services[id]?.delegate = nil; services[id]?.stop(); services.removeValue(forKey: id)
    emit("onLost", ["sessionId": sessionId, "serviceId": id])
  }
  func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
    guard active, services[key(sender)] === sender else { return }
    sender.delegate = nil; services.removeValue(forKey: key(sender))
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
    guard !addresses.isEmpty else { return }
    var txt: [String: String] = [:]
    if let data = sender.txtRecordData() {
      for (name, value) in NetService.dictionary(fromTXTRecord: data) { txt[name] = String(data: value, encoding: .utf8) }
    }
    emit("onService", ["sessionId": sessionId, "serviceId": key(sender), "addresses": Array(Set(addresses)), "port": sender.port, "txt": txt])
  }
}
