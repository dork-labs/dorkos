/** Validate two separately owned handles for the same current generation. */
export function createRunAuthority() {
  const issued = new WeakMap();
  let generation = 0;
  let currentMain;
  const issue = (role, signal, main) => {
    const token = Object.freeze({});
    issued.set(token, { role, signal, main, generation });
    return token;
  };
  const requireHandle = (token, role) => {
    const record = issued.get(token);
    if (record?.role !== role || record.generation !== generation || record.signal.aborted)
      throw new Error('Invalid or expired custody lifeline');
    return record;
  };

  const scopeRecord = (main, scope) => {
    const worker = requireHandle(scope, 'scope');
    if (worker.main !== main) throw new Error('Custody scope belongs to a different run');
    return worker;
  };

  return {
    openMain(signal) {
      if (currentMain && !issued.get(currentMain).signal.aborted)
        throw new Error('Custody run main is already open');
      generation++;
      currentMain = issue('main', signal);
      return currentMain;
    },
    openScope(main, signal) {
      const owner = requireHandle(main, 'main');
      if (owner.signal === signal) throw new Error('Custody lifelines must close independently');
      return issue('scope', signal, main);
    },
    signals(main, scope) {
      const owner = requireHandle(main, 'main');
      return [owner.signal, scopeRecord(main, scope).signal];
    },
    acquireScope(main, scope) {
      requireHandle(main, 'main');
      const worker = scopeRecord(main, scope);
      if (worker.state === 'uncertain') throw new Error('Custody scope has unconfirmed cleanup');
      if (worker.state) throw new Error('Custody scope already has an outstanding launch');
      const lease = {};
      worker.state = lease;
      return (uncertain) => {
        if (worker.state === lease) worker.state = uncertain ? 'uncertain' : undefined;
      };
    },
  };
}
