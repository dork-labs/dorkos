---
covers:
  - 'fix(mesh,server): registering an agent adopts the manifest a folder already has (DOR-1019)'
---

### Fixed

- Adding an agent by folder used to write a brand new agent file over any agent file that folder already had. Point it at a project you keep in git and DorkOS quietly rewrote a file your repository owns — and removing the agent afterwards deleted it. Now DorkOS takes on the agent the folder already describes instead of replacing it, so the file is left exactly as it was, and an agent file that git is tracking is never deleted when you remove the agent (DOR-1019)
