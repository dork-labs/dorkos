import Foundation

final class Fixture {
  let sha = String(repeating: "a", count: 40)
  var responses: [[String: Any]] = []
  var calls: [(String, String?, [String: Any]?)] = []
  var signs = 0
  var signedPayload = Data()
  init() {
    let pr: [String: Any] = [
      "state": "open", "head": ["sha": sha], "base": ["repo": ["full_name": "dork-labs/dorkos"]],
    ]
    responses = [
      pr, ["id": 123], ["id": 456, "app_id": 123], ["token": "mock-installation-token"], pr,
      ["context": "security-review", "state": "success", "creator": ["id": 789]], pr,
    ]
  }
  func run(pr: String = "12", sha: String? = nil, appID: Int = 123, botID: Int = 789) async throws
    -> String
  {
    try await approve(
      pr: pr, sha: sha ?? self.sha, appID: appID, botID: botID,
      now: Date(timeIntervalSince1970: 1_700_000_000),
      transport: { path, token, body in
        self.calls.append((path, token, body))
        return WireResponse(status: 200, data: try json(self.responses.removeFirst()))
      },
      signer: { payload in
        self.signs += 1
        self.signedPayload = payload
        return Data([1, 2, 3])
      })
  }
}
func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw ApprovalError(message: "TEST FAILED: " + message) }
}
@main struct CoreTests {
  static func main() async throws {
    let f = Fixture()
    let sha = try await f.run()
    try require(sha == f.sha && f.signs == 1 && f.calls.count == 7, "exact successful flow")
    let parts = String(decoding: f.signedPayload, as: UTF8.self).split(separator: ".")
    func decode(_ value: Substring) throws -> [String: Any] {
      var raw = String(value).replacingOccurrences(of: "-", with: "+").replacingOccurrences(
        of: "_", with: "/")
      while raw.count % 4 != 0 { raw += "=" }
      return try JSONSerialization.jsonObject(with: Data(base64Encoded: raw)!) as! [String: Any]
    }
    try require(try decode(parts[0])["alg"] as? String == "RS256", "RS256 header")
    let claims = try decode(parts[1])
    try require(
      claims["iat"] as? Int == 1_699_999_940 && claims["exp"] as? Int == 1_700_000_540
        && claims["iss"] as? String == "123", "JWT claims")
    try require(
      f.calls[0].1 == nil && f.calls[4].1 == nil, "public reads need no extra App permissions")
    try require(f.calls[3].2?["repositories"] as? [String] == ["dorkos"], "repository token scope")
    try require(
      (f.calls[3].2?["permissions"] as? [String: String]) == [
        "statuses": "write", "metadata": "read",
      ], "least permissions")
    try require(
      f.calls[5].0.hasSuffix(f.sha) && f.calls[5].1 == "mock-installation-token", "exact head/token"
    )
    try require(
      f.calls[5].2?["description"] as? String == "Security approved aaaaaaaaaaaa", "description")
    for index in [0, 1, 2, 3, 4, 5, 6] {
      let failed = Fixture()
      switch index {
      case 0, 4, 6: failed.responses[index]["head"] = ["sha": String(repeating: "b", count: 40)]
      case 1: failed.responses[index]["id"] = 999
      case 2: failed.responses[index]["app_id"] = 999
      case 3: failed.responses[index] = [:]
      default: failed.responses[index]["creator"] = ["id": 999]
      }
      do {
        _ = try await failed.run()
        throw ApprovalError(message: "fault unexpectedly accepted")
      } catch let error as ApprovalError {
        try require(error.message != "fault unexpectedly accepted", "planted fault \(index)")
      }
      if index < 5 {
        try require(
          !failed.calls.contains(where: { $0.0.contains("/statuses/") }), "no write after refusal")
      }
    }
    for (pr, sha, app, bot) in [
      ("0", f.sha, 123, 789), ("12", "short", 123, 789), ("12", f.sha, 0, 789),
      ("12", f.sha, 123, 0),
    ] {
      let failed = Fixture()
      do {
        _ = try await failed.run(pr: pr, sha: sha, appID: app, botID: bot)
        throw ApprovalError(message: "bad config accepted")
      } catch let error as ApprovalError {
        try require(error.message != "bad config accepted", "configuration refusal")
      }
      try require(failed.calls.isEmpty && failed.signs == 0, "no signer/network for invalid input")
    }
    print(
      "Swift approval mock-signer tests passed: flow, JWT claims, scope, identities, head races, invalid configuration"
    )
  }
}
