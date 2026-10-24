/**
 * The command tripwire for web approvals of `Bash` (Claude Code) and `Shell`
 * (Codex): refuse a command whose text names a protected root or a
 * protected name (`protected-names.ts`).
 *
 * A root counts however it is spelled: as written, by its real path (when a
 * symlink leads to it), through `~`, `$HOME`, `${HOME}`, `%USERPROFILE%` or
 * `$XDG_CONFIG_HOME`, and any mention of `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`
 * or `$DORK_HOME`, which always name one. A root matches only as a whole
 * folder: followed by a separator, a quote, a shell break or the end, so
 * `~/.dork` does not match `~/.dorkos-notes`. Shell startup files, `.ssh` and
 * `.gitconfig` also count by bare name. A quote right before or after a
 * folder variable is dropped first, so `"$HOME"/.zshrc` reads as
 * `$HOME/.zshrc`. The git settings `core.hooksPath` and `core.fsmonitor`,
 * which make git run a program, are refused by name.
 *
 * This is a tripwire, not a parser. A command that hides the name still gets
 * through: a variable of its own, base64, a glob or brace (`.g?t`,
 * `.{git,x}`), or `cd` into a folder then a relative path. That stays the
 * accepted `Bash`/`Shell` residual named in `relay-approvable.ts`.
 *
 * It also fails closed the other way, on purpose: a command that only
 * mentions a name, such as `grep --exclude-dir=.git`, `find -not -path
 * './.git/*'`, `cat .github/workflows/ci.yml` or `git commit -m "ignore
 * .vscode"`, is refused too. The owner approves those at the computer.
 *
 * @module services/core/session-relay/web-approvable/command-tripwire
 */
import path from 'node:path';
import { realOrResolved, wordNamesProtected } from './protected-names.js';

/** Characters a shell treats as a break between words, for splitting command text. */
const WORD_BREAK = /[\s'"`;|&<>()=,:]+/;

/** What may follow a root for it to name that whole folder. */
const AFTER_ROOT = /[\s'"`;|&<>()=,:/\\]/;

/** A quote right before or after a folder variable, which a shell drops: `"$HOME"/.zshrc`. */
const QUOTED_ANCHOR =
  /["']?(~|\$home|\$\{home\}|%userprofile%|\$xdg_config_home|\$\{xdg_config_home\})["']?/gi;

/** Git settings that make git run a program, refused by name in any case. */
const GIT_RUN_KEYS = new Set(['core.hookspath', 'core.fsmonitor']);

/** Variables whose value is always a protected root, in `$X`, `${X}` or `%X%` form. */
const ROOT_VARIABLES = /(?:\$\{?|%)(?:claude_config_dir|codex_home|dork_home)(?![a-z0-9_])/i;

/** Home-folder files and folders that run later, refused by bare name in command text. */
const HOME_NAMES = new Set([
  '.gitconfig',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.ssh',
]);

/** What the command tripwire compares against. */
export interface CommandTripwireContext {
  /** The protected roots, as the caller resolved them. */
  protectedRoots: readonly string[];
  /** The home folder, for `~`, `$HOME` and `%USERPROFILE%` spellings; none when unknown. */
  homeDir: string | null;
  /** `$XDG_CONFIG_HOME` when set; `~/.config` stands in when it is not. */
  xdgConfigHome: string | null;
  /** Folds text for comparison: lower case where case is ignored, unchanged elsewhere. */
  fold: (text: string) => string;
}

/** Each prefix a command may write in place of a folder, with the folder it stands for. */
function anchors(context: CommandTripwireContext): Array<[string[], string]> {
  if (context.homeDir === null) return [];
  const home = context.homeDir;
  return [
    [['~/', '$HOME/', '${HOME}/', '%USERPROFILE%/', '%USERPROFILE%\\'], home],
    [
      ['$XDG_CONFIG_HOME/', '${XDG_CONFIG_HOME}/'],
      context.xdgConfigHome ?? path.join(home, '.config'),
    ],
  ];
}

/** Every way a command may spell one protected root, folded. */
function rootSpellings(root: string, context: CommandTripwireContext): string[] {
  const spellings = new Set<string>();
  for (const form of new Set([root, realOrResolved(root)])) {
    spellings.add(form);
    for (const [prefixes, folder] of anchors(context)) {
      const relative = path.relative(folder, form);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const tail = relative.split(path.sep).join('/');
      for (const prefix of prefixes) spellings.add(`${prefix}${tail}`);
    }
  }
  return [...spellings].map(context.fold);
}

/** Whether `text` holds `spelling` as a whole folder: followed by a break or the end. */
function holdsWhole(text: string, spelling: string): boolean {
  for (let at = text.indexOf(spelling); at !== -1; at = text.indexOf(spelling, at + 1)) {
    const next = text[at + spelling.length];
    if (next === undefined || AFTER_ROOT.test(next)) return true;
  }
  return false;
}

/**
 * Whether a command's text names a protected root or a protected name. A
 * tripwire, not a parser: see the module header for what it misses.
 *
 * @param command - The command text exactly as the card shows it.
 * @param context - The protected roots, the home folder and the case rule.
 * @returns True when the command should be decided at this computer.
 */
export function commandNamesProtected(command: string, context: CommandTripwireContext): boolean {
  const text = context.fold(command).replace(QUOTED_ANCHOR, '$1');
  if (ROOT_VARIABLES.test(text)) return true;
  const roots = context.protectedRoots.flatMap((root) => rootSpellings(root, context));
  if (roots.some((spelling) => holdsWhole(text, spelling))) return true;
  return text
    .split(WORD_BREAK)
    .map((word) => word.split(/[\\/]+/))
    .some(
      (parts) =>
        wordNamesProtected(parts) ||
        parts.some((part) => HOME_NAMES.has(part) || GIT_RUN_KEYS.has(part.toLowerCase()))
    );
}
