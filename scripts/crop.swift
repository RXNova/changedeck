// Crops a PNG to an exact pixel rectangle: swift crop.swift in.png out.png x y width height
import AppKit
let a = CommandLine.arguments
guard a.count == 7, let image = NSImage(contentsOfFile: a[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let x = Int(a[3]), let y = Int(a[4]), let w = Int(a[5]), let h = Int(a[6]),
      let cropped = cg.cropping(to: CGRect(x: x, y: y, width: w, height: h)) else {
  FileHandle.standardError.write("usage: crop.swift in.png out.png x y width height\n".data(using: .utf8)!)
  exit(1)
}
let rep = NSBitmapImageRep(cgImage: cropped)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
