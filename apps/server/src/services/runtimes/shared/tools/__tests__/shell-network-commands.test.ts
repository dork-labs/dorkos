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

describe('more ways a command reaches the network mark', () => {
  it.each([
    'exec 3<>/dev/tcp/example.com/80',
    'cat < /dev/tcp/example.com/80',
    'echo hi > /dev/udp/example.com/53',
    `php -r '$u = "https:" . "//example.com"; echo file_get_contents($u);'`,
    `php -r '$s = fsockopen($argv[1], 80);' example.com`,
    'openssl s_client -connect example.com:443',
    'openssl s_time -connect example.com:443',
    'yt-dlp -a list.txt',
    'youtube-dl ytsearch:made-up',
    `osascript -e 'do shell script "curl example.com"'`,
    `osascript -e 'do shell script "gh issue list"'`,
    `osascript -e 'do shell script cmd'`,
    `osascript -e 'open location "https://example.com"'`,
    'python3 -m http.client',
    'python3 -m urllib.request example.com',
    'python3 -murllib.request example.com',
    'xargs -a urls.txt curl',
    'xargs --arg-file=urls.txt wget',
    'xargs -0 -a urls.txt -n 1 curl -s',
    "cat > notes.md <<'EOF'\nhi\nEOF\ngh issue list",
  ])('%s', (command) => {
    expect(marks(command)).toBe(true);
  });

  it.each([
    'openssl rand -hex 16',
    'openssl x509 -in cert.pem -noout -text',
    `osascript -e 'display notification "done"'`,
    `osascript -e 'do shell script "ls"'`,
    'python3 -m pytest',
    'python3 -m json.tool data.json',
    'xargs -a files.txt wc -l',
    'cat /dev/null',
  ])('%s does not', (command) => {
    expect(marks(command)).toBe(false);
  });
});
