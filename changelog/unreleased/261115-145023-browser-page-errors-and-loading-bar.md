---
covers:
  - 'feat(browser): the Agent browser draws its own page errors and a loading line (DOR-4430, DOR-4431)'
  - 'fix(browser): the Blocked by DorkOS line reads "The Agent browser keeps pages like this closed." (DOR-4430)'
---

### Changed

- When a page won't load in the Agent browser in the Mac app, DorkOS now says why in plain words where the page would be: the site can't be found, didn't respond, you're offline, its certificate isn't valid, or the page stopped working. Each has one button to fix it, like **Try again** or **Go back**. The address stays in the field.
- There is no way past a certificate error, because agents use this browser too.
- A thin line under the browser's controls now shows while a page loads, and **Go** becomes **Stop** until it finishes.
- When an agent's page doesn't load, the agent is told the same thing you see.
