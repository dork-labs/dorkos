#!/usr/bin/env npx tsx

/**
 * Template Fetch Utilities
 *
 * GitHub API utilities for the template update system.
 * Fetches tags, releases, and file contents from public repositories.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const execAsync = promisify(exec)

interface GitHubTag {
  name: string
  commit: {
    sha: string
    url: string
  }
  zipball_url: string
  tarball_url: string
}

interface GitHubRelease {
  tag_name: string
  name: string
  body: string
  published_at: string
  prerelease: boolean
  draft: boolean
}

interface GitHubContent {
  name: string
  path: string
  sha: string
  size: number
  url: string
  html_url: string
  download_url: string | null
  type: 'file' | 'dir'
  content?: string
  encoding?: string
}

interface GitHubTreeItem {
  path: string
  mode: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
  url: string
}

interface GitHubTree {
  sha: string
  url: string
  tree: GitHubTreeItem[]
  truncated: boolean
}

interface FetchResult<T> {
  success: boolean
  data?: T
  error?: string
  rateLimitRemaining?: number
  rateLimitReset?: Date
}

const GITHUB_API = 'https://api.github.com'

/**
 * Parse owner/repo from repository string
 */
function parseRepository(repository: string): { owner: string; repo: string } | null {
  const match = repository.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

/**
 * Make a GitHub API request with rate limit handling
 */
async function githubFetch<T>(url: string): Promise<FetchResult<T>> {
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'next-starter-template-updater',
      },
    })

    const rateLimitRemaining = parseInt(response.headers.get('x-ratelimit-remaining') || '0', 10)
    const rateLimitReset = new Date(parseInt(response.headers.get('x-ratelimit-reset') || '0', 10) * 1000)

    if (response.status === 403 && rateLimitRemaining === 0) {
      return {
        success: false,
        error: `GitHub API rate limit exceeded. Resets at ${rateLimitReset.toLocaleTimeString()}.`,
        rateLimitRemaining,
        rateLimitReset,
      }
    }

    if (!response.ok) {
      const errorBody = await response.text()
      return {
        success: false,
        error: `GitHub API error (${response.status}): ${errorBody}`,
        rateLimitRemaining,
        rateLimitReset,
      }
    }

    const data = await response.json() as T
    return {
      success: true,
      data,
      rateLimitRemaining,
      rateLimitReset,
    }
  } catch (error) {
    return {
      success: false,
      error: `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/**
 * Fetch all tags from a repository
 */
export async function fetchTags(repository: string): Promise<FetchResult<GitHubTag[]>> {
  const parsed = parseRepository(repository)
  if (!parsed) {
    return { success: false, error: `Invalid repository format: ${repository}. Expected owner/repo.` }
  }

  const url = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/tags`
  return githubFetch<GitHubTag[]>(url)
}

/**
 * Fetch all releases from a repository
 */
export async function fetchReleases(repository: string): Promise<FetchResult<GitHubRelease[]>> {
  const parsed = parseRepository(repository)
  if (!parsed) {
    return { success: false, error: `Invalid repository format: ${repository}. Expected owner/repo.` }
  }

  const url = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/releases`
  return githubFetch<GitHubRelease[]>(url)
}

/**
 * Fetch file content at a specific ref (tag, branch, or commit)
 */
export async function fetchFileContent(
  repository: string,
  path: string,
  ref: string
): Promise<FetchResult<string>> {
  const parsed = parseRepository(repository)
  if (!parsed) {
    return { success: false, error: `Invalid repository format: ${repository}. Expected owner/repo.` }
  }

  const url = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/contents/${path}?ref=${ref}`
  const result = await githubFetch<GitHubContent>(url)

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      rateLimitRemaining: result.rateLimitRemaining,
      rateLimitReset: result.rateLimitReset,
    }
  }

  if (result.data?.type !== 'file') {
    return { success: false, error: `Path ${path} is not a file` }
  }

  if (!result.data.content || result.data.encoding !== 'base64') {
    return { success: false, error: `Unexpected content encoding for ${path}` }
  }

  const content = Buffer.from(result.data.content, 'base64').toString('utf-8')
  return {
    success: true,
    data: content,
    rateLimitRemaining: result.rateLimitRemaining,
    rateLimitReset: result.rateLimitReset,
  }
}

/**
 * Fetch directory listing at a specific ref
 */
export async function fetchDirectoryListing(
  repository: string,
  path: string,
  ref: string
): Promise<FetchResult<GitHubContent[]>> {
  const parsed = parseRepository(repository)
  if (!parsed) {
    return { success: false, error: `Invalid repository format: ${repository}. Expected owner/repo.` }
  }

  const url = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/contents/${path}?ref=${ref}`
  return githubFetch<GitHubContent[]>(url)
}

/**
 * Fetch complete file tree for a ref (recursive)
 */
export async function fetchFileTree(
  repository: string,
  ref: string
): Promise<FetchResult<string[]>> {
  const parsed = parseRepository(repository)
  if (!parsed) {
    return { success: false, error: `Invalid repository format: ${repository}. Expected owner/repo.` }
  }

  // First get the commit SHA for the ref
  const refUrl = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/git/ref/tags/${ref}`
  let refResult = await githubFetch<{ object: { sha: string; type: string } }>(refUrl)

  if (!refResult.success) {
    // Try as a branch
    const branchUrl = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/git/ref/heads/${ref}`
    refResult = await githubFetch<{ object: { sha: string; type: string } }>(branchUrl)
    if (!refResult.success) {
      return {
        success: false,
        error: refResult.error,
        rateLimitRemaining: refResult.rateLimitRemaining,
        rateLimitReset: refResult.rateLimitReset,
      }
    }
  }

  let commitSha = refResult.data?.object.sha
  if (!commitSha) {
    return { success: false, error: `Could not resolve ref: ${ref}` }
  }

  // If the object is a tag (annotated tag), we need to dereference it to get the commit
  if (refResult.data?.object.type === 'tag') {
    const tagUrl = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/git/tags/${commitSha}`
    const tagResult = await githubFetch<{ object: { sha: string } }>(tagUrl)
    if (!tagResult.success) {
      return {
        success: false,
        error: tagResult.error,
        rateLimitRemaining: tagResult.rateLimitRemaining,
        rateLimitReset: tagResult.rateLimitReset,
      }
    }
    commitSha = tagResult.data?.object.sha
    if (!commitSha) {
      return { success: false, error: `Could not dereference tag: ${ref}` }
    }
  }

  // Get the tree SHA from the commit
  const commitUrl = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/git/commits/${commitSha}`
  const commitResult = await githubFetch<{ tree: { sha: string } }>(commitUrl)

  if (!commitResult.success) {
    return {
      success: false,
      error: commitResult.error,
      rateLimitRemaining: commitResult.rateLimitRemaining,
      rateLimitReset: commitResult.rateLimitReset,
    }
  }

  const treeSha = commitResult.data?.tree.sha
  if (!treeSha) {
    return { success: false, error: `Could not get tree for commit: ${commitSha}` }
  }

  // Get the full tree recursively
  const treeUrl = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/git/trees/${treeSha}?recursive=1`
  const treeResult = await githubFetch<GitHubTree>(treeUrl)

  if (!treeResult.success) {
    return {
      success: false,
      error: treeResult.error,
      rateLimitRemaining: treeResult.rateLimitRemaining,
      rateLimitReset: treeResult.rateLimitReset,
    }
  }

  const files = treeResult.data?.tree
    .filter((item) => item.type === 'blob')
    .map((item) => item.path) || []

  return {
    success: true,
    data: files,
    rateLimitRemaining: treeResult.rateLimitRemaining,
    rateLimitReset: treeResult.rateLimitReset,
  }
}

/**
 * Get changelog content between two versions
 */
export async function getChangelogBetweenVersions(
  repository: string,
  fromVersion: string,
  toVersion: string
): Promise<FetchResult<string>> {
  // Fetch the CHANGELOG.md at the target version
  const result = await fetchFileContent(repository, 'CHANGELOG.md', toVersion)

  if (!result.success) return result

  const changelog = result.data!

  // Parse changelog to extract sections between versions
  // Format: ## [X.Y.Z] - YYYY-MM-DD
  const versionPattern = /^## \[([^\]]+)\]/gm
  const matches = Array.from(changelog.matchAll(versionPattern))

  let startIdx = -1
  let endIdx = changelog.length

  for (let i = 0; i < matches.length; i++) {
    const version = matches[i][1]
    const idx = matches[i].index!

    if (version === toVersion.replace(/^v/, '')) {
      startIdx = idx
    } else if (startIdx !== -1) {
      // Found the end (either fromVersion or the next version after we started)
      if (version === fromVersion.replace(/^v/, '') ||
          compareVersions(version, fromVersion.replace(/^v/, '')) < 0) {
        endIdx = idx
        break
      }
    }
  }

  if (startIdx === -1) {
    // Try to get [Unreleased] section if target is latest
    const unreleasedMatch = changelog.match(/^## \[Unreleased\][\s\S]*?(?=^## \[|$)/m)
    if (unreleasedMatch) {
      return { success: true, data: unreleasedMatch[0], rateLimitRemaining: result.rateLimitRemaining, rateLimitReset: result.rateLimitReset }
    }
    return { success: false, error: `Could not find version ${toVersion} in changelog` }
  }

  const excerpt = changelog.slice(startIdx, endIdx).trim()
  return {
    success: true,
    data: excerpt,
    rateLimitRemaining: result.rateLimitRemaining,
    rateLimitReset: result.rateLimitReset,
  }
}

export interface BreakingChange {
  version: string
  description: string
  migrationGuidance?: string
  type: 'breaking-marker' | 'breaking-section' | 'removed-item'
}

/**
 * Detect breaking changes in changelog between versions
 */
export async function detectBreakingChanges(
  repository: string,
  fromVersion: string,
  toVersion: string
): Promise<FetchResult<BreakingChange[]>> {
  // Get the changelog content between versions
  const changelogResult = await getChangelogBetweenVersions(repository, fromVersion, toVersion)

  if (!changelogResult.success) {
    return {
      success: false,
      error: changelogResult.error,
      rateLimitRemaining: changelogResult.rateLimitRemaining,
      rateLimitReset: changelogResult.rateLimitReset,
    }
  }

  const changelog = changelogResult.data!
  const breakingChanges: BreakingChange[] = []

  // Extract version from changelog header
  const versionMatch = changelog.match(/^## \[([^\]]+)\]/)
  const version = versionMatch ? versionMatch[1] : toVersion.replace(/^v/, '')

  // Pattern 1: **BREAKING**: marker in any line
  const breakingMarkerPattern = /\*\*BREAKING\*\*:\s*(.+?)(?:\n|$)/gi
  const breakingMarkers = Array.from(changelog.matchAll(breakingMarkerPattern))

  for (const match of breakingMarkers) {
    const description = match[1].trim()
    const migrationGuidance = extractMigrationGuidance(match.input!, match.index!)

    breakingChanges.push({
      version,
      description,
      migrationGuidance,
      type: 'breaking-marker',
    })
  }

  // Pattern 2: ### Breaking Changes section
  // Split by section headers to get clean section content
  const sections = changelog.split(/^###\s+/m)
  const breakingSection = sections.find(s => s.trim().startsWith('Breaking Changes'))
  if (breakingSection) {
    // Get content after the section title (first line)
    const sectionContent = breakingSection.split('\n').slice(1).join('\n')
    const items = extractListItems(sectionContent)

    for (const item of items) {
      const migrationGuidance = extractMigrationGuidance(item, 0)

      breakingChanges.push({
        version,
        description: item.replace(/^[-*]\s+/, '').split('\n')[0].trim(),
        migrationGuidance,
        type: 'breaking-section',
      })
    }
  }

  // Pattern 3: ### Removed section
  const removedSection = sections.find(s => s.trim().startsWith('Removed'))
  if (removedSection) {
    // Get content after the section title (first line)
    const sectionContent = removedSection.split('\n').slice(1).join('\n')
    const items = extractListItems(sectionContent)

    for (const item of items) {
      const migrationGuidance = extractMigrationGuidance(item, 0)

      breakingChanges.push({
        version,
        description: item.replace(/^[-*]\s+/, '').split('\n')[0].trim(),
        migrationGuidance,
        type: 'removed-item',
      })
    }
  }

  return {
    success: true,
    data: breakingChanges,
    rateLimitRemaining: changelogResult.rateLimitRemaining,
    rateLimitReset: changelogResult.rateLimitReset,
  }
}

/**
 * Extract migration guidance from text following a breaking change
 * Looks for "Migration:", "Migrate:", or indented guidance text
 */
function extractMigrationGuidance(text: string, startIndex: number): string | undefined {
  const remainingText = text.slice(startIndex)

  // Look for explicit migration markers
  // Use [\s\S] instead of . with /s flag for compatibility
  const migrationMatch = remainingText.match(/\n\s*Migrat(?:e|ion):\s*([\s\S]+?)(?=\n[-*]|\n\n|$)/i)
  if (migrationMatch) {
    return migrationMatch[1].trim()
  }

  // Look for indented text following the item (common in nested lists)
  const indentedMatch = remainingText.match(/\n\s{2,}([\s\S]+?)(?=\n[-*]|\n\n|$)/i)
  if (indentedMatch) {
    return indentedMatch[1].trim()
  }

  return undefined
}

/**
 * Extract list items from markdown section
 * Handles both - and * bullet points
 */
function extractListItems(section: string): string[] {
  const items: string[] = []
  const lines = section.split('\n')
  let currentItem = ''

  for (const line of lines) {
    // Check if line starts a new list item
    if (/^\s*[-*]\s+/.test(line)) {
      if (currentItem) {
        items.push(currentItem.trim())
      }
      currentItem = line
    } else if (currentItem && line.trim()) {
      // Continuation of current item
      currentItem += '\n' + line
    } else if (!line.trim() && currentItem) {
      // Empty line ends current item
      items.push(currentItem.trim())
      currentItem = ''
    }
  }

  // Add last item
  if (currentItem) {
    items.push(currentItem.trim())
  }

  return items.filter((item) => item.length > 0)
}

/**
 * Compare two semver versions
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/, '').split(/[.-]/).map((p) => {
    const num = parseInt(p, 10)
    return isNaN(num) ? p : num
  })
  const partsB = b.replace(/^v/, '').split(/[.-]/).map((p) => {
    const num = parseInt(p, 10)
    return isNaN(num) ? p : num
  })

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] ?? 0
    const partB = partsB[i] ?? 0

    if (typeof partA === 'number' && typeof partB === 'number') {
      if (partA < partB) return -1
      if (partA > partB) return 1
    } else {
      const strA = String(partA)
      const strB = String(partB)
      if (strA < strB) return -1
      if (strA > strB) return 1
    }
  }

  return 0
}

/**
 * Find the latest version from tags
 */
export function findLatestVersion(tags: GitHubTag[]): GitHubTag | null {
  if (tags.length === 0) return null

  // Filter to semver-like tags (v1.2.3 or 1.2.3)
  const semverTags = tags.filter((t) => /^v?\d+\.\d+\.\d+/.test(t.name))

  if (semverTags.length === 0) return tags[0]

  // Sort by version, descending
  semverTags.sort((a, b) => compareVersions(b.name, a.name))

  return semverTags[0]
}

/**
 * Create a backup branch before template updates
 */
export async function createBackupBranch(
  baseName: string = 'template-backup'
): Promise<{ success: boolean; branchName?: string; error?: string }> {
  // Generate timestamp-based branch name
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const branchName = `${baseName}/${timestamp}`

  try {
    // Check if we're in a git repo
    const gitCheck = await execAsync('git rev-parse --git-dir')
    if (!gitCheck.stdout) {
      return { success: false, error: 'Not a git repository' }
    }

    // Check for uncommitted changes
    const statusResult = await execAsync('git status --porcelain')
    if (statusResult.stdout.trim()) {
      return {
        success: false,
        error: 'Uncommitted changes detected. Please commit or stash before updating.'
      }
    }

    // Create the backup branch
    await execAsync(`git branch ${branchName}`)

    return { success: true, branchName }
  } catch (error) {
    return {
      success: false,
      error: `Failed to create backup branch: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * Check if file content matches (no changes needed)
 */
export function filesMatch(localContent: string, templateContent: string): boolean {
  return localContent.trim() === templateContent.trim()
}

/**
 * Generate a simple diff output
 */
function generateDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  let diff = `--- a/${filePath}\n+++ b/${filePath}\n`

  // Simple unified diff format
  const maxLines = Math.max(oldLines.length, newLines.length)
  let contextStart = 0
  let inDiff = false

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]

    if (oldLine === newLine) {
      if (inDiff) {
        diff += ` ${oldLine ?? ''}\n`
      }
      contextStart = i + 1
    } else {
      if (!inDiff) {
        // Start new hunk
        diff += `@@ -${contextStart + 1},${oldLines.length - contextStart} +${contextStart + 1},${newLines.length - contextStart} @@\n`
        inDiff = true
      }

      if (oldLine !== undefined) {
        diff += `-${oldLine}\n`
      }
      if (newLine !== undefined) {
        diff += `+${newLine}\n`
      }
    }
  }

  return diff
}

/**
 * Replace file with template version
 */
export async function replaceFile(
  repository: string,
  ref: string,
  filePath: string,
  localBasePath: string
): Promise<FetchResult<{ action: 'replaced' | 'unchanged' | 'created'; diff?: string }>> {
  // 1. Fetch template file content
  const templateResult = await fetchFileContent(repository, filePath, ref)
  if (!templateResult.success) {
    return {
      success: false,
      error: templateResult.error,
      rateLimitRemaining: templateResult.rateLimitRemaining,
      rateLimitReset: templateResult.rateLimitReset,
    }
  }

  const templateContent = templateResult.data!
  const fullLocalPath = path.join(localBasePath, filePath)

  // 2. Read local file if exists
  let localContent: string | null = null
  try {
    localContent = await fs.readFile(fullLocalPath, 'utf-8')
  } catch {
    // File doesn't exist locally
  }

  // 3. Compare and determine action
  if (localContent === null) {
    // File doesn't exist, will be created
    return {
      success: true,
      data: { action: 'created' },
      rateLimitRemaining: templateResult.rateLimitRemaining,
      rateLimitReset: templateResult.rateLimitReset,
    }
  }

  if (filesMatch(localContent, templateContent)) {
    return {
      success: true,
      data: { action: 'unchanged' },
      rateLimitRemaining: templateResult.rateLimitRemaining,
      rateLimitReset: templateResult.rateLimitReset,
    }
  }

  // 4. Generate diff for verbose mode
  const diff = generateDiff(localContent, templateContent, filePath)

  return {
    success: true,
    data: { action: 'replaced', diff },
    rateLimitRemaining: templateResult.rateLimitRemaining,
    rateLimitReset: templateResult.rateLimitReset,
  }
}

/**
 * Simple glob pattern matcher supporting * and **
 * @param filePath - The file path to test
 * @param pattern - The glob pattern (supports * and **)
 */
function matchesGlob(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  // ** matches any number of path segments
  // * matches any characters within a segment
  const regexPattern = pattern
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR__/g, '.*')
    .replace(/\?/g, '[^/]')

  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(filePath)
}

/**
 * Recursively get all files in a directory matching patterns
 * @param directory - Root directory to search
 * @param patterns - Array of glob patterns to match
 */
async function getLocalFiles(directory: string, patterns: string[]): Promise<string[]> {
  const results: string[] = []

  async function walkDirectory(currentPath: string, relativePath: string = ''): Promise<void> {
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)
        const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name

        if (entry.isDirectory()) {
          // Recursively walk subdirectories
          await walkDirectory(fullPath, relPath)
        } else if (entry.isFile()) {
          // Check if file matches any pattern
          const normalizedPath = relPath.replace(/\\/g, '/') // Normalize to forward slashes
          if (patterns.some(pattern => matchesGlob(normalizedPath, pattern))) {
            results.push(normalizedPath)
          }
        }
      }
    } catch (error) {
      // Silently skip directories we can't read (e.g., permission issues)
      if ((error as NodeJS.ErrnoException).code !== 'EACCES' &&
          (error as NodeJS.ErrnoException).code !== 'EPERM') {
        throw error
      }
    }
  }

  await walkDirectory(directory)
  return results.sort()
}

/**
 * Detect user-created files by comparing local files to template tree
 * @param repository - GitHub repository (owner/repo format)
 * @param ref - Git ref (tag, branch, or commit) to compare against
 * @param localDirectory - Local directory to scan
 * @param patterns - Glob patterns to match (e.g., ['.claude/commands/**', '.claude/skills/**'])
 * @returns Array of file paths that exist locally but not in template
 */
export async function detectUserAdditions(
  repository: string,
  ref: string,
  localDirectory: string,
  patterns: string[]
): Promise<FetchResult<string[]>> {
  try {
    // 1. Fetch file tree from template at ref
    const treeResult = await fetchFileTree(repository, ref)
    if (!treeResult.success) {
      return {
        success: false,
        error: treeResult.error,
        rateLimitRemaining: treeResult.rateLimitRemaining,
        rateLimitReset: treeResult.rateLimitReset,
      }
    }

    // 2. Get template files matching patterns
    const templateFiles = new Set(
      treeResult.data!.filter(filePath =>
        patterns.some(pattern => matchesGlob(filePath, pattern))
      )
    )

    // 3. Get local files matching patterns
    const localFiles = await getLocalFiles(localDirectory, patterns)

    // 4. Return files in local but NOT in template
    const userAdditions = localFiles.filter(filePath => !templateFiles.has(filePath))

    return {
      success: true,
      data: userAdditions,
      rateLimitRemaining: treeResult.rateLimitRemaining,
      rateLimitReset: treeResult.rateLimitReset,
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to detect user additions: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * Three-way diff merge decision
 */
export type MergeDecision =
  | { action: 'replace'; reason: 'template-only-change' | 'new-in-template' }
  | { action: 'keep'; reason: 'user-only-change' | 'deleted-locally' }
  | { action: 'conflict'; reason: 'both-modified' }
  | { action: 'skip'; reason: 'unchanged' | 'not-in-either' }

/**
 * Result of three-way diff analysis
 */
export interface ThreeWayDiffResult {
  decision: MergeDecision
  base?: string      // Content at user's current version
  ours?: string      // Local file content
  theirs?: string    // Content at target version
}

/**
 * Marker section parsed from CLAUDE.md
 */
export interface MarkerSection {
  name: string
  content: string
  startIndex: number
  endIndex: number
}

/**
 * Result of marker-based update
 */
export interface MarkerUpdateResult {
  updated: string[]      // Sections that were updated
  added: string[]        // New sections appended
  deprecated: string[]   // Sections marked as deprecated
  preserved: string[]    // User sections preserved
}

/**
 * Parse marker sections from CLAUDE.md content
 * Format: <!-- template-section-start: name --> ... <!-- template-section-end: name -->
 */
export function parseMarkerSections(content: string): MarkerSection[] {
  const sections: MarkerSection[] = []
  const startPattern = /<!-- template-section-start:\s*([^\s]+)\s*-->/g
  const endPattern = /<!-- template-section-end:\s*([^\s]+)\s*-->/g

  // Find all start markers
  const startMatches = Array.from(content.matchAll(startPattern))
  const endMatches = Array.from(content.matchAll(endPattern))

  // Create a map of end markers for quick lookup
  const endMap = new Map<string, { index: number; match: RegExpMatchArray }[]>()
  for (const match of endMatches) {
    const name = match[1]
    if (!endMap.has(name)) {
      endMap.set(name, [])
    }
    endMap.get(name)!.push({ index: match.index!, match })
  }

  // Match start markers with corresponding end markers
  for (const startMatch of startMatches) {
    const name = startMatch[1]
    const startIndex = startMatch.index!

    // Find the matching end marker (first one after this start)
    const endCandidates = endMap.get(name)
    if (!endCandidates || endCandidates.length === 0) {
      console.warn(`Warning: No matching end marker for section "${name}"`)
      continue
    }

    const endMatch = endCandidates.find(e => e.index > startIndex)
    if (!endMatch) {
      console.warn(`Warning: No matching end marker after start for section "${name}"`)
      continue
    }

    const endIndex = endMatch.index + endMatch.match[0].length

    // Extract content between markers (excluding the markers themselves)
    const contentStart = startIndex + startMatch[0].length
    const contentEnd = endMatch.index
    const sectionContent = content.slice(contentStart, contentEnd)

    sections.push({
      name,
      content: sectionContent,
      startIndex,
      endIndex,
    })
  }

  return sections
}

/**
 * Update CLAUDE.md using marker-based partial updates
 * Preserves content outside markers (user-owned sections)
 */
export function updateClaudeMdMarkers(
  localContent: string,
  templateContent: string
): { result: string; changes: MarkerUpdateResult } {
  const localSections = parseMarkerSections(localContent)
  const templateSections = parseMarkerSections(templateContent)

  const changes: MarkerUpdateResult = {
    updated: [],
    added: [],
    deprecated: [],
    preserved: [],
  }

  // Create maps for quick lookup
  const localMap = new Map(localSections.map(s => [s.name, s]))
  const templateMap = new Map(templateSections.map(s => [s.name, s]))

  // Build result by processing the local content
  let result = localContent

  // Sort local sections by position (descending) so we can replace from end to start
  const sortedLocalSections = [...localSections].sort((a, b) => b.startIndex - a.startIndex)

  // 1. Update existing sections
  for (const localSection of sortedLocalSections) {
    const templateSection = templateMap.get(localSection.name)

    if (templateSection) {
      // Section exists in both - check if content changed
      if (localSection.content.trim() !== templateSection.content.trim()) {
        // Replace the entire section (including markers)
        const fullTemplateSection = `<!-- template-section-start: ${templateSection.name} -->${templateSection.content}<!-- template-section-end: ${templateSection.name} -->`

        const before = result.slice(0, localSection.startIndex)
        const after = result.slice(localSection.endIndex)
        result = before + fullTemplateSection + after

        changes.updated.push(localSection.name)
      } else {
        changes.preserved.push(localSection.name)
      }
    } else {
      // Section exists locally but not in template - mark as deprecated
      const deprecationComment = `<!-- DEPRECATED: This template section is no longer maintained. Consider removing if not needed. -->\n`
      const before = result.slice(0, localSection.startIndex)
      const after = result.slice(localSection.endIndex)
      result = before + deprecationComment + `<!-- template-section-start: ${localSection.name} -->${localSection.content}<!-- template-section-end: ${localSection.name} -->` + after

      changes.deprecated.push(localSection.name)
    }
  }

  // 2. Append new sections from template
  for (const templateSection of templateSections) {
    if (!localMap.has(templateSection.name)) {
      const newSectionNotification = `\n\n<!-- NEW TEMPLATE SECTION ADDED (${new Date().toISOString()}) -->\n`
      const fullTemplateSection = `<!-- template-section-start: ${templateSection.name} -->${templateSection.content}<!-- template-section-end: ${templateSection.name} -->`

      result += newSectionNotification + fullTemplateSection
      changes.added.push(templateSection.name)
    }
  }

  return { result, changes }
}

/**
 * Dependency change information for package.json merge
 */
export interface DepChange {
  name: string
  action: 'added' | 'updated' | 'removed' | 'kept' | 'conflict'
  from?: string  // Previous version
  to?: string    // New version
  reason: string
}

/**
 * Result of package.json three-way merge
 */
export interface PackageJsonMergeResult {
  merged: Record<string, unknown>  // The merged package.json
  changes: {
    dependencies: DepChange[]
    devDependencies: DepChange[]
  }
  conflicts: DepChange[]  // Items needing user review
}

/**
 * Perform three-way diff analysis to determine merge strategy
 *
 * Decision tree:
 * - Base == Ours? → Template-only change → Replace with Theirs
 * - Base == Theirs? → User-only change → Keep Ours
 * - All different? → Both modified → Conflict (Claude-guided merge)
 * - None exist? → Skip
 * - Only Theirs exists? → New in template → Replace
 * - Only Ours exists (no Base)? → User-created → Keep
 *
 * @param repository - GitHub repository (owner/repo format)
 * @param baseRef - User's current template version (e.g., v1.0.0)
 * @param targetRef - Target template version to update to (e.g., v1.1.0)
 * @param filePath - Path to the file relative to repository root
 * @param localBasePath - Local directory containing the file (default: '.')
 * @returns Three-way diff result with merge decision
 */
export async function threeWayDiff(
  repository: string,
  baseRef: string,
  targetRef: string,
  filePath: string,
  localBasePath: string = '.'
): Promise<FetchResult<ThreeWayDiffResult>> {
  // 1. Fetch base (template at user's current version)
  const baseResult = await fetchFileContent(repository, filePath, baseRef)
  const base = baseResult.success ? baseResult.data : undefined

  // 2. Fetch theirs (template at target version)
  const theirsResult = await fetchFileContent(repository, filePath, targetRef)
  const theirs = theirsResult.success ? theirsResult.data : undefined

  // 3. Read ours (local file)
  const fullLocalPath = path.join(localBasePath, filePath)
  let ours: string | undefined
  try {
    ours = await fs.readFile(fullLocalPath, 'utf-8')
  } catch {
    // File doesn't exist locally
    ours = undefined
  }

  // 4. Apply decision tree
  let decision: MergeDecision

  // Case: None exist (shouldn't happen, but handle gracefully)
  if (!base && !ours && !theirs) {
    decision = { action: 'skip', reason: 'not-in-either' }
  }
  // Case: New in template (no base, no ours, but theirs exists)
  else if (!base && !ours && theirs) {
    decision = { action: 'replace', reason: 'new-in-template' }
  }
  // Case: Deleted locally (base exists, ours deleted, theirs exists)
  else if (base && !ours && theirs) {
    decision = { action: 'keep', reason: 'deleted-locally' }
  }
  // Case: User-created file (no base, ours exists, no theirs - or theirs same as ours)
  else if (!base && ours && !theirs) {
    decision = { action: 'keep', reason: 'user-only-change' }
  }
  // Case: File removed from template (base exists, no theirs)
  else if (base && !theirs) {
    decision = { action: 'keep', reason: 'user-only-change' }
  }
  // Case: No changes anywhere (all three match or base == ours == theirs)
  else if (base && ours && theirs && filesMatch(base, ours) && filesMatch(base, theirs)) {
    decision = { action: 'skip', reason: 'unchanged' }
  }
  // Case: Template-only change (base == ours, but theirs different)
  else if (base && ours && theirs && filesMatch(base, ours) && !filesMatch(base, theirs)) {
    decision = { action: 'replace', reason: 'template-only-change' }
  }
  // Case: User-only change (base == theirs, but ours different)
  else if (base && ours && theirs && filesMatch(base, theirs) && !filesMatch(base, ours)) {
    decision = { action: 'keep', reason: 'user-only-change' }
  }
  // Case: Both modified (base != ours && base != theirs && ours != theirs)
  else if (base && ours && theirs && !filesMatch(base, ours) && !filesMatch(base, theirs)) {
    decision = { action: 'conflict', reason: 'both-modified' }
  }
  // Fallback: If we somehow don't match any case, treat as conflict
  else {
    decision = { action: 'conflict', reason: 'both-modified' }
  }

  // 5. Return result
  return {
    success: true,
    data: {
      decision,
      base,
      ours,
      theirs,
    },
    rateLimitRemaining: theirsResult.rateLimitRemaining ?? baseResult.rateLimitRemaining,
    rateLimitReset: theirsResult.rateLimitReset ?? baseResult.rateLimitReset,
  }
}

/**
 * Merge dependencies using three-way logic
 *
 * Merge Rules:
 * | Base | Ours | Theirs | Action |
 * |------|------|--------|--------|
 * | A@1  | A@1  | A@2    | Update to A@2 (template changed) |
 * | A@1  | A@2  | A@1    | Keep A@2 (user changed) |
 * | A@1  | A@2  | A@3    | Conflict - keep A@2, flag for review |
 * | -    | -    | A@1    | Add A@1 (new in template) |
 * | A@1  | A@1  | -      | Remove A (template removed) |
 * | -    | A@1  | -      | Keep A@1 (user added) |
 *
 * @param baseDeps - Dependencies at base version (user's current template version)
 * @param oursDeps - Dependencies in local package.json
 * @param theirsDeps - Dependencies in target template version
 * @returns Merged dependencies and list of changes
 */
function mergeDependencies(
  baseDeps: Record<string, string> = {},
  oursDeps: Record<string, string> = {},
  theirsDeps: Record<string, string> = {}
): { merged: Record<string, string>; changes: DepChange[] } {
  const merged: Record<string, string> = {}
  const changes: DepChange[] = []

  // Get all unique dependency names
  const allDeps = new Set([
    ...Object.keys(baseDeps),
    ...Object.keys(oursDeps),
    ...Object.keys(theirsDeps),
  ])

  for (const name of Array.from(allDeps)) {
    const baseVer = baseDeps[name]
    const oursVer = oursDeps[name]
    const theirsVer = theirsDeps[name]

    // Case 1: New in template (not in base or ours, but in theirs)
    if (!baseVer && !oursVer && theirsVer) {
      merged[name] = theirsVer
      changes.push({
        name,
        action: 'added',
        to: theirsVer,
        reason: 'New dependency in template',
      })
    }
    // Case 2: User added (not in base or theirs, but in ours)
    else if (!baseVer && !theirsVer && oursVer) {
      merged[name] = oursVer
      changes.push({
        name,
        action: 'kept',
        from: oursVer,
        reason: 'User-added dependency',
      })
    }
    // Case 3: Template removed, user unchanged (in base and ours same, not in theirs)
    else if (baseVer && oursVer && !theirsVer && baseVer === oursVer) {
      // Don't include in merged (removed)
      changes.push({
        name,
        action: 'removed',
        from: oursVer,
        reason: 'Template removed dependency',
      })
    }
    // Case 4: Template removed, user changed (in base, in ours different, not in theirs)
    else if (baseVer && oursVer && !theirsVer && baseVer !== oursVer) {
      // Keep user's version (user modified before template removed it)
      merged[name] = oursVer
      changes.push({
        name,
        action: 'kept',
        from: oursVer,
        reason: 'User modified before template removal',
      })
    }
    // Case 5: All three exist
    else if (baseVer && oursVer && theirsVer) {
      // Subcase: User unchanged, template changed (base == ours, theirs different)
      if (baseVer === oursVer && theirsVer !== baseVer) {
        merged[name] = theirsVer
        changes.push({
          name,
          action: 'updated',
          from: oursVer,
          to: theirsVer,
          reason: 'Template updated version',
        })
      }
      // Subcase: User changed, template unchanged (base == theirs, ours different)
      else if (baseVer === theirsVer && oursVer !== baseVer) {
        merged[name] = oursVer
        changes.push({
          name,
          action: 'kept',
          from: oursVer,
          reason: 'User modified version',
        })
      }
      // Subcase: Both changed to same version
      else if (oursVer === theirsVer && baseVer !== oursVer) {
        merged[name] = oursVer
        changes.push({
          name,
          action: 'kept',
          from: oursVer,
          reason: 'Both changed to same version',
        })
      }
      // Subcase: All same (no change)
      else if (baseVer === oursVer && oursVer === theirsVer) {
        merged[name] = oursVer
        // No change entry for unchanged deps
      }
      // Subcase: Both changed to different versions (conflict)
      else if (oursVer !== baseVer && theirsVer !== baseVer && oursVer !== theirsVer) {
        // Keep user's version, but flag as conflict
        merged[name] = oursVer
        changes.push({
          name,
          action: 'conflict',
          from: oursVer,
          to: theirsVer,
          reason: `Both modified: user set ${oursVer}, template set ${theirsVer}`,
        })
      }
    }
    // Case 6: Only in base and ours (template removed in theirs)
    else if (baseVer && oursVer && !theirsVer) {
      // Already handled above
    }
    // Case 7: Only in base and theirs (user removed locally)
    else if (baseVer && !oursVer && theirsVer) {
      // Don't include - user intentionally removed
      changes.push({
        name,
        action: 'kept',
        reason: 'User removed locally',
      })
    }
  }

  return { merged, changes }
}

/**
 * Perform three-way merge of package.json files
 *
 * Merges dependencies and devDependencies sections using three-way logic.
 * Preserves all other fields from "ours" (local version).
 *
 * @param base - package.json at base version (user's current template version)
 * @param ours - Local package.json
 * @param theirs - package.json at target template version
 * @returns Merge result with merged package.json, changes, and conflicts
 */
export function mergePackageJson(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>
): PackageJsonMergeResult {
  // Start with "ours" as the base (preserves all non-dependency fields)
  const merged = { ...ours }

  // Extract dependency objects (ensure they're Record<string, string>)
  const baseDeps = (base.dependencies as Record<string, string>) ?? {}
  const oursDeps = (ours.dependencies as Record<string, string>) ?? {}
  const theirsDeps = (theirs.dependencies as Record<string, string>) ?? {}

  const baseDevDeps = (base.devDependencies as Record<string, string>) ?? {}
  const oursDevDeps = (ours.devDependencies as Record<string, string>) ?? {}
  const theirsDevDeps = (theirs.devDependencies as Record<string, string>) ?? {}

  // Merge dependencies
  const depsResult = mergeDependencies(baseDeps, oursDeps, theirsDeps)
  const devDepsResult = mergeDependencies(baseDevDeps, oursDevDeps, theirsDevDeps)

  // Update merged object with merged dependencies
  if (Object.keys(depsResult.merged).length > 0) {
    merged.dependencies = depsResult.merged
  } else {
    delete merged.dependencies
  }

  if (Object.keys(devDepsResult.merged).length > 0) {
    merged.devDependencies = devDepsResult.merged
  } else {
    delete merged.devDependencies
  }

  // Collect all conflicts
  const conflicts = [
    ...depsResult.changes.filter((c) => c.action === 'conflict'),
    ...devDepsResult.changes.filter((c) => c.action === 'conflict'),
  ]

  return {
    merged,
    changes: {
      dependencies: depsResult.changes,
      devDependencies: devDepsResult.changes,
    },
    conflicts,
  }
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'tags': {
      const repo = args[1]
      if (!repo) {
        console.error('Usage: template-fetch.ts tags <owner/repo>')
        process.exit(1)
      }
      const result = await fetchTags(repo)
      if (!result.success) {
        console.error(result.error)
        process.exit(1)
      }
      console.log(JSON.stringify(result.data, null, 2))
      break
    }

    case 'releases': {
      const repo = args[1]
      if (!repo) {
        console.error('Usage: template-fetch.ts releases <owner/repo>')
        process.exit(1)
      }
      const result = await fetchReleases(repo)
      if (!result.success) {
        console.error(result.error)
        process.exit(1)
      }
      console.log(JSON.stringify(result.data, null, 2))
      break
    }

    case 'file': {
      const repo = args[1]
      const path = args[2]
      const ref = args[3]
      if (!repo || !path || !ref) {
        console.error('Usage: template-fetch.ts file <owner/repo> <path> <ref>')
        process.exit(1)
      }
      const result = await fetchFileContent(repo, path, ref)
      if (!result.success) {
        console.error(result.error)
        process.exit(1)
      }
      console.log(result.data)
      break
    }

    case 'tree': {
      const repo = args[1]
      const ref = args[2]
      if (!repo || !ref) {
        console.error('Usage: template-fetch.ts tree <owner/repo> <ref>')
        process.exit(1)
      }
      const result = await fetchFileTree(repo, ref)
      if (!result.success) {
        console.error(result.error)
        process.exit(1)
      }
      console.log(JSON.stringify(result.data, null, 2))
      break
    }

    case 'changelog': {
      const repo = args[1]
      const fromVersion = args[2]
      const toVersion = args[3]
      if (!repo || !fromVersion || !toVersion) {
        console.error('Usage: template-fetch.ts changelog <owner/repo> <from-version> <to-version>')
        process.exit(1)
      }
      const result = await getChangelogBetweenVersions(repo, fromVersion, toVersion)
      if (!result.success) {
        console.error(result.error)
        process.exit(1)
      }
      console.log(result.data)
      break
    }

    case 'detect-additions': {
      const repo = args[1]
      const ref = args[2]
      const localDir = args[3]
      const patterns = args.slice(4)
      if (!repo || !ref || !localDir || patterns.length === 0) {
        console.error('Usage: template-fetch.ts detect-additions <owner/repo> <ref> <local-dir> <pattern1> [pattern2...]')
        console.error('Example: template-fetch.ts detect-additions user/repo v1.0.0 /path/to/repo ".claude/commands/**" ".claude/skills/**"')
        process.exit(1)
      }
      const result = await detectUserAdditions(repo, ref, localDir, patterns)
      if (!result.success) {
        console.error(result.error)
        process.exit(1)
      }
      console.log(JSON.stringify(result.data, null, 2))
      break
    }

    case 'breaking': {
      const repo = args[1]
      const fromVersion = args[2]
      const toVersion = args[3]
      if (!repo || !fromVersion || !toVersion) {
        console.error('Usage: template-fetch.ts breaking <owner/repo> <from-version> <to-version>')
        console.error('Example: template-fetch.ts breaking vercel/next.js v14.0.0 v15.0.0')
        process.exit(1)
      }
      const result = await detectBreakingChanges(repo, fromVersion, toVersion)
      if (!result.success) {
        console.error(result.error)
        process.exit(1)
      }

      if (result.data && result.data.length > 0) {
        console.log('\n🚨 Breaking Changes Detected:\n')
        for (const change of result.data) {
          console.log(`[${change.type}] ${change.description}`)
          if (change.migrationGuidance) {
            console.log(`  Migration: ${change.migrationGuidance}`)
          }
          console.log('')
        }
      } else {
        console.log('✅ No breaking changes detected')
      }
      break
    }

    case 'diff': {
      const repo = args[1]
      const baseRef = args[2]
      const targetRef = args[3]
      const filePath = args[4]
      const localDir = args[5] || '.'
      if (!repo || !baseRef || !targetRef || !filePath) {
        console.error('Usage: template-fetch.ts diff <owner/repo> <base-ref> <target-ref> <file-path> [local-dir]')
        console.error('Example: template-fetch.ts diff user/repo v1.0.0 v1.1.0 .claude/commands/git-commit.ts')
        process.exit(1)
      }
      const result = await threeWayDiff(repo, baseRef, targetRef, filePath, localDir)
      if (!result.success) {
        console.error(result.error)
        process.exit(1)
      }

      const { decision, base, ours, theirs } = result.data!
      console.log(`\n📊 Three-Way Diff Analysis: ${filePath}\n`)
      console.log(`Decision: ${decision.action.toUpperCase()} (${decision.reason})`)
      console.log(`\nFile exists:`)
      console.log(`  Base (${baseRef}):   ${base !== undefined ? '✓' : '✗'}`)
      console.log(`  Ours (local):        ${ours !== undefined ? '✓' : '✗'}`)
      console.log(`  Theirs (${targetRef}): ${theirs !== undefined ? '✓' : '✗'}`)

      if (decision.action === 'conflict') {
        console.log(`\n⚠️  CONFLICT: Both template and local file modified`)
        console.log(`This will require manual merge or Claude-guided resolution.`)
      } else if (decision.action === 'replace') {
        console.log(`\n✅ Safe to replace: ${decision.reason}`)
      } else if (decision.action === 'keep') {
        console.log(`\n✅ Keep local version: ${decision.reason}`)
      } else {
        console.log(`\n⏭️  No action needed: ${decision.reason}`)
      }
      break
    }

    case 'markers': {
      const localFile = args[1]
      const templateFile = args[2]
      if (!localFile || !templateFile) {
        console.error('Usage: template-fetch.ts markers <local-file> <template-file>')
        console.error('Example: template-fetch.ts markers CLAUDE.md template-CLAUDE.md')
        process.exit(1)
      }

      try {
        const localContent = await fs.readFile(localFile, 'utf-8')
        const templateContent = await fs.readFile(templateFile, 'utf-8')

        const { result, changes } = updateClaudeMdMarkers(localContent, templateContent)

        console.log('\n📝 Marker-Based Update Results\n')
        console.log(`Updated sections: ${changes.updated.length}`)
        if (changes.updated.length > 0) {
          changes.updated.forEach(name => console.log(`  - ${name}`))
        }

        console.log(`\nAdded sections: ${changes.added.length}`)
        if (changes.added.length > 0) {
          changes.added.forEach(name => console.log(`  + ${name}`))
        }

        console.log(`\nDeprecated sections: ${changes.deprecated.length}`)
        if (changes.deprecated.length > 0) {
          changes.deprecated.forEach(name => console.log(`  ! ${name}`))
        }

        console.log(`\nPreserved sections: ${changes.preserved.length}`)
        if (changes.preserved.length > 0) {
          changes.preserved.forEach(name => console.log(`  ✓ ${name}`))
        }

        console.log('\n---\n')
        console.log(result)
      } catch (error) {
        console.error(`Error reading files: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
      break
    }

    case 'merge-pkg': {
      const baseFile = args[1]
      const oursFile = args[2]
      const theirsFile = args[3]
      if (!baseFile || !oursFile || !theirsFile) {
        console.error('Usage: template-fetch.ts merge-pkg <base-file> <ours-file> <theirs-file>')
        console.error('Example: template-fetch.ts merge-pkg base.json ours.json theirs.json')
        process.exit(1)
      }

      try {
        // Read all three package.json files
        const base = JSON.parse(await fs.readFile(baseFile, 'utf-8')) as Record<string, unknown>
        const ours = JSON.parse(await fs.readFile(oursFile, 'utf-8')) as Record<string, unknown>
        const theirs = JSON.parse(await fs.readFile(theirsFile, 'utf-8')) as Record<string, unknown>

        // Perform merge
        const result = mergePackageJson(base, ours, theirs)

        // Display results
        console.log('\n📦 Package.json Three-Way Merge\n')

        // Display dependency changes
        if (result.changes.dependencies.length > 0) {
          console.log('Dependencies:')
          for (const change of result.changes.dependencies) {
            const icon = change.action === 'added' ? '➕' :
                        change.action === 'updated' ? '⬆️' :
                        change.action === 'removed' ? '➖' :
                        change.action === 'conflict' ? '⚠️' : '✓'

            let line = `  ${icon} ${change.name}`
            if (change.from && change.to) {
              line += `: ${change.from} → ${change.to}`
            } else if (change.to) {
              line += `: ${change.to}`
            } else if (change.from) {
              line += ` (${change.from})`
            }
            console.log(line)
            console.log(`     ${change.reason}`)
          }
          console.log('')
        }

        // Display devDependency changes
        if (result.changes.devDependencies.length > 0) {
          console.log('DevDependencies:')
          for (const change of result.changes.devDependencies) {
            const icon = change.action === 'added' ? '➕' :
                        change.action === 'updated' ? '⬆️' :
                        change.action === 'removed' ? '➖' :
                        change.action === 'conflict' ? '⚠️' : '✓'

            let line = `  ${icon} ${change.name}`
            if (change.from && change.to) {
              line += `: ${change.from} → ${change.to}`
            } else if (change.to) {
              line += `: ${change.to}`
            } else if (change.from) {
              line += ` (${change.from})`
            }
            console.log(line)
            console.log(`     ${change.reason}`)
          }
          console.log('')
        }

        // Display conflicts
        if (result.conflicts.length > 0) {
          console.log('⚠️  Conflicts requiring review:')
          for (const conflict of result.conflicts) {
            console.log(`  - ${conflict.name}: ${conflict.reason}`)
          }
          console.log('')
        }

        // Display merged result
        console.log('Merged package.json:')
        console.log(JSON.stringify(result.merged, null, 2))
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
      break
    }


    default:
      console.error('Usage: template-fetch.ts <tags|releases|file|tree|changelog|detect-additions|breaking|diff|markers> [args...]')
      process.exit(1)
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}
