import Foundation

/// Pure policy: tests supply canned codesign display output, never a real binary.
func validateHelperDisplay(_ output: String, expectedHash: String) throws {
  var header = output
  if let start = output.range(of: "<?xml"),
    let end = output.range(of: "</plist>", range: start.lowerBound..<output.endIndex)
  {
    let xml = String(output[start.lowerBound..<end.upperBound])
    guard let bytes = xml.data(using: .utf8),
      let entitlements = try PropertyListSerialization.propertyList(from: bytes, format: nil)
        as? [String: Any]
    else { throw ApprovalError(message: "Cannot read helper entitlements") }
    for name in [
      "com.apple.security.get-task-allow",
      "com.apple.security.cs.allow-dyld-environment-variables",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.cs.allow-unsigned-executable-memory",
    ] where entitlements[name] != nil {
      throw ApprovalError(message: "Helper contains a forbidden entitlement")
    }
    header.removeSubrange(start.lowerBound..<end.upperBound)
  } else if output.contains("<plist") || output.contains("<?xml") {
    throw ApprovalError(message: "Incomplete helper entitlements")
  }
  let flags = try NSRegularExpression(pattern: "(?m)^CodeDirectory .*flags=0x([0-9a-fA-F]+)\\b")
  let hashes = try NSRegularExpression(pattern: "(?m)^CDHash=([0-9a-fA-F]{40})$")
  let range = NSRange(header.startIndex..., in: header)
  let flagMatches = flags.matches(in: header, range: range)
  let hashMatches = hashes.matches(in: header, range: range)
  guard flagMatches.count == 1, hashMatches.count == 1,
    let flagRange = Range(flagMatches[0].range(at: 1), in: header),
    let hashRange = Range(hashMatches[0].range(at: 1), in: header),
    let value = UInt32(header[flagRange], radix: 16), value & 0x10000 != 0,
    header[hashRange].lowercased() == expectedHash
  else { throw ApprovalError(message: "Helper must have hardened runtime and the exact cdhash") }
}

/// Called only by Dorian's attended provisioner, before any Keychain operation.
func validateHelperSignature(path: String, expectedHash: String) throws {
  let command = Process()
  command.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
  command.arguments = ["-d", "--entitlements", "-", "--verbose=4", path]
  let pipe = Pipe()
  command.standardOutput = pipe
  command.standardError = pipe
  try command.run()
  let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
  command.waitUntilExit()
  guard command.terminationStatus == 0, let output = String(data: bytes, encoding: .utf8) else {
    throw ApprovalError(message: "Cannot inspect helper code signature")
  }
  try validateHelperDisplay(output, expectedHash: expectedHash)
}
