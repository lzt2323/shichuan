package app.pickdrop.storage

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class PickDropStorageModule : Module() {
  private var pending: Promise? = null
  private var source: File? = null
  override fun definition() = ModuleDefinition {
    Name("PickDropStorage")
    AsyncFunction("saveMedia") { uri: String, name: String, mime: String ->
      val context = appContext.reactContext ?: error("应用暂不可用")
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, name)
        put(MediaStore.Images.Media.MIME_TYPE, mime)
        if (Build.VERSION.SDK_INT >= 29) { put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/PickDrop"); put(MediaStore.Images.Media.IS_PENDING, 1) }
      }
      val target = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: error("无法创建照片，请检查存储空间")
      try {
        resolver.openOutputStream(target)?.use { output -> File(Uri.parse(uri).path!!).inputStream().use { it.copyTo(output) } } ?: error("无法写入相册")
        if (Build.VERSION.SDK_INT >= 29) { values.clear(); values.put(MediaStore.Images.Media.IS_PENDING, 0); resolver.update(target, values, null, null) }
      } catch (error: Exception) { resolver.delete(target, null, null); throw error }
      mapOf("saved" to true, "destination" to "相册")
    }
    AsyncFunction("exportFile") { uri: String, name: String, mime: String, promise: Promise ->
      if (pending != null) { promise.reject("EXPORT_BUSY", "请先完成当前保存", null) }
      else {
        source = File(Uri.parse(uri).path!!); pending = promise
        try {
          val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION); type = mime; putExtra(Intent.EXTRA_TITLE, name) }
          appContext.throwingActivity.startActivityForResult(intent, 47401)
        } catch (error: Exception) { pending = null; source = null; promise.reject("EXPORT_OPEN", error.message, error) }
      }
    }.runOnQueue(Queues.MAIN)
    OnActivityResult { _, (requestCode, resultCode, data) ->
      if (requestCode == 47401) {
        val promise = pending; val file = source; pending = null; source = null
        if (resultCode != Activity.RESULT_OK || data?.data == null) promise?.resolve(mapOf("saved" to false))
        else Thread {
          try {
            val resolver = appContext.reactContext!!.contentResolver
            resolver.openOutputStream(data.data!!)?.use { output -> file!!.inputStream().use { it.copyTo(output) } } ?: error("无法写入所选文件")
            promise?.resolve(mapOf("saved" to true, "destination" to "文件"))
          } catch (error: Exception) { runCatching { appContext.reactContext?.contentResolver?.delete(data.data!!, null, null) }; promise?.reject("EXPORT_WRITE", "保存失败，请检查文件位置和存储空间", error) }
        }.start()
      }
    }
    AsyncFunction("sweepIncoming") { _: Boolean -> Unit }
    AsyncFunction("incomingBytes") { 0L }
    AsyncFunction("cleanupIncoming") { _: List<String> -> Unit }
  }
}
