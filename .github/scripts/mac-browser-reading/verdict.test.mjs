import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { checkFlags, disabledFeatureFlags, EXPECTED_ROWS, verdict } from './verdict.mjs';

const stock = ['LensOverlay', 'MediaRouter'];
const all = () => EXPECTED_ROWS.map((id) => ({ id, pass: true }));

describe('flags', () => {
  test('one flag with the whole list and both features passes', () => {
    const args = '/x/chrome --a --disable-features=LensOverlay,MediaRouter,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable --b';
    assert.equal(checkFlags(args, stock).pass, true);
  });

  test('two flags fail, because Chromium honours only the last', () => {
    const args = '--disable-features=LensOverlay,MediaRouter --disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable';
    const result = checkFlags(args, stock);
    assert.equal(result.pass, false);
    assert.equal(result.count, 2);
  });

  test('a missing required feature fails and is named', () => {
    const result = checkFlags('--disable-features=LensOverlay,MediaRouter,HttpsUpgrades', stock);
    assert.equal(result.pass, false);
    assert.deepEqual(result.missing, ['HttpsFirstBalancedModeAutoEnable']);
  });

  test('a dropped Playwright feature fails', () => {
    const result = checkFlags('--disable-features=MediaRouter,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable', stock);
    assert.deepEqual(result.missing, ['LensOverlay']);
  });

  test('no flag at all fails', () => {
    assert.equal(checkFlags('/x/chrome --a', stock).pass, false);
  });

  test('an unread Playwright list fails rather than passing on nothing', () => {
    assert.equal(checkFlags('--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable', []).pass, false);
  });

  test('a similar flag is not counted', () => {
    assert.deepEqual(disabledFeatureFlags('--xdisable-features=A --disable-features=B'), [['B']]);
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
