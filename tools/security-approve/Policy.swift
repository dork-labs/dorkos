import Foundation

// Pure policy: no file, network or Keychain access. Tests feed it plain values.

/// The only macOS user allowed to hold the App key or run either program.
let approverUser = "dorkos-approver"
let approverHome = "/Users/dorkos-approver"
/// Root-owned install folder. Neither program runs from anywhere else.
let installDirectory = "/usr/local/libexec/dorkos-approve"
let helperPath = installDirectory + "/security-approve"
let provisionerPath = installDirectory + "/security-approve-provision"
/// Agent-writable inbox. Everything read from here is untrusted input.
let sharedDirectory = "/Users/Shared/dorkos-approve"
let maxQueueBytes = 65_536
let maxReviewBytes = 1_048_576
let maxBatch = 25

struct QueueEntry: Equatable, Hashable {
  let pr: Int
  let sha: String
}

/// Accepts only `<pr> <40-hex-sha>` lines. Anything else is counted, never shown.
func parseQueue(_ data: Data) -> (entries: [QueueEntry], refused: Int) {
  guard let text = String(data: data, encoding: .utf8) else { return ([], 1) }
  var entries: [QueueEntry] = []
  var refused = 0
  for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
    let parts = line.split(separator: " ", omittingEmptySubsequences: false)
    guard parts.count == 2,
      parts[0].range(of: "^[1-9][0-9]{0,6}$", options: .regularExpression) != nil,
      parts[1].range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
      let pr = Int(parts[0])
    else {
      refused += 1
      continue
    }
    let entry = QueueEntry(pr: pr, sha: String(parts[1]))
    if entries.contains(entry) { continue }
    if entries.count == maxBatch {
      refused += 1
      continue
    }
    entries.append(entry)
  }
  return (entries, refused)
}

/// Paths that can change the gate, its owners or this approver. A PR touching
/// any of them is never batched: it gets its own confirmation with its diff shown.
func needsOwnConfirmation(_ path: String) -> Bool {
  let lower = path.lowercased()
  let name = lower.split(separator: "/").last.map(String.init) ?? lower
  return lower.hasPrefix(".github/") || name == "codeowners"
    || lower.hasPrefix("tools/security-approve/") || lower.hasPrefix("ci/security-")
    || lower == "ci/required-checks.json" || lower == "packages/ci-steward/src/rulesets.ts"
    || lower == "scripts/security-paths-check.mjs"
}

/// GitHub text (titles, file names) is still agent-written. Strip anything that
/// could move the cursor, recolor or reorder the terminal, then cap the length.
func terminalSafe(_ text: String, limit: Int = 72) -> String {
  let unsafe: Set<Unicode.GeneralCategory> = [
    .control, .format, .lineSeparator, .paragraphSeparator, .privateUse, .surrogate, .unassigned,
  ]
  var scalars = String.UnicodeScalarView()
  scalars.append(contentsOf: text.unicodeScalars.filter { !unsafe.contains($0.properties.generalCategory) })
  let clean = String(scalars)
  return clean.count <= limit ? clean : String(clean.prefix(limit - 1)) + "…"
}

/// A review counts only if its file is `pr-<n>.md` or `pr-<n>-….md` and names the exact SHA.
func reviewNamesSHA(fileName: String, contents: Data, pr: Int, sha: String) -> Bool {
  guard fileName.range(of: "^pr-\(pr)([^0-9][^/]*)?\\.md$", options: .regularExpression) != nil
  else { return false }
  return contents.range(of: Data(sha.utf8)) != nil
}

struct RunnerFacts {
  let user: String?
  let home: String?
  let uid: uid_t
  let euid: uid_t
  let stdinIsTerminal: Bool
}

/// Both programs run only as the approver user, attended, at a terminal.
func checkRunner(_ facts: RunnerFacts) throws {
  guard facts.user == approverUser, facts.home == approverHome, facts.uid == facts.euid,
    facts.uid != 0
  else {
    throw ApprovalError(message: "Run this as the \(approverUser) user, not as \(facts.user ?? "?")")
  }
  guard facts.stdinIsTerminal else {
    throw ApprovalError(message: "Run this from Terminal; it needs a person at the keyboard")
  }
}

struct PathFacts {
  let owner: uid_t
  let mode: UInt16
  let isSymlink: Bool
}

/// The running program and every folder above it must be root-owned and
/// writable by nobody else, so no agent can swap the binary under the pin.
func checkInstall(
  executable: String, resolved: String, expected: String, facts: (String) -> PathFacts?
) throws {
  guard executable == expected, resolved == expected else {
    throw ApprovalError(message: "Run this only from \(expected)")
  }
  var path = expected
  while true {
    guard let info = facts(path), !info.isSymlink, info.owner == 0, info.mode & 0o022 == 0 else {
      throw ApprovalError(message: "\(path) must be owned by root and writable only by root")
    }
    if path == "/" { return }
    let parent = (path as NSString).deletingLastPathComponent
    path = parent.isEmpty ? "/" : parent
  }
}

/// The key lives only in a Keychain inside the approver's own home.
func checkKeychainPath(resolved: String) throws {
  guard resolved.hasPrefix(approverHome + "/Library/Keychains/"), resolved.hasSuffix(".keychain-db"),
    !resolved.contains("/../")
  else {
    throw ApprovalError(message: "Keychain must be inside \(approverHome)/Library/Keychains")
  }
}
