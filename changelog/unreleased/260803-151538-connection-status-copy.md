---
covers:
  - 'fix(client): retire network-sense "Connection" copy (DOR-855)'
  - 'fix(client): rename Remote Access dialog''s "Establishing connection..." (DOR-855)'
  - 'fix(client,server): retire "Check your connection" in server-origin copy (DOR-855)'
  - 'fix(client): apply DOR-855 copy decisions from adversarial review'
---

### Changed

- Status messages about your network no longer say "Connection" — a word we're
  saving for the Connections page. The live-sync indicator now says "Live
  updates" (or "Offline" when it's down), a lost server link says "Server link
  lost. Check your network.", a stalled fetch says "Can't reach DorkOS",
  adapter tests say "Reachable" or "Not reachable" while trying to reach it,
  and tunnel and install errors name what actually failed instead of saying
  "Connection" (DOR-855)
