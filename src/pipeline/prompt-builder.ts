/**
 * Prompt Builder
 *
 * Assembles stage-specific prompts with:
 * - Role context (what the agent is expected to do)
 * - Work item details and acceptance criteria
 * - Codebase context (tree, key files)
 * - Learning hints (placeholder for M13)
 */

import { execSync } from 'child_process'

// ============================================================================
// Types
// ============================================================================

export interface WorkItemContext {
  /** External identifier (e.g. GitHub issue number). */
  workItemId?: string
  /** Human-readable description of the task. */
  description: string
  /** Acceptance criteria the work must satisfy. */
  acceptanceCriteria: string[]
  /** Full issue body (for architect reasoning). */
  issueBody?: string
}

export interface CodebaseContext {
  /** Absolute path to the worktree root. */
  worktreePath: string
  /** Source branch name. */
  sourceBranch: string
}

export interface PromptParts {
  /** The system prompt (injected via --append-system-prompt). */
  systemPrompt: string
  /** The user prompt (passed to -p). */
  userPrompt: string
}

// ============================================================================
// Codebase Introspection
// ============================================================================

/**
 * Get a compact directory tree of the worktree (max 3 levels, excluding noise).
 */
function getCodebaseTree(worktreePath: string): string {
  try {
    // Use find to list directories (more portable than tree)
    const result = execSync(
      'find . -maxdepth 3 -type d ' +
      '\\( -name node_modules -o -name .git -o -name dist -o -name coverage -o -name .next -o -name __pycache__ \\) -prune ' +
      '-o -type d -print | head -80 | sort',
      { cwd: worktreePath, encoding: 'utf-8', timeout: 5000 },
    ).trim()
    return result || '(unable to read directory tree)'
  } catch {
    return '(unable to read directory tree)'
  }
}

/**
 * List key files that likely define the project structure.
 */
function getKeyFiles(worktreePath: string): string {
  try {
    const result = execSync(
      'find . -maxdepth 2 -type f ' +
      '\\( -name "package.json" -o -name "tsconfig.json" -o -name "Cargo.toml" ' +
      '-o -name "go.mod" -o -name "pyproject.toml" -o -name "Makefile" ' +
      '-o -name "CLAUDE.md" -o -name ".clauderc" -o -name "README.md" \\) ' +
      '| head -20 | sort',
      { cwd: worktreePath, encoding: 'utf-8', timeout: 5000 },
    ).trim()
    return result || '(no key files found)'
  } catch {
    return '(unable to list key files)'
  }
}

// ============================================================================
// AC Parsing
// ============================================================================

/**
 * Parse acceptance criteria from an issue body.
 *
 * Looks for patterns like:
 * - "## Acceptance Criteria" / "## AC" sections
 * - Checkbox lines: `- [ ] ...` or `- [x] ...`
 * - Numbered items under AC headings
 *
 * If no structured AC is found, returns an empty array.
 */
export function parseAcceptanceCriteria(issueBody: string): string[] {
  const lines = issueBody.split('\n')
  const criteria: string[] = []
  let inAcSection = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Detect AC section headers
    if (/^#{1,3}\s*(acceptance\s+criteria|ac)\s*$/i.test(trimmed)) {
      inAcSection = true
      continue
    }

    // If we're in an AC section and hit another heading, stop
    if (inAcSection && /^#{1,3}\s/.test(trimmed) && !/^#{1,3}\s*(acceptance\s+criteria|ac)\s*$/i.test(trimmed)) {
      inAcSection = false
      continue
    }

    // Collect checkbox items anywhere in the body
    const checkboxMatch = trimmed.match(/^-\s*\[[ x]\]\s*(.+)$/i)
    if (checkboxMatch) {
      criteria.push(checkboxMatch[1].trim())
      continue
    }

    // Collect numbered items in AC section
    if (inAcSection) {
      const numberedMatch = trimmed.match(/^\d+[.)]\s*(.+)$/)
      if (numberedMatch) {
        criteria.push(numberedMatch[1].trim())
        continue
      }

      // Collect dash-prefixed items in AC section
      const dashMatch = trimmed.match(/^-\s+(.+)$/)
      if (dashMatch) {
        criteria.push(dashMatch[1].trim())
      }
    }
  }

  return criteria
}

// ============================================================================
// Prompt Builders
// ============================================================================

/**
 * Build the prompt parts for the architect stage.
 */
export function buildArchitectPrompt(
  workItem: WorkItemContext,
  codebase: CodebaseContext,
): PromptParts {
  const tree = getCodebaseTree(codebase.worktreePath)
  const keyFiles = getKeyFiles(codebase.worktreePath)

  const systemPrompt = [
    'You are an architect agent in the Orcha pipeline.',
    'Your job is to analyze the codebase and produce a detailed implementation blueprint.',
    '',
    'Guidelines:',
    '- Read the codebase carefully using the available tools (Read, Grep, Glob).',
    '- Understand the existing architecture, patterns, and conventions.',
    '- Produce a blueprint that a developer agent can follow to implement the changes.',
    '- Be specific about which files to create/modify and what changes to make.',
    '- Identify risks and suggest a test strategy.',
    '- Do NOT make any changes to the code. You are read-only.',
    '',
    'Output your blueprint as a JSON object matching the requested schema.',
  ].join('\n')

  const acSection = workItem.acceptanceCriteria.length > 0
    ? ['', '## Acceptance Criteria', ...workItem.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`)]
    : []

  const issueSection = workItem.issueBody
    ? ['', '## Full Issue Body', workItem.issueBody]
    : []

  const userPrompt = [
    '# Work Item',
    workItem.workItemId ? `ID: ${workItem.workItemId}` : '',
    '',
    '## Description',
    workItem.description,
    ...acSection,
    ...issueSection,
    '',
    '# Codebase Context',
    '',
    '## Source Branch',
    codebase.sourceBranch,
    '',
    '## Directory Structure',
    '```',
    tree,
    '```',
    '',
    '## Key Files',
    '```',
    keyFiles,
    '```',
    '',
    '# Instructions',
    'Analyze the codebase and produce an implementation blueprint.',
    'Your output must be a JSON object with these fields:',
    '- approach: High-level description of the implementation approach',
    '- filesToTouch: Array of file paths that need to be created or modified',
    '- risks: Array of potential risks or concerns',
    '- testStrategy: How to test the changes',
    '- steps: Array of step objects, each with "description" and "details"',
  ].filter((line) => line !== '').join('\n')

  return { systemPrompt, userPrompt }
}

/**
 * Build a generic stage prompt (for future stages like dev, fix, ship).
 * Placeholder — will be expanded in later milestones.
 */
export function buildStagePrompt(
  stage: string,
  workItem: WorkItemContext,
  codebase: CodebaseContext,
  additionalContext?: string,
): PromptParts {
  const systemPrompt = [
    `You are a ${stage} agent in the Orcha pipeline.`,
    `Perform the ${stage} stage of the implementation.`,
    additionalContext || '',
  ].filter(Boolean).join('\n')

  const acSection = workItem.acceptanceCriteria.length > 0
    ? ['', '## Acceptance Criteria', ...workItem.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`)]
    : []

  const userPrompt = [
    '# Work Item',
    workItem.workItemId ? `ID: ${workItem.workItemId}` : '',
    '',
    '## Description',
    workItem.description,
    ...acSection,
  ].filter((line) => line !== '').join('\n')

  return { systemPrompt, userPrompt }
}
