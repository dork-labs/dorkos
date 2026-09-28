---
covers:
  - 'fix(connectors): stop refusing every connected-app action whose settings have defaults'
  - 'fix(connectors): refuse a corrupt stored schema cleanly and pin the open-root rule'
---

### Fixed

- Agents can use your connected apps again. Every Gmail action an agent tried, like reading your inbox, was turned away with a message saying its details did not match, even when they were right. DorkOS was quietly filling in the app's own default settings before checking the request, then refusing it for no longer matching what the agent sent. It now checks exactly what the agent sent and passes it along unchanged, and the app fills in its own defaults as it always has.
- The same mistake turned away most choices about which app events an agent hears about, such as new email in one label. Those are accepted again.
- When an agent's request really is wrong, the refusal now names the setting at fault, like a number sent as text or a setting the action does not have, so the agent can fix its request and try again.
