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
    // M1: current macOS prints entitlements as text unless asked for XML. Text never passes,
    // forbidden or not, and the real command always asks for XML.
    for text in [
      "[Dict]\n\t[Key] com.apple.security.cs.allow-dyld-environment-variables\n\t[Value]\n\t\t[Bool] true\n",
      "[Dict]\n\t[Key] com.apple.security.app-sandbox\n\t[Value]\n\t\t[Bool] true\n",
    ] {
      refuses(safe + text)
      refuses(text + safe)
    }
    let arguments = helperDisplayArguments("/usr/local/libexec/dorkos-approve/security-approve")
    guard arguments.contains("--xml"), arguments.last == "/usr/local/libexec/dorkos-approve/security-approve"
    else { fatalError("codesign display must request XML entitlements") }
    print(
      "Helper signature policy: canned runtime, cdhash, XML-only and entitlement cases passed; no binaries inspected"
    )
  }
}
