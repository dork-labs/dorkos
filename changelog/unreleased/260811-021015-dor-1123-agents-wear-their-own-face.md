---
covers:
  - 'fix(client): agents wear their own face in three more places, and onboarding shows the real DorkBot (DOR-1123)'
  - 'fix(client): first light waits for DorkBot’s real face, and the offline sheet draws agents as agents (DOR-1123)'
---

### Fixed

- Agents now look like agents in four more places: the task list, the command palette's
  preview, the folder picker's recent list, and the sheet that lists agents DorkOS
  cannot reach. Each of those drew an agent as a small coloured dot with an emoji beside
  it, with no square outline and no badge, so the same agent looked like one thing in
  the sidebar and something else here. They now draw the same face the rest of the
  cockpit does (DOR-1123)
- The DorkBot you meet during setup is now the DorkBot you keep. Its picture on the
  welcome screens was built from a stand-in name rather than from DorkBot itself, so the
  colour and emoji you saw while setting up were not the ones waiting for you in the
  sidebar afterwards. Setup now shows a plain grey placeholder for the moment before it
  knows DorkBot's real face, then the real one, and that is the face you keep (DOR-1123)
