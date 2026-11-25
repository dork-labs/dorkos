---
covers:
  - 'fix(agents): Git, Kubernetes, Python package and GPG sign-in files are protected across your home folder (DOR-4388)'
---

### Security

- DorkOS now protects more of your sign-in files everywhere in your home folder, not only inside an agent's own folder: Git's saved logins, your Kubernetes config, Python package upload settings and your GPG keys. Agents can't read them.
