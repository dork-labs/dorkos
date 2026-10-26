import Foundation

// Single-PR approval against a fake GitHub with a mock signer.

func fixture(_ edit: (FakeGitHub) -> Void = { _ in }) -> FakeGitHub {
  let f = FakeGitHub()
  f.pulls[12] = .init(heads: [sha("a")])
  f.reviewedPRs = [12]
  edit(f)
  return f
}

@main struct CoreTests {
  static func main() async throws {
    let f = fixture()
    try require(try await f.single(12, sha("a")) == sha("a"), "returns the SHA")
    try require(f.signs == 1 && f.confirms.count == 1 && f.posts.count == 1, "one confirm, sign, post")
    try require(
      f.confirms[0] == "Approve dork-labs/dorkos PR #12 at \(sha("a"))", "confirm names PR and SHA")
    try require(f.shown[0].contains("apps/client/src/app.ts"), "diff summary shown before confirm")
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
      f.calls.filter { $0.path.contains("/pulls/") }.allSatisfy { $0.token == nil },
      "public reads carry no token")
    let mint = f.calls.first { $0.path.hasSuffix("/access_tokens") }!
    try require(mint.body?["repositories"] as? [String] == ["dorkos"], "repository token scope")
    try require(
      (mint.body?["permissions"] as? [String: String]) == ["statuses": "write", "metadata": "read"],
      "least permissions")
    let post = f.calls.first { $0.body != nil && $0.path.contains("/statuses/") }!
    try require(
      post.path.hasSuffix(sha("a")) && post.token == "mock-installation-token", "exact head/token")
    try require(
      post.body?["description"] as? String == "Security approved aaaaaaaaaaaa", "description")

    // Each planted fault refuses. Faults before the post must leave no status behind.
    let faults: [(String, Bool, (FakeGitHub) -> Void)] = [
      ("head moved before confirm", true, { $0.pulls[12]!.heads = [sha("b")] }),
      ("closed PR", true, { $0.pulls[12]!.state = "closed" }),
      ("fork base", true, { $0.pulls[12]!.repo = "someone/dorkos" }),
      ("app id differs", true, { $0.appID = 999 }),
      ("installation differs", true, { $0.installationAppID = 999 }),
      ("token missing", true, { $0.token = nil }),
      ("head moved before post", true, { $0.pulls[12]!.heads = [sha("a"), sha("b")] }),
      ("creator differs", false, { $0.creatorID = 999 }),
      ("head moved after post", false, { $0.pulls[12]!.heads = [sha("a"), sha("a"), sha("b")] }),
      ("no review for this SHA", true, { $0.reviewedPRs = [] }),
      ("owner refused", true, { $0.refuseConfirm = true }),
    ]
    for (label, noPost, edit) in faults {
      let failed = fixture(edit)
      try await requireRefusal("", label) { _ = try await failed.single(12, sha("a")) }
      if noPost { try require(failed.posts.isEmpty, "\(label): no status written") }
    }
    let refused = fixture { $0.refuseConfirm = true }
    _ = try? await refused.single(12, sha("a"))
    try require(refused.signs == 0, "a refused confirm never reaches the key")
    let unreviewed = fixture { $0.reviewedPRs = [] }
    _ = try? await unreviewed.single(12, sha("a"))
    try require(unreviewed.confirms.isEmpty && unreviewed.signs == 0, "no review, no prompt")

    for (pr, head, app, bot) in [
      (0, sha("a"), 123, 789), (12, "short", 123, 789), (12, sha("a"), 0, 789),
      (12, sha("a"), 123, 0), (12, sha("A"), 123, 789),
    ] {
      let failed = fixture()
      try await requireRefusal("", "bad input \(pr) \(head) \(app) \(bot)") {
        _ = try await failed.single(pr, head, appID: app, botID: bot)
      }
      try require(failed.calls.isEmpty && failed.signs == 0, "no network or key for bad input")
    }

    // Sensitive PRs still go through single mode, with the flagged diff shown.
    let sensitive = fixture {
      $0.pulls[12]!.title = "Fix \u{1B}[2J\u{202E}gate"
      $0.pulls[12]!.files = [
        ["filename": ".github/workflows/security-gate.yml", "additions": 1, "deletions": 1]
      ]
    }
    _ = try await sensitive.single(12, sha("a"))
    try require(sensitive.shown[0].contains("! +1 -1 .github/workflows/security-gate.yml"), "flagged")
    try require(
      !sensitive.shown[0].contains("\u{1B}") && !sensitive.shown[0].contains("\u{202E}"),
      "terminal escapes stripped from GitHub text")
    print("Swift single-approval tests passed: flow, JWT, scope, identities, head races, review, confirm")
  }
}
