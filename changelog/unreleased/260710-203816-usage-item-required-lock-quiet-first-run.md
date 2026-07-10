### Fixed

- The usage item in the status bar now actually shows your Claude subscription usage. It updates at the end of every reply with how much of your rate-limit window you've used and when it resets. Before, it stayed empty unless you were about to hit a limit (DOR-99)
- The Marketplace card in Settings → Extensions now says "Required" instead of showing an on/off switch that did nothing. If you flipped that dead switch in the past, Marketplace turns itself back on (DOR-122)
- A brand-new install no longer prints a scary "initial scan failed" warning at startup. Having no Claude Code sessions yet is normal, and the log now treats it that way (DOR-247)
