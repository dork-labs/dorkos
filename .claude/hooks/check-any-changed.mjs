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
    // it, hiding real `any` from the check (DOR-642). The shared stripper lexes
    // with TypeScript's own parser instead, and preserves positions, so the line
    // numbers reported below still point at the real lines.
    //
    // Imported dynamically so a checkout with no `node_modules` (a fresh
    // worktree, before `pnpm install`) reaches the catch below and warns rather
    // than crashing with a module-resolution stack trace.
    const { codeOnly } = await import('../../scripts/lib/code-only.mjs');
    const strippedContent = codeOnly(originalContent, absolutePath);

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
