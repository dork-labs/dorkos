import Foundation

// Fake GitHub routed by path. No network, no Keychain, no signing key.

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
    var files: [[String: Any]] = [["filename": "apps/client/src/app.ts", "additions": 3, "deletions": 1]]
    var changedFiles: Int? = nil
  }
  var pulls: [Int: Pull] = [:]
  var statuses: [String: [[String: Any]]] = [:]
  var appID = 123
  var installationAppID = 123
  var token: String? = "mock-installation-token"
  var creatorID = 789
  var calls: [(path: String, token: String?, body: [String: Any]?)] = []
  var signs = 0
  var signedPayload = Data()
  var confirms: [String] = []
  var shown: [String] = []
  var refuseConfirm = false
  var reviewedPRs: Set<Int> = []

  var posts: [String] { calls.filter { $0.body != nil && $0.path.contains("/statuses/") }.map(\.path) }

  func transport(_ path: String, _ token: String?, _ body: [String: Any]?) async throws
    -> WireResponse
  {
    calls.append((path, token, body))
    let pullPrefix = "/repos/dork-labs/dorkos/pulls/"
    var value: Any = [:]
    if path.hasPrefix(pullPrefix) {
      let rest = path.dropFirst(pullPrefix.count)
      let number = Int(rest.prefix { $0.isNumber })!
      guard var pull = pulls[number] else { return WireResponse(status: 404, data: Data("{}".utf8)) }
      if rest.contains("/files") {
        let page = Int(path.components(separatedBy: "page=").last!)!
        value = Array(pull.files.dropFirst((page - 1) * 100).prefix(100))
      } else {
        let head = pull.heads.count > 1 ? pull.heads.removeFirst() : pull.heads[0]
        pulls[number] = pull
        value = [
          "state": pull.state, "title": pull.title, "head": ["sha": head],
          "base": ["repo": ["full_name": pull.repo]],
          "changed_files": pull.changedFiles ?? pull.files.count,
        ]
      }
    } else if path.hasPrefix("/repos/dork-labs/dorkos/commits/") {
      let commit = path.components(separatedBy: "/")[5]
      value = statuses[commit] ?? []
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
      reviewed: { pr, _ in self.reviewedPRs.contains(pr) }, show: { self.shown.append($0) },
      confirm: confirm, signer: signer)
  }

  func batch(_ queue: String) async throws -> BatchReport {
    try await approveBatch(
      queue: parseQueue(Data(queue.utf8)), appID: 123, botID: 789,
      now: Date(timeIntervalSince1970: 1_700_000_000), transport: transport,
      reviewed: { pr, _ in self.reviewedPRs.contains(pr) }, show: { self.shown.append($0) },
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
