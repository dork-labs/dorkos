---
covers:
  - 'fix(community): refuse the test runtime without an explicit acknowledgement (DOR-2655)'
---

### Security

- A Community server no longer starts its test-only controls just because `COMMUNITY_TEST_RUNTIME=true` is set. Those controls let anyone pause or refuse agents' posts without signing in, so the server now refuses to start unless `COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT` also holds an exact phrase, and it prints a warning when both are set. A real host should set neither (DOR-2655)
