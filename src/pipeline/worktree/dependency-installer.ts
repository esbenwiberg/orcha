/**
 * Dependency Installer
 *
 * Automatically installs dependencies for detected tech stacks in a worktree.
 * This prevents gate failures due to missing dependencies (e.g. npm packages,
 * Python packages, .NET NuGet packages).
 *
 * Logs installation output to: ~/.orcha/pipelines/{id}/logs/dependency-install.log
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { TechStack } from '../tech-scanner.js'

// ============================================================================
// Types
// ============================================================================

export interface InstallResult {
  /** Whether all installations succeeded. */
  success: boolean
  /** Tech stacks that failed installation. */
  failedTechs: string[]
  /** Combined output from all installations. */
  output: string
  /** Error messages (empty if success). */
  errors: string[]
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Install dependencies for all detected tech stacks in a worktree.
 *
 * Detects package manager and runs installation commands. Captures output
 * and handles failures gracefully (doesn't throw — returns failed techs).
 *
 * @param worktreePath - Absolute path to the worktree
 * @param techStacks - Tech stacks detected by tech-scanner
 * @returns InstallResult with success status and failed techs
 */
export async function installDependencies(
  worktreePath: string,
  techStacks: TechStack[],
): Promise<InstallResult> {
  const outputs: string[] = []
  const errors: string[] = []
  const failedTechs: string[] = []

  for (const stack of techStacks) {
    try {
      const result = await installStackDependencies(stack)
      outputs.push(`\n=== ${stack.type.toUpperCase()} (${stack.absolutePath}) ===\n`)
      outputs.push(result.output)

      if (!result.success) {
        failedTechs.push(stack.type)
        errors.push(`${stack.type}: ${result.error}`)
      }
    } catch (err) {
      const errorMsg = (err as Error).message
      failedTechs.push(stack.type)
      errors.push(`${stack.type}: ${errorMsg}`)
      outputs.push(`\n=== ${stack.type.toUpperCase()} (${stack.absolutePath}) ===\n`)
      outputs.push(`ERROR: ${errorMsg}\n`)
    }
  }

  return {
    success: failedTechs.length === 0,
    failedTechs: [...new Set(failedTechs)], // deduplicate
    output: outputs.join('\n'),
    errors,
  }
}

// ============================================================================
// Per-Stack Installers
// ============================================================================

interface StackInstallResult {
  success: boolean
  output: string
  error?: string
}

/**
 * Install dependencies for a single tech stack.
 */
async function installStackDependencies(stack: TechStack): Promise<StackInstallResult> {
  switch (stack.type) {
    case 'node':
      return installNodeDependencies(stack)
    case 'python':
      return installPythonDependencies(stack)
    case 'dotnet':
      return installDotnetDependencies(stack)
    default:
      return {
        success: false,
        output: '',
        error: `Unknown tech type: ${(stack as TechStack).type}`,
      }
  }
}

/**
 * Install Node.js dependencies using npm/yarn/pnpm.
 * Detects which package manager to use based on lock files.
 */
function installNodeDependencies(stack: TechStack): StackInstallResult {
  const cwd = stack.absolutePath
  const execOpts = {
    cwd,
    encoding: 'utf-8' as const,
    timeout: 300000, // 5 minute timeout
    stdio: 'pipe' as const,
    env: process.env, // Inherit parent PATH for npm hooks and binaries
  }

  // Detect package manager
  let installCmd: string
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) {
    installCmd = 'pnpm install'
  } else if (existsSync(join(cwd, 'yarn.lock'))) {
    installCmd = 'yarn install'
  } else {
    installCmd = 'npm install'
  }

  try {
    const output = execSync(installCmd, execOpts)
    return {
      success: true,
      output: `${installCmd}\n${output}`,
    }
  } catch (err: unknown) {
    const error = err as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      success: false,
      output: [
        `${installCmd}`,
        error.stdout || '',
        error.stderr || '',
      ].join('\n'),
      error: error.stderr || error.message || 'Installation failed',
    }
  }
}

/**
 * Install Python dependencies using pip.
 * Installs from requirements.txt, pyproject.toml, or setup.py.
 */
function installPythonDependencies(stack: TechStack): StackInstallResult {
  const cwd = stack.absolutePath
  const execOpts = {
    cwd,
    encoding: 'utf-8' as const,
    timeout: 300000, // 5 minute timeout
    stdio: 'pipe' as const,
    env: process.env, // Inherit parent PATH for pip and python binaries
  }

  // Try different installation methods in order of preference
  const installAttempts: Array<{ cmd: string; file: string }> = [
    { cmd: 'pip install -r requirements.txt', file: 'requirements.txt' },
    { cmd: 'pip install -e .', file: 'pyproject.toml' },
    { cmd: 'pip install -e .', file: 'setup.py' },
  ]

  for (const attempt of installAttempts) {
    if (!existsSync(join(cwd, attempt.file))) continue

    try {
      const output = execSync(attempt.cmd, execOpts)
      return {
        success: true,
        output: `${attempt.cmd}\n${output}`,
      }
    } catch (err: unknown) {
      const error = err as { status?: number; stdout?: string; stderr?: string; message?: string }
      // If requirements.txt fails, try next method
      if (attempt.file === 'requirements.txt') continue

      return {
        success: false,
        output: [
          `${attempt.cmd}`,
          error.stdout || '',
          error.stderr || '',
        ].join('\n'),
        error: error.stderr || error.message || 'Installation failed',
      }
    }
  }

  // No installation files found
  return {
    success: true,
    output: 'No installation files found (requirements.txt, pyproject.toml, setup.py). Skipping.',
  }
}

/**
 * Install .NET dependencies using dotnet restore.
 */
function installDotnetDependencies(stack: TechStack): StackInstallResult {
  const cwd = stack.absolutePath
  const execOpts = {
    cwd,
    encoding: 'utf-8' as const,
    timeout: 300000, // 5 minute timeout
    stdio: 'pipe' as const,
    env: process.env, // Inherit parent PATH for dotnet binary
  }

  const installCmd = 'dotnet restore'

  try {
    const output = execSync(installCmd, execOpts)
    return {
      success: true,
      output: `${installCmd}\n${output}`,
    }
  } catch (err: unknown) {
    const error = err as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      success: false,
      output: [
        `${installCmd}`,
        error.stdout || '',
        error.stderr || '',
      ].join('\n'),
      error: error.stderr || error.message || 'Installation failed',
    }
  }
}
