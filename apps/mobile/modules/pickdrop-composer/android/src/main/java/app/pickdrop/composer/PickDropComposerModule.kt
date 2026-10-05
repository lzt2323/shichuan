package app.pickdrop.composer

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PickDropComposerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PickDropComposer")
    View(PickDropComposerView::class) {
      Events("onTextChange", "onPasteImage", "onContentHeightChange")
      Prop("value") { view: PickDropComposerView, value: String -> view.pendingValue = value }
      Prop("mostRecentEventCount") { view: PickDropComposerView, count: Int -> view.mostRecentEventCount = count }
      Prop("editable") { view: PickDropComposerView, editable: Boolean -> view.setEditable(editable) }
      OnViewDidUpdateProps { view: PickDropComposerView -> view.applyPendingValue() }
    }
  }
}
