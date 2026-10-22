import Foundation

struct ApprovalError: Error { let message: String }
struct WireResponse {
  let status: Int
  let data: Data
}
typealias Transport = (String, String?, [String: Any]?) async throws -> WireResponse
typealias Signer = (Data) async throws -> Data

func base64url(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
func json(_ object: [String: Any]) throws -> Data {
  try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

/// Only the reviewed binary config selects an App, repository or endpoint.
func approve(
  pr: String, sha: String, appID: Int, botID: Int, now: Date = Date(),
  transport: Transport, signer: Signer
) async throws -> String {
  guard pr.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil,
    sha.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil
  else {
    throw ApprovalError(message: "Expected a PR number and full lowercase SHA")
  }
  guard appID > 0, botID > 0 else {
    throw ApprovalError(message: "Security App identity is not provisioned")
  }
  let repo = "/repos/dork-labs/dorkos"
  func request(_ path: String, _ token: String? = nil, _ body: [String: Any]? = nil) async throws
    -> [String: Any]
  {
    let response = try await transport(path, token, body)
    guard (200..<300).contains(response.status),
      let value = try JSONSerialization.jsonObject(with: response.data) as? [String: Any]
    else {
      throw ApprovalError(message: "GitHub request failed; no response body is logged")
    }
    return value
  }
  func head() async throws {
    let value = try await request("\(repo)/pulls/\(pr)")
    let base = value["base"] as? [String: Any]
    guard value["state"] as? String == "open",
      (value["head"] as? [String: Any])?["sha"] as? String == sha,
      (base?["repo"] as? [String: Any])?["full_name"] as? String == "dork-labs/dorkos"
    else {
      throw ApprovalError(message: "PR head moved, is closed, or belongs elsewhere")
    }
  }
  try await head()
  let seconds = Int(now.timeIntervalSince1970)
  let unsigned =
    try base64url(json(["alg": "RS256", "typ": "JWT"])) + "."
    + base64url(
      json([
        "iat": seconds - 60, "exp": seconds + 540, "iss": String(appID),
      ]))
  let signature = try await signer(Data(unsigned.utf8))
  let jwt = unsigned + "." + base64url(signature)
  let app = try await request("/app", jwt)
  guard app["id"] as? Int == appID else {
    throw ApprovalError(message: "App identity differs from pin")
  }
  let installation = try await request("\(repo)/installation", jwt)
  guard installation["app_id"] as? Int == appID,
    let installationID = installation["id"] as? Int, installationID > 0
  else {
    throw ApprovalError(message: "Installation identity differs from pin")
  }
  let access = try await request(
    "/app/installations/\(installationID)/access_tokens", jwt,
    ["repositories": ["dorkos"], "permissions": ["statuses": "write", "metadata": "read"]])
  guard let token = access["token"] as? String, !token.isEmpty else {
    throw ApprovalError(message: "Installation token missing")
  }
  try await head()
  let status = try await request(
    "\(repo)/statuses/\(sha)", token,
    [
      "context": "security-review", "state": "success",
      "description": "Security approved \(sha.prefix(12))",
    ])
  guard status["context"] as? String == "security-review", status["state"] as? String == "success",
    (status["creator"] as? [String: Any])?["id"] as? Int == botID
  else {
    throw ApprovalError(message: "Posted status did not confirm pinned bot identity")
  }
  try await head()
  return sha
}
