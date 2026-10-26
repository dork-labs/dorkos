import Foundation

struct ApprovalError: Error { let message: String }
struct WireResponse {
  let status: Int
  let data: Data
}
typealias Transport = (String, String?, [String: Any]?) async throws -> WireResponse
typealias Signer = (Data) async throws -> Data
/// Asks the person to confirm; throws if they refuse. Shown reason names every PR and SHA.
typealias Confirm = (String) async throws -> Void
typealias Show = (String) -> Void
typealias Reviewed = (Int, String) -> Bool

func base64url(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
func json(_ object: [String: Any]) throws -> Data {
  try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

let repoName = "dork-labs/dorkos"
let repoPath = "/repos/dork-labs/dorkos"
/// GitHub's files list stops at 3,000; past that, completeness is unknown.
let maxListedFiles = 3000

struct HeadMoved: Error {}

struct ChangedFile {
  let path: String
  let previous: String?
  let additions: Int
  let deletions: Int
}

/// Everything the person sees is built here, from GitHub, never from queue text.
struct Candidate {
  let pr: Int
  let sha: String
  let title: String
  let files: [ChangedFile]
  let complete: Bool
  var needsOwn: Bool {
    !complete || files.contains { needsOwnConfirmation($0.path) || $0.previous.map(needsOwnConfirmation) == true }
  }
}

/// Only the reviewed binary config selects an App, repository or endpoint.
struct GitHub {
  let transport: Transport

  func value(_ path: String, _ token: String? = nil, _ body: [String: Any]? = nil) async throws
    -> Any
  {
    let response = try await transport(path, token, body)
    guard (200..<300).contains(response.status) else {
      throw ApprovalError(message: "GitHub request failed; no response body is logged")
    }
    return try JSONSerialization.jsonObject(with: response.data)
  }
  func object(_ path: String, _ token: String? = nil, _ body: [String: Any]? = nil) async throws
    -> [String: Any]
  {
    guard let value = try await value(path, token, body) as? [String: Any] else {
      throw ApprovalError(message: "GitHub returned an unexpected shape")
    }
    return value
  }
  func list(_ path: String) async throws -> [[String: Any]] {
    guard let value = try await value(path) as? [[String: Any]] else {
      throw ApprovalError(message: "GitHub returned an unexpected shape")
    }
    return value
  }

  /// Open, still at this exact head, and based in this repository; else `HeadMoved`.
  func head(_ pr: Int, _ sha: String) async throws -> [String: Any] {
    let value = try await object("\(repoPath)/pulls/\(pr)")
    let base = value["base"] as? [String: Any]
    guard value["state"] as? String == "open",
      (value["head"] as? [String: Any])?["sha"] as? String == sha,
      (base?["repo"] as? [String: Any])?["full_name"] as? String == repoName
    else { throw HeadMoved() }
    return value
  }

  func candidate(_ pr: Int, _ sha: String) async throws -> Candidate {
    let pull = try await head(pr, sha)
    let expected = pull["changed_files"] as? Int ?? -1
    var files: [ChangedFile] = []
    var page = 1
    while files.count < expected, files.count < maxListedFiles, page <= 30 {
      let batch = try await list("\(repoPath)/pulls/\(pr)/files?per_page=100&page=\(page)")
      if batch.isEmpty { break }
      for file in batch {
        guard let path = file["filename"] as? String else {
          throw ApprovalError(message: "GitHub returned a file without a name")
        }
        files.append(
          ChangedFile(
            path: path, previous: file["previous_filename"] as? String,
            additions: file["additions"] as? Int ?? 0, deletions: file["deletions"] as? Int ?? 0))
      }
      page += 1
    }
    return Candidate(
      pr: pr, sha: sha, title: terminalSafe(pull["title"] as? String ?? ""), files: files,
      complete: expected >= 0 && expected < maxListedFiles && files.count == expected)
  }

  /// True when the newest `security-review` status on this SHA is the bot's success.
  func alreadyApproved(_ sha: String, botID: Int) async throws -> Bool {
    let statuses = try await list("\(repoPath)/commits/\(sha)/statuses?per_page=100")
    guard let newest = statuses.first(where: { $0["context"] as? String == "security-review" })
    else { return false }
    return newest["state"] as? String == "success"
      && (newest["creator"] as? [String: Any])?["id"] as? Int == botID
  }

  /// Signs one App JWT and mints one repository-scoped, statuses-only token.
  func installationToken(appID: Int, now: Date, signer: Signer) async throws -> String {
    let seconds = Int(now.timeIntervalSince1970)
    let unsigned =
      try base64url(json(["alg": "RS256", "typ": "JWT"])) + "."
      + base64url(json(["iat": seconds - 60, "exp": seconds + 540, "iss": String(appID)]))
    let jwt = unsigned + "." + base64url(try await signer(Data(unsigned.utf8)))
    guard try await object("/app", jwt)["id"] as? Int == appID else {
      throw ApprovalError(message: "App identity differs from pin")
    }
    let installation = try await object("\(repoPath)/installation", jwt)
    guard installation["app_id"] as? Int == appID,
      let installationID = installation["id"] as? Int, installationID > 0
    else { throw ApprovalError(message: "Installation identity differs from pin") }
    let access = try await object(
      "/app/installations/\(installationID)/access_tokens", jwt,
      ["repositories": ["dorkos"], "permissions": ["statuses": "write", "metadata": "read"]])
    guard let token = access["token"] as? String, !token.isEmpty else {
      throw ApprovalError(message: "Installation token missing")
    }
    return token
  }

  /// Rechecks the head right before and after posting. A moved head throws `HeadMoved`.
  func post(_ pr: Int, _ sha: String, token: String, botID: Int) async throws {
    _ = try await head(pr, sha)
    let status = try await object(
      "\(repoPath)/statuses/\(sha)", token,
      [
        "context": "security-review", "state": "success",
        "description": "Security approved \(sha.prefix(12))",
      ])
    guard status["context"] as? String == "security-review",
      status["state"] as? String == "success",
      (status["creator"] as? [String: Any])?["id"] as? Int == botID
    else { throw ApprovalError(message: "Posted status did not confirm pinned bot identity") }
    _ = try await head(pr, sha)
  }
}

func checkPins(appID: Int, botID: Int) throws {
  guard appID > 0, botID > 0 else {
    throw ApprovalError(message: "Security App identity is not provisioned")
  }
}

func diffSummary(_ candidate: Candidate) -> String {
  var lines = ["PR #\(candidate.pr) \(candidate.title)", "Head \(candidate.sha)"]
  lines.append(
    candidate.complete
      ? "\(candidate.files.count) files changed:" : "File list incomplete; shown files:")
  for file in candidate.files.prefix(60) {
    let flag = needsOwnConfirmation(file.path) ? "!" : " "
    let renamed = file.previous.map { " (was \(terminalSafe($0, limit: 60)))" } ?? ""
    lines.append(
      "\(flag) +\(file.additions) -\(file.deletions) \(terminalSafe(file.path, limit: 100))\(renamed)")
  }
  if candidate.files.count > 60 { lines.append("  … \(candidate.files.count - 60) more") }
  return lines.joined(separator: "\n")
}

/// One PR, any paths, with its diff summary shown and its own confirmation.
func approve(
  pr: String, sha: String, appID: Int, botID: Int, now: Date = Date(),
  transport: @escaping Transport, reviewed: Reviewed, show: Show, confirm: Confirm,
  signer: Signer
) async throws -> String {
  guard pr.range(of: "^[1-9][0-9]{0,6}$", options: .regularExpression) != nil, let number = Int(pr),
    sha.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil
  else { throw ApprovalError(message: "Expected a PR number and full lowercase SHA") }
  try checkPins(appID: appID, botID: botID)
  let github = GitHub(transport: transport)
  do {
    let candidate = try await github.candidate(number, sha)
    guard reviewed(number, sha) else {
      throw ApprovalError(message: "No Security review names this exact SHA")
    }
    show(diffSummary(candidate))
    try await confirm("Approve dork-labs/dorkos PR #\(number) at \(sha)")
    let token = try await github.installationToken(appID: appID, now: now, signer: signer)
    try await github.post(number, sha, token: token, botID: botID)
  } catch is HeadMoved {
    throw ApprovalError(message: "PR head moved, is closed, or belongs elsewhere")
  }
  return sha
}

struct BatchReport {
  var approved: [Int] = []
  var dropped: [(pr: Int, reason: String)] = []
}

/// Many PRs, one confirmation. Never includes a PR that needs its own confirmation.
func approveBatch(
  queue: (entries: [QueueEntry], refused: Int), appID: Int, botID: Int, now: Date = Date(),
  transport: @escaping Transport, reviewed: Reviewed, show: Show, confirm: Confirm,
  signer: Signer
) async throws -> BatchReport {
  try checkPins(appID: appID, botID: botID)
  let github = GitHub(transport: transport)
  var report = BatchReport()
  var ready: [Candidate] = []
  for entry in queue.entries {
    do {
      if try await github.alreadyApproved(entry.sha, botID: botID) {
        report.dropped.append((entry.pr, "already approved at this head"))
        continue
      }
      let candidate = try await github.candidate(entry.pr, entry.sha)
      if !reviewed(entry.pr, entry.sha) {
        report.dropped.append((entry.pr, "no Security review names this SHA"))
      } else if candidate.needsOwn {
        report.dropped.append(
          (entry.pr, "needs its own confirm: security-approve \(entry.pr) \(entry.sha)"))
      } else {
        ready.append(candidate)
      }
    } catch is HeadMoved {
      report.dropped.append((entry.pr, "head moved or PR closed"))
    }
  }
  var lines: [String] = []
  if queue.refused > 0 { lines.append("Ignored \(queue.refused) malformed queue lines.") }
  for (pr, reason) in report.dropped { lines.append("  skip #\(pr): \(reason)") }
  lines.append(ready.isEmpty ? "Nothing to approve." : "Approve these \(ready.count) PRs:")
  for candidate in ready {
    lines.append("  #\(candidate.pr) \(candidate.sha.prefix(12)) \(candidate.title)")
  }
  show(lines.joined(separator: "\n"))
  guard !ready.isEmpty else { return report }
  let names = ready.map { "#\($0.pr) \($0.sha.prefix(12))" }.joined(separator: ", ")
  try await confirm("Approve \(ready.count) dork-labs/dorkos PRs: \(names)")
  let token = try await github.installationToken(appID: appID, now: now, signer: signer)
  for candidate in ready {
    do {
      try await github.post(candidate.pr, candidate.sha, token: token, botID: botID)
      report.approved.append(candidate.pr)
      show("approved #\(candidate.pr)")
    } catch is HeadMoved {
      report.dropped.append((candidate.pr, "head moved while posting; the new head is not approved"))
      show("skip #\(candidate.pr): head moved while posting; the new head is not approved")
    }
  }
  return report
}
