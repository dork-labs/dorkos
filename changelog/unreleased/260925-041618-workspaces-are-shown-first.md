---
covers:
  - 'fix(workspaces): show a new workspace before anything runs there, and run its hooks only as shown (DOR-2335)'
  - "fix(workspaces): remember a person's worktree hooks, reopen lost cards, and review legacy removal hooks (DOR-2335)"
  - "fix(workspaces): run a source's git hooks only when a person makes the workspace (DOR-2335)"
---

### Security

- A new workspace is now checked before anything runs in it. A clone is read first: its settings files, the links it keeps and what its skills run. Your repository's workspace commands are shown with them. When you make a workspace that brings any of these, you see them first and then decide. When an agent asks for one, a person approves it on a card that shows them. Before, a cloned repository's settings ran in every session there and nobody saw them (DOR-2335)
- A workspace's cleanup commands are now the ones you saw when it was made. Changing the repository's workspace file afterwards no longer changes what runs when the workspace is removed. For a workspace made before this release, you are shown its cleanup commands before they run, and you can remove it without running them (DOR-2335)
- When an agent makes a workspace from your repository, your repository's own git hooks and file monitor no longer run inside DorkOS. When you make one yourself, they run as they would for your own git (DOR-2335)
- Once you allow the workspace commands of your own repository, new workspaces from it no longer ask again until a command changes. `dorkos harness hooks --list` shows these decisions, and `--revoke <folder>` forgets one (DOR-2335)
