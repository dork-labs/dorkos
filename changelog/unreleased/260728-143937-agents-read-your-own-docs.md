---
covers:
  - 'fix(server): send agents to the docs your own instance is running (DOR-660)'
---

### Fixed

- Point your agents at your own copy of the docs. DorkOS hands your agents a link to the docs, and until now that link always went to dorkos.ai. Set `DORKOS_DOCS_BASE_URL` to your own site and your agents read that one instead. It has to be an `http://` or `https://` web address, or DorkOS will not start. Leave it unset and nothing changes (DOR-660)
