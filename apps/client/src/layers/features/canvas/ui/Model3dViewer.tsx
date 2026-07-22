import { createElement, useEffect, useRef, useState } from 'react';
import '@google/model-viewer';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** 3D model formats the canvas renders. glTF/GLB go to model-viewer; STL/OBJ to three.js. */
export type Model3dFormat = 'gltf' | 'stl' | 'obj';

/** Props for {@link Model3dViewer}. */
export interface Model3dViewerProps {
  /** Same-origin (or remote) URL streaming the model bytes. */
  url: string;
  /** Model format, derived from the source extension. */
  format: Model3dFormat;
  /** Accessible label for the viewer. */
  label: string;
}

/**
 * 3D model renderer, isolated behind a `React.lazy` boundary so `three.js` and
 * `<model-viewer>` never enter the main bundle. glTF/GLB render in Google's
 * `<model-viewer>` web component (orbit + zoom built in); STL/OBJ render in a
 * minimal three.js scene with orbit controls. Both auto-frame the model.
 */
export function Model3dViewer({ url, format, label }: Model3dViewerProps) {
  if (format === 'gltf') {
    return createElement('model-viewer', {
      src: url,
      'camera-controls': true,
      'auto-rotate': true,
      ar: false,
      'shadow-intensity': '1',
      alt: label,
      style: { width: '100%', height: '100%' },
    });
  }
  // Key by the model identity so a new url/format mounts a fresh viewer — this
  // resets the WebGL-failure state, so a model that failed to open never poisons
  // the next one loaded into the same tab.
  return <ThreeModelViewer key={`${url}:${format}`} url={url} format={format} label={label} />;
}

/** three.js STL/OBJ viewer: loads the geometry, frames it, and orbits on drag. */
function ThreeModelViewer({ url, format, label }: Model3dViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // WebGL context creation can fail (GPU off, too many live contexts — terminal
  // tabs hold them too). That is a normal runtime condition, not a crash: we
  // render an in-tab message rather than letting the throw escape the effect.
  const [webglFailed, setWebglFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Construct the renderer FIRST and guard it, so a failure returns before any
    // resource (scene, controls, observer, appended canvas) is created — the
    // cleanup below then only ever runs when every referenced object exists.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
      console.error('[Canvas] WebGL renderer unavailable:', error);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: WebGL availability is only knowable by attempting construction, which needs the effect-only DOM container; surfacing the failure as state is the correct fallback
      setWebglFailed(true);
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1);
    keyLight.position.set(1, 1, 1);
    scene.add(keyLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    let disposed = false;
    let frame = 0;

    /** Center + scale the loaded object so it fills the frame, then start the render loop. */
    function frameObject(object: THREE.Object3D): void {
      const box = new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      object.position.sub(center);
      scene.add(object);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      camera.position.set(0, 0, maxDim * 2.2);
      camera.near = maxDim / 100;
      camera.far = maxDim * 100;
      camera.updateProjectionMatrix();
      controls.update();
      renderLoop();
    }

    function renderLoop(): void {
      if (disposed) return;
      frame = requestAnimationFrame(renderLoop);
      controls.update();
      renderer.render(scene, camera);
    }

    const meshMaterial = new THREE.MeshStandardMaterial({
      color: 0x9ca3af,
      metalness: 0.1,
      roughness: 0.6,
    });

    if (format === 'stl') {
      new STLLoader().load(url, (geometry) => {
        if (disposed) return;
        geometry.computeVertexNormals();
        frameObject(new THREE.Mesh(geometry, meshMaterial));
      });
    } else {
      new OBJLoader().load(url, (object) => {
        if (disposed) return;
        object.traverse((child) => {
          if (child instanceof THREE.Mesh) child.material = meshMaterial;
        });
        frameObject(object);
      });
    }

    const resize = () => {
      const { clientWidth, clientHeight } = container;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url, format]);

  if (webglFailed) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
        <p>This 3D model can&rsquo;t be shown here. Your device couldn&rsquo;t open a 3D view.</p>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" aria-label={label} role="img" />;
}
