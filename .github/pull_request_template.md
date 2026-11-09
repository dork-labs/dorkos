## What and why

<!-- One or two sentences: what changes for the person using DorkOS, and why. -->

## Checklist

- [ ] A PR that does one part of a multi-part ticket says `Refs DOR-…`, never `Fixes`/`Closes`, so Linear doesn't close open work.
- [ ] User-facing change: a fragment in `changelog/unreleased/`. Otherwise: the `skip-changelog` label.
- [ ] Touches auth, permissions, connectors, mini apps, relay or Cloud auth: opened with `hold` for a security review.
- [ ] `pnpm verify` passes locally.
