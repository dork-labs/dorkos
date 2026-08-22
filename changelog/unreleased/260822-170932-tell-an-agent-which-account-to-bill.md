---
covers:
  - 'feat(client): tell an agent which account to bill, and see every billing override from Settings (DOR-1407)'
  - 'fix(server,client,shared): an unreadable account registry is unknown, not empty (DOR-1407)'
---

### Added

- An agent can now be told which Claude account to bill. Open its profile, click **Runs on**, and pick an account — the same way you pick its model. The row shows where the setting came from: green when the agent simply follows your default, amber when you chose something else here, and one tap on that chip puts it back. The row only appears where the choice is real: on Claude Code, and only once this machine knows of more than one account.
- Settings → Runtimes now lists agents that bill somewhere other than your default, alongside the ones that run on a different runtime or model. If an agent points at an account that isn't registered on this machine, it is listed in amber with a warning — it quietly bills to your default until you fix it — and clicking the row opens that agent so you can.
- An agent pointing at an account that isn't registered also turns up under **Needs attention** in the sidebar, the same as one pointing at a runtime you haven't connected. You find out where you happen to be looking, rather than only when you open Settings.
- If DorkOS can't read your account list at all, it now says so instead of quietly acting as though you have no accounts — so a temporary hiccup no longer paints every agent amber.
