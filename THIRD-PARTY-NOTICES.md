# Third-party notices

DorkOS is MIT licensed (see `LICENSE`). This repository also carries code and text copied or adapted from the third-party projects below, each under its own licence. Their copyright and permission notices are reproduced here as those licences require.

Packages that ship this material keep their own notices file: `packages/cli/THIRD-PARTY-NOTICES.md` (the `dorkos` npm package) and `packages/doe/THIRD-PARTY-NOTICES.md` (the `@dorkos/doe` npm package).

## superpowers

- Upstream: https://github.com/obra/superpowers, version 5.0.6
- Licence: MIT, Copyright (c) 2025 Jesse Vincent
- Absorbed in March 2026 (commit `da1bc0c049`, spec `specs/absorb-superpowers-plugin/`). DorkOS has since edited these files; the upstream notice still applies to the parts that came from superpowers.

| DorkOS path                                                                                                                                                                          | Upstream path                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `.claude/skills/test-driven-development/SKILL.md`, `testing-anti-patterns.md`                                                                                                        | `skills/test-driven-development/SKILL.md`, `testing-anti-patterns.md`                    |
| `.agents/skills/verification-before-completion/SKILL.md`                                                                                                                             | `skills/verification-before-completion/SKILL.md`                                         |
| `.claude/skills/receiving-code-review/SKILL.md`                                                                                                                                      | `skills/receiving-code-review/SKILL.md`                                                  |
| `.claude/skills/requesting-code-review/SKILL.md`                                                                                                                                     | `skills/requesting-code-review/SKILL.md`                                                 |
| `.claude/agents/code-reviewer.md`                                                                                                                                                    | `agents/code-reviewer.md`, `skills/requesting-code-review/code-reviewer.md`              |
| `.agents/skills/visual-companion/SKILL.md`; `scripts/server.cjs`, `helper.js`, `frame-template.html`, `start-server.sh`, `stop-server.sh`                                            | `skills/brainstorming/visual-companion.md`; `skills/brainstorming/scripts/` (same names) |
| `.agents/skills/debugging-systematically/condition-based-waiting.md`, `defense-in-depth.md`, `root-cause-tracing.md`, `find-polluter.sh`, and "The 3-Fix Rule" section of `SKILL.md` | `skills/systematic-debugging/` (same names)                                              |

```
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## rulesync

- Upstream: https://github.com/dyoshikawa/rulesync, commit `b4bf09d5` (npm `rulesync@9.0.2`)
- Licence: MIT, Copyright (c) 2024 dyoshikawa
- DorkOS path: `packages/harness/src/vendor/rulesync-maps.ts`, which carries the full notice in its header. The maps are bundled into the `dorkos` npm package, so `packages/cli/THIRD-PARTY-NOTICES.md` repeats the notice.

## Pi (Earendil Works)

- Upstream: https://github.com/earendil-works/pi, version 1.0.4
- Licence: MIT, Copyright (c) 2025 Mario Zechner
- DorkOS path: `packages/doe/src/registry/bm25.ts`, extracted from `packages/coding-agent/src/extensions/tool-search/tool.ts`. Details and the permission notice are in `packages/doe/THIRD-PARTY-NOTICES.md`.

## Fonts

IBM Plex, under the SIL Open Font License 1.1, ships with the website. Its licence sits beside the font files in `apps/site/src/app/fonts/OFL.txt` and `apps/site/src/lib/og/fonts/OFL.txt`.
