---
covers:
  - 'fix(client): stop network status copy from saying "Connection" (DOR-855)'
---

### Changed

- Status messages about your network no longer say "Connection" — a word we're
  saving for the Connections page. The live-sync indicator now says "Live stream,"
  the relay banner says "Server link," adapter tests say "Reachable" or "Not
  reachable," and tunnel errors name the tunnel directly (DOR-855)
