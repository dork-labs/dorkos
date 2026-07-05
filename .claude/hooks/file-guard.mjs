#!/usr/bin/env node
/**
 * File Guard Hook
 * Enforces file access restrictions based on deny patterns from settings.json
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';

const { resolve, relative, isAbsolute, basename } = path;

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

// Load deny rules from settings.json, split by access type.
//
// Rules are tool-scoped ("Read(./.env)", "Write(./.git/**)"); bare legacy
// patterns are treated as denying both reads and writes. The split matters:
// .git/** is deny-listed for Edit/Write only — Bash reads of .git (cat
// .git/config, git plumbing) must stay allowed.
function loadDenyPatterns() {
  const settingsPath = resolve(process.cwd(), '.claude/settings.json');
  if (!existsSync(settingsPath)) {
    return { read: [], write: [] };
  }
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const rules = settings.permissions?.deny || [];
    const read = new Set();
    const write = new Set();
    for (const rule of rules) {
      const scoped = /^([A-Za-z]+)\((.+)\)$/.exec(rule);
      const pattern = (scoped ? scoped[2] : rule).replace(/^\.\//, '');
      const tool = scoped ? scoped[1] : null;
      if (!tool) {
        read.add(pattern);
        write.add(pattern);
      } else if (tool === 'Read') {
        read.add(pattern);
      } else if (tool === 'Edit' || tool === 'Write') {
        write.add(pattern);
      }
    }
    return { read: [...read], write: [...write] };
  } catch {
    return { read: [], write: [] };
  }
}

// Extract file paths from a bash command, tagged with the access type the
// command implies so they can be checked against the matching deny set.
function extractPathsFromBashCommand(command) {
  if (!command) return [];

  const tagged = [];

  const patterns = [
    // cat, less, more, head, tail, etc. — reads
    {
      re: /\b(?:cat|less|more|head|tail|bat|view)\s+(?:-[a-zA-Z0-9]+\s+)*["']?([^\s|><;"'&]+)["']?/g,
      access: 'read',
    },
    // rm, cp, mv, touch — mutations (cp/mv also read their source; check both)
    {
      re: /\b(?:rm|cp|mv|touch)\s+(?:-[a-zA-Z0-9]+\s+)*["']?([^\s|><;"'&]+)["']?/g,
      access: 'both',
    },
    // source, . — reads (and executes)
    { re: /\b(?:source|\.)\s+["']?([^\s|><;"'&]+)["']?/g, access: 'read' },
    // Input redirection — read
    { re: /<\s*["']?([^\s|><;"'&]+)["']?/g, access: 'read' },
    // Output redirection — write
    { re: />{1,2}\s*["']?([^\s|><;"'&]+)["']?/g, access: 'write' },
    // Bare path-looking arguments — most likely reads
    { re: /(?:^|\s)["']?((?:\.{1,2}\/|\/)[^\s|><;"'&]+)["']?/g, access: 'read' },
  ];

  for (const { re, access } of patterns) {
    let match;
    while ((match = re.exec(command)) !== null) {
      if (match[1]) {
        tagged.push({ path: match[1], access });
      }
    }
  }

  // Check for sensitive pipeline patterns
  const sensitivePatterns = [
    /find\s+.*\|\s*xargs\s+.*(?:cat|head|tail|less)/i,
    /xargs\s+.*(?:cat|head|tail|less)/i,
    /(?:cat|head|tail)\s+.*\*.*\.(?:env|key|pem)/i,
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(command)) {
      console.error('⚠️  Detected potentially sensitive pipeline pattern');
      // Don't extract paths but flag for review
    }
  }

  return tagged;
}

// Normalize path relative to cwd
function normalizePath(filePath, cwd) {
  if (!filePath) return null;

  // Handle absolute paths
  if (isAbsolute(filePath)) {
    return relative(cwd, filePath) || filePath;
  }

  // Handle relative paths - keep as-is but normalize
  return filePath.replace(/^\.\//, '');
}

// Match a file path against a glob pattern (no external deps)
function matchesPattern(filePath, pattern) {
  // Exact match (e.g. ".env")
  if (filePath === pattern || basename(filePath) === pattern) return true;

  // Use Node 22+ path.matchesGlob if available
  if (typeof path.matchesGlob === 'function') {
    return path.matchesGlob(filePath, pattern);
  }

  // Fallback: convert glob to regex
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*')
        .replace(/\?/g, '[^/]') +
      '$'
  );
  return regex.test(filePath);
}

// Paths that are safe to access despite matching deny patterns
const ALLOW_LIST = ['.env.example'];

// Check if path matches any deny pattern
function isDenied(filePath, denyPatterns) {
  if (!filePath) return false;

  const normalized = filePath.replace(/^\.\//, '');

  // Allow-list takes priority over deny patterns
  if (ALLOW_LIST.includes(normalized) || ALLOW_LIST.includes(basename(normalized))) {
    return false;
  }

  for (const pattern of denyPatterns) {
    if (matchesPattern(normalized, pattern)) return true;
  }
  return false;
}

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      process.exit(0);
    }

    const payload = JSON.parse(input);
    const toolName = payload.tool_name;
    const toolInput = payload.tool_input || {};
    const cwd = process.cwd();

    // Load deny patterns split by access type
    const denyPatterns = loadDenyPatterns();

    // Collect paths to check, tagged with implied access
    const pathsToCheck = [];

    // Only Bash reaches this hook (see settings.json PreToolUse matcher):
    // Read/Edit/Write are covered natively by tool-scoped permissions.deny
    // rules. This guard extends the same policy to file access via Bash.
    if (toolName === 'Bash' && toolInput.command) {
      for (const { path: p, access } of extractPathsFromBashCommand(toolInput.command)) {
        const normalized = normalizePath(p, cwd);
        if (normalized) {
          pathsToCheck.push({ path: normalized, access });
        }
      }
    }

    // Check each path against the deny set(s) its access type implies
    for (const { path, access } of pathsToCheck) {
      if (!path) continue;
      const denied =
        (access !== 'write' && isDenied(path, denyPatterns.read)) ||
        (access !== 'read' && isDenied(path, denyPatterns.write));
      if (denied) {
        console.error(`🚫 Access denied: ${path}`);
        console.error(`   Matches deny pattern in .claude/settings.json`);
        process.exit(2);
      }
    }

    // All paths allowed
    process.exit(0);
  } catch (error) {
    console.error(`❌ File guard error: ${error.message}`);
    process.exit(0); // Don't block on errors, just warn
  }
}

main();
