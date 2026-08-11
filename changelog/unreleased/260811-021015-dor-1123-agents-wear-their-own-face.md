---
covers:
  - 'fix(client): agents wear their own face in three more places, and onboarding shows the real DorkBot (DOR-1123)'
---

### Fixed

- Agents now look like agents in the task list, the command palette's preview, and the
  folder picker's recent list. Those three spots drew an agent as a small coloured dot
  with an emoji beside it — no square outline, no badge — so the same agent looked like
  one thing in the sidebar and something else here. They now use the same face
  everywhere (DOR-1123)
- The DorkBot you meet during setup is now the DorkBot you keep. Its picture on the
  welcome screens was built from a stand-in name rather than from DorkBot itself, so
  the colour and emoji you saw while setting up were not the ones waiting for you in
  the sidebar afterwards. Same face now, start to finish (DOR-1123)
