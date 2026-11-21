# Shared native tool implementation record

DOR-4481

## First delivery candidate

Tasks 1.1 and 1.2 are implemented locally, together with the prerequisite that forwards the optional live facts callback. The principal service reads through the current turn's existing owner and rechecks ownership around asynchronous authority validation. The runtime adapters and tool registrations retain their existing behavior.

The candidate is on `codex/shared-tool-turn-foundation` in `/Volumes/ext-ssd-1/dork-os/worktrees-cold/dorkos/codex__shared-tool-turn-foundation`, based on `4da51fef983573ad910742d4348724167ae7830e`. DOR-2067's full capability input schemas arrived in PR #3895. Its workspace verification prerequisite arrived in PR #3836.

Root originally reviewed the isolated contract (`368faf37f3`), resolver (`5b359d10a0`), and callback forwarding (`1b2d75d4b3`) under `REVIEW.md`. The current submission keeps the ADR proposed and includes only the foundation. The frozen inputs are unchanged.

- Specification SHA256: `1b6116896f35b2854ecd451a0a6863f5dca14d0b9d4169a478c317eaa7afab41`.
- Task JSON SHA256: `cd5882c5cb6c936670b3cb3e9abec81f1d6e12f35c32d1e45a3192256c5521c2`.
- Task Markdown SHA256: `3f7d6fc8828ece933c5fb935e03ef9608fd3eee3fe4a7e547363d247666afed5`.

## Verification and remaining work

The first composed candidate passed 188 focused tests across 14 files in a clean test home. Coverage includes reading fresh turn facts, callback forwarding, the real principal store, and compatibility with current runtime tool registration. The final review removes an unused exported type alias and checks the actual port signature directly.

Adapter bindings, shared invocation, the four-runtime fixture, and all later cutovers are outside this delivery candidate. The larger working branch retains its own progress and evidence. Keep the ticket open through final integrated verification, review, required CI, and merge.
