import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustody } from '../build-custody.mjs';
test('guardian compile-only builds distinct pinned images without executing produced tools', () => {
  const commands = [],
    removed = [];
  const receipt = buildCustody({
    platform: 'darwin',
    temporary: () => '/private/fixture/build',
    chmod: () => {},
    write: () => {},
    remove: (path) => removed.push(path),
    read: (path) => Buffer.from('dummy build bytes ' + path),
    command: (tool, args) => {
      commands.push({ tool, args });
      assert.ok(
        ['/usr/bin/xcrun', '/fixture/clang'].includes(tool),
        'no produced helper/probe/runner may be executed'
      );
      if (args.includes('--find')) return '/fixture/clang';
      if (args.includes('--show-sdk-path')) return '/fixture/sdk';
      return 'fixture-tool';
    },
  });
  assert.equal(receipt.build, 'COMPILED_LINKED_NOT_EXECUTED');
  assert.equal(receipt.nativeSubjects, 0);
  assert.equal(receipt.helperExecutions, 0);
  assert.equal(receipt.runtimeExports, 'UNVERIFIED');
  assert.equal(
    receipt.manifest.assets['fixture-a'].sha256 === receipt.manifest.assets['fixture-b'].sha256,
    false
  );
  assert.ok(commands.some((c) => c.args.includes('-DDORK_FIXTURE_IMAGE=2')));
  assert.ok(
    commands
      .filter((c) => c.tool === '/fixture/clang' && !c.args.includes('--version'))
      .every((c) => c.args.includes('-isysroot'))
  );
  for (const source of ['guardian-custody.c', 'guardian-tree.c', 'tree-fixture.c']) {
    assert.ok(receipt.source[source], 'MISSING_SOURCE_CORRESPONDENCE_' + source);
    assert.ok(
      commands.some(
        (c) => c.args.includes('-c') && c.args.some((arg) => arg.endsWith('/' + source))
      ),
      'MISSING_COMPILE_COMMAND_' + source
    );
  }
  const guardianLink = commands.find((c) => c.args.at(-1) === '/private/fixture/build/guardian');
  assert.ok(
    guardianLink.args.includes('/private/fixture/build/guardian-custody.c.o'),
    'MISSING_CUSTODY_LINK_OBJECT'
  );
  assert.ok(
    guardianLink.args.includes('/private/fixture/build/guardian-tree.c.o'),
    'MISSING_TREE_LINK_OBJECT'
  );
  assert.deepEqual(removed, ['/private/fixture/build']);
});
test('compile failure preserves primary and still removes owned temporary build root', () => {
  let removed = 0;
  const receipt = buildCustody({
    platform: 'darwin',
    temporary: () => '/fixture/build',
    chmod: () => {},
    read: () => Buffer.from('source'),
    remove: () => {
      removed++;
    },
    command: (_tool, args) => {
      if (args.includes('-c')) throw Error('INTENDED_COMPILER_FAULT');
      return args.includes('--find') ? '/fixture/clang' : '/fixture/sdk';
    },
  });
  assert.equal(receipt.reason, 'BUILD_UNVERIFIED');
  assert.equal(receipt.diagnostic, 'INTENDED_COMPILER_FAULT');
  assert.equal(removed, 1);
  assert.equal(receipt.identityQueries, 0);
});
