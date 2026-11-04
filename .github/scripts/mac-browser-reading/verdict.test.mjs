import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  checkAgentFlags,
  checkPlainFlags,
  disabledFeatureFlags,
  EXPECTED_ROWS,
  verdict,
} from './verdict.mjs';

const stock = ['LensOverlay', 'MediaRouter'];
const KEYCHAIN = '--use-mock-keychain --password-store=basic';
const all = () => EXPECTED_ROWS.map((id) => ({ id, pass: true }));

describe('agent window flags', () => {
  test('one flag with the whole list and both features passes', () => {
    const args = `/x/chrome ${KEYCHAIN} --a --disable-features=LensOverlay,MediaRouter,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable --b`;
    assert.equal(checkAgentFlags(args, stock).pass, true);
  });

  test('two flags fail, because Chromium honours only the last', () => {
    const args =
      '--disable-features=LensOverlay,MediaRouter --disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable';
    const result = checkAgentFlags(args, stock);
    assert.equal(result.pass, false);
    assert.equal(result.count, 2);
  });

  test('a missing required feature fails and is named', () => {
    const result = checkAgentFlags(
      '--disable-features=LensOverlay,MediaRouter,HttpsUpgrades',
      stock
    );
    assert.equal(result.pass, false);
    assert.deepEqual(result.missing, ['HttpsFirstBalancedModeAutoEnable']);
  });

  test('a dropped Playwright feature fails', () => {
    const result = checkAgentFlags(
      '--disable-features=MediaRouter,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
      stock
    );
    assert.deepEqual(result.missing, ['LensOverlay']);
  });

  test('no flag at all fails', () => {
    assert.equal(checkAgentFlags('/x/chrome --a', stock).pass, false);
  });

  test('an unread Playwright list fails rather than passing on nothing', () => {
    assert.equal(
      checkAgentFlags('--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable', []).pass,
      false
    );
  });

  test('a similar flag is not counted', () => {
    assert.deepEqual(disabledFeatureFlags('--xdisable-features=A --disable-features=B'), [['B']]);
  });
});

describe('plain window flags', () => {
  test('one flag with both features passes, with no Playwright list', () => {
    assert.equal(
      checkPlainFlags(
        `/x/chrome ${KEYCHAIN} --a --disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable --b`
      ).pass,
      true
    );
  });

  test('one feature of the two fails and names the other', () => {
    const result = checkPlainFlags('--disable-features=HttpsUpgrades');
    assert.equal(result.pass, false);
    assert.deepEqual(result.missing, ['HttpsFirstBalancedModeAutoEnable']);
  });

  test('two flags fail, because Chromium honours only the last', () => {
    assert.equal(
      checkPlainFlags(
        '--disable-features=HttpsUpgrades --disable-features=HttpsFirstBalancedModeAutoEnable'
      ).pass,
      false
    );
  });

  test('no flag fails', () => {
    assert.equal(checkPlainFlags('/x/chrome --a').pass, false);
  });

  test("the same line would fail for the agent window, which must keep Playwright's list", () => {
    const line = `${KEYCHAIN} --disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable`;
    assert.equal(checkPlainFlags(line).pass, true);
    assert.equal(checkAgentFlags(line, ['LensOverlay']).pass, false);
  });
});

describe('keychain switches', () => {
  const features =
    '--disable-features=LensOverlay,MediaRouter,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable';

  test('dropping --use-mock-keychain fails both windows and names it', () => {
    const line = `--password-store=basic ${features}`;
    assert.deepEqual(checkAgentFlags(line, stock).missingSwitches, ['--use-mock-keychain']);
    assert.equal(checkPlainFlags(line).pass, false);
  });

  test('dropping --password-store=basic fails both windows and names it', () => {
    const line = `--use-mock-keychain ${features}`;
    assert.deepEqual(checkPlainFlags(line).missingSwitches, ['--password-store=basic']);
    assert.equal(checkAgentFlags(line, stock).pass, false);
  });

  test('another password store fails', () => {
    assert.equal(
      checkPlainFlags(`--use-mock-keychain --password-store=keychain ${features}`).pass,
      false
    );
  });
});

describe('verdict', () => {
  test('every row passed is green', () => {
    assert.equal(verdict(all()).pass, true);
  });

  test('a skipped row is red', () => {
    const result = verdict(all().slice(1));
    assert.equal(result.pass, false);
    assert.deepEqual(result.skipped, [EXPECTED_ROWS[0]]);
  });

  test('no rows at all is red', () => {
    assert.equal(verdict([]).pass, false);
  });

  test('a failed row is red', () => {
    const rows = all();
    rows[2].pass = false;
    assert.deepEqual(verdict(rows).failed, [EXPECTED_ROWS[2]]);
  });

  test('a truthy non-boolean is not a pass', () => {
    const rows = all();
    rows[0].pass = 'yes';
    assert.equal(verdict(rows).pass, false);
  });

  test('a crash is red even with every row passed', () => {
    assert.equal(verdict(all(), 'boom').pass, false);
  });

  test('a row nobody expects is red, so the list stays honest', () => {
    assert.equal(verdict([...all(), { id: 'new', pass: true }]).pass, false);
  });
});
