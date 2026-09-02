#!/usr/bin/env node
/**
 * Check Any Changed Hook
 * Detects forbidden `any` type usage in TypeScript files.
 *
 * Only CODE counts — an `any` named in prose or inside a string is not a type
 * annotation. Comments and literals are blanked by the repo's shared stripper
 * (`scripts/lib/code-only.mjs`), which lexes with TypeScript's own parser and
 * preserves positions. Fixtures: `scripts/__tests__/code-only.test.ts`.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Read JSON from stdin
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

/**
 * The shared stripper, or `null` after saying — loudly — that the check is off.
 *
 * The stripper needs `typescript` from node_modules, and a checkout without one
 * is a state this repo really reaches: a fresh worktree before `pnpm install`.
 * Exiting 0 there is right (a hook that blocks every edit in a new worktree gets
 * turned off), but doing it QUIETLY is not: the check would report nothing while
 * looking exactly like a clean file, which is the silent-blind-spot shape this
 * whole hook was just fixed for.
 *
 * There is deliberately NO degraded regex mode. The regexes this replaced are
 * the defect — they hid real `any` behind an apostrophe — so falling back to
 * them would trade a check that says it is off for one that lies. Off and loud
 * beats on and wrong.
 */
async function loadStripper(filePath) {
  try {
    const { codeOnly } = await import('../../scripts/lib/code-only.mjs');
    return codeOnly;
  } catch (error) {
    console.error('');
    console.error('⚠️  THE `any` CHECK DID NOT RUN. This file was not checked:');
    console.error(`   ${filePath}`);
    console.error('');
    console.error('   It needs `typescript` from node_modules, and loading it failed — usually a');
    console.error('   fresh worktree that has never been installed.');
    console.error(`   Cause: ${error.message}`);
    console.error('');
    console.error('   Fix: run `pnpm install` in this checkout, then edit the file again.');
    console.error('');
    return null;
  }
}

// Find any violations in content
function findAnyViolations(content, originalContent) {
  const violations = [];
  // Line `i` of the stripped content is line `i` of the file: the stripper
  // blanks in place rather than deleting, so the two stay index-aligned and the
  // reported line number is the real one. Deleting a multi-line block comment
  // instead pulled every line below it up and misreported (DOR-642).
  const lines = originalContent.split('\n');
  const strippedLines = content.split('\n');

  // Patterns to detect forbidden `any` usage
  const patterns = [
    { regex: /:\s*any\b/, description: ': any' },
    { regex: /\bas\s+any\b/, description: 'as any' },
    { regex: /<any>/, description: '<any>' },
    { regex: /<any,/, description: '<any,' },
    { regex: /,\s*any>/, description: ', any>' },
    { regex: /,\s*any,/, description: ', any,' },
  ];

  for (let i = 0; i < strippedLines.length; i++) {
    const strippedLine = strippedLines[i];
    const originalLine = lines[i];

    for (const { regex, description } of patterns) {
      if (regex.test(strippedLine)) {
        violations.push({
          line: i + 1,
          content: originalLine.trim(),
          pattern: description,
        });
        break; // Only report once per line
      }
    }
  }

  return violations;
}

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      process.exit(0);
    }

    const payload = JSON.parse(input);
    const toolInput = payload.tool_input || {};
    const filePath = toolInput.file_path;

    // Skip if no file path
    if (!filePath) {
      process.exit(0);
    }

    // Skip if not a TypeScript file
    if (!/\.(ts|tsx)$/.test(filePath)) {
      process.exit(0);
    }

    // Skip type definition files
    if (/\.d\.ts$/.test(filePath)) {
      process.exit(0);
    }

    // Resolve and check if file exists
    const absolutePath = resolve(process.cwd(), filePath);
    if (!existsSync(absolutePath)) {
      process.exit(0);
    }

    // Read file content
    const originalContent = readFileSync(absolutePath, 'utf8');

    // Prose does not declare types, so comments and string literals are blanked
    // before the patterns below run. This used to be a pair of regexes here —
    // strings, then comments — and an apostrophe in a TSDoc ("the API's
    // cookie/header") opened a fake string literal that blanked the code below
    // it, so the check read the wrong lines and reported the wrong ones
    // (DOR-642). The shared stripper lexes with TypeScript's own parser instead,
    // and preserves positions, so the line numbers below point at real lines.
    //
    // Imported dynamically because it needs `typescript` from node_modules, and
    // a checkout without one is a real state here — a fresh worktree before
    // `pnpm install`. That case is announced rather than swallowed; see below.
    const stripper = await loadStripper(absolutePath);
    if (!stripper) {
      process.exit(0);
    }
    const strippedContent = stripper(originalContent, absolutePath);

    // Find violations
    const violations = findAnyViolations(strippedContent, originalContent);

    if (violations.length > 0) {
      console.error(`❌ Found ${violations.length} forbidden 'any' type usage(s) in ${filePath}:`);
      console.error('');
      for (const v of violations) {
        console.error(`   Line ${v.line}: ${v.pattern}`);
        console.error(`   ${v.content}`);
        console.error('');
      }
      console.error('💡 Use specific types instead of `any`. Consider:');
      console.error('   - `unknown` for truly unknown types (safer)');
      console.error('   - Proper type definitions');
      console.error('   - Generic type parameters');
      process.exit(2);
    }

    process.exit(0);
  } catch (error) {
    console.error(`❌ Check-any error: ${error.message}`);
    process.exit(0); // Don't block on errors, just warn
  }
}

main();
