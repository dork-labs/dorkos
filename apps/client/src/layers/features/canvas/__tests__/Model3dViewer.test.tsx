/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// `<model-viewer>` is a side-effect web-component registration that assumes a
// full browser; stub it so importing the viewer never touches jsdom internals.
vi.mock('@google/model-viewer', () => ({}));

// Force WebGL context creation to fail the way it does on a GPU-less / exhausted
// machine: the THREE.WebGLRenderer constructor throws synchronously. Everything
// after the throw (lights, controls, loaders) is never reached, so bare newable
// stubs suffice.
vi.mock('three', () => ({
  WebGLRenderer: class {
    constructor() {
      throw new Error('Error creating WebGL context.');
    }
  },
  Scene: class {},
  PerspectiveCamera: class {},
  AmbientLight: class {},
  DirectionalLight: class {},
  Box3: class {},
  Vector3: class {},
  MeshStandardMaterial: class {},
  Mesh: class {},
}));
vi.mock('three/examples/jsm/loaders/STLLoader.js', () => ({ STLLoader: vi.fn() }));
vi.mock('three/examples/jsm/loaders/OBJLoader.js', () => ({ OBJLoader: vi.fn() }));
vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({ OrbitControls: vi.fn() }));

import { Model3dViewer } from '../ui/Model3dViewer';

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  cleanup();
});

describe('Model3dViewer — WebGL guard', () => {
  it('renders an in-tab message instead of throwing when WebGL is unavailable', () => {
    // Must not throw out of the effect — a throw would escape to the canvas
    // boundary; the viewer degrades in place instead.
    expect(() =>
      render(<Model3dViewer url="blob:model.stl" format="stl" label="Test model" />)
    ).not.toThrow();

    expect(screen.getByText(/can.t be shown here/i)).toBeInTheDocument();
    // The 3D canvas surface is not mounted once WebGL failed.
    expect(screen.queryByRole('img', { name: 'Test model' })).not.toBeInTheDocument();
  });
});
