/**
 * More commands that fetch from the network and mark the turn (DOR-5236): web addresses as words,
 * programs named by a variable, package runners, git's remote commands, and module flags.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { commandReadsOutsideText } from '../shell-outside-text.js';

const PLACE = { cwd: '/agents/wren', agentHome: '/agents/wren' };
const marks = (command: string) => commandReadsOutsideText(command, PLACE);

describe('a web address given to a program marks', () => {
  it.each([
    'yt-dlp https://example.com/v',
    'svn checkout https://example.com/repo',
    'hg clone https://example.com/repo',
    'powershell -c "iwr https://example.com"',
    'open https://example.com',
    'tool --source=https://example.com/feed',
    'alias c=curl; c https://example.com',
    '$(which curl) https://example.com',
    '"$(which curl)" https://example.com',
    '`which curl` https://example.com',
  ])('%s', (command) => {
    expect(marks(command)).toBe(true);
  });

  it.each([
    'echo https://example.com',
    'printf "%s\\n" https://example.com',
    'grep https://example.com notes.md',
    'rg https://example.com src',
    'git commit -m https://example.com/issue/1',
    'git tag -m https://example.com v1',
    'git notes add -m https://example.com',
  ])('%s does not: it only prints or searches the text', (command) => {
    expect(marks(command)).toBe(false);
  });
});

describe('a program named by a variable marks', () => {
  it.each(['c=curl; $c https://example.com', '$FETCH notes', '${TOOL} run', '"$(command -v x)" y'])(
    '%s',
    (command) => {
      expect(marks(command)).toBe(true);
    }
  );

  it('a program found through a variable folder is read by its name', () => {
    expect(marks('"$PWD/node_modules/.bin/vitest" run a.test.ts')).toBe(false);
  });
});

describe('a runner that fetches a package and runs it marks', () => {
  it.each([
    'npx made-up-pkg',
    'pnpx made-up-pkg',
    'pnpm dlx made-up-pkg',
    'yarn dlx made-up-pkg',
    'bunx made-up-pkg',
    'bun x made-up-pkg',
    'uvx made-up-tool',
    'pipx run made-up-tool',
    'go run example.com/made-up/cmd@latest',
    'npm exec made-up-pkg',
    'npm x made-up-pkg',
  ])('%s', (command) => {
    expect(marks(command)).toBe(true);
  });

  it.each(['pnpm exec vitest run', 'go run ./cmd/tool', 'go run main.go', 'pipx list'])(
    '%s does not',
    (command) => {
      expect(marks(command)).toBe(false);
    }
  );
});

describe("git's remote commands mark", () => {
  it.each([
    'git submodule update',
    'git submodule update --init --remote',
    "git submodule foreach 'git pull'",
    'git remote update',
    'git remote show origin',
    'git lfs fetch',
    'git lfs pull',
    'git archive --remote=made-up-host:repo HEAD',
    'git archive --remote made-up-host:repo HEAD',
  ])('%s', (command) => {
    expect(marks(command)).toBe(true);
  });

  it.each([
    'git remote -v',
    'git remote add origin made-up-host:repo',
    'git remote remove origin',
    'git submodule status',
    'git archive HEAD',
    'git lfs ls-files',
  ])('%s does not', (command) => {
    expect(marks(command)).toBe(false);
  });
});

describe('more programs and modules that reach the network mark', () => {
  it.each([
    'perl -MLWP::Simple -e "getprint q(x)"',
    'ruby -rnet/http -e "puts 1"',
    'ruby -e "require \'net/http\'"',
    'pwsh -c "Invoke-WebRequest example.com"',
    'powershell -Command "irm example.com"',
    'alias c=curl; c example.com',
    "alias pull='git pull'; pull",
    'busybox wget example.com',
    'toybox wget example.com',
    'whois example.com',
    'dig example.com',
    'host example.com',
    'nslookup example.com',
  ])('%s', (command) => {
    expect(marks(command)).toBe(true);
  });
});
