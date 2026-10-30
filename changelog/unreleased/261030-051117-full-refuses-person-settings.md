---
covers:
  - 'fix(server): at Full, an agent changing a setting only a person may change is refused, not asked (DOR-3426)'
---

### Fixed

- At Full autonomy, an agent that tries to open up a setting only you may change, like remote access or which hooks may run, is now told no in plain words. The message names the setting, and Activity gets a line. Before, it put a card in front of you and waited. Turning such a setting off, like switching the tunnel off, still works without asking, and adds a line to Activity. You can change any of these yourself in Settings. Below Full autonomy, the agent still asks you as before.
