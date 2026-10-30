---
covers:
  - 'fix(server): at Full autonomy, outside words only add a line to Activity (DOR-3412)'
---

### Fixed

- An agent set to Full autonomy no longer gets stopped because it read something from outside your team, like a web page or an email. It can now check account usage, make a promise, and edit its own SOUL.md and HEARTBEAT.md. Each of these adds a line to Activity, as starting a chat now does too, so you can see what happened. Three things stay off at every level: an agent changing its own level or what it may do, revealing a key DorkOS keeps for you, and any limit you set yourself.
