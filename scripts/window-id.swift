// Prints the window ID of the VS Code Extension Development Host window, for `screencapture -l`.
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let name = w[kCGWindowName as String] as? String ?? ""
  if owner == "Code" && name.contains("Extension Development Host") {
    print(w[kCGWindowNumber as String] as! Int); break
  }
}
