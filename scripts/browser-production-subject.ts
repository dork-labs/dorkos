import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

// Both parsers are existing pinned build dependencies, never runtime authority.
const { parse: parseYaml } = createRequire(
  new URL('../apps/desktop/package.json', import.meta.url)
)('yaml') as { parse(text: string): unknown };
const CATALOGUE = 'apps/server/src/services/browser/runtime/admission/accepted-catalogue.ts';
export const BROWSER_SUBJECT_ROOTS = [
  'packages/browser/src',
  'apps/server/src/services/browser',
  'apps/client/src/layers/features/managed-browser',
  'apps/client/src/layers/shared/lib/browser-frame',
  'apps/client/src/layers/widgets/browser',
] as const;
export const BROWSER_SUBJECT_ENTRIES = [
  'apps/client/src/layers/features/settings/ui/ExperimentsTab.tsx',
  'apps/client/src/layers/shared/lib/transport/http-transport.ts',
  'apps/server/src/services/core/config-manager.ts',
  'apps/server/src/services/core/auth/index.ts',
  'apps/server/src/middleware/browser-origin.ts',
  'apps/server/src/middleware/host-guard.ts',
  'apps/server/src/middleware/mcp-auth.ts',
  'apps/desktop/src/main/server-process.ts',
  'apps/desktop/src/main/browser-qualification/bootstrap.ts',
  'packages/shared/src/browser-desktop-qualification.ts',
  'apps/desktop/scripts/restore-browser-library.ts',
  'packages/shared/src/browser-schemas.ts',
  'packages/shared/src/config-schema.ts',
  'packages/shared/src/transport.ts',
  'packages/browser/scripts/build-native-observer.ts',
] as const;
// Composition/build roots bind the wiring itself, not every independent domain
// imported by the application's composition root. Their browser callees are
// explicit seeds above, and their ordinary imported dependencies are followed.
export const BROWSER_SUBJECT_WIRING = [
  'apps/server/src/index.ts',
  'apps/desktop/src/main/index.ts',
  'apps/desktop/src/server-entry.ts',
  'apps/desktop/src/preload/index.ts',
  'apps/client/src/router.tsx',
  'apps/client/src/main.tsx',
  'apps/client/vite.config.ts',
  'apps/desktop/electron.vite.config.ts',
  'apps/desktop/electron-builder.yml',
  'apps/desktop/scripts/browser-packaging.ts',
  'apps/desktop/scripts/build-server.ts',
  'packages/cli/scripts/build.ts',
  'scripts/browser-production-subject.ts',
] as const;
interface Package {
  dir: string;
  name: string;
  exports?: Record<string, unknown>;
}
interface Lock {
  importers: Record<string, Record<string, Record<string, { specifier: string; version: string }>>>;
  packages: Record<string, unknown>;
  snapshots: Record<
    string,
    { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  >;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('BROWSER_SUBJECT_VALUE_UNAVAILABLE');
  return serialized;
}
function sourceExport(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  const row = entry as Record<string, unknown>;
  if (typeof row.types === 'string' && row.types.endsWith('.d.ts'))
    return typeof row.default === 'string' && /^\.\/dist\/.+\.js$/u.test(row.default)
      ? row.default.replace('./dist/', './src/').replace(/\.js$/u, '.ts')
      : undefined;
  const source = row.types ?? row.default;
  return typeof source === 'string' ? source : undefined;
}
const excluded = (path: string) => /(?:^|\/)__tests__(?:\/|$)|\.(?:test|fixture)\./u.test(path);

/** Catalogue records are literal data. Reject executable additions before removing only their array from the subject. */
function catalogueSubject(bytes: Buffer): Buffer {
  const source = ts.createSourceFile(
    CATALOGUE,
    bytes.toString('utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const refuse = (): never => {
    throw new Error('BROWSER_SUBJECT_CATALOGUE_EXECUTABLE');
  };
  if (
    ts
      .transpileModule(bytes.toString('utf8'), { reportDiagnostics: true })
      .diagnostics?.some((row) => row.category === ts.DiagnosticCategory.Error) ||
    source.statements.length !== 2
  )
    return refuse();
  const [imported, statement] = source.statements;
  if (
    !imported ||
    !ts.isImportDeclaration(imported) ||
    !ts.isStringLiteral(imported.moduleSpecifier) ||
    imported.moduleSpecifier.text !== './accepted-mode.js' ||
    !imported.importClause?.isTypeOnly ||
    imported.importClause.name ||
    imported.attributes
  )
    return refuse();
  const bindings = imported.importClause.namedBindings;
  const binding = bindings && ts.isNamedImports(bindings) ? bindings.elements[0] : undefined;
  if (
    !binding ||
    !bindings ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.length !== 1 ||
    binding.name.text !== 'AcceptedBrowserMode' ||
    binding.propertyName
  )
    return refuse();
  if (
    !statement ||
    !ts.isVariableStatement(statement) ||
    statement.modifiers?.length !== 1 ||
    statement.modifiers[0]?.kind !== ts.SyntaxKind.ExportKeyword ||
    statement.declarationList.flags !== ts.NodeFlags.Const ||
    statement.declarationList.declarations.length !== 1
  )
    return refuse();
  const declaration = statement.declarationList.declarations[0];
  const printer = ts.createPrinter({ removeComments: true });
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== 'acceptedBrowserModes' ||
    declaration.exclamationToken ||
    !declaration.type ||
    printer.printNode(ts.EmitHint.Unspecified, declaration.type, source) !==
      'readonly AcceptedBrowserMode[]'
  )
    return refuse();
  const initializer = declaration.initializer;
  if (
    !initializer ||
    !ts.isCallExpression(initializer) ||
    initializer.typeArguments ||
    !ts.isPropertyAccessExpression(initializer.expression) ||
    !ts.isIdentifier(initializer.expression.expression) ||
    initializer.expression.expression.text !== 'Object' ||
    initializer.expression.name.text !== 'freeze' ||
    initializer.arguments.length !== 1 ||
    !initializer.arguments[0] ||
    !ts.isArrayLiteralExpression(initializer.arguments[0])
  )
    return refuse();
  const data = (node: ts.Expression): void => {
    if (
      ts.isStringLiteral(node) ||
      (ts.isNumericLiteral(node) && Number.isFinite(Number(node.text))) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    )
      return;
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand) &&
      Number.isFinite(Number(node.operand.text))
    )
      return;
    if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) data(item);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set<string>();
      for (const item of node.properties) {
        if (
          !ts.isPropertyAssignment(item) ||
          !(ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))
        )
          return refuse();
        const key = item.name.text;
        if (key === '__proto__' || names.has(key)) return refuse();
        names.add(key);
        data(item.initializer);
      }
      return;
    }
    return refuse();
  };
  data(initializer.arguments[0]);
  const call = ts.factory.updateCallExpression(initializer, initializer.expression, undefined, [
    ts.factory.createArrayLiteralExpression(),
  ]);
  const normalized = ts.factory.updateVariableDeclaration(
    declaration,
    declaration.name,
    undefined,
    declaration.type,
    call
  );
  const variables = ts.factory.updateVariableDeclarationList(statement.declarationList, [
    normalized,
  ]);
  const exported = ts.factory.updateVariableStatement(statement, statement.modifiers, variables);
  return Buffer.from(printer.printFile(ts.factory.updateSourceFile(source, [imported, exported])));
}

/** Actual production import closure and selected lock identities; no catalogue self-hash. */
export async function browserProductionInputs(root: string): Promise<ReadonlyMap<string, Buffer>> {
  const inputs = new Map<string, Buffer>();
  const packages = new Map<string, Package>();
  for (const group of ['apps', 'packages'])
    for (const row of await readdir(join(root, group), { withFileTypes: true })) {
      if (!row.isDirectory()) continue;
      const dir = group + '/' + row.name;
      let bytes: string;
      try {
        bytes = await readFile(join(root, dir, 'package.json'), 'utf8');
      } catch (value) {
        if (value instanceof Error && 'code' in value && value.code === 'ENOENT') continue;
        throw value;
      }
      const pkg = JSON.parse(bytes) as Package;
      if (pkg.name) packages.set(pkg.name, { ...pkg, dir });
    }
  const lock = parseYaml(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')) as Lock;
  if (!lock || !lock.importers || !lock.packages || !lock.snapshots)
    throw new Error('BROWSER_SUBJECT_LOCK_UNAVAILABLE');
  const selected = new Set<string>();
  const dependency = (name: string, version: string): void => {
    if (version.startsWith('link:') || version.startsWith('workspace:')) return;
    if (version.startsWith('npm:')) {
      const alias = version.slice(4),
        split = alias.lastIndexOf('@');
      if (split <= 0) throw new Error('BROWSER_SUBJECT_DEPENDENCY_UNAVAILABLE');
      name = alias.slice(0, split);
      version = alias.slice(split + 1);
    }
    const key = name + '@' + version;
    if (selected.has(key)) return;
    selected.add(key);
    const base = name + '@' + version.split('(')[0];
    const record = lock.packages[base],
      snapshot = lock.snapshots[key];
    if (!record || !snapshot) throw new Error('BROWSER_SUBJECT_DEPENDENCY_UNAVAILABLE');
    inputs.set('lock/' + key, Buffer.from(canonical({ package: record, snapshot })));
    for (const [child, resolvedVersion] of Object.entries({
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    }))
      dependency(child, resolvedVersion);
  };
  const external = (path: string, specifier: string) => {
    if (isBuiltin(specifier)) return;
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (!name) throw new Error('BROWSER_SUBJECT_IMPORT_UNAVAILABLE:' + path);
    const owner = [...packages.values()].find((pkg) => path.startsWith(pkg.dir + '/'));
    const importer = owner?.dir ?? '.';
    const declared = (importer: string) => {
      const groups = lock.importers[importer];
      return (
        groups?.dependencies?.[name] ??
        groups?.optionalDependencies?.[name] ??
        groups?.devDependencies?.[name]
      );
    };
    let selectedImporter = importer;
    let row = declared(importer);
    if (!row && importer !== '.') {
      const ancestor = declared('.');
      if (ancestor) {
        // Match the actual Node ancestor resolution, not an arbitrary lock row with the same name.
        const original = createRequire(join(root, path)).resolve(specifier);
        const rootOriginal = createRequire(join(root, 'package.json')).resolve(specifier);
        if (original !== rootOriginal)
          throw new Error('BROWSER_SUBJECT_IMPORT_IDENTITY_MISMATCH:' + importer + ':' + name);
        row = ancestor;
        selectedImporter = '.';
      }
    }
    if (!row) throw new Error('BROWSER_SUBJECT_IMPORT_UNAVAILABLE:' + importer + ':' + name);
    inputs.set('import/' + selectedImporter + '/' + name, Buffer.from(canonical(row)));
    dependency(name, row.version);
  };
  const file = async (path: string): Promise<string> => {
    const normalized = relative(root, resolve(root, path)).split(sep).join('/');
    if (normalized.startsWith('../') || normalized === '..')
      throw new Error('BROWSER_SUBJECT_PATH_UNAVAILABLE');
    const stem = normalized.replace(/\.(?:js|jsx)$/u, '');
    const candidates = /\.(?:js|jsx)$/u.test(normalized)
      ? [stem + '.ts', stem + '.tsx', normalized]
      : normalized.endsWith('.ts')
        ? [normalized, normalized.slice(0, -3) + '.tsx']
        : [
            normalized,
            normalized + '.ts',
            normalized + '.tsx',
            normalized + '/index.ts',
            normalized + '/index.tsx',
          ];
    for (const candidate of candidates) {
      try {
        if ((await stat(join(root, candidate))).isFile()) return candidate;
      } catch (value) {
        if (!(value instanceof Error && 'code' in value && value.code === 'ENOENT')) throw value;
      }
    }
    throw new Error('BROWSER_SUBJECT_SOURCE_UNAVAILABLE:' + normalized);
  };
  const visited = new Map<string, Set<string>>();
  const follow = async (
    path: string,
    traverse = true,
    demanded: readonly string[] = ['*']
  ): Promise<void> => {
    path = await file(path);
    if (excluded(path)) return;
    const previous = visited.get(path);
    if (previous?.has('*') || (previous && demanded.every((name) => previous.has(name)))) return;
    const names = new Set([...(previous ?? []), ...demanded]);
    visited.set(path, names);
    const bytes = await readFile(join(root, path));
    inputs.set(path, path === CATALOGUE ? catalogueSubject(bytes) : bytes);
    if (!traverse || !/\.[cm]?[jt]sx?$/u.test(path)) return;
    const source = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    const imports = new Map<string, Set<string>>();
    const add = (specifier: string, requested: string[]) => {
      const old = imports.get(specifier) ?? new Set<string>();
      for (const name of requested) old.add(name);
      imports.set(specifier, old);
    };
    const visit = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const clause = node.importClause,
          bindings = clause?.namedBindings;
        const requested =
          !clause || (bindings && ts.isNamespaceImport(bindings))
            ? ['*']
            : [
                ...(clause.name ? ['default'] : []),
                ...(bindings && ts.isNamedImports(bindings)
                  ? bindings.elements
                      .filter((row) => !row.isTypeOnly)
                      .map((row) => (row.propertyName ?? row.name).text)
                  : []),
              ];
        if (requested.length) add(node.moduleSpecifier.text, requested);
      } else if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const requested = !node.exportClause
          ? [...names]
          : ts.isNamespaceExport(node.exportClause)
            ? names.has('*') || names.has(node.exportClause.name.text)
              ? ['*']
              : []
            : node.exportClause.elements
                .filter((row) => !row.isTypeOnly && (names.has('*') || names.has(row.name.text)))
                .map((row) => (row.propertyName ?? row.name).text);
        if (requested.length) add(node.moduleSpecifier.text, requested);
      } else if (
        ts.isCallExpression(node) &&
        node.arguments.length >= 1 &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        add(node.arguments[0].text, ['*']);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const [specifier, requested] of imports) {
      if (specifier.startsWith('.'))
        await follow(join(dirname(path), specifier), true, [...requested]);
      else if (specifier.startsWith('@/'))
        await follow('apps/client/src/' + specifier.slice(2), true, [...requested]);
      else {
        const parts = specifier.split('/'),
          name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (!name) throw new Error('BROWSER_SUBJECT_IMPORT_UNAVAILABLE:' + path);
        const pkg = packages.get(name);
        if (pkg) {
          // Server composition is deliberately bound as wiring, not followed.
          if (name === '@dorkos/server') {
            await follow('apps/server/src/index.ts', false);
            continue;
          }
          const key =
            parts.length > (specifier.startsWith('@') ? 2 : 1)
              ? './' + parts.slice(specifier.startsWith('@') ? 2 : 1).join('/')
              : '.';
          const target = sourceExport(pkg.exports?.[key]);
          if (!target) throw new Error('BROWSER_SUBJECT_EXPORT_UNAVAILABLE:' + specifier);
          inputs.set('export/' + name + '/' + key, Buffer.from(canonical(pkg.exports?.[key])));
          await follow(join(pkg.dir, target), true, [...requested]);
        } else external(path, specifier);
      }
    }
  };
  const collect = async (path: string): Promise<void> => {
    for (const row of await readdir(join(root, path), { withFileTypes: true })) {
      const child = path + '/' + row.name;
      if (excluded(child)) continue;
      if (row.isDirectory()) await collect(child);
      else if (row.isFile() && /\.(?:ts|tsx|c|h)$/u.test(row.name)) await follow(child);
    }
  };
  for (const path of BROWSER_SUBJECT_ROOTS) await collect(path);
  // The real DB migrator reads these data files dynamically at startup. Its
  // generator snapshots are not runtime inputs and are deliberately excluded.
  for (const row of await readdir(join(root, 'packages/db/drizzle'), { withFileTypes: true }))
    if (row.isFile() && row.name.endsWith('.sql'))
      await follow('packages/db/drizzle/' + row.name, false);
  await follow('packages/db/drizzle/meta/_journal.json', false);
  for (const path of BROWSER_SUBJECT_ENTRIES) await follow(path);
  for (const path of BROWSER_SUBJECT_WIRING) await follow(path, false);
  for (const pkg of packages.values()) {
    if (![...visited.keys()].some((path) => path.startsWith(pkg.dir + '/'))) continue;
    const manifest = JSON.parse(await readFile(join(root, pkg.dir, 'package.json'), 'utf8')) as {
      version?: string;
      type?: string;
    };
    inputs.set(
      'package/' + pkg.name,
      Buffer.from(
        canonical({
          name: pkg.name,
          version: manifest.version ?? null,
          type: manifest.type ?? null,
        })
      )
    );
  }
  // Runtime library loading and build parsers are constructor-owned dynamic
  // ports, not literal source imports. Pin their existing declared identities.
  for (const [path, names] of [
    ['packages/browser/package.json', ['playwright-core']],
    ['package.json', ['typescript']],
    ['apps/desktop/package.json', ['yaml', 'electron', 'electron-builder']],
    ['packages/cli/package.json', ['esbuild']],
  ] as const)
    for (const name of names) external(path, name);
  return inputs;
}
/** Fingerprint the exact reviewed production closure and pinned resolved dependency identities. */
export async function browserProductionSubject(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const [path, bytes] of [...(await browserProductionInputs(root))].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    hash.update(path + '\0' + bytes.length + '\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}
