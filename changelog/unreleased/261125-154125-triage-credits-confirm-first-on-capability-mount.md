---
covers:
  - 'fix(api): the answer to using credits for checks is served by the capability mount, with a confirm-first hold (DOR-4978)'
---

### Changed

- Answering "Run cheap checks on DorkOS credits?" works as before in the app. **Use credits** still asks you to confirm it's you, and **Not now** still saves at once.
- Only you, the owner, can answer. An agent still gets `person_only`, and someone else signed in still gets `owner_only`, with the same words as before.
- Any request that sends an `Authorization` header now gets `person_only`, even where the old route let it through.
- For API users: the operation id `heartbeats.updateTriageCredits` is now `heartbeat.choose_triage_credits`. The same answer can also be sent to `POST /api/capabilities/heartbeat.choose_triage_credits/invoke`, with the same checks.
- If heartbeats aren't running, the answer is now `503` instead of `404`.
