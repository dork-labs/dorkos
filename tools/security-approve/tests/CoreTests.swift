import Foundation

// Single-PR approval against a fake GitHub with a mock signer.

func fixture(_ edit: (FakeGitHub) -> Void = { _ in }) -> FakeGitHub {
  let f = FakeGitHub()
  f.pulls[12] = .init(heads: [sha("a")])
  f.hinted = [12]
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
    try require(f.display.contains("apps/client/src/app.ts"), "diff summary shown before confirm")
    try require(f.display.contains("head \(sha("a"))"), "full SHA shown")
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

    // M4: the shown diff comes from main's head ... this exact SHA, never the live files list.
    try require(
      f.calls.contains { $0.path == "/repos/dork-labs/dorkos/compare/\(sha("9"))...\(sha("a"))" },
      "compare uses immutable SHAs")
    try require(!f.calls.contains { $0.path.contains("/files") }, "never reads /pulls/N/files")
    // S8: the first read is public; post-time head checks carry the minted token.
    let pullReads = f.calls.filter { $0.path == "/repos/dork-labs/dorkos/pulls/12" }
    try require(
      pullReads.count == 3 && pullReads[0].token == nil
        && pullReads.dropFirst().allSatisfy { $0.token == "mock-installation-token" },
      "post-time head checks use the token")
    let mint = f.calls.first { $0.path.hasSuffix("/access_tokens") }!
    try require(mint.body?["repositories"] as? [String] == ["dorkos"], "repository token scope")
    try require(
      (mint.body?["permissions"] as? [String: String]) == ["statuses": "write", "metadata": "read"],
      "least permissions")
    let post = f.calls.first { $0.method == "POST" && $0.path.contains("/statuses/") }!
    try require(
      post.path.hasSuffix(sha("a")) && post.token == "mock-installation-token", "exact head/token")
    try require(
      post.body?["description"] as? String == "Security approved aaaaaaaaaaaa", "description")
    // S11: the token is revoked after the post.
    try require(
      f.revokes == 1 && f.calls.last?.method == "DELETE"
        && f.calls.last?.token == "mock-installation-token", "token revoked last")

    // Each planted fault refuses. Faults before the post must leave no status behind.
    let faults: [(String, Bool, (FakeGitHub) -> Void)] = [
      ("head moved before confirm", true, { $0.pulls[12]!.heads = [sha("b")] }),
      ("closed PR", true, { $0.pulls[12]!.state = "closed" }),
      ("fork base", true, { $0.pulls[12]!.repo = "someone/dorkos" }),
      ("base is not main", true, { $0.pulls[12]!.baseRef = "x" }),
      ("comparison base differs", true, { $0.compareBase = sha("7") }),
      ("app id differs", true, { $0.appID = 999 }),
      ("installation differs", true, { $0.installationAppID = 999 }),
      ("token missing", true, { $0.token = nil }),
      ("head moved before post", true, { $0.pulls[12]!.heads = [sha("a"), sha("b")] }),
      ("creator differs", false, { $0.creatorID = 999 }),
      ("head moved after post", false, { $0.pulls[12]!.heads = [sha("a"), sha("a"), sha("b")] }),
      ("no review hint for this SHA", true, { $0.hinted = [] }),
      ("owner refused", true, { $0.refuseConfirm = true }),
    ]
    for (label, noPost, edit) in faults {
      let failed = fixture(edit)
      try await requireRefusal("", label) { _ = try await failed.single(12, sha("a")) }
      if noPost { try require(failed.posts.isEmpty, "\(label): no status written") }
      let minted = failed.calls.contains { $0.path.hasSuffix("/access_tokens") && failed.token != nil }
      if minted { try require(failed.revokes == 1, "\(label): minted token still revoked") }
    }
    let refused = fixture { $0.refuseConfirm = true }
    _ = try? await refused.single(12, sha("a"))
    try require(refused.signs == 0, "a refused confirm never reaches the key")
    let unhinted = fixture { $0.hinted = [] }
    _ = try? await unhinted.single(12, sha("a"))
    try require(unhinted.confirms.isEmpty && unhinted.signs == 0, "no review hint, no prompt")

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

    // Sensitive PRs still go through single mode, with flagged files shown.
    let sensitive = fixture {
      $0.pulls[12]!.title = "Fix \u{1B}[2J\u{202E}gate"
      $0.compareFiles[sha("a")] = [
        ["filename": ".github/workflows/security-gate.yml", "additions": 1, "deletions": 1],
        ["filename": "apps/server/src/services/core/auth/login.ts", "additions": 2, "deletions": 0],
      ]
    }
    _ = try await sensitive.single(12, sha("a"))
    try require(sensitive.display.contains("! +1 -1 .github/workflows/security-gate.yml"), "! flag")
    try require(
      sensitive.display.contains("* +2 -0 apps/server/src/services/core/auth/login.ts"), "* gate flag")
    try require(
      !sensitive.display.contains("\u{1B}") && !sensitive.display.contains("\u{202E}"),
      "terminal escapes stripped from GitHub text")
    let huge = fixture {
      $0.compareFiles[sha("a")] = (0..<300).map { ["filename": "docs/f\($0).md"] }
    }
    _ = try await huge.single(12, sha("a"))
    try require(huge.display.contains("File list incomplete"), "300 files marked incomplete")
    print("Swift single-approval tests passed: flow, JWT, scope, immutable diff, base main, races, revoke")
  }
}
