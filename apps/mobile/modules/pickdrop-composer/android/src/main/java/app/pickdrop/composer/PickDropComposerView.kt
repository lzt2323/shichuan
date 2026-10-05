package app.pickdrop.composer

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.ActionMode
import android.view.Gravity
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.PopupMenu
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.roundToInt

class PickDropComposerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true
  private val onTextChange by EventDispatcher<Map<String, Any>>()
  private val onPasteImage by EventDispatcher<Unit>()
  private val onContentHeightChange by EventDispatcher<Map<String, Any>>()
  private var nativeEventCount = 0
  private var applyingValue = false
  private var lastContentHeight = 0
  internal var pendingValue = ""
  internal var mostRecentEventCount = 0
  private val editor = ComposerEditText(context) { onPasteImage(Unit) }
  private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

  init {
    editor.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    editor.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    editor.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_ENTER_ACTION
    editor.setSingleLine(false)
    editor.setHorizontallyScrolling(false)
    editor.gravity = Gravity.TOP or Gravity.START
    editor.background = null
    editor.setPadding(dp(12), dp(10), dp(12), dp(10))
    editor.textSize = 14f
    editor.setTextColor(Color.rgb(48, 65, 92))
    editor.setHintTextColor(Color.rgb(161, 174, 192))
    editor.hint = "发文件或说点什么…"
    editor.contentDescription = "消息内容"
    editor.filters = arrayOf(InputFilter.LengthFilter(10000))
    editor.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(value: Editable?) {
        if (!applyingValue) {
          nativeEventCount++
          onTextChange(mapOf("text" to (value?.toString() ?: ""), "eventCount" to nativeEventCount))
        }
        editor.post { reportContentHeight() }
      }
    })
    addView(editor)
  }

  internal fun setEditable(editable: Boolean) { editor.isEnabled = editable }

  internal fun applyPendingValue() {
    // Do not let a delayed JS render overwrite a newer keystroke. Equal text
    // must not call setText: doing so discards the IME's composing spans.
    if (mostRecentEventCount < nativeEventCount || editor.text.toString() == pendingValue) return
    val start = editor.selectionStart.coerceAtLeast(0)
    val end = editor.selectionEnd.coerceAtLeast(0)
    applyingValue = true
    try {
      editor.setText(pendingValue)
      editor.setSelection(start.coerceAtMost(editor.length()), end.coerceAtMost(editor.length()))
    } finally { applyingValue = false }
    editor.post { reportContentHeight() }
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    reportContentHeight()
  }

  private fun reportContentHeight() {
    val textLayout = editor.layout ?: return
    val pixels = (textLayout.height + editor.compoundPaddingTop + editor.compoundPaddingBottom).coerceIn(dp(44), dp(112))
    if (pixels != lastContentHeight) {
      lastContentHeight = pixels
      onContentHeightChange(mapOf("height" to pixels / resources.displayMetrics.density))
    }
  }
}

// Only inspect the clipboard's MIME description in response to a paste/menu
// gesture. JS reads the actual image after onPasteImage. No URI is accepted or
// opened here, and no clipboard observer or input-method content hook is added.
private class ComposerEditText(context: Context, private val pasteImage: () -> Unit) : EditText(context) {
  private var pastePopup: PopupMenu? = null
  private fun hasClipboardImage(): Boolean {
    if (!isEnabled) return false
    return try {
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.primaryClipDescription?.hasMimeType("image/*") == true
    } catch (_: SecurityException) { false }
  }

  private val imagePasteActions = object : ActionMode.Callback {
    private fun update(menu: Menu): Boolean {
      if (!hasClipboardImage()) return false
      val paste = menu.findItem(android.R.id.paste) ?: menu.add(Menu.NONE, android.R.id.paste, Menu.NONE, "粘贴")
      paste.isEnabled = true
      paste.setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
      return true
    }
    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean { update(menu); return true }
    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = update(menu)
    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
      if ((item.itemId == android.R.id.paste || item.itemId == android.R.id.pasteAsPlainText) && hasClipboardImage()) {
        pasteImage()
        mode.finish()
        return true
      }
      return false // Keep native cut/copy/select-all and plain-text paste.
    }
    override fun onDestroyActionMode(mode: ActionMode) {}
  }

  init {
    customSelectionActionModeCallback = imagePasteActions
    customInsertionActionModeCallback = imagePasteActions
  }

  override fun onTextContextMenuItem(id: Int): Boolean {
    if ((id == android.R.id.paste || id == android.R.id.pasteAsPlainText) && hasClipboardImage()) {
      pasteImage()
      return true
    }
    return super.onTextContextMenuItem(id)
  }

  private fun imagePasteShortcut(keyCode: Int, event: KeyEvent): Boolean {
    val paste = keyCode == KeyEvent.KEYCODE_V && event.isCtrlPressed && !event.isAltPressed || keyCode == KeyEvent.KEYCODE_INSERT && event.isShiftPressed
    if (!paste || !hasClipboardImage()) return false
    if (event.repeatCount == 0) pasteImage()
    return true
  }

  override fun onKeyShortcut(keyCode: Int, event: KeyEvent): Boolean = imagePasteShortcut(keyCode, event) || super.onKeyShortcut(keyCode, event)
  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = imagePasteShortcut(keyCode, event) || super.onKeyDown(keyCode, event)

  override fun performLongClick(): Boolean {
    // Android may refuse to create an insertion ActionMode when the editor is
    // empty and the clipboard cannot coerce its image URI to text. Supply only
    // the missing paste menu; normal text selection and cursor handles stay native.
    if (text.isNullOrEmpty() && hasClipboardImage()) return showImagePasteMenu()
    val handled = super.performLongClick()
    return handled || hasClipboardImage() && showImagePasteMenu()
  }

  private fun showImagePasteMenu(): Boolean {
    requestFocus()
    pastePopup?.dismiss()
    pastePopup = PopupMenu(context, this).apply {
      menu.add(Menu.NONE, android.R.id.paste, Menu.NONE, "粘贴")
      setOnMenuItemClickListener { onTextContextMenuItem(it.itemId) }
      show()
    }
    return true
  }

  override fun onDetachedFromWindow() {
    pastePopup?.dismiss()
    pastePopup = null
    super.onDetachedFromWindow()
  }
}
