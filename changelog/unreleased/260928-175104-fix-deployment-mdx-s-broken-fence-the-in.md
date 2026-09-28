---
covers:
  - "fix(docs): fix deployment.mdx's broken fence — the Interactive Setup tab never rendered"
  - 'docs(connections): match docs to the shipped product, gate the four retired nouns in docs/ (DOR-2508)'
  - 'fix(connections): address review — fence bug, scoped exemptions, docs tests, honesty fixes (DOR-2508)'
  - 'fix(connections): replace Prettier-broken vocab-allow markers with scoped allowlist entries'
  - 'fix(connections): fix MDX-breaking markers, add contains scoping, fix fence-closer anchoring (DOR-2508)'
  - 'fix(connections): remove all inline vocab-allow markers, ban them in docs/, fix changelog coverage (DOR-2508)'
---

### Fixed

- The Deployment guide's Interactive Setup tab now shows up and renders correctly — it was silently swallowed into the Environment Variables code block next to it
- The Connections docs now match what's actually in the app: how to answer an agent's request for an app right from the chat card, that Gmail and Google Calendar are the only apps with a real Read and write level today, what happens to a connected app when your DorkOS account link ends, and the real risk of leaving login off while sharing an app with every agent
