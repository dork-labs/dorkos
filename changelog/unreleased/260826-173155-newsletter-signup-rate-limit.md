---
covers:
  - 'feat(site): a per-IP throttle the public API routes can share (DOR-1581)'
  - 'feat(site): the newsletter signup turns away a flood from one address (DOR-1581)'
---

### Security

- The newsletter signup boxes on dorkos.ai now turn away a flood of sign-ups
  coming from one place. Signing up works exactly as before. Someone sending
  attempt after attempt is asked to wait a few minutes (DOR-1581)
