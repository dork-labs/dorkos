# Tasks: marketplace-install-verification

- **1.1** Hash cache and verifyInstall: §3 cache (lstat size/mtime/ctime/ino key, LRU 20k, hashFile only) and §4 verifyInstall with clean/modified/unknown, customized, added under EFFECT_BEARING_PATHS, truncation. Tests first per §9; mutation-check the cache key and the added rule. (depends on nothing)
- **1.2** Strict rebuild rebuildRecordStrict: §5: lock, re-check inside the lock, metadata, fetchAtCommit, staged + skillRef injection via a helper shared with rebuildInstalledFiles, exact match with the userEditable exemption, atomic write, write nothing otherwise. Tests per §9; mutation-check the match rule, exemption, lock, re-check and no-write. (depends on 1.1)
- **1.3** Background sweep after boot: §6 rebuildLegacyRecords over install roots, sequential, logged; chained after the project install-recovery sweep in index.ts. (depends on 1.2)
- **2.1** Shared schema, installed?verify, MCP verify flag: §7: InstallIntegrity in shared, InstalledPackage.integrity, GET /installed and /installed/:name ?verify=true (concurrency 4), marketplace_list_installed verify. Tests. (depends on 1.1)
- **2.2** Prepare route, transport, CLI: §8: POST /packages/:name/prepare (name guard, marketplace.install gate, locateInstallRoot, five messages), prepareMarketplacePackage in Http/Direct transports and mock factory, dorkos marketplace prepare, installed --verify Files column. (depends on 1.2, 2.1)
- **2.3** Doctor deep check: §7 checkInstalledPackages in deep-health checks + run.ts source. (depends on 2.1)
- **2.4** Installed view and update confirm: §7 client: one verify query, changed row note with tooltip, legacy row + Prepare button, confirm-dialog sentence. Tests and screenshots. (depends on 2.1, 2.2)
- **3.1** Proof, docs, changelog: §10 proof on a copy of blintz's flow; contributing/marketplace-installs.md, docs/marketplace, CLI help, one changelog fragment; 04-implementation.md. (depends on 1.3, 2.4, 2.3)
