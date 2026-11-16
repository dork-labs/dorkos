# app-builder-pack

One skill, `building-dorkos-apps`, for any DorkOS agent asked to build a small app
(a DorkOS extension) for the person it works with.

It covers:

- a short placement interview: the job and who uses it, how often it's used, what it touches, where its data comes from and who hears comments, then a stated place in plain words
- scaffolding with `create_extension` and picking the smallest template
- checking the build with `test_extension`
- reading `serverStatus` and the log after install, because "compiled" isn't "started"
- telling the person, in plain words, what the app can reach before they allow it
- least privilege: no network, connections, secrets or agent tools unless the request names them
- screenshots of every surface the app takes, at phone and desktop width, light and dark
- the person's approval for the first run, every file change and every widened reach

Files:

- `skills/building-dorkos-apps/SKILL.md`: the workflow
- `skills/building-dorkos-apps/placement.md`: the interview, every surface and how to add it, open platform gaps
- `skills/building-dorkos-apps/pitfalls.md`: mistakes that pass tests and fail in DorkOS
- `skills/building-dorkos-apps/example.md`: a worked example, scaffold to test

The pack runs nothing and holds no keys. It's instructions only.
