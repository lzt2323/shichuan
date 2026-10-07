import ExpoModulesCore
import Photos
import UIKit

public final class PickDropStorageModule: Module {
  private var exporter: ExportDelegate?
  public func definition() -> ModuleDefinition {
    Name("PickDropStorage")
    AsyncFunction("saveMedia") { (uri: URL, name: String, mime: String, promise: Promise) in
      PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
        guard status == .authorized || status == .limited else { promise.reject("PHOTO_PERMISSION", "请在系统设置允许拾传添加照片，再重试保存"); return }
        PHPhotoLibrary.shared().performChanges({
          PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: uri, options: nil)
        }) { success, error in
          if success { promise.resolve(["saved": true, "destination": "相册"]) }
          else { promise.reject("PHOTO_SAVE", error?.localizedDescription ?? "此图片格式无法保存到相册，请选择保存到文件") }
        }
      }
    }
    AsyncFunction("exportFile") { (uri: URL, name: String, mime: String, promise: Promise) in
      guard self.exporter == nil else { promise.reject("EXPORT_BUSY", "请先完成当前保存"); return }
      guard let view = self.appContext?.utilities?.currentViewController() else { promise.reject("EXPORT_VIEW", "暂时无法打开保存位置"); return }
      let picker = UIDocumentPickerViewController(forExporting: [uri], asCopy: true)
      let delegate = ExportDelegate(promise: promise) { self.exporter = nil }
      self.exporter = delegate; picker.delegate = delegate
      view.present(picker, animated: true)
    }.runOnQueue(.main)
    AsyncFunction("sweepIncoming") { (clearAll: Bool) in
      guard let id = Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId") as? String,
            let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id) else { return }
      let pending = UserDefaults(suiteName: id)?.data(forKey: "expo-sharing")
      var protected = Set<String>()
      if let pending {
        guard let records = (try? JSONSerialization.jsonObject(with: pending)) as? [[String: Any]],
              records.allSatisfy({ $0["value"] is String }) else { return }
        protected = Set(records.compactMap { $0["value"] as? String })
      }
      let directory = root.appendingPathComponent("PickDropIncoming")
      // Legacy versions staged regular files directly in this app-owned container.
      for location in [directory, root] {
        for url in (try? FileManager.default.contentsOfDirectory(at: location, includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey])) ?? [] {
          let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
          guard values?.isRegularFile == true, !url.lastPathComponent.hasPrefix(".") else { continue }
          let modified = values?.contentModificationDate ?? Date()
          if (clearAll || Date().timeIntervalSince(modified) > 86400) && !protected.contains(url.absoluteString) { try? FileManager.default.removeItem(at: url) }
        }
      }
    }
    AsyncFunction("incomingBytes") { () -> Int64 in
      guard let id = Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId") as? String,
            let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id) else { return 0 }
      var total: Int64 = 0
      for location in [root, root.appendingPathComponent("PickDropIncoming")] {
        for url in (try? FileManager.default.contentsOfDirectory(at: location, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey])) ?? [] {
          let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
          if values?.isRegularFile == true && !url.lastPathComponent.hasPrefix(".") { total += Int64(values?.fileSize ?? 0) }
        }
      }
      return total
    }
    AsyncFunction("cleanupIncoming") { (uris: [String]) in
      guard let id = Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId") as? String,
            let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id) else { return }
      for value in uris {
        guard let url = URL(string: value), url.isFileURL,
              (url.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL || url.deletingLastPathComponent().standardizedFileURL == root.appendingPathComponent("PickDropIncoming").standardizedFileURL) else { continue }
        try? FileManager.default.removeItem(at: url)
      }
    }
  }
}
private final class ExportDelegate: NSObject, UIDocumentPickerDelegate {
  let promise: Promise
  let finish: () -> Void
  init(promise: Promise, finish: @escaping () -> Void) { self.promise = promise; self.finish = finish }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { promise.resolve(["saved": false]); finish() }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { promise.resolve(["saved": true, "destination": "文件"]); finish() }
}
