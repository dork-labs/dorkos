### Changed

- Changelog entries now live as one fragment file per change under `changelog/unreleased/` instead of a shared `[Unreleased]` section, so parallel worktrees no longer collide on the changelog. The post-commit hook writes a fragment from each conventional commit, and `/system:release` compiles them into `CHANGELOG.md`; older releases moved to `changelog/archive/` and a docs archive page. See `changelog/README.md` (ADR 260707-231641).
