import Darwin
import Foundation
import LocalAuthentication
import Security

@main struct Provision {
  static func main() async {
    do {
      // Only the approver user, at a terminal, from the root-owned path, may provision.
      try checkThisProgram(expected: provisionerPath)
      var args = CommandLine.arguments
      let repin = args.count == 4 && args[1] == "--repin"
      if repin { args.remove(at: 1) }
      guard args.count == 3 else {
        throw ApprovalError(
          message: "Usage: security-approve-provision [--repin] <keychain-path> <helper-cdhash>")
      }
      // The key never lands outside the approver's own home.
      let keychainPath = resolvedPath(args[1]) ?? ""
      try checkKeychainPath(resolved: keychainPath)
      // Only the installed helper can be pinned, and only while its folder is root-owned.
      try checkInstall(
        executable: helperPath, resolved: resolvedPath(helperPath) ?? "", expected: helperPath,
        facts: pathFacts)
      try validateHelperSignature(path: helperPath, expectedHash: args[2])
      var accessResult: Unmanaged<SecAccess>?
      guard DorkExactAccess(helperPath, args[2], &accessResult) == errSecSuccess,
        let access = accessResult?.takeRetainedValue()
      else {
        throw ApprovalError(
          message: "Exact cdhash requirement unavailable or helper hash/signature differs")
      }
      let owner = LAContext()
      guard
        try await owner.evaluatePolicy(
          .deviceOwnerAuthentication,
          localizedReason: "Authorize Security helper cdhash \(args[2])")
      else {
        throw ApprovalError(message: "Owner authentication refused")
      }
      var keychain: SecKeychain?
      guard FileManager.default.fileExists(atPath: keychainPath),
        SecKeychainOpen(keychainPath, &keychain) == errSecSuccess, let keychain
      else {
        throw ApprovalError(message: "Cannot open the specified Keychain")
      }
      var keychainStatus = SecKeychainStatus()
      guard SecKeychainGetStatus(keychain, &keychainStatus) == errSecSuccess else {
        throw ApprovalError(message: "The specified file is not an available Keychain")
      }
      if repin {
        let query: [String: Any] = [
          kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: securityService, kSecAttrAccount as String: securityAccount,
          kSecMatchSearchList as String: [keychain], kSecReturnRef as String: true,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let result, CFGetTypeID(result) == SecKeychainItemGetTypeID()
        else {
          throw ApprovalError(message: "Cannot find the specific existing App item")
        }
        let item = unsafeBitCast(result, to: SecKeychainItem.self)
        guard SecKeychainItemSetAccess(item, access) == errSecSuccess else {
          throw ApprovalError(message: "Keychain refused ACL replacement")
        }
        print("Reapproved exact cdhash \(args[2])")
        return
      }
      var terminal = termios()
      guard tcgetattr(STDIN_FILENO, &terminal) == 0 else {
        throw ApprovalError(message: "Cannot protect terminal input")
      }
      var hidden = terminal
      hidden.c_lflag &= ~tcflag_t(ECHO)
      guard tcsetattr(STDIN_FILENO, TCSAFLUSH, &hidden) == 0 else {
        throw ApprovalError(message: "Cannot disable terminal echo")
      }
      defer { tcsetattr(STDIN_FILENO, TCSAFLUSH, &terminal) }
      FileHandle.standardError.write(
        Data("Paste App private PEM, then Ctrl-D on an empty line (input hidden):\n".utf8))
      var pem = FileHandle.standardInput.readDataToEndOfFile()
      defer { pem.resetBytes(in: 0..<pem.count) }
      var format = SecExternalFormat.formatUnknown
      var kind = SecExternalItemType.itemTypePrivateKey
      var imported: CFArray?
      guard
        SecItemImport(pem as CFData, nil, &format, &kind, [], nil, nil, &imported) == errSecSuccess,
        let keys = imported as? [SecKey], keys.count == 1
      else {
        throw ApprovalError(message: "Input is not a single supported RSA private key")
      }
      guard SecKeyIsAlgorithmSupported(keys[0], .sign, .rsaSignatureMessagePKCS1v15SHA256) else {
        throw ApprovalError(message: "Input must be an RSA signing key")
      }
      var error: Unmanaged<CFError>?
      guard let data = SecKeyCopyExternalRepresentation(keys[0], &error) else {
        throw ApprovalError(message: "Cannot import RSA bytes")
      }
      var bytes = data as Data
      defer { bytes.resetBytes(in: 0..<bytes.count) }
      let attributes: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: securityService, kSecAttrAccount as String: securityAccount,
        kSecValueData as String: bytes, kSecAttrAccess as String: access,
        kSecUseKeychain as String: keychain,
      ]
      let status = SecItemAdd(attributes as CFDictionary, nil)
      guard status == errSecSuccess else {
        throw ApprovalError(
          message:
            "Keychain item creation refused (\(status)); existing items are never overwritten")
      }
      print(
        "Item created with exact cdhash \(args[2])"
      )
    } catch let error as ApprovalError {
      FileHandle.standardError.write(Data((error.message + "\n").utf8))
      exit(1)
    } catch {
      FileHandle.standardError.write(Data("Provisioning failed\n".utf8))
      exit(1)
    }
  }
}
