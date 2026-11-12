// CI-only native screenshot and OCR of the one throwaway Chrome process.
import Foundation
import CoreGraphics
import Vision
let pid = Int32(CommandLine.arguments[1])!
let output = CommandLine.arguments[2]
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
guard let window = windows.first(where: { item in
  guard (item[kCGWindowOwnerPID as String] as? Int32) == pid,
    let bounds = item[kCGWindowBounds as String] as? [String: CGFloat] else { return false }
  return (bounds["Width"] ?? 0) > 400 && (bounds["Height"] ?? 0) > 300
}), let id = window[kCGWindowNumber as String] as? UInt32 else { exit(2) }
let capture = Process()
capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
capture.arguments = ["-x", "-o", "-l", String(id), output]
try capture.run()
capture.waitUntilExit()
guard capture.terminationStatus == 0 else { exit(3) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(url: URL(fileURLWithPath: output)).perform([request])
print((request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n"))
