---
covers:
  - 'fix(site): send the shipped email without a version (DOR-909)'
---

### Fixed

- If you reported a bug or asked for a feature and left your email, you now actually get the "your report shipped" email when we ship it. Before, that email only went out if the report carried a version number, and none of them ever did, so nobody got one. The email now links to the changelog so you can see what changed.
- A report closed as a duplicate now shows as closed on its status page, instead of sitting at "triaged".
