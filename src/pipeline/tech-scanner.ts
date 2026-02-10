/**
 * Tech Scanner
 *
 * Shared tech detection module that identifies technology stacks in a
 * repository worktree. All pipeline runners consume this to determine
 * which test, lint, and build commands to use.
 *
 * Supports: Node.js, .NET, Python
 * A mixed repo can return multiple TechStack entries.
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'

// ============================================================================
// Types
// ============================================================================

export interface TechStack {
  /** Technology type (e.g. 'node', 'dotnet', 'python'). */
  type: 'node' | 'dotnet' | 'python'
  /** Root path of the overall worktree. */
  rootPath: string
  /** Absolute path where the tech was detected (e.g. path to package.json's directory). */
  absolutePath: string
  /** How the tech was detected (e.g. 'package.json', '*.sln', 'pyproject.toml'). */
  detectedVia: string
  /** Available commands for this stack. */
  commands: {
    test?: string
    lint?: string
    build?: string
  }
  /** File extensions that are lintable for this stack. */
  lintableExtensions: string[]
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Detect all technology stacks present in a worktree.
 * Scans root and one level deep. Returns all detected stacks
 * (a mixed repo returns multiple entries).
 */
export function detectTechStacks(worktreePath: string): TechStack[] {
  const stacks: TechStack[] = []

  stacks.push(...detectNode(worktreePath))
  stacks.push(...detectDotnet(worktreePath))
  stacks.push(...detectPython(worktreePath))

  return stacks
}

// ============================================================================
// Node.js Detection
// ============================================================================

/**
 * Detect Node.js projects by looking for package.json at root and one level deep.
 * Reads scripts to detect test/lint/build commands.
 * Checks dependencies for eslint as fallback lint.
 */
function detectNode(worktreePath: string): TechStack[] {
  const stacks: TechStack[] = []
  const candidates: string[] = []

  // Check root
  const rootPkg = join(worktreePath, 'package.json')
  if (existsSync(rootPkg)) {
    candidates.push(rootPkg)
  }

  // Check one level deep (exclude node_modules)
  try {
    const entries = readdirSync(worktreePath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const nested = join(worktreePath, entry.name, 'package.json')
      if (existsSync(nested)) {
        candidates.push(nested)
      }
    }
  } catch {
    // Directory not readable — skip
  }

  for (const pkgPath of candidates) {
    try {
      const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const scripts = pkgJson.scripts || {}
      const deps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
      }

      const commands: TechStack['commands'] = {}

      // Test command
      if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
        commands.test = 'npm test'
      }

      // Lint command
      if (scripts.lint) {
        commands.lint = 'npm run lint'
      } else if (deps?.eslint) {
        commands.lint = 'npx eslint .'
      }

      // Build command
      if (scripts.build) {
        commands.build = 'npm run build'
      }

      stacks.push({
        type: 'node',
        rootPath: worktreePath,
        absolutePath: dirname(pkgPath),
        detectedVia: 'package.json',
        commands,
        lintableExtensions: ['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs'],
      })
    } catch {
      // Malformed package.json — skip
    }
  }

  return stacks
}

// ============================================================================
// .NET Detection
// ============================================================================

/**
 * Detect .NET projects by looking for *.sln at root, then *.csproj at root
 * and one level deep. Commands are always available with the .NET SDK.
 */
function detectDotnet(worktreePath: string): TechStack[] {
  const stacks: TechStack[] = []

  const dotnetCommands: TechStack['commands'] = {
    test: 'dotnet test',
    lint: 'dotnet format --verify-no-changes',
    build: 'dotnet build',
  }
  const dotnetExtensions = ['.cs', '.fs', '.vb']

  // Check root for *.sln
  try {
    const rootEntries = readdirSync(worktreePath, { withFileTypes: true })
    const slnFiles = rootEntries.filter((e) => e.isFile() && e.name.endsWith('.sln'))

    if (slnFiles.length > 0) {
      // Solution file found — this covers the whole project
      stacks.push({
        type: 'dotnet',
        rootPath: worktreePath,
        absolutePath: worktreePath,
        detectedVia: slnFiles[0].name,
        commands: { ...dotnetCommands },
        lintableExtensions: [...dotnetExtensions],
      })
      return stacks
    }
  } catch {
    // Directory not readable — skip
  }

  // No .sln — look for *.csproj at root and one level deep
  const csprojPaths: string[] = []

  try {
    const rootEntries = readdirSync(worktreePath, { withFileTypes: true })

    // Root-level .csproj
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.endsWith('.csproj')) {
        csprojPaths.push(join(worktreePath, entry.name))
      }
    }

    // One level deep
    for (const entry of rootEntries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      try {
        const subEntries = readdirSync(join(worktreePath, entry.name), { withFileTypes: true })
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith('.csproj')) {
            csprojPaths.push(join(worktreePath, entry.name, sub.name))
          }
        }
      } catch {
        // Sub-directory not readable — skip
      }
    }
  } catch {
    // Root not readable — skip
  }

  for (const csprojPath of csprojPaths) {
    stacks.push({
      type: 'dotnet',
      rootPath: worktreePath,
      absolutePath: dirname(csprojPath),
      detectedVia: csprojPath.slice(worktreePath.length + 1), // relative path
      commands: { ...dotnetCommands },
      lintableExtensions: [...dotnetExtensions],
    })
  }

  return stacks
}

// ============================================================================
// Python Detection
// ============================================================================

/** Marker files that indicate a Python project at root level. */
const PYTHON_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'] as const

/**
 * Detect Python projects by looking for common marker files at root.
 * Reads pyproject.toml/requirements.txt to detect available tools.
 */
function detectPython(worktreePath: string): TechStack[] {
  let detectedVia: string | null = null

  for (const marker of PYTHON_MARKERS) {
    if (existsSync(join(worktreePath, marker))) {
      detectedVia = marker
      break
    }
  }

  if (!detectedVia) return []

  // Read all available content for dependency/config detection
  const pyprojectContent = readFileSafe(join(worktreePath, 'pyproject.toml'))
  const requirementsContent = readFileSafe(join(worktreePath, 'requirements.txt'))
  const setupContent = readFileSafe(join(worktreePath, 'setup.py'))
  const setupCfgContent = readFileSafe(join(worktreePath, 'setup.cfg'))

  const allContent = [pyprojectContent, requirementsContent, setupContent, setupCfgContent].join('\n')

  const commands: TechStack['commands'] = {}

  // Test command: only set if pytest is detected in deps
  if (hasPythonDep(allContent, 'pytest')) {
    commands.test = 'pytest'
  }
  // else: no test command — don't assume pytest is installed

  // Lint command: prefer ruff, then flake8, else skip
  if (hasPythonDep(allContent, 'ruff')) {
    commands.lint = 'ruff check .'
  } else if (hasPythonDep(allContent, 'flake8')) {
    commands.lint = 'flake8'
  }
  // else: no lint command

  // Build command: only if pyproject.toml has [build-system]
  if (pyprojectContent && pyprojectContent.includes('[build-system]')) {
    commands.build = 'python -m build'
  }

  return [
    {
      type: 'python',
      rootPath: worktreePath,
      absolutePath: worktreePath,
      detectedVia,
      commands,
      lintableExtensions: ['.py', '.pyi'],
    },
  ]
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read a file and return its content, or null if it doesn't exist / can't be read.
 */
function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Maximum content size to scan for dependencies (1MB). Prevents ReDoS on huge files. */
const MAX_CONTENT_SIZE = 1024 * 1024

/**
 * Check if a Python dependency name appears in combined project content.
 * Simple substring match — handles pyproject.toml, requirements.txt, setup.py, setup.cfg.
 *
 * Security:
 * - Validates dep against a safe pattern to prevent regex injection
 * - Limits content size to prevent ReDoS attacks with specially crafted large files
 * - Escapes dep before using in RegExp for defense-in-depth
 */
function hasPythonDep(content: string, dep: string): boolean {
  // Validate dep is a reasonable Python package name (alphanumeric, hyphens, underscores)
  // This prevents any regex injection even if escapeRegex has edge cases
  if (!/^[a-zA-Z0-9_-]+$/.test(dep)) {
    return false
  }

  // Limit content size to prevent ReDoS attacks
  const safeContent = content.length > MAX_CONTENT_SIZE
    ? content.slice(0, MAX_CONTENT_SIZE)
    : content

  // Match the dep name as a word boundary (avoid partial matches like "ruff" in "scruff")
  // Patterns: "ruff", 'ruff', ruff==, ruff>=, ruff[, ruff\n, ruff (in requirements.txt lines)
  const escapedDep = escapeRegex(dep)
  const pattern = new RegExp(`(?:^|['"\\s,])${escapedDep}(?:['"\\s,>=<!\\[\\]]|$)`, 'm')
  return pattern.test(safeContent)
}
