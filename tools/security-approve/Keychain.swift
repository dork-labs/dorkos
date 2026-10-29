import Foundation
import Security

let securityService = "ai.dorkos.security-review"
let securityAccount = "github-app-private-key"

/// Never prompts to broaden an ACL. Reads only the single configured item.
func keychainSecret(
  keychain: SecKeychain? = nil, service: String = securityService,
  account: String = securityAccount
) throws -> Data {
  // SecKeychainOpen alone can succeed for a missing file. A scoped test read
  // must validate the reference before querying, rather than fall back globally.
  if let keychain {
    var status: SecKeychainStatus = 0
    guard SecKeychainGetStatus(keychain, &status) == errSecSuccess else {
      throw ApprovalError(message: "Specified Keychain does not exist")
    }
  }
  SecKeychainSetUserInteractionAllowed(false)
  var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service, kSecAttrAccount as String: account,
    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
  ]
  if let keychain { query[kSecMatchSearchList as String] = [keychain] }
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  guard status == errSecSuccess, let bytes = result as? Data else {
    throw ApprovalError(message: "Keychain refused the pinned item (\(status))")
  }
  return bytes
}

/// Keychain item holds DER PKCS#1 RSA private-key bytes, never a file/env input.
func signJWT(_ payload: Data) throws -> Data {
  var bytes = try keychainSecret()
  defer { bytes.resetBytes(in: 0..<bytes.count) }
  var error: Unmanaged<CFError>?
  guard
    let key = SecKeyCreateWithData(
      bytes as CFData,
      [
        kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
        kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      ] as CFDictionary, &error),
    SecKeyIsAlgorithmSupported(key, .sign, .rsaSignatureMessagePKCS1v15SHA256),
    let signature = SecKeyCreateSignature(
      key, .rsaSignatureMessagePKCS1v15SHA256,
      payload as CFData, &error)
  else {
    throw ApprovalError(message: "Keychain RSA signing failed")
  }
  return signature as Data
}
