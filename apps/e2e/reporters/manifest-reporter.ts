import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';

interface TestEntry {
  specFile: string;
  feature: string;
  description: string;
  lastRun: string;
  lastStatus: string;
  runCount: number;
  passCount: number;
  failCount: number;
  relatedCode: string[];
  explorationNotes?: string[];
  lastModified: string;
}

interface Manifest {
  version: number;
  tests: Record<string, TestEntry>;
  runHistory: Array<{
    id: string;
    timestamp: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
  }>;
}

interface TestCaseResult {
  title: string;
  status: string;
  file: string;
  feature: string;
  duration: number;
}

class ManifestReporter implements Reporter {
  private manifestPath: string;
  private manifest: Manifest;
  private runResults: TestCaseResult[] = [];
  private startTime = Date.now();

  constructor() {
    this.manifestPath = path.resolve(import.meta.dirname, '..', 'manifest.json');
    this.manifest = this.loadManifest();
  }

  private loadManifest(): Manifest {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
    } catch {
      return { version: 1, tests: {}, runHistory: [] };
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const testsDir = path.resolve(import.meta.dirname, '..', 'tests');
    const relativeFile = path.relative(testsDir, test.location.file);
    const feature = relativeFile.split(path.sep)[0] || 'unknown';

    this.runResults.push({
      title: test.title,
      status: result.status,
      file: relativeFile,
      feature,
      duration: result.duration,
    });
  }

  onEnd(_result: FullResult) {
    const now = new Date();
    const runId = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Aggregate results per spec file (not per test case)
    const byFile = new Map<string, TestCaseResult[]>();
    for (const r of this.runResults) {
      const group = byFile.get(r.file) ?? [];
      group.push(r);
      byFile.set(r.file, group);
    }

    for (const [file, results] of byFile) {
      const testKey = path.basename(file, '.spec.ts');
      const allPassed = results.every((r) => r.status === 'passed');
      const anyFailed = results.some((r) => r.status === 'failed');

      const existing = this.manifest.tests[testKey] || {
        specFile: `tests/${file}`,
        feature: results[0].feature,
        description: results.map((r) => r.title).join(', '),
        lastRun: '',
        lastStatus: '',
        runCount: 0,
        passCount: 0,
        failCount: 0,
        relatedCode: [],
        lastModified: '',
      };

      existing.lastRun = now.toISOString();
      existing.lastStatus = allPassed ? 'passed' : anyFailed ? 'failed' : 'mixed';
      existing.runCount++;
      if (allPassed) existing.passCount++;
      if (anyFailed) existing.failCount++;
      this.manifest.tests[testKey] = existing;
    }

    this.manifest.runHistory.push({
      id: runId,
      timestamp: now.toISOString(),
      total: this.runResults.length,
      passed: this.runResults.filter((r) => r.status === 'passed').length,
      failed: this.runResults.filter((r) => r.status === 'failed').length,
      skipped: this.runResults.filter((r) => r.status === 'skipped').length,
      duration: Date.now() - this.startTime,
    });
    if (this.manifest.runHistory.length > 100) {
      this.manifest.runHistory = this.manifest.runHistory.slice(-100);
    }

    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }
}

export default ManifestReporter;
