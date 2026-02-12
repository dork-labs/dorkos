#!/usr/bin/env node
/**
 * File Guard Hook
 * Enforces file access restrictions based on deny patterns from settings.json
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'
import ignore from 'ignore'

// Read JSON from stdin
async function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('readable', () => {
      let chunk
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk
      }
    })
    process.stdin.on('end', () => {
      resolve(data)
    })
  })
}

// Load deny patterns from settings.json
function loadDenyPatterns() {
  const settingsPath = resolve(process.cwd(), '.claude/settings.json')
  if (!existsSync(settingsPath)) {
    return []
  }
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    return settings.permissions?.deny || []
  } catch {
    return []
  }
}

// Extract file paths from bash command
function extractPathsFromBashCommand(command) {
  if (!command) return []

  const paths = []

  // Common file-related commands and their argument patterns
  const patterns = [
    // cat, less, more, head, tail, etc.
    /\b(?:cat|less|more|head|tail|bat|view)\s+(?:-[a-zA-Z0-9]+\s+)*["']?([^\s|><;"'&]+)["']?/g,
    // rm, cp, mv, touch
    /\b(?:rm|cp|mv|touch)\s+(?:-[a-zA-Z0-9]+\s+)*["']?([^\s|><;"'&]+)["']?/g,
    // source, .
    /\b(?:source|\.)\s+["']?([^\s|><;"'&]+)["']?/g,
    // Redirections
    /[<>]\s*["']?([^\s|><;"'&]+)["']?/g,
    // File paths that look like paths
    /(?:^|\s)["']?((?:\.{1,2}\/|\/)[^\s|><;"'&]+)["']?/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(command)) !== null) {
      if (match[1]) {
        paths.push(match[1])
      }
    }
  }

  // Check for sensitive pipeline patterns
  const sensitivePatterns = [
    /find\s+.*\|\s*xargs\s+.*(?:cat|head|tail|less)/i,
    /xargs\s+.*(?:cat|head|tail|less)/i,
    /(?:cat|head|tail)\s+.*\*.*\.(?:env|key|pem)/i,
  ]

  for (const pattern of sensitivePatterns) {
    if (pattern.test(command)) {
      console.error('⚠️  Detected potentially sensitive pipeline pattern')
      // Don't extract paths but flag for review
    }
  }

  return paths
}

// Normalize path relative to cwd
function normalizePath(filePath, cwd) {
  if (!filePath) return null

  // Handle absolute paths
  if (isAbsolute(filePath)) {
    return relative(cwd, filePath) || filePath
  }

  // Handle relative paths - keep as-is but normalize
  return filePath.replace(/^\.\//, '')
}

// Check if path matches any deny pattern
function isDenied(filePath, ig) {
  if (!filePath) return false

  // Normalize the path
  const normalized = filePath.replace(/^\.\//, '')

  // Check against ignore patterns
  return ig.ignores(normalized)
}

async function main() {
  try {
    const input = await readStdin()
    if (!input.trim()) {
      process.exit(0)
    }

    const payload = JSON.parse(input)
    const toolName = payload.tool_name
    const toolInput = payload.tool_input || {}
    const cwd = process.cwd()

    // Load deny patterns and create ignore instance
    const denyPatterns = loadDenyPatterns()
    const ig = ignore().add(denyPatterns)

    // Collect paths to check
    const pathsToCheck = []

    // Extract file_path from tool_input (Read, Write, Edit, MultiEdit)
    if (toolInput.file_path) {
      pathsToCheck.push(normalizePath(toolInput.file_path, cwd))
    }

    // For Bash commands, extract paths from the command string
    if (toolName === 'Bash' && toolInput.command) {
      const extractedPaths = extractPathsFromBashCommand(toolInput.command)
      for (const p of extractedPaths) {
        const normalized = normalizePath(p, cwd)
        if (normalized) {
          pathsToCheck.push(normalized)
        }
      }
    }

    // Check each path against deny patterns
    for (const path of pathsToCheck) {
      if (path && isDenied(path, ig)) {
        console.error(`🚫 Access denied: ${path}`)
        console.error(`   Matches deny pattern in .claude/settings.json`)
        process.exit(2)
      }
    }

    // All paths allowed
    process.exit(0)

  } catch (error) {
    console.error(`❌ File guard error: ${error.message}`)
    process.exit(0) // Don't block on errors, just warn
  }
}

main()
