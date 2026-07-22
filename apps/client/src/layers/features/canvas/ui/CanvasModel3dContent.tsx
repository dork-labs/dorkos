import { lazy, Suspense, useMemo } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { resolveCanvasFetchUrl } from '../lib/fetch-src';
import type { Model3dFormat } from './Model3dViewer';

// Lazy: three.js + <model-viewer> load only when a 3D document first renders.
const Model3dViewer = lazy(() =>
  import('./Model3dViewer').then((m) => ({ default: m.Model3dViewer }))
);

interface CanvasModel3dContentProps {
  /** 3D model canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'model3d' }>;
}

/**
 * Map a model file extension to its renderer format, or null when unsupported.
 *
 * @param src - The model source URL or path.
 * @internal Exported for testing only.
 */
export function formatOf(src: string): Model3dFormat | null {
  const ext = src.split('.').pop()?.toLowerCase();
  if (ext === 'glb' || ext === 'gltf') return 'gltf';
  if (ext === 'stl') return 'stl';
  if (ext === 'obj') return 'obj';
  if (ext === '3mf') return '3mf';
  if (ext === 'ply') return 'ply';
  if (ext === 'fbx') return 'fbx';
  if (ext === 'dae') return 'dae';
  return null;
}

/**
 * 3D model canvas renderer: resolves the model bytes to a cwd-confined URL and
 * lazy-loads the heavy {@link Model3dViewer} (three.js / model-viewer). glTF/GLB
 * orbit in `<model-viewer>`; STL/OBJ/PLY/3MF/FBX/DAE render in a three.js scene.
 */
export function CanvasModel3dContent({ content }: CanvasModel3dContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);

  const resolved = useMemo(
    () => resolveCanvasFetchUrl(content.src, (p) => transport.mediaUrl(cwd ?? '', p)),
    [content.src, transport, cwd]
  );
  const format = useMemo(() => formatOf(content.src), [content.src]);

  if (resolved.url === null || format === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
        <p>This 3D model can&rsquo;t be displayed here.</p>
      </div>
    );
  }

  return (
    <div className="bg-muted/40 h-full w-full">
      <Suspense
        fallback={<div className="text-muted-foreground p-4 text-sm">Loading 3D viewer…</div>}
      >
        <Model3dViewer
          url={resolved.url}
          format={format}
          label={content.title ?? 'Canvas 3D model'}
        />
      </Suspense>
    </div>
  );
}
