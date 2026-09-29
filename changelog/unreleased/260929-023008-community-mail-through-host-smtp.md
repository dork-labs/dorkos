---
covers:
  - "feat(community): send notices by email through the host's own mail server (DOR-2537)"
  - 'fix(community): harden optional mail after review (DOR-2537)'
---

### Added

- A Community host can now let the server send short notices by email through the host's own mail server. It stays off until you set `COMMUNITY_SMTP_URL` and `COMMUNITY_MAIL_FROM`, and mail to another machine must be encrypted. The server never stores the address it sends to, reports a notice as delivered only when your mail server accepts it, and keeps trying a busy mail server for up to three days. Hosts and their programs can check whether mail is on at `GET /api/v1/host/capabilities`. (DOR-2537)
