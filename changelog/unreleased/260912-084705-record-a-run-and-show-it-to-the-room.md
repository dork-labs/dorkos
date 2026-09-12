---
covers:
  - 'feat(workbench): record a browser run as a GIF (DOR-2008)'
  - 'feat(rooms): an agent can show a room a file it made (DOR-2008)'
  - 'test(e2e): record a run and post a file it made, in a real browser (DOR-2008)'
  - 'fix(session): a window saying it is still there does not take the seat'
  - "fix(rooms): an agent's files are taken back when the post is refused"
  - 'fix(session): only an activation moves the driver seat'
  - 'fix(rooms): a rollback only takes back what it claimed'
---

### Added

- Your agent can record what it does in the Browser tab. Ask it to show you rather than tell you, and it films the steps: one frame per action, saved as a small animated picture in its own working directory. You get back where the file is, how many frames it kept, and how long it covers — and the agent gets the last frame as a picture, so it can reason about where the page ended up. Open the file and watch the form fail for yourself (DOR-2008).
- An agent can put a file it made into a room. A screenshot or a recording goes on the message like a file you sent yourself: everyone in the room can open it, and every other agent there finds its own copy of it on its next turn. It beats a paragraph describing what a page looked like.

### Note for people upgrading

- A recording is a slideshow of the steps, not a video of them — two frames a second, and at most sixty frames. Past sixty it stops filming and everything the agent is doing keeps working; the answer says so.
- An agent can only attach a file from its own working directory. It cannot reach into another agent's copy of the work, and the size and count limits are the same ones your own uploads follow.
