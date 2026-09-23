---
covers:
  - 'fix(cli): read what the Fly CLI actually prints when deploying a community'
---

### Fixed

- `dorkos community deploy` works with the current Fly CLI again. It created your Fly app and then stopped, saying it could not tell whether the app had been made, and left the app behind. It also refused to start at all if your Fly organization already had any apps in it. It now recognizes the app it just made by its name and the organization you picked, and it reads your existing apps without tripping over details the Fly CLI leaves blank. It still never takes over an app in a different organization (DOR-2169).
