/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// Keep the heavy <model-viewer> web component out of jsdom.
vi.mock('@google/model-viewer', () => ({}));

// Fake three example loaders: each exposes a `.load(url, onLoad)` spy so the
// format→loader dispatch is asserted without WebGL, bytes, or real parsing.
const stlLoad = vi.fn();
const plyLoad = vi.fn();
const objLoad = vi.fn();
const threeMfLoad = vi.fn();
const fbxLoad = vi.fn();
const colladaLoad = vi.fn();

vi.mock('three/examples/jsm/loaders/STLLoader.js', () => ({
  STLLoader: class {
    load = stlLoad;
  },
}));
vi.mock('three/examples/jsm/loaders/PLYLoader.js', () => ({
  PLYLoader: class {
    load = plyLoad;
  },
}));
vi.mock('three/examples/jsm/loaders/OBJLoader.js', () => ({
  OBJLoader: class {
    load = objLoad;
  },
}));
vi.mock('three/examples/jsm/loaders/3MFLoader.js', () => ({
  ThreeMFLoader: class {
    load = threeMfLoad;
  },
}));
vi.mock('three/examples/jsm/loaders/FBXLoader.js', () => ({
  FBXLoader: class {
    load = fbxLoad;
  },
}));
vi.mock('three/examples/jsm/loaders/ColladaLoader.js', () => ({
  ColladaLoader: class {
    load = colladaLoad;
  },
}));
vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    enableDamping = false;
    update(): void {}
    dispose(): void {}
  },
}));

import { loadThreeModel } from '../ui/Model3dViewer';

const sharedMaterial = new THREE.MeshStandardMaterial();

beforeEach(() => vi.clearAllMocks());

describe('loadThreeModel — format dispatch', () => {
  it('routes STL to STLLoader and builds a mesh with the shared material', () => {
    const onLoad = vi.fn();
    stlLoad.mockImplementation((_url, cb) => cb(new THREE.BufferGeometry()));
    loadThreeModel('stl', 'part.stl', sharedMaterial, onLoad);
    expect(stlLoad).toHaveBeenCalledWith('part.stl', expect.any(Function));
    const object = onLoad.mock.calls[0][0];
    expect(object).toBeInstanceOf(THREE.Mesh);
    expect(object.material).toBe(sharedMaterial);
  });

  it('routes PLY to PLYLoader and builds a mesh with the shared material', () => {
    const onLoad = vi.fn();
    plyLoad.mockImplementation((_url, cb) => cb(new THREE.BufferGeometry()));
    loadThreeModel('ply', 'cloud.ply', sharedMaterial, onLoad);
    expect(plyLoad).toHaveBeenCalled();
    expect(onLoad.mock.calls[0][0]).toBeInstanceOf(THREE.Mesh);
  });

  it('routes OBJ to OBJLoader and overwrites mesh materials with the shared material', () => {
    const onLoad = vi.fn();
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    group.add(mesh);
    objLoad.mockImplementation((_url, cb) => cb(group));
    loadThreeModel('obj', 'mesh.obj', sharedMaterial, onLoad);
    expect(objLoad).toHaveBeenCalled();
    // OBJ carries no fetched .mtl here, so its meshes take the calm-gray material.
    expect(mesh.material).toBe(sharedMaterial);
    expect(onLoad).toHaveBeenCalledWith(group);
  });

  it('routes 3MF to ThreeMFLoader and preserves embedded materials', () => {
    const onLoad = vi.fn();
    const group = new THREE.Group();
    const embedded = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), embedded);
    group.add(mesh);
    threeMfLoad.mockImplementation((_url, cb) => cb(group));
    loadThreeModel('3mf', 'print.3mf', sharedMaterial, onLoad);
    expect(threeMfLoad).toHaveBeenCalled();
    // Fallback only paints material-less meshes, so the 3MF's own color survives.
    expect(mesh.material).toBe(embedded);
    expect(onLoad).toHaveBeenCalledWith(group);
  });

  it('routes FBX to FBXLoader and preserves embedded materials', () => {
    const onLoad = vi.fn();
    const group = new THREE.Group();
    const embedded = new THREE.MeshPhongMaterial();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), embedded);
    group.add(mesh);
    fbxLoad.mockImplementation((_url, cb) => cb(group));
    loadThreeModel('fbx', 'rig.fbx', sharedMaterial, onLoad);
    expect(fbxLoad).toHaveBeenCalled();
    expect(mesh.material).toBe(embedded);
  });

  it('routes DAE to ColladaLoader, unwrapping the collada scene', () => {
    const onLoad = vi.fn();
    const scene = new THREE.Group();
    colladaLoad.mockImplementation((_url, cb) => cb({ scene }));
    loadThreeModel('dae', 'scene.dae', sharedMaterial, onLoad);
    expect(colladaLoad).toHaveBeenCalled();
    expect(onLoad).toHaveBeenCalledWith(scene);
  });

  it('is a no-op for gltf — <model-viewer> owns that path', () => {
    const onLoad = vi.fn();
    loadThreeModel('gltf', 'model.glb', sharedMaterial, onLoad);
    expect(onLoad).not.toHaveBeenCalled();
    expect(stlLoad).not.toHaveBeenCalled();
  });
});
