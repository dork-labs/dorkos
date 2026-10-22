import Foundation

@main struct HelperPolicyTests {
  static func main() throws {
    let hash = String(repeating: "a", count: 40)
    let safe = "CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1\nCDHash=\(hash)\n"
    try validateHelperDisplay(safe, expectedHash: hash)
    let xml = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict></dict></plist>"
    try validateHelperDisplay(safe + xml, expectedHash: hash)
    func refuses(_ output: String) {
      do {
        try validateHelperDisplay(output, expectedHash: hash)
        fatalError("Unsafe canned signature accepted")
      } catch {}
    }
    refuses(safe.replacingOccurrences(of: "0x10000(runtime)", with: "0x2(adhoc)"))
    refuses(safe.replacingOccurrences(of: hash, with: String(repeating: "b", count: 40)))
    refuses(safe + "<?xml broken")
    for name in [
      "com.apple.security.get-task-allow",
      "com.apple.security.cs.allow-dyld-environment-variables",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.cs.allow-unsigned-executable-memory",
    ] {
      for value in ["<true/>", "<false/>"] {
        refuses(
          safe
            + xml.replacingOccurrences(
              of: "<dict></dict>", with: "<dict><key>\(name)</key>\(value)</dict>"))
      }
    }
    print(
      "Helper signature policy: canned runtime, cdhash and entitlement cases passed; no binaries inspected"
    )
  }
}
