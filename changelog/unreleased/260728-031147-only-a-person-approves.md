### Fixed

- With **Require login** turned on, approving a risky action now has to happen inside DorkOS, in a browser you are signed in to. Your agents hold one of your API keys so they can run `dorkos` commands, and a key used to be enough to answer an approval, which meant an agent could approve its own work. It cannot any more. The same goes for saying no, and for the shortcut that let an agent skip the question entirely.

### Changed

- With **Require login** on, removing a package from the terminal now puts a card in front of you first, and `dorkos uninstall` prints the command to run once you have said yes. Everything else you run from the terminal, like installing packages, changing where packages come from, and creating tasks, works exactly as before.
