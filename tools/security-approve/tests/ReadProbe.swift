import Foundation
import Security

@main struct ReadProbe {
  static func main() {
    guard CommandLine.arguments.count == 2 else { exit(2) }
    var keychain: SecKeychain?
    guard SecKeychainOpen(CommandLine.arguments[1], &keychain) == errSecSuccess, let keychain else {
      exit(2)
    }
    do {
      let value = try keychainSecret(
        keychain: keychain, service: "ai.dorkos.security-review-test", account: "disposable")
      guard value == Data("disposable-not-an-app-key".utf8) else { exit(3) }
      print("ACL read allowed")
    } catch {
      print("ACL read refused")
      exit(1)
    }
  }
}
