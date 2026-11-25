---
covers:
  - 'fix(agents): Git, Kubernetes, Python package and GPG sign-in files are protected across your home folder (DOR-4388)'
  - 'fix(agents): seven more home sign-in files join the protected list (DOR-4388)'
---

### Security

- DorkOS now protects more of your sign-in files everywhere in your home folder, not only inside an agent's own folder. Agents can't read your saved logins for Git, Kubernetes, Python package uploads, GPG, PostgreSQL, Vault, Cargo, RubyGems, Terraform and the Azure CLI.
- So an agent's own `git push` with a saved login, `gpg`, `kubectl`, `twine`, `psql`, `vault`, `cargo publish`, `gem push`, `terraform` and `az` can't sign in from its chats any more. Where a service is offered in Connections, connect it there instead.
