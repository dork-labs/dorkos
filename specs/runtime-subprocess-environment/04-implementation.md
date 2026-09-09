# Runtime environment protection implementation

## Session 1 — 2026-09-08

Worker: /root/connections_hosted_corrections (existing originating implementation worker). Worktree: codex-runtime-env-design, branch codex/runtime-env-design, pinned base 03f68928b427e7a533055dbdfa2b3dac457c5714. Root owns tracker and final publication.

The operator approved checkpoint5 (tree7347628f11b79d562edf3e87bfb353360233d197) after independent PASS0. Task8.1 is complete. Tasks8.2–8.5 proceed sequentially in this single-writer tree; separate reviewer will inspect frozen implementation. No live authentication, provider calls or installed CLI execution.

Tasks8.2–8.4 are implemented. The shared pure projection, finite runtime/purpose catalogs, three owner-only names lists, withheld config snapshots, and append-only migration0.76.0 are wired. All model launches, warmups, default probes, login/install helpers and Ollama execFile defaults supply a complete environment. Codex policy changes invalidate a captured client; Claude keeps its existing environment fingerprint and account pin. No historical migration body changes.

Task8.5 is in verification. Actual installed Claude/Codex SDK captures use intercepted synthetic spawns, not live model calls. Existing account/persistent/provision tests, real configuration upgrade/write tests, and parsed launch census pass. Six controlled regressions were killed: parent remerge, absent Codex env, absent Claude warmup env, stale Codex client policy, reserved-name opt-in, and missing migration persistence. An initial mutation command selected no tests; it is preserved as invalid evidence and replaced by an assertion-count-checked run. Raw proof and exact restoration hashes are in `.dork/flow/runtime-env-execute/`.

Unknown parent variables intentionally stop propagating; the runtime guide documents exact-name opt-in and restart requirements. Same-OS-user access and values already held by a running process remain outside this protection. Independent code review and normal verification are pending; no completion/publication claim is made.
