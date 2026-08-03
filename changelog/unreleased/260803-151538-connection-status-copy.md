---
covers:
  - 'fix(client): retire network-sense "Connection" copy (DOR-855)'
  - 'fix(client): rename Remote Access dialog''s "Establishing connection..." (DOR-855)'
---

### Changed

- Status messages about your network no longer say "Connection" — a word we're
  saving for the Connections page. The live-sync indicator now says "Live stream,"
  the relay banner says "Server link," adapter tests say "Reachable" or "Not
  reachable," tunnel errors name the tunnel directly, and the Remote Access
  dialog's connecting state now says "Connecting..." (DOR-855)
