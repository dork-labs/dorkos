# Launch copy for hosted communities

These two texts describe the app's **Start a community** and **Move a community here** entry
points (task 5.2, DOR-2261). The code shipped dark in PR #2037: the rows appear only when the
linked account's service answers the hosted-community routes, and the hosted service does not
serve them yet. Saying people "can now" do this would break the demo-claim gate
(`meta/positioning-202607/09-gtm-plan.md` §2.0), so the copy waits here.

They ship at the hosted-communities launch, in the same PR that turns the service on:

- `changelog-fragment.md` moves to `changelog/unreleased/` with a fresh timestamp id, and its
  `covers:` list is updated to that PR's commits (or it covers the launch PR as `"#<n>"`).
- `docs-guide-section.mdx` goes back into `docs/guides/communities.mdx`, just before
  "Add an agent to a Community channel".

Both are written to the `writing-for-humans` skill. Re-read them against what launched before
moving them, in case a step or a label changed.
