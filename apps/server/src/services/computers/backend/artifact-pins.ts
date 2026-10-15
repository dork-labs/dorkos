import type { PinnedArtifact } from './types.js';

/** Official Lima v2.2.1 SHA256SUMS, verified 2026-10-12. */
export const LIMA_ARTIFACT: PinnedArtifact = {
  url: 'https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz',
  sha256: '9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e',
  maxBytes: 100_000_000,
};
/** Official immutable Debian 13 image, downloaded and checked against upstream SHA512SUMS, verified 2026-10-12. */
// https://cloud.debian.org/images/cloud/trixie/20261001-2618/SHA512SUMS
// Upstream SHA512: d8470b8c6c38fead046c794b5800a5a7b96672d5bcf543cc230ceb0c4b8ace05ed341a0c8928045422243fde26b2f1f2f58e99244c65709ffda2e3d4b674dd5a
export const LINUX_ARTIFACT: PinnedArtifact = {
  url: 'https://cloud.debian.org/images/cloud/trixie/20261001-2618/debian-13-genericcloud-arm64-20261001-2618.qcow2',
  sha256: '8b94e48bb338ae2f6168927cff36edc6dfc7ecac44804c6839f371769e58813a',
  maxBytes: 1_000_000_000,
};
/** Official GitHub release asset digest, verified 2026-10-12. */
export const OPENCODE_ARTIFACT: PinnedArtifact = {
  url: 'https://github.com/anomalyco/opencode/releases/download/v1.19.0/opencode-linux-arm64.tar.gz',
  sha256: 'e9841d43d3e1a8f36ed2691592d3b8b4fb097e606c8b559a277a1b845840e26b',
  maxBytes: 200_000_000,
};
