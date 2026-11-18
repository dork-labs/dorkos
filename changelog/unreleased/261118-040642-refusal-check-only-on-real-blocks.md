---
covers:
  - 'fix(browser): the Agent browser only treats real block pages as refusals, and the agent hands them over without stalling (DOR-4662)'
---

### Fixed

- Ordinary pages no longer count as a site refusing the Agent browser. Before, a help page that said "press and hold", or any page titled "Access denied", made your agent stop and hand the browser to you. Now only a real block page counts, such as Google's "Couldn't sign you in", a bot check or an access block.
- When a site does refuse the Agent browser, your agent now hands it to you right away. Before, two of its instructions disagreed, so it could get stuck.
