---
covers:
  - 'fix(server): at Full autonomy, outside words only add a line to Activity (DOR-3412)'
  - 'fix(server): lowering an agent reaches its open chats at once, even under a stricter hold (DOR-3416)'
  - 'fix(server): at Full, an agent loosening a permission after reading outside words is refused, not asked (DOR-3417)'
---

### Fixed

- An agent set to Full autonomy no longer gets stopped because it read something from outside your team, like a web page or an email. It can now check account usage, make a promise, and edit its own SOUL.md and HEARTBEAT.md. Each of these adds a line to Activity, as starting a chat now does too, so you can see what happened. Three things stay off at every level: an agent changing its own level or what it may do, revealing a key DorkOS keeps for you, and any limit you set yourself.
- When you lower an agent's level, for example from Full autonomy to Ask first, its chats that were already open follow at once. Before, a chat that had just read outside words could act on its next turn at the old level without asking you.
- At Full autonomy, an agent that read outside words and then tries to loosen a permission is now told no in plain words, with a line in Activity. It used to put a card in front of you instead.
