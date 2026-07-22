import { createElement, useEffect, useRef } from 'react';
import '@google/model-viewer';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
// 3MFLoader.js exports the class as `ThreeMFLoader` (a leading digit is not a
// valid JS identifier), so the file name and the export name differ.
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * 3D model formats the canvas renders. glTF/GLB go to `<model-viewer>`; the rest
 * render in a three.js scene via their example loaders.
 */
export type Model3dFormat = 'gltf' | 'stl' | 'obj' | '3mf' | 'ply' | 'fbx' | 'dae';

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
 * `<model-viewer>` web component (orbit + zoom built in); STL/OBJ/PLY/3MF/FBX/DAE
 * render in a minimal three.js scene with orbit controls. Both auto-frame the model.
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
  return <ThreeModelViewer url={url} format={format} label={label} />;
}

/**
 * Load a model with the three.js example loader for its format and hand the
 * framed-ready object back. Isolated from the render effect so the format→loader
 * dispatch is unit-testable without a WebGL context.
 *
 * Material handling differs by format. STL and PLY are pure geometry (no material
 * at all), so their mesh is built with the shared calm-gray `material`. OBJ meshes
 * are reassigned that material too — its `.mtl` sidecar is not fetched here, so the
 * loader leaves only a default white material. FBX, Collada (DAE) and 3MF embed
 * their own materials/colors (the reason to use those richer formats), so their
 * loaded scene is passed through untouched.
 *
 * @param format - The three.js render format (never `gltf`, which model-viewer owns).
 * @param url - The model bytes URL.
 * @param material - Shared material applied to geometry-only (STL/PLY) and OBJ meshes.
 * @param onLoad - Called with the loaded `Object3D` once parsing resolves.
 * @internal Exported for testing only.
 */
export function loadThreeModel(
  format: Model3dFormat,
  url: string,
  material: THREE.Material,
  onLoad: (object: THREE.Object3D) => void
): void {
  switch (format) {
    case 'stl':
      new STLLoader().load(url, (geometry) => {
        geometry.computeVertexNormals();
        onLoad(new THREE.Mesh(geometry, material));
      });
      break;
    case 'ply':
      new PLYLoader().load(url, (geometry) => {
        geometry.computeVertexNormals();
        onLoad(new THREE.Mesh(geometry, material));
      });
      break;
    case 'obj':
      new OBJLoader().load(url, (object) => {
        object.traverse((child) => {
          if (child instanceof THREE.Mesh) child.material = material;
        });
        onLoad(object);
      });
      break;
    case '3mf':
      // Materials/colors are embedded in the 3MF — pass the scene through as-is.
      new ThreeMFLoader().load(url, (object) => onLoad(object));
      break;
    case 'fbx':
      // FBX carries its own materials — pass the loaded group through as-is.
      new FBXLoader().load(url, (object) => onLoad(object));
      break;
    case 'dae':
      // Collada carries its own materials — pass its scene through as-is.
      new ColladaLoader().load(url, (collada) => {
        if (collada) onLoad(collada.scene);
      });
      break;
    case 'gltf':
      // glTF/GLB never reach the three.js path — `<model-viewer>` renders them
      // in Model3dViewer before ThreeModelViewer mounts. Guarded for exhaustiveness.
      break;
  }
}

/** Dispose a material and any textures it references, releasing their GPU memory. */
function disposeMaterial(material: THREE.Material): void {
  // Textures hang off material properties (map, normalMap, aoMap, …) as Texture
  // values; dispose each before the material itself.
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}

/**
 * Release the GPU resources (geometries, materials, textures) a loaded scene holds.
 * Called on unmount so repeatedly opening and closing 3D documents — FBX/DAE/3MF
 * can carry textures — never leaks GPU memory.
 *
 * @param root - The scene root to traverse.
 */
function disposeSceneResources(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry?.dispose();
    const material = child.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach(disposeMaterial);
    else if (material) disposeMaterial(material);
  });
}

/**
 * three.js viewer for STL/OBJ/PLY/3MF/FBX/DAE: loads the geometry, frames it, and
 * orbits on drag. glTF/GLB take the `<model-viewer>` path in {@link Model3dViewer}.
 */
function ThreeModelViewer({ url, format, label }: Model3dViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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

    loadThreeModel(format, url, meshMaterial, (object) => {
      if (disposed) return;
      frameObject(object);
    });

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
      // Release the loaded model's GPU resources before tearing down the renderer,
      // so reopening 3D documents doesn't leak geometries/materials/textures.
      disposeSceneResources(scene);
      // The shared material is unused by formats that embed their own (FBX/DAE/3MF),
      // so the scene traversal above won't reach it — dispose it directly. For
      // STL/PLY/OBJ it was already disposed above; Material.dispose() is idempotent.
      meshMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url, format]);

  return <div ref={containerRef} className="h-full w-full" aria-label={label} role="img" />;
}
