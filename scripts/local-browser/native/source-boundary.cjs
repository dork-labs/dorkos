/** Inert host-side structural checks; never executes inspected utility source. */
const assert = require('node:assert/strict');
module.exports.validateBoundary = function validateBoundary(ts, source, offset) {
  assert(source.length < 4 * 1024 * 1024, 'Utility source bound');
  const tree = ts.createSourceFile(
    'owned-utility.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  assert.equal(tree.parseDiagnostics.length, 0, 'Utility source must parse');
  const bindings = [];
  const calls = [];
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.some(
        (arg) => ts.isStringLiteral(arg) && arg.text === 'internal/modules/run_main'
      )
    ) {
      for (const entry of node.name.elements)
        if (
          (entry.propertyName ?? entry.name).getText(tree) === 'runEntryPointWithESMLoader' &&
          ts.isIdentifier(entry.name)
        )
          bindings.push({ name: entry.name.text, node });
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(bindings.length, 1, 'Require one recognizable builtin loader binding');
  const binding = bindings[0];
  const loaders = calls.filter(
    (call) =>
      ts.isIdentifier(call.expression) &&
      call.expression.text === binding.name &&
      call.getStart(tree) > binding.node.getStart(tree)
  );
  assert.equal(loaders.length, 1, 'Require one recognizable loader invocation');
  const loader = loaders[0];
  assert(
    loader.arguments.some((arg) => /\.import\s*\(/.test(arg.getText(tree))),
    'Require recognizable server module import callback'
  );
  assert(source.includes('_serviceStartupScript'), 'Expected Electron utility startup source');
  assert(
    offset >= 0 && offset < binding.node.getStart(tree) && offset < loader.getStart(tree),
    'Pause must precede loader binding and invocation'
  );
  // Offset order alone cannot establish execution order in webpack module functions.
  // Admit only a syntactic entry location: the first effectful top-level statement,
  // or the same location reached through zero-argument, zero-parameter immediate
  // function wrappers. Never descend into module-table function bodies.
  const entries = [];
  function unwrap(node) {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  }
  function entry(statements, depth) {
    assert(depth < 8, 'Entry wrapper depth bound');
    const first = statements.find(
      (statement) =>
        !(ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) &&
        !ts.isEmptyStatement(statement)
    );
    assert(first, 'Expected an executable entry statement');
    entries.push({ offset: first.getStart(tree), kind: ts.SyntaxKind[first.kind], depth });
    if (ts.isVariableStatement(first)) {
      const declaration = first.declarationList.declarations[0];
      if (declaration && ts.isIdentifier(declaration.name) && declaration.initializer)
        entries.push({
          offset: declaration.initializer.getStart(tree),
          kind: 'first-variable-initializer',
          depth,
        });
    }
    if (ts.isExpressionStatement(first)) {
      const expression = unwrap(first.expression);
      if (ts.isCallExpression(expression) && expression.arguments.length === 0) {
        const callee = unwrap(expression.expression);
        if (
          (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) &&
          callee.parameters.length === 0 &&
          !callee.asteriskToken &&
          !callee.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
          ts.isBlock(callee.body)
        )
          entry(callee.body.statements, depth + 1);
      }
    }
  }
  entry(tree.statements, 0);
  const accepted = entries.find((entry) => entry.offset === offset);
  assert(
    accepted,
    'Pause is not a structurally proven initial entry location; refuse ambiguous webpack offsets'
  );
  const token = ts.getTokenAtPosition(tree, offset);
  assert(
    token && token.getStart(tree) <= offset && token.getEnd() >= offset,
    'Paused location must identify a parsed token'
  );
  return {
    initialEntry: accepted,
    entryCandidates: entries,
    pausedToken: token.getText(tree),
    pausedTokenKind: ts.SyntaxKind[token.kind],
    loaderBindingOffset: binding.node.getStart(tree),
    loaderOffset: loader.getStart(tree),
    loaderStatement: loader.getText(tree).slice(0, 2048),
    sourceLength: source.length,
  };
};

/** Admit the first pause only; this helper never resumes or searches past it. */
module.exports.admitFirstPause = function admitFirstPause(
  paused,
  parsed,
  breakpoint,
  resolvedEvents
) {
  const frame = paused?.params?.callFrames?.[0];
  assert(frame?.location, 'First pause requires an actual top call frame');
  assert.equal(
    parsed?.params?.scriptId,
    frame.location.scriptId,
    'Paused and parsed script identity must match'
  );
  assert.equal(
    parsed.params.url,
    'node:electron/js2c/utility_init',
    'First pause must be the exact utility builtin'
  );
  assert(
    typeof breakpoint?.breakpointId === 'string' && breakpoint.breakpointId.length > 0,
    'Owned breakpoint identity required'
  );
  const ids = paused.params.hitBreakpoints;
  assert(Array.isArray(ids), 'Breakpoint IDs must be an explicit array');
  assert(
    ids.length === 0 || ids.includes(breakpoint.breakpointId),
    'Nonempty hit IDs must include owned pending breakpoint'
  );
  const same = (location) =>
    location?.scriptId === frame.location.scriptId &&
    location.lineNumber === frame.location.lineNumber &&
    location.columnNumber === frame.location.columnNumber;
  const event = resolvedEvents.find(
    (value) =>
      value.method === 'Debugger.breakpointResolved' &&
      value.params.breakpointId === breakpoint.breakpointId &&
      same(value.params.location)
  );
  const initial = breakpoint.locations?.find(same);
  assert(event || initial, 'First pause must match actual owned resolved breakpoint location');
  return {
    frame,
    resolved: event?.params ?? { breakpointId: breakpoint.breakpointId, location: initial },
    scheduledEmptyHitIds: ids.length === 0,
  };
};

/** One Node ESM startup pause may be resumed only after the pre-import guard. */
module.exports.admitPostGuardPause = function admitPostGuardPause(paused, events, expected) {
  assert.equal(expected.guardAttested, true, 'Post-guard pause requires attestation');
  assert.equal(expected.handled, 0, 'Repeated startup pause refused');
  assert.equal(paused?.params?.reason, 'Break on start', 'Unknown startup pause reason');
  const ids = paused.params.hitBreakpoints;
  assert(Array.isArray(ids) && ids.length === 0, 'Startup pause must have explicit empty hit IDs');
  const frame = paused.params.callFrames?.[0];
  assert(frame?.location && frame.callFrameId, 'Actual startup call frame required');
  const script = events.find(
    (event) =>
      event.method === 'Debugger.scriptParsed' && event.params.scriptId === frame.location.scriptId
  )?.params;
  assert.equal(
    script?.url,
    expected.expectedUrl,
    'Startup module must be the exact owned Playwright entry'
  );
  assert.equal(script.isModule, true);
  assert.equal(script.executionContextId, expected.executionContextId, 'Startup context changed');
  assert.equal(frame.location.lineNumber, 0);
  assert.equal(frame.location.columnNumber, 0);
  const parent = paused.params.callFrames?.[1];
  assert.equal(parent?.functionName, '#asyncInstantiate', 'Pinned ESM startup ancestry required');
  const parentScript = events.find(
    (event) =>
      event.method === 'Debugger.scriptParsed' && event.params.scriptId === parent.location.scriptId
  )?.params;
  assert.equal(parentScript?.url, 'node:internal/modules/esm/module_job');
  assert.equal(parentScript.executionContextId, expected.executionContextId);
  return { frame, script, parent, parentScript };
};

module.exports.validateLiveGuard = function validateLiveGuard(actual, expected) {
  assert(actual && typeof actual === 'object', 'Live guard witness required');
  for (const name of ['pid', 'execPath', 'home', 'canonicalData', 'homeEnv', 'codexEnv']) {
    assert.equal(actual[name], expected[name], 'Live guard identity changed: ' + name);
  }
  assert.deepEqual(actual.guard, expected.guard, 'Live guard attestation changed');
  assert.deepEqual(actual.tests, { guardSelfTests: 3, identitiesUnchanged: true });
  return true;
};

/** Final custody is authoritative even when the body finished successfully. */
module.exports.settleProbeReceipt = function settleProbeReceipt(receipt) {
  if (receipt.finalFence?.failed || !receipt.finalFence?.guardAttested || receipt.forkFenceError) {
    receipt.status = 'failed';
  }
  return receipt.status;
};
