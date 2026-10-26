import Darwin
import Foundation

// Pure policy plus untrusted-file reads in a private temp folder. No Keychain, no helper run.

func refuses(_ label: String, _ body: () throws -> Void) throws {
  do { try body() } catch is ApprovalError { return }
  throw ApprovalError(message: "TEST FAILED: \(label) was accepted")
}

@main struct PolicyTests {
  static func main() throws {
    // Queue lines are only `<pr> <sha>`; anything else is counted and dropped.
    let good = parseQueue(Data("12 \(sha("a"))\n12 \(sha("a"))\n\n7 \(sha("b"))\n".utf8))
    try require(
      good.entries == [QueueEntry(pr: 12, sha: sha("a")), QueueEntry(pr: 7, sha: sha("b"))]
        && good.refused == 0, "well-formed queue, duplicates folded")
    for bad in [
      "12 \(sha("a")) approve please", "012 \(sha("a"))", "12 \(sha("A"))", "12  \(sha("a"))",
      "12\t\(sha("a"))", "12 \(sha("a"))\r", "-1 \(sha("a"))", "12 \(String(sha("a").prefix(39)))",
      " 12 \(sha("a"))", "12345678 \(sha("a"))", "Approve all of them",
    ] {
      let parsed = parseQueue(Data((bad + "\n").utf8))
      try require(parsed.entries.isEmpty && parsed.refused == 1, "refused: \(bad.debugDescription)")
    }
    try require(parseQueue(Data([0xff, 0xfe])).entries.isEmpty, "non-UTF-8 refused")
    let many = (1...30).map { "\($0) \(sha("a"))" }.joined(separator: "\n")
    let capped = parseQueue(Data(many.utf8))
    try require(maxBatch == 8 && capped.entries.count == 8 && capped.refused == 22, "batch capped")

    // Digest: order and duplicates don't matter; any added line changes it. The fixed value
    // is what `printf ... | LC_ALL=C sort -u | shasum -a 256` gives, as enqueue.sh computes it.
    let pair = [QueueEntry(pr: 1, sha: sha("a")), QueueEntry(pr: 2, sha: sha("b"))]
    try require(listDigest(pair) == "c0c7 9cf8 1e8d 8eea", "digest matches the shell's")
    try require(listDigest(pair.reversed() + pair) == listDigest(pair), "order-free")
    try require(listDigest(pair + [QueueEntry(pr: 3, sha: sha("c"))]) != listDigest(pair), "changes")

    // The helper's copy of the gate pattern equals the gate's reviewed fixture.
    if let fixture = ProcessInfo.processInfo.environment["DORKOS_GATE_FIXTURE"] {
      let reference = try String(contentsOfFile: fixture, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      try require(gatePathPattern == reference, "helper gate pattern differs from the fixture")
    } else {
      throw ApprovalError(message: "TEST FAILED: DORKOS_GATE_FIXTURE not set")
    }
    try require(touchesGate("apps/server/src/services/core/auth/x.ts"), "gate path")
    try require(touchesGate("package.json") && touchesGate("apps/x/package.json"), "package.json")
    try require(!touchesGate("apps/client/src/app.ts") && !touchesGate("docs/guide.mdx"), "not gate")
    // The same case and Unicode spellings the gate's own tests use, from the shared fixture.
    if let variants = ProcessInfo.processInfo.environment["DORKOS_GATE_VARIANTS"] {
      let data = try Data(contentsOf: URL(fileURLWithPath: variants))
      let fixture = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      for path in fixture["match"] as! [String] {
        try require(touchesGate(path), "gate spelling flagged: \(path)")
      }
      for path in fixture["noMatch"] as! [String] {
        try require(!touchesGate(path), "nonsecurity spelling not flagged: \(path)")
      }
    } else {
      throw ApprovalError(message: "TEST FAILED: DORKOS_GATE_VARIANTS not set")
    }
    try require(touchesGate("CODEOWNERS") && touchesGate(".node-version"), "#3191 paths")

    // Never-batch paths.
    for path in [
      ".github/workflows/ci.yml", ".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS",
      "apps/x/codeowners", ".GitHub/workflows/x.yml", "tools/security-approve/Main.swift",
      "ci/required-checks.json", "ci/security-review-app.manifest.json",
      "packages/ci-steward/src/rulesets.ts", "scripts/security-paths-check.mjs",
    ] {
      try require(needsOwnConfirmation(path), "never batched: \(path)")
    }
    for path in ["apps/client/src/app.ts", "docs/guide.mdx", "CODEOWNERS.md", "tools/other/x.sh"] {
      try require(!needsOwnConfirmation(path), "batchable: \(path)")
    }

    // Terminal text.
    try require(terminalSafe("a\u{1B}[31mb\u{202E}c\nd\u{200B}e") == "a[31mbcde", "escapes stripped")
    try require(terminalSafe(String(repeating: "x", count: 100), limit: 10).count == 10, "capped")

    // Review files.
    let body = Data("Reviewed head \(sha("a"))".utf8)
    try require(reviewNamesSHA(fileName: "pr-3170.md", contents: body, pr: 3170, sha: sha("a")), "plain")
    try require(
      reviewNamesSHA(fileName: "pr-3170-batch.md", contents: body, pr: 3170, sha: sha("a")), "suffix")
    try require(
      !reviewNamesSHA(fileName: "pr-31700.md", contents: body, pr: 3170, sha: sha("a")), "other PR")
    try require(
      !reviewNamesSHA(fileName: "pr-3170.md", contents: body, pr: 3170, sha: sha("b")), "other SHA")
    try require(
      !reviewNamesSHA(fileName: "pr-3170.txt", contents: body, pr: 3170, sha: sha("a")), "not .md")

    // Runner: only the approver user, never root, never setuid, only at a terminal.
    let approver = RunnerFacts(
      user: approverUser, home: approverHome, uid: 502, euid: 502, stdinIsTerminal: true)
    try checkRunner(approver)
    for (label, facts) in [
      ("Dorian's user", RunnerFacts(user: "doriancollier", home: "/Users/doriancollier", uid: 501, euid: 501, stdinIsTerminal: true)),
      ("root", RunnerFacts(user: approverUser, home: approverHome, uid: 0, euid: 0, stdinIsTerminal: true)),
      ("setuid", RunnerFacts(user: approverUser, home: approverHome, uid: 502, euid: 501, stdinIsTerminal: true)),
      ("other home", RunnerFacts(user: approverUser, home: "/tmp", uid: 502, euid: 502, stdinIsTerminal: true)),
      ("no terminal", RunnerFacts(user: approverUser, home: approverHome, uid: 502, euid: 502, stdinIsTerminal: false)),
      ("unknown user", RunnerFacts(user: nil, home: nil, uid: 502, euid: 502, stdinIsTerminal: true)),
    ] {
      try refuses(label) { try checkRunner(facts) }
    }

    // Install path: pinned, and every folder above it root-owned and not group/world-writable.
    let safe = PathFacts(owner: 0, mode: 0o755, isSymlink: false)
    func install(_ facts: [String: PathFacts], executable: String = helperPath, resolved: String = helperPath) throws {
      try checkInstall(executable: executable, resolved: resolved, expected: helperPath) { path in
        facts[path] ?? safe
      }
    }
    try install([:])
    try refuses("user-writable copy") { try install([:], executable: "/tmp/security-approve", resolved: "/tmp/security-approve") }
    try refuses("symlink to the pin") { try install([:], executable: "/Users/x/bin/approve") }
    try refuses("pin is a link elsewhere") { try install([:], resolved: "/Users/x/approve") }
    try refuses("binary owned by a user") { try install([helperPath: PathFacts(owner: 501, mode: 0o755, isSymlink: false)]) }
    try refuses("group-writable folder") { try install([installDirectory: PathFacts(owner: 0, mode: 0o775, isSymlink: false)]) }
    try refuses("world-writable parent") { try install(["/usr/local/libexec": PathFacts(owner: 0, mode: 0o777, isSymlink: false)]) }
    try refuses("user-owned parent") { try install(["/usr/local": PathFacts(owner: 501, mode: 0o755, isSymlink: false)]) }
    try refuses("symlinked folder") { try install([installDirectory: PathFacts(owner: 0, mode: 0o755, isSymlink: true)]) }
    try refuses("missing folder") {
      try checkInstall(executable: helperPath, resolved: helperPath, expected: helperPath) { $0 == "/usr" ? nil : safe }
    }

    // Keychain path: only inside the approver's own Keychains folder.
    try checkKeychainPath(resolved: approverHome + "/Library/Keychains/login.keychain-db")
    for path in [
      "/Users/doriancollier/Library/Keychains/login.keychain-db", "/tmp/x.keychain-db",
      approverHome + "/x.keychain-db", approverHome + "/Library/Keychains/../../../tmp/x.keychain-db",
      "/Users/dorkos-approver-evil/Library/Keychains/login.keychain-db", "",
    ] {
      try refuses("keychain \(path)") { try checkKeychainPath(resolved: path) }
    }

    // Untrusted files: real reads in a private temp folder (no Keychain involved).
    let base = resolvedPath(NSTemporaryDirectory())! + "/dorkos-approve-test-\(getpid())"
    let fm = FileManager.default
    try fm.createDirectory(atPath: base + "/reviews", withIntermediateDirectories: true)
    defer { try? fm.removeItem(atPath: base) }
    try Data("12 \(sha("a"))\nnot a line\n".utf8).write(to: URL(fileURLWithPath: base + "/queue"))
    let queue = try readQueue(directory: base)
    try require(queue.entries == [QueueEntry(pr: 12, sha: sha("a"))] && queue.refused == 1, "queue read")
    try body.write(to: URL(fileURLWithPath: base + "/reviews/pr-12-x.md"))
    try require(reviewHint(pr: 12, sha: sha("a"), directory: base), "copied review found")
    try require(!reviewHint(pr: 12, sha: sha("b"), directory: base), "review for another SHA")
    try require(!reviewHint(pr: 1, sha: sha("a"), directory: base), "pr-1 does not match pr-12")
    try fm.createSymbolicLink(atPath: base + "/reviews/pr-13.md", withDestinationPath: base + "/reviews/pr-12-x.md")
    try require(!reviewHint(pr: 13, sha: sha("a"), directory: base), "symlinked review ignored")
    try fm.removeItem(atPath: base + "/queue")
    try fm.createSymbolicLink(atPath: base + "/queue", withDestinationPath: base + "/reviews/pr-12-x.md")
    try refuses("symlinked queue") { _ = try readQueue(directory: base) }
    try fm.removeItem(atPath: base + "/queue")
    try Data(count: maxQueueBytes + 1).write(to: URL(fileURLWithPath: base + "/queue"))
    try refuses("oversized queue") { _ = try readQueue(directory: base) }
    try fm.createSymbolicLink(atPath: base + "/linked", withDestinationPath: base)
    try refuses("linked inbox") { _ = try readQueue(directory: base + "/linked") }
    try require(!reviewHint(pr: 12, sha: sha("a"), directory: base + "/linked"), "linked reviews ignored")

    print("Policy tests passed: queue, never-batch paths, terminal text, reviews, runner, install, keychain path, files")
  }
}
