/**
 * Load an isolated extension's compiled server bundle with an injected
 * `require` (DOR-2686, spec §4 step 4).
 *
 * The compiler bundles everything an extension imports except `express` and
 * `@dorkos/extension-api` (`extension-compiler.ts` marks them external, and
 * the in-process host provides them). Here the bootstrap provides its own
 * bundled copies of those, the `child_process` shim in place of the real
 * module, and Node's built-in modules as they are. Anything else is refused:
 * a bundle is self-contained by construction, so a request for another
 * package is a bundle that would not work anyway, and refusing it keeps the
 * child from loading files it was never meant to.
 *
 * @module services/extensions/isolation/child/load-bundle
 */
import fs from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { bundleDependencyRefusal } from '../ipc-protocol.js';

/** Modules the bootstrap provides by name, resolved lazily on first use. */
export type ProvidedModules = Record<string, () => unknown>;

/**
 * Build the `require` a bundle sees.
 *
 * @param provided - Modules provided by name (express, the extension API, the shim).
 * @param fromFile - A file to resolve built-ins relative to (the bootstrap).
 */
export function createInjectedRequire(
  provided: ProvidedModules,
  fromFile: string
): (name: string) => unknown {
  const nodeRequire = createRequire(fromFile);
  const cache = new Map<string, unknown>();
  return (name: string) => {
    if (typeof name !== 'string') throw new TypeError('require() takes a module name.');
    const provide = Object.prototype.hasOwnProperty.call(provided, name)
      ? provided[name]
      : undefined;
    if (provide) {
      if (!cache.has(name)) cache.set(name, provide());
      return cache.get(name);
    }
    if (isBuiltin(name)) return nodeRequire(name);
    throw Object.assign(new Error(bundleDependencyRefusal(name)), {
      code: 'ERR_EXTENSION_BUNDLE_DEPENDENCY',
    });
  };
}

/**
 * Evaluate a CommonJS bundle with the injected `require` and return its
 * exports. The real file name is kept, so stack traces (and the inline source
 * maps the compiler emits) point at the extension's own code.
 *
 * @param bundlePath - The compiled bundle.
 * @param injectedRequire - From {@link createInjectedRequire}.
 * @returns The bundle's `module.exports`.
 */
export function loadBundle(
  bundlePath: string,
  injectedRequire: (name: string) => unknown
): unknown {
  const code = fs.readFileSync(bundlePath, 'utf8');
  const fn = vm.compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], {
    filename: bundlePath,
  });
  const mod: { exports: unknown } = { exports: {} };
  fn.call(mod.exports, mod.exports, injectedRequire, mod, bundlePath, path.dirname(bundlePath));
  return mod.exports;
}
