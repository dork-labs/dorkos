import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const id = 'virtual:dorkos-extension-frame';

/**
 * The plugin's shape, written out rather than imported from `vite`: the web
 * build runs Vite 6 and the desktop renderer Vite 7, and each accepts this
 * object while neither accepts the other's `Plugin` type.
 */
interface ExtensionFramePlugin {
  name: string;
  resolveId(source: string): string | undefined;
  load(source: string): Promise<string | undefined>;
}

/**
 * Bundle the app frame runtime (DOR-3293) on its own, so it shares no window or
 * module state with the host. The result is a string the host inlines into each
 * sandboxed frame's `srcdoc`.
 */
export function extensionFramePlugin(): ExtensionFramePlugin {
  let runtime: Promise<string> | undefined;
  return {
    name: 'dorkos:extension-frame',
    resolveId(source) {
      return source === id ? `\0${id}` : undefined;
    },
    async load(source) {
      if (source !== `\0${id}`) return undefined;
      runtime ??= build({
        entryPoints: [
          path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            'src/layers/features/extensions/frame/runtime.tsx'
          ),
        ],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
        minify: true,
        define: { 'process.env.NODE_ENV': '"production"' },
      }).then((result) => result.outputFiles[0].text);
      return `export default ${JSON.stringify(await runtime)}`;
    },
  };
}
