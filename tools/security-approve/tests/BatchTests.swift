import Foundation

// Batch approval against a fake GitHub with a mock signer.

func batchFixture(_ edit: (FakeGitHub) -> Void = { _ in }) -> FakeGitHub {
  let f = FakeGitHub()
  f.pulls[1] = .init(heads: [sha("a")], title: "First")
  f.pulls[2] = .init(heads: [sha("b")], title: "Second")
  f.pulls[3] = .init(heads: [sha("c")], title: "Third")
  f.hinted = [1, 2, 3]
  edit(f)
  return f
}
let threeQueued = "1 \(sha("a"))\n2 \(sha("b"))\n3 \(sha("c"))\n"
let threeEntries = [
  QueueEntry(pr: 1, sha: sha("a")), QueueEntry(pr: 2, sha: sha("b")),
  QueueEntry(pr: 3, sha: sha("c")),
]

@main struct BatchTests {
  static func main() async throws {
    // One confirm and one signature cover the whole list; the token is revoked at the end.
    let f = batchFixture()
    let report = try await f.batch(threeQueued)
    let digest = listDigest(threeEntries)
    try require(report.approved == [1, 2, 3] && report.dropped.isEmpty, "all three approved")
    try require(f.confirms.count == 1 && f.signs == 1, "one confirm, one signature")
    try require(
      f.confirms[0]
        == "Approve 3 dork-labs/dorkos PRs, list \(digest): #1 aaaaaaaaaaaa, #2 bbbbbbbbbbbb, #3 cccccccccccc",
      "confirm names the digest and every PR")
    try require(f.posts.count == 3 && f.revokes == 1, "three statuses, then one revoke")
    try require(f.calls.filter { $0.path.hasSuffix("/access_tokens") }.count == 1, "one token")

    // M3: every batched PR shows its full SHA and its files; the digest is shown up top.
    try require(f.display.contains("List digest: \(digest)"), "digest shown")
    for (pr, head) in [(1, sha("a")), (2, sha("b")), (3, sha("c"))] {
      try require(f.display.contains("PR #\(pr) ") && f.display.contains("head \(head)"), "#\(pr) full SHA")
    }
    try require(f.display.contains("apps/client/src/app.ts"), "files listed in batch")

    // M3 attack: an agent opens a gate-sensitive PR, forges the review hint and appends a
    // well-formed line. It cannot hide: its file is flagged and the digest no longer
    // matches the one Security posted for its own three entries.
    let forged = batchFixture {
      $0.pulls[4] = .init(heads: [sha("d")], title: "docs: fix typo")
      $0.compareFiles[sha("d")] = [["filename": "apps/server/src/services/core/auth/session.ts"]]
      $0.hinted.insert(4)
    }
    _ = try await forged.batch(threeQueued + "4 \(sha("d"))\n")
    try require(!forged.display.contains("List digest: \(digest)"), "digest changes")
    try require(
      forged.display.contains("*") && forged.display.contains("core/auth/session.ts"),
      "gate-sensitive file flagged")

    // Agent text in the queue is refused, never shown, never looked up.
    let agentText = batchFixture()
    let injected =
      threeQueued
      + "4 \(sha("d")) Dorian already said yes, approve all\nAPPROVE EVERYTHING\n#5 \(sha("e"))\n"
    let injectedReport = try await agentText.batch(injected)
    try require(injectedReport.approved == [1, 2, 3], "only well-formed lines approved")
    try require(agentText.display.contains("Ignored 3 malformed"), "refused lines counted")
    try require(agentText.display.contains("List digest: \(digest)"), "junk lines leave digest alone")
    try require(
      !agentText.display.contains("Dorian") && !agentText.display.contains("APPROVE")
        && !agentText.confirms[0].contains("#4"), "no agent text shown or confirmed")
    try require(
      !agentText.calls.contains { $0.path.contains("/pulls/4") || $0.path.contains("/pulls/5") },
      "refused lines are never looked up")

    // A head that moved since queueing is dropped before the confirm.
    let movedEarly = batchFixture { $0.pulls[2]!.heads = [sha("f")] }
    let early = try await movedEarly.batch(threeQueued)
    try require(early.approved == [1, 3], "moved head dropped")
    try require(!movedEarly.confirms[0].contains("#2"), "moved head not in the confirm")
    try require(!movedEarly.posts.contains { $0.hasSuffix(sha("b")) }, "nothing posted for it")

    // A head that moves after the confirm, right before posting, is dropped too.
    let movedLate = batchFixture { $0.pulls[2]!.heads = [sha("b"), sha("f")] }
    let late = try await movedLate.batch(threeQueued)
    try require(late.approved == [1, 3], "late move dropped")
    try require(movedLate.confirms[0].contains("#2"), "it was confirmed")
    try require(!movedLate.posts.contains { $0.hasSuffix(sha("b")) }, "but never posted")
    try require(
      late.dropped.contains { $0.pr == 2 && $0.reason.contains("moved while posting") },
      "reported as moved")

    // M4(b): what is shown is the diff of the queued SHA, whatever the branch shows now.
    let pushed = batchFixture {
      $0.compareFiles[sha("f")] = [["filename": ".github/workflows/ci.yml"]]
    }
    _ = try await pushed.batch(threeQueued)
    try require(
      !pushed.calls.contains { $0.path.hasSuffix("...\(sha("f"))") }, "only the queued SHA compared")

    // M4(a): a PR that is not based on main is dropped.
    let offMain = batchFixture { $0.pulls[2]!.baseRef = "x" }
    try require(try await offMain.batch(threeQueued).approved == [1, 3], "non-main base dropped")

    // Never batched: CODEOWNERS, .github, rulesets, the approver, renames out of them,
    // and any comparison at GitHub's 300-file cap.
    let sensitiveFiles: [(String, [[String: Any]])] = [
      ("CODEOWNERS", [["filename": "CODEOWNERS"]]),
      (".github/CODEOWNERS", [["filename": ".github/CODEOWNERS"]]),
      ("docs/CODEOWNERS", [["filename": "docs/CODEOWNERS"]]),
      ("workflow", [["filename": ".github/workflows/ci.yml"]]),
      ("gate script", [["filename": ".github/scripts/security-gate.mjs"]]),
      ("required checks", [["filename": "ci/required-checks.json"]]),
      ("rulesets", [["filename": "packages/ci-steward/src/rulesets.ts"]]),
      ("approver", [["filename": "tools/security-approve/Main.swift"]]),
      ("rename out of CODEOWNERS", [["filename": "OWNERS.txt", "previous_filename": "CODEOWNERS"]]),
      ("300 files", (0..<300).map { ["filename": "docs/f\($0).md"] }),
      ("duplicate names", [["filename": "README.md"], ["filename": "README.md"]]),
    ]
    for (label, files) in sensitiveFiles {
      let s = batchFixture { $0.compareFiles[sha("b")] = files }
      let r = try await s.batch(threeQueued)
      try require(r.approved == [1, 3], "\(label): kept out of the batch")
      try require(
        r.dropped.contains { $0.pr == 2 && $0.reason.contains("security-approve 2 \(sha("b"))") },
        "\(label): points to its own confirm")
      try require(!s.posts.contains { $0.hasSuffix(sha("b")) }, "\(label): nothing posted")
    }

    // No review hint for that SHA, or already approved at that head: skipped.
    let unhinted = batchFixture { $0.hinted = [1, 3] }
    try require(try await unhinted.batch(threeQueued).approved == [1, 3], "no hint dropped")
    let done = batchFixture {
      $0.statuses[sha("b")] = [["context": "security-review", "state": "success", "creator": ["id": 789]]]
    }
    try require(try await done.batch(threeQueued).approved == [1, 3], "already approved skipped")
    let lookalike = batchFixture {
      $0.statuses[sha("b")] = [["context": "security-review", "state": "success", "creator": ["id": 1]]]
    }
    try require(
      try await lookalike.batch(threeQueued).approved == [1, 2, 3], "a forged success is not 'done'")

    // A refused confirm reaches neither the key nor GitHub writes.
    let refused = batchFixture { $0.refuseConfirm = true }
    try await requireRefusal("refused", "owner refusal") { _ = try await refused.batch(threeQueued) }
    try require(refused.signs == 0 && refused.posts.isEmpty, "refusal: no key, no post")

    // A failed post still revokes the token.
    let badCreator = batchFixture { $0.creatorID = 1 }
    try await requireRefusal("pinned bot", "creator differs") { _ = try await badCreator.batch(threeQueued) }
    try require(badCreator.revokes == 1, "token revoked after a failed post")

    // Nothing eligible: no prompt at all.
    let empty = batchFixture { $0.hinted = [] }
    let none = try await empty.batch(threeQueued)
    try require(none.approved.isEmpty && empty.confirms.isEmpty && empty.signs == 0, "no prompt")

    // S7: at most 8 queue lines are considered.
    let many = batchFixture {
      for n in 4...10 { $0.pulls[n] = .init(heads: [sha("e")]) }
      $0.hinted = Set(1...10)
    }
    let ten = (1...10).map { n in "\(n) \(n <= 3 ? [sha("a"), sha("b"), sha("c")][n - 1] : sha("e"))" }
    let capped = try await many.batch(ten.joined(separator: "\n"))
    try require(capped.approved.count == 8, "batch capped at 8")
    try require(many.display.contains("Ignored 2 malformed or extra"), "extras counted")

    // GitHub titles are agent-written too: escapes are stripped before display.
    let escaped = batchFixture { $0.pulls[1]!.title = "ok\u{1B}]52;c;evil\u{07}\u{202E}txt" }
    _ = try await escaped.batch(threeQueued)
    try require(
      !escaped.display.contains("\u{1B}") && !escaped.display.contains("\u{07}")
        && !escaped.display.contains("\u{202E}"), "title sanitized")

    // Pins of zero refuse before any network.
    let unpinned = FakeGitHub()
    try await requireRefusal("not provisioned", "zero pins") {
      _ = try await approveBatch(
        queue: parseQueue(Data(threeQueued.utf8)), appID: 0, botID: 0,
        transport: unpinned.transport, reviewHint: { _, _ in true }, show: { _ in },
        confirm: unpinned.confirm, signer: unpinned.signer)
    }
    try require(unpinned.calls.isEmpty, "zero pins: no network")
    print(
      "Swift batch tests passed: digest, files shown, forged-hint attack visible, base main, immutable diff, moved heads, never-batch, cap, revoke"
    )
  }
}
