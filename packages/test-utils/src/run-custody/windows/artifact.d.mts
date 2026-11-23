type WindowsCustodyArchitecture = 'x64' | 'arm64' | 'ia32';
type WindowsCustodyArtifact = {
  readonly architecture: WindowsCustodyArchitecture;
  readonly machine: number;
  readonly sha256: string;
};

export function verifyWindowsCustodyArtifact(input: {
  manifest: Uint8Array;
  artifact: Uint8Array;
  expected: {
    architecture: WindowsCustodyArchitecture;
    protocolVersion: number;
    manifestSha256: string;
    sources: Readonly<Record<string, Uint8Array>>;
  };
}): WindowsCustodyArtifact;

export function resolveWindowsCustodyArtifact(selection: {
  architecture: WindowsCustodyArchitecture;
  protocolVersion: number;
  manifestSha256: string;
  sourceFiles: readonly string[];
}): Promise<WindowsCustodyArtifact & { readonly path: string }>;
