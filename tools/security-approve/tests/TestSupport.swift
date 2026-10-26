import Foundation

// Fake GitHub routed by method and path. No network, no Keychain, no signing key.

func sha(_ character: Character) -> String { String(repeating: character, count: 40) }

func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw ApprovalError(message: "TEST FAILED: " + message) }
}

/// Runs `body` and requires it to throw an `ApprovalError` whose message contains `text`.
func requireRefusal(_ text: String, _ label: String, _ body: () async throws -> Void) async throws {
  do {
    try await body()
  } catch let error as ApprovalError {
    try require(text.isEmpty || error.message.contains(text), "\(label): got \"\(error.message)\"")
    return
  }
  throw ApprovalError(message: "TEST FAILED: \(label) was accepted")
}

final class FakeGitHub {
  struct Pull {
    var heads: [String]
    var title = "A safe change"
    var state = "open"
    var repo = "dork-labs/dorkos"
    var baseRef = "main"
  }
  let mainSHA = sha("9")
  var pulls: [Int: Pull] = [:]
  /// The immutable diff main...<sha>. Keyed by SHA, so a moved head cannot change it.
  var compareFiles: [String: [[String: Any]]] = [:]
  var compareBase: String? = nil
  var statuses: [String: [[String: Any]]] = [:]
  var appID = 123
  var installationAppID = 123
  var token: String? = "mock-installation-token"
  var creatorID = 789
  var calls: [(method: String, path: String, token: String?, body: [String: Any]?)] = []
  var signs = 0
  var signedPayload = Data()
  var confirms: [String] = []
  var shown: [String] = []
  var refuseConfirm = false
  var hinted: Set<Int> = []

  var posts: [String] { calls.filter { $0.method == "POST" && $0.path.contains("/statuses/") }.map(\.path) }
  var revokes: Int { calls.filter { $0.method == "DELETE" && $0.path == "/installation/token" }.count }
  var display: String { shown.joined(separator: "\n") }

  func defaultFiles() -> [[String: Any]] {
    [["filename": "apps/client/src/app.ts", "additions": 3, "deletions": 1]]
  }

  func transport(_ method: String, _ path: String, _ token: String?, _ body: [String: Any]?)
    async throws -> WireResponse
  {
    calls.append((method, path, token, body))
    let pullPrefix = "/repos/dork-labs/dorkos/pulls/"
    let comparePrefix = "/repos/dork-labs/dorkos/compare/"
    var value: Any = [:]
    if method == "DELETE", path == "/installation/token" {
      return WireResponse(status: 204, data: Data())
    } else if path.hasPrefix(pullPrefix) {
      let number = Int(path.dropFirst(pullPrefix.count))!
      guard var pull = pulls[number] else { return WireResponse(status: 404, data: Data("{}".utf8)) }
      let head = pull.heads.count > 1 ? pull.heads.removeFirst() : pull.heads[0]
      pulls[number] = pull
      value = [
        "state": pull.state, "title": pull.title, "head": ["sha": head],
        "base": ["ref": pull.baseRef, "repo": ["full_name": pull.repo]],
      ]
    } else if path == "/repos/dork-labs/dorkos/git/ref/heads/main" {
      value = ["object": ["sha": mainSHA]]
    } else if path.hasPrefix(comparePrefix) {
      let range = path.dropFirst(comparePrefix.count).components(separatedBy: "...")
      try require(range[0] == mainSHA, "compare starts at main's head")
      value = [
        "base_commit": ["sha": compareBase ?? range[0]], "merge_base_commit": ["sha": sha("8")],
        "files": compareFiles[range[1]] ?? defaultFiles(),
      ]
    } else if path.hasPrefix("/repos/dork-labs/dorkos/commits/") {
      value = statuses[path.components(separatedBy: "/")[5]] ?? []
    } else if path == "/app" {
      value = ["id": appID]
    } else if path == "/repos/dork-labs/dorkos/installation" {
      value = ["id": 456, "app_id": installationAppID]
    } else if path == "/app/installations/456/access_tokens" {
      value = self.token.map { ["token": $0] } ?? [:]
    } else if path.hasPrefix("/repos/dork-labs/dorkos/statuses/") {
      value = ["context": "security-review", "state": "success", "creator": ["id": creatorID]]
    } else {
      return WireResponse(status: 404, data: Data("{}".utf8))
    }
    return WireResponse(status: 200, data: try JSONSerialization.data(withJSONObject: value))
  }

  func single(_ pr: Int, _ head: String, appID: Int = 123, botID: Int = 789) async throws -> String {
    try await approve(
      pr: String(pr), sha: head, appID: appID, botID: botID,
      now: Date(timeIntervalSince1970: 1_700_000_000), transport: transport,
      reviewHint: { pr, _ in self.hinted.contains(pr) }, show: { self.shown.append($0) },
      confirm: confirm, signer: signer)
  }

  func batch(_ queue: String) async throws -> BatchReport {
    try await approveBatch(
      queue: parseQueue(Data(queue.utf8)), appID: 123, botID: 789,
      now: Date(timeIntervalSince1970: 1_700_000_000), transport: transport,
      reviewHint: { pr, _ in self.hinted.contains(pr) }, show: { self.shown.append($0) },
      confirm: confirm, signer: signer)
  }

  func confirm(_ reason: String) async throws {
    confirms.append(reason)
    if refuseConfirm { throw ApprovalError(message: "Owner authentication refused") }
  }

  func signer(_ payload: Data) async throws -> Data {
    signs += 1
    signedPayload = payload
    return Data([1, 2, 3])
  }
}
