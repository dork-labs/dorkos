### Fixed

- Ghost Codex sessions no longer appear under every agent: a session without a working directory now belongs to no project list (all runtimes, enforced by the shared conformance suite), every Codex turn resolves and durably persists a real cwd, legacy cwd-less thread rows are backfilled on their next turn, and every surface derives per-agent membership from one shared selector. Title-less sessions render "Untitled session" instead of a blank row. (DOR-202, DOR-203, ADR 260707-193314)
