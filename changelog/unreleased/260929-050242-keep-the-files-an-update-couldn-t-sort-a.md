---
covers:
  - "feat: keep the files an update couldn't sort as yours, from the app or the CLI (DOR-2341)"
  - 'fix: offer Check files first, and keep the review under the same lock (DOR-2341)'
---

### Added

- A package installed from a folder on your computer, or one whose version no longer exists, used to list the files an update couldn't sort forever, and if one of them still ran, it waited for your Review after every update. Where **Check files** can't sort them, open the note on its row in **Installed** and press **Keep these as mine**, or run `dorkos marketplace keep-files <package>`. DorkOS shows you the files and marks the ones that still run, and asks first. After that they're yours: updates keep them, and nothing is moved or deleted. For a package held back from every session, it also shows everything the package runs, and your yes approves what it discloses now, like a Review. Only you can do this, not an agent (DOR-2341)
