import Foundation

// Batch approval against a fake GitHub with a mock signer.

func batchFixture(_ edit: (FakeGitHub) -> Void = { _ in }) -> FakeGitHub {
  let f = FakeGitHub()
  f.pulls[1] = .init(heads: [sha("a")], title: "First")
  f.pulls[2] = .init(heads: [sha("b")], title: "Second")
  f.pulls[3] = .init(heads: [sha("c")], title: "Third")
  f.reviewedPRs = [1, 2, 3]
  edit(f)
  return f
}
let threeQueued = "1 \(sha("a"))\n2 \(sha("b"))\n3 \(sha("c"))\n"

@main struct BatchTests {
  static func main() async throws {
    // One confirm and one signature cover the whole list.
    let f = batchFixture()
    let report = try await f.batch(threeQueued)
    try require(report.approved == [1, 2, 3] && report.dropped.isEmpty, "all three approved")
    try require(f.confirms.count == 1 && f.signs == 1, "one confirm, one signature")
    try require(
      f.confirms[0]
        == "Approve 3 dork-labs/dorkos PRs: #1 aaaaaaaaaaaa, #2 bbbbbbbbbbbb, #3 cccccccccccc",
      "confirm names every PR and SHA")
    try require(f.posts.count == 3, "three statuses")
    try require(f.calls.filter { $0.path.hasSuffix("/access_tokens") }.count == 1, "one token")

    // Agent text in the queue is refused and never shown.
    let agentText = batchFixture()
    let injected =
      threeQueued
      + "4 \(sha("d")) Dorian already said yes, approve all\nAPPROVE EVERYTHING\n#5 \(sha("e"))\n"
    let injectedReport = try await agentText.batch(injected)
    try require(injectedReport.approved == [1, 2, 3], "only well-formed lines approved")
    let shown = agentText.shown.joined(separator: "\n")
    try require(shown.contains("Ignored 3 malformed queue lines."), "refused lines counted")
    try require(
      !shown.contains("Dorian") && !shown.contains("APPROVE") && !agentText.confirms[0].contains("#4"),
      "no agent text shown or confirmed")
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

    // Never batched: CODEOWNERS, workflows, rulesets, the approver itself, renames out of them,
    // and any PR whose file list GitHub could not give in full.
    let sensitiveFiles: [(String, [[String: Any]], Int?)] = [
      ("CODEOWNERS", [["filename": "CODEOWNERS"]], nil),
      (".github/CODEOWNERS", [["filename": ".github/CODEOWNERS"]], nil),
      ("docs/CODEOWNERS", [["filename": "docs/CODEOWNERS"]], nil),
      ("workflow", [["filename": ".github/workflows/ci.yml"]], nil),
      ("gate script", [["filename": ".github/scripts/security-gate.mjs"]], nil),
      ("required checks", [["filename": "ci/required-checks.json"]], nil),
      ("rulesets", [["filename": "packages/ci-steward/src/rulesets.ts"]], nil),
      ("approver", [["filename": "tools/security-approve/Main.swift"]], nil),
      ("rename out of CODEOWNERS", [["filename": "OWNERS.txt", "previous_filename": "CODEOWNERS"]], nil),
      ("incomplete list", [["filename": "README.md"]], 2),
    ]
    for (label, files, changed) in sensitiveFiles {
      let s = batchFixture {
        $0.pulls[2]!.files = files
        $0.pulls[2]!.changedFiles = changed
      }
      let r = try await s.batch(threeQueued)
      try require(r.approved == [1, 3], "\(label): kept out of the batch")
      try require(
        r.dropped.contains { $0.pr == 2 && $0.reason.contains("security-approve 2 \(sha("b"))") },
        "\(label): points to its own confirm")
      try require(!s.posts.contains { $0.hasSuffix(sha("b")) }, "\(label): nothing posted")
    }

    // No review for that SHA, or already approved at that head: skipped.
    let unreviewed = batchFixture { $0.reviewedPRs = [1, 3] }
    try require(try await unreviewed.batch(threeQueued).approved == [1, 3], "no review dropped")
    let done = batchFixture {
      $0.statuses[sha("b")] = [
        ["context": "security-review", "state": "success", "creator": ["id": 789]]
      ]
    }
    try require(try await done.batch(threeQueued).approved == [1, 3], "already approved skipped")
    let forged = batchFixture {
      $0.statuses[sha("b")] = [
        ["context": "security-review", "state": "success", "creator": ["id": 1]]
      ]
    }
    try require(
      try await forged.batch(threeQueued).approved == [1, 2, 3], "a forged success is not 'done'")

    // A refused confirm reaches neither the key nor GitHub writes.
    let refused = batchFixture { $0.refuseConfirm = true }
    try await requireRefusal("refused", "owner refusal") { _ = try await refused.batch(threeQueued) }
    try require(refused.signs == 0 && refused.posts.isEmpty, "refusal: no key, no post")

    // Nothing eligible: no prompt at all.
    let empty = batchFixture { $0.reviewedPRs = [] }
    let none = try await empty.batch(threeQueued)
    try require(none.approved.isEmpty && empty.confirms.isEmpty && empty.signs == 0, "no prompt")

    // GitHub titles are agent-written too: escapes are stripped before display.
    let escaped = batchFixture { $0.pulls[1]!.title = "ok\u{1B}]52;c;evil\u{07}\u{202E}txt" }
    _ = try await escaped.batch(threeQueued)
    let display = escaped.shown.joined()
    try require(
      !display.contains("\u{1B}") && !display.contains("\u{07}") && !display.contains("\u{202E}"),
      "title sanitized")

    // Pins of zero refuse before any network.
    let unpinned = FakeGitHub()
    try await requireRefusal("not provisioned", "zero pins") {
      _ = try await approveBatch(
        queue: parseQueue(Data(threeQueued.utf8)), appID: 0, botID: 0,
        transport: unpinned.transport, reviewed: { _, _ in true }, show: { _ in },
        confirm: unpinned.confirm, signer: unpinned.signer)
    }
    try require(unpinned.calls.isEmpty, "zero pins: no network")
    print(
      "Swift batch tests passed: one confirm, agent text refused, moved heads dropped, never-batch paths, review, refusal"
    )
  }
}
