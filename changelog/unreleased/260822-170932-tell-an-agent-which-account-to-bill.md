---
covers:
  - 'feat(client): tell an agent which account to bill, and see every billing override from Settings (DOR-1407)'
---

### Added

- An agent can now be told which Claude account to bill. Open its profile, click **Runs on**, and pick an account — the same way you pick its model. The row shows where the setting came from: green when the agent simply follows your default, amber when you chose something else here, and one tap on that chip puts it back. The row only appears where the choice is real: on Claude Code, and only once this machine knows of more than one account.
- Settings → Runtimes now lists agents that bill somewhere other than your default, alongside the ones that run on a different runtime or model. If an agent points at an account you have since removed, it is listed in amber with a warning — it quietly bills to your default until you fix it — and clicking the row opens that agent so you can.
