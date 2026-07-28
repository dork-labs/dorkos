### Fixed

- With **Require login** turned on, approving a risky action now has to happen inside DorkOS, in a browser you are signed in to. Your agents hold one of your API keys so they can run `dorkos` commands, and a key used to be enough to answer an approval, which meant an agent could approve its own work. It cannot any more. The same goes for saying no, and for the shortcut that let an agent skip the question entirely.
