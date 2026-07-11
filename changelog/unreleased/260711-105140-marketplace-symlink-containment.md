### Fixed

- Installing a marketplace package can no longer plant a shortcut that reaches outside where it's installed. A package could previously ship a symlink like `data -> /etc/passwd` or `data -> ../../another-project`; the installer copied it as-is, so later syncing followed the shortcut and read or wrote files outside the package's own folder. Now every symlink is dropped while the package is being staged, and each one is noted in the install log. Real packages are unaffected — they're plain files and folders, never shortcuts (DOR-279)
