## What and why

<!-- One or two sentences: what changes for the person using DorkOS, and why. -->

## Checklist

- [ ] A PR that does one part of a multi-part ticket says `Refs DOR-…`, never `Fixes`/`Closes`, so Linear doesn't close open work.
- [ ] Security fix: the public title, body, commits and test names say what's fixed, never what's still open. Residuals go to Security privately.
- [ ] User-facing change: a fragment in `changelog/unreleased/`. Otherwise: the `skip-changelog` label.
- [ ] Touches auth, permissions, connectors, mini apps, relay or Cloud auth: opened with `review:deep` and no `hold`. The arm script already waits for Security's label, so a Security review is never a hold reason.
- [ ] `pnpm verify` passes locally.
