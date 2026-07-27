---
covers:
  - 'fix(config): losing your config no longer loses your privacy choice (DOR-584)'
  - 'feat(config): every config default states what it does for the user'
  - 'docs(adr): user-safe defaults as a stated, enforced principle (DOR-584)'
---

### Fixed

- Your privacy choice now survives a config reset. If your settings file was damaged and DorkOS had to rebuild it, or you reset your settings, the answer you gave about sharing data used to be thrown away and replaced with the sharing-on defaults. It is now kept, along with anything else you had made stricter: a login requirement you switched on, a limit you tightened, and the record that revoked your standing permissions. Preferences like your theme still go back to defaults, as a reset should (DOR-584)
- Resetting one section by name, like `dorkos config reset telemetry`, still does exactly what it says. Naming the section is the clear request that a blanket reset is not (DOR-584)

### Security

- A settings block that was missing the feature-usage entry no longer counts as permission to send those events. A missing answer is never treated as a yes (DOR-584)
