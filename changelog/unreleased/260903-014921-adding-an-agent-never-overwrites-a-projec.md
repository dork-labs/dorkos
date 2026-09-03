---
covers:
  - 'fix(mesh,server): registering an agent adopts the manifest a folder already has (DOR-1019)'
  - 'fix(mesh,server,client): make the adopt seam reachable, honest and undoable (DOR-1019)'
---

### Fixed

- Adding an agent by folder used to write a brand new agent file over any agent file that folder already had. Point it at a project you keep in git and DorkOS quietly rewrote a file your repository owns — and removing the agent afterwards deleted it. Now DorkOS takes on the agent the folder already describes instead of replacing it, so the file is left exactly as it was. An agent file that git is tracking is never deleted either: removing that agent leaves the file alone and blocks the folder from scans instead, so the agent doesn't simply come back — and DorkOS says so when it does that. Adding the folder again brings the agent back and unblocks it (DOR-1019)
