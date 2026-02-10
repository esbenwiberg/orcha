/**
 * Prompt Builder
 *
 * Assembles stage-specific prompts with:
 * - Role context (what the agent is expected to do)
 * - Work item details and acceptance criteria
 * - Codebase context (tree, key files)
 * - Learning hints from past pipeline outcomes
 */

import { execSync } from 'child_process'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadTemplate, compileTemplate } from './template-loader.js'

// ============================================================================
// Logging
// ============================================================================

const ORCHA_HOME = join(homedir(), '.orcha')
const PIPELINE_WARNINGS_LOG = join(ORCHA_HOME, 'pipeline-warnings.log')

/**
 * Log a warning to the persistent pipeline warnings log.
 *
 * Logs are appended to ~/.orcha/pipeline-warnings.log for debugging
 * template loading failures and other non-fatal issues.
 *
 * Security: Sanitizes message to prevent log injection attacks by removing
 * control characters and newlines that could confuse log parsing.
 */
async function logWarning(message: string): Promise<void> {
  try {
    const timestamp = new Date().toISOString()
    // Sanitize message: remove control characters and replace newlines with escaped representation
    // eslint-disable-next-line no-control-regex
    const sanitizedMessage = message.replace(/[\x00-\x1f]/g, '').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
    const logLine = `[${timestamp}] ${sanitizedMessage}\n`
    await appendFile(PIPELINE_WARNINGS_LOG, logLine, 'utf-8')
  } catch (err) {
    // Fall back to console if we can't write to log file.
    // This ensures warnings are visible during development/debugging.
    // We don't throw because logging failures shouldn't break the pipeline.
    console.error(`[prompt-builder] Failed to write to warning log: ${(err as Error).message}`)
  }
}

// ============================================================================
// Hardcoded Fallback Prompts
// ============================================================================

// NOTE: Hardcoded fallback prompts are implemented inline in each build*Prompt
// function's catch block. This keeps variable handling type-safe and avoids
// complex generic handling. When template loading fails (missing file, invalid
// YAML, etc.), the function falls back to the original hardcoded prompts that
// existed before the template migration.

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
 *
 * @param learningHints - Optional hints from past pipeline outcomes (M13 learning loop).
 */
export async function buildArchitectPrompt(
  workItem: WorkItemContext,
  codebase: CodebaseContext,
  learningHints?: string[],
): Promise<PromptParts> {
  const tree = getCodebaseTree(codebase.worktreePath)
  const keyFiles = getKeyFiles(codebase.worktreePath)

  // Try loading template, fall back to hardcoded prompts on failure
  try {
    const template = await loadTemplate('architect')
    const variables = {
      workItem,
      codebase,
      tree,
      keyFiles,
      learningHints: learningHints || [],
    }
    return compileTemplate(template, variables)
  } catch (err) {
    // Note: Template loading failure is expected on first run or fresh installs.
    // The hardcoded prompts serve as a reliable fallback. If custom templates are
    // configured and failing, check ~/.orcha/prompts/ for syntax errors.
    const errMsg = err instanceof Error ? err.message : String(err)
    const warning = `Failed to load template 'architect': ${errMsg}. Falling back to hardcoded default prompt.`
    console.warn(`[prompt-builder] ${warning}`)
    await logWarning(warning)

    // FALLBACK: Original hardcoded implementation
    const learningSection = learningHints && learningHints.length > 0
      ? [
        '',
        'Lessons from past pipeline runs (use these to improve your blueprint):',
        ...learningHints.map((h) => `- ${h}`),
      ]
      : []

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
      'IMPORTANT - Milestone Planning:',
      '- Divide large tasks into discrete MILESTONES (not steps).',
      '- Each milestone should be independently implementable with a focused scope (single responsibility).',
      '- Each milestone runs with FRESH CONTEXT (no cross-milestone state pollution).',
      '- For small tasks (1-3 simple changes), use a single milestone.',
      '- For large tasks (complex features, multi-file refactors), create 3-7 milestones.',
      '- Milestone boundaries should align with natural checkpoints (e.g., add schema → add API → add UI).',
      ...learningSection,
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
      '',
      'Your output must be a JSON object with these fields:',
      '- headline: A short, clear title for the plan (e.g. "Add User Authentication")',
      '- shortDescription: Summary INCLUDING the milestone count (e.g. "Implements user authentication with 3 milestones")',
      '  * IMPORTANT: The shortDescription MUST explicitly state how many milestones the plan contains',
      '  * Format: "<Summary of what is being done> with <N> milestone(s)"',
      '  * Example: "Adds JWT-based authentication with 4 milestones"',
      '  * Example: "Refactors error handling with 1 milestone"',
      '- approach: High-level description of the implementation approach',
      '- filesToTouch: Array of file paths that need to be created or modified',
      '- risks: Array of potential risks or concerns',
      '- testStrategy: How to test the changes',
      '- milestones: Array of milestone objects, each with:',
      '  - description: What this milestone accomplishes',
      '  - details: Step-by-step implementation guidance',
      '  - filesToTouch (optional): Subset of files this milestone touches',
      '',
      'CRITICAL: Use "milestones" field (not "steps"). Each milestone executes with fresh context.',
      '',
      'Example blueprint structure:',
      '{',
      '  "headline": "Add User Authentication",',
      '  "shortDescription": "Implements JWT-based user authentication with 3 milestones",',
      '  "approach": "...",',
      '  "filesToTouch": ["src/auth.ts", "src/middleware.ts"],',
      '  "risks": ["..."],',
      '  "testStrategy": "...",',
      '  "milestones": [',
      '    { "description": "Create auth schema and models", "details": "..." },',
      '    { "description": "Implement JWT signing and validation", "details": "..." },',
      '    { "description": "Add authentication middleware", "details": "..." }',
      '  ]',
      '}',
    ].filter((line) => line !== '').join('\n')

    return { systemPrompt, userPrompt }
  }
}

/**
 * Build a generic stage prompt (for future stages like fix, ship).
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

// ============================================================================
// Dev Stage Prompt
// ============================================================================

export interface BlueprintContext {
  /** The blueprint JSON content as a string (DEPRECATED - use rawMarkdown). */
  blueprintJson: string
  /** The full raw markdown blueprint (preserves ALL context). Prefer this over blueprintJson. */
  rawMarkdown?: string
}

export interface MilestoneContext {
  /** The full blueprint JSON content as a string (DEPRECATED - use rawMarkdown). */
  blueprintJson: string
  /** The full raw markdown blueprint (preserves ALL context). Prefer this over blueprintJson. */
  rawMarkdown?: string
  /** Zero-based index of the current milestone. */
  milestoneIndex: number
  /** Total number of milestones. */
  totalMilestones: number
  /** The current milestone's description. */
  milestoneDescription: string
  /** The current milestone's implementation details. */
  milestoneDetails: string
  /** The full raw text for this milestone section (preserves ALL context). Prefer this over description/details. */
  milestoneRawText?: string
  /** Optional: files this milestone touches. */
  milestoneFilesToTouch?: string[]
}

/**
 * Build the prompt parts for the dev stage.
 *
 * The dev agent receives the full blueprint via --append-system-prompt and
 * implements the changes described in it. The project's CLAUDE.md is picked
 * up automatically from the worktree by Claude Code.
 */
export async function buildDevPrompt(
  workItem: WorkItemContext,
  codebase: CodebaseContext,
  blueprint: BlueprintContext,
): Promise<PromptParts> {
  // Try loading template, fall back to hardcoded prompts on failure
  try {
    const template = await loadTemplate('dev')
    const variables = {
      workItem,
      codebase,
      blueprint,
    }
    return compileTemplate(template, variables)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const warning = `Failed to load template 'dev': ${errMsg}. Falling back to hardcoded default prompt.`
    console.warn(`[prompt-builder] ${warning}`)
    await logWarning(warning)

    // FALLBACK: Original hardcoded implementation
    // Prefer rawMarkdown (full context) over blueprintJson (structured but lossy)
    const blueprintContent = blueprint.rawMarkdown || blueprint.blueprintJson
    const blueprintFormat = blueprint.rawMarkdown ? 'Markdown' : 'JSON'

    const systemPrompt = [
      'You are a dev agent in the Orcha pipeline.',
      'Your job is to implement the changes described in the blueprint provided below.',
      '',
      'Guidelines:',
      '- Follow the blueprint steps precisely.',
      '- Create and modify only the files listed in filesToTouch.',
      '- Follow the existing code conventions and patterns in the codebase.',
      '- Write clean, well-structured code.',
      '- Do NOT run tests — that is the gate stage\'s job.',
      '- Do NOT commit your changes — the pipeline handles commits automatically.',
      '- If the blueprint is ambiguous, make reasonable decisions and note them.',
    ].join('\n')

    const acSection = workItem.acceptanceCriteria.length > 0
      ? ['', '## Acceptance Criteria', ...workItem.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`)]
      : []

    const userPrompt = [
      `## Blueprint (${blueprintFormat})`,
      blueprintContent,
      '',
      '# Task',
      workItem.workItemId ? `Work Item: ${workItem.workItemId}` : '',
      '',
      '## Description',
      workItem.description,
      ...acSection,
      '',
      '# Instructions',
      'Implement the changes described in the blueprint.',
      'Work through each step in order. Create or modify the listed files.',
      `Source branch: ${codebase.sourceBranch}`,
    ].filter((line) => line !== '').join('\n')

    return { systemPrompt, userPrompt }
  }
}

/**
 * Build the prompt parts for a SINGLE MILESTONE in the dev stage.
 *
 * This is used when executing milestones sequentially with fresh Claude sessions.
 * Each milestone gets its own context, with the full blueprint provided for
 * reference but instructions focused on the current milestone only.
 *
 * Benefits of milestone-based execution:
 * - Fresh context prevents pollution from previous milestone conversations
 * - Lower per-session cost (smaller context window usage)
 * - Easier debugging (can resume from a specific milestone)
 * - Clear progress tracking
 */
export async function buildMilestoneDevPrompt(
  workItem: WorkItemContext,
  codebase: CodebaseContext,
  milestone: MilestoneContext,
): Promise<PromptParts> {
  // Try loading template, fall back to hardcoded prompts on failure
  try {
    const template = await loadTemplate('milestone-dev')
    const variables = {
      workItem,
      codebase,
      milestone,
    }
    return compileTemplate(template, variables)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const warning = `Failed to load template 'milestone-dev': ${errMsg}. Falling back to hardcoded default prompt.`
    console.warn(`[prompt-builder] ${warning}`)
    await logWarning(warning)

    // FALLBACK: Original hardcoded implementation
    const milestoneNum = milestone.milestoneIndex + 1
    const totalNum = milestone.totalMilestones

    const filesToTouchSection = milestone.milestoneFilesToTouch && milestone.milestoneFilesToTouch.length > 0
      ? [
        '',
        '## Files to Touch (this milestone)',
        milestone.milestoneFilesToTouch.map((f) => `- ${f}`).join('\n'),
      ]
      : []

    // Prefer rawMarkdown (full blueprint context) over blueprintJson
    const blueprintContent = milestone.rawMarkdown || milestone.blueprintJson
    const blueprintFormat = milestone.rawMarkdown ? 'Markdown' : 'JSON'

    const systemPrompt = [
      'You are a dev agent in the Orcha pipeline.',
      `Your job is to implement the changes described in the blueprint provided below.`,
      '',
      `**You are implementing milestone ${milestoneNum} of ${totalNum}.**`,
      'Previous milestones have already been completed and committed.',
      'Focus ONLY on the current milestone — do not implement other milestones.',
      '',
      'Guidelines:',
      '- Follow the milestone description and details precisely.',
      `- This is milestone ${milestoneNum}: "${milestone.milestoneDescription}"`,
      '- Create and modify only the files needed for THIS milestone.',
      '- Follow the existing code conventions and patterns in the codebase.',
      '- Write clean, well-structured code.',
      '- Do NOT run tests — that is the gate stage\'s job.',
      '- Do NOT commit your changes — the pipeline handles commits automatically.',
      '- If the milestone is ambiguous, make reasonable decisions and note them.',
      ...filesToTouchSection,
    ].join('\n')

    const acSection = workItem.acceptanceCriteria.length > 0
      ? ['', '## Acceptance Criteria (for full task)', ...workItem.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`)]
      : []

    // If we have rawText, use it (preserves full context from blueprint markdown)
    // Otherwise fall back to structured fields
    const milestoneContent = milestone.milestoneRawText || [
      '## Details',
      milestone.milestoneDetails,
    ].join('\n')

    const userPrompt = [
      `## Full Blueprint (for reference - ${blueprintFormat})`,
      blueprintContent,
      '',
      '# Current Milestone',
      `Milestone ${milestoneNum} of ${totalNum}: ${milestone.milestoneDescription}`,
      '',
      milestoneContent,
      '',
      '# Task Context',
      workItem.workItemId ? `Work Item: ${workItem.workItemId}` : '',
      '',
      '## Description',
      workItem.description,
      ...acSection,
      '',
      '# Instructions',
      `Implement milestone ${milestoneNum}: "${milestone.milestoneDescription}"`,
      'Work through the milestone details. Create or modify only the files needed for this milestone.',
      `Source branch: ${codebase.sourceBranch}`,
    ].filter((line) => line !== '').join('\n')

    return { systemPrompt, userPrompt }
  }
}

// ============================================================================
// AC Validator Prompt
// ============================================================================

export interface DiffContext {
  /** The git diff output showing changes made. */
  diff: string
}

export interface FixLoopContext {
  /** The blueprint JSON content. */
  blueprintJson: string
  /** The git diff of current changes. */
  diff: string
  /** Gate failure details (aggregated). */
  failureReport: string
  /** Which fix attempt this is (1-based). */
  attempt: number
  /** Max fix attempts allowed. */
  maxAttempts: number
  /** Enhanced context (full file contents, history, affected modules). */
  enhancedContext?: {
    fullFileContents: Record<string, string>
    attemptHistory: string
    affectedModules: string
    relatedFiles: string[]
    successfulFixExamples?: string
  }
}

/**
 * Build the prompt parts for the AC validator gate agent.
 *
 * The AC validator compares the git diff against the acceptance criteria
 * and produces a structured pass/fail verdict.
 */
export async function buildAcValidatorPrompt(
  workItem: WorkItemContext,
  diff: DiffContext,
): Promise<PromptParts> {
  // Try loading template, fall back to hardcoded prompts on failure
  try {
    const template = await loadTemplate('gate/ac-validator')
    const variables = {
      workItem,
      diff,
    }
    return compileTemplate(template, variables)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const warning = `Failed to load template 'gate/ac-validator': ${errMsg}. Falling back to hardcoded default prompt.`
    console.warn(`[prompt-builder] ${warning}`)
    await logWarning(warning)

    // FALLBACK: Original hardcoded implementation
    const systemPrompt = [
      'You are an acceptance criteria validator in the Orcha pipeline gate.',
      'Your job is to determine whether the code changes satisfy the acceptance criteria.',
      '',
      'Guidelines:',
      '- Compare each acceptance criterion against the diff carefully.',
      '- Be practical: if the AC is clearly met by the code changes, mark it as passing.',
      '- If an AC is partially met or unclear, explain what is missing.',
      '- Do NOT nitpick style or minor issues — focus on whether ACs are satisfied.',
      '',
      'IMPORTANT: You MUST output ONLY a JSON object — no prose, no markdown, no explanation.',
      'Do not use tools. The diff is provided below — analyze it directly.',
      '',
      'Output exactly this JSON structure and nothing else:',
      '{',
      '  "pass": true/false,',
      '  "summary": "Brief overall summary",',
      '  "criteria": [',
      '    { "criterion": "the AC text", "met": true/false, "explanation": "why" }',
      '  ]',
      '}',
    ].join('\n')

    const acSection = workItem.acceptanceCriteria.length > 0
      ? workItem.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
      : '(No explicit acceptance criteria provided — use your best judgment based on the description.)'

    const userPrompt = [
      '# Acceptance Criteria',
      acSection,
      '',
      '# Task Description',
      workItem.description,
      '',
      '# Code Changes (git diff)',
      '```diff',
      diff.diff,
      '```',
      '',
      '# Instructions',
      'Evaluate whether the code changes above satisfy each acceptance criterion.',
      'Output ONLY the JSON verdict. No other text before or after.',
    ].join('\n')

    return { systemPrompt, userPrompt }
  }
}

// ============================================================================
// Adversary Prompt
// ============================================================================

/**
 * Build the prompt parts for the adversary gate agent.
 *
 * The adversary writes tests designed to expose bugs in the dev agent's code.
 * Tests are written to a temp directory and executed against the worktree.
 *
 * @param techType - Optional tech type to guide the adversary on which language/framework to use for tests.
 */
export async function buildAdversaryPrompt(
  workItem: WorkItemContext,
  diff: DiffContext,
  testPatterns: string,
  techType?: 'node' | 'dotnet' | 'python',
): Promise<PromptParts> {
  // Tech-specific guidance for the adversary
  const techGuidance = getTechGuidance(techType)

  // Try loading template, fall back to hardcoded prompts on failure
  try {
    const template = await loadTemplate('gate/adversary')
    const variables = {
      workItem,
      diff,
      testPatterns,
      techType,
      techGuidance,
    }
    return compileTemplate(template, variables)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const warning = `Failed to load template 'gate/adversary': ${errMsg}. Falling back to hardcoded default prompt.`
    console.warn(`[prompt-builder] ${warning}`)
    await logWarning(warning)

    // FALLBACK: Original hardcoded implementation
    const systemPrompt = [
      'You are an adversary agent in the Orcha pipeline gate.',
      'Your job is to write tests that EXPOSE BUGS in the code changes.',
      '',
      ...(techGuidance ? [`Detected project technology: ${techGuidance.label}`, ''] : []),
      'Guidelines:',
      '- Study the diff carefully for edge cases, off-by-one errors, missing validation, race conditions, and incorrect assumptions.',
      '- Write focused test files that target the weakest parts of the implementation.',
      '- Each test should be self-contained and clearly named.',
      ...(techGuidance ? [
        `- Write tests in ${techGuidance.language} using ${techGuidance.framework}.`,
        `- Use file naming convention: ${techGuidance.fileNaming}`,
      ] : [
        '- Use the same test framework and patterns as the existing project tests.',
      ]),
      '- Only write tests — do NOT modify any source code.',
      '- If the code looks solid, still try creative edge cases.',
      '',
      'Output your tests as JSON with this structure:',
      '{',
      '  "tests": [',
      '    {',
      `      "filename": "${techGuidance?.exampleFilename ?? 'adversary-test-1.test.ts'}",`,
      '      "description": "Tests edge case X in module Y",',
      '      "content": "..."',
      '    }',
      '  ],',
      '  "reasoning": "Brief explanation of what bugs you are targeting"',
      '}',
    ].join('\n')

    const userPrompt = [
      '# Code Changes (git diff)',
      '```diff',
      diff.diff,
      '```',
      '',
      '# Task Description',
      workItem.description,
      '',
      '# Existing Test Patterns',
      '```',
      testPatterns || '(no existing tests found)',
      '```',
      '',
      '# Instructions',
      'Write adversarial tests that expose bugs or edge cases in the code changes above.',
      ...(techGuidance ? [`Write tests in ${techGuidance.language} using ${techGuidance.framework}.`] : []),
      'Output your tests as the JSON structure described in your instructions.',
    ].join('\n')

    return { systemPrompt, userPrompt }
  }
}

/**
 * Get tech-specific guidance for adversary test generation.
 */
function getTechGuidance(techType?: 'node' | 'dotnet' | 'python'): {
  label: string
  language: string
  framework: string
  fileNaming: string
  exampleFilename: string
} | null {
  switch (techType) {
    case 'node':
      return {
        label: 'Node.js / TypeScript',
        language: 'TypeScript',
        framework: 'plain assertions (no test runner needed — the file is executed directly with tsx)',
        fileNaming: 'adversary-*.test.ts',
        exampleFilename: 'adversary-test-1.test.ts',
      }
    case 'python':
      return {
        label: 'Python',
        language: 'Python',
        framework: 'pytest (use assert statements and test_ function naming)',
        fileNaming: 'test_adversary_*.py',
        exampleFilename: 'test_adversary_1.py',
      }
    case 'dotnet':
      return {
        label: '.NET / C#',
        language: 'C#',
        framework: 'xUnit or NUnit (note: adversary tests for .NET are review-only and will not be executed)',
        fileNaming: 'Adversary*Tests.cs',
        exampleFilename: 'AdversaryTest1Tests.cs',
      }
    default:
      return null
  }
}

// ============================================================================
// Security Review Prompt
// ============================================================================

/**
 * Build the prompt parts for the security review gate agent.
 *
 * Reviews the diff against OWASP top 10 and common security issues.
 */
export async function buildSecurityReviewPrompt(
  workItem: WorkItemContext,
  diff: DiffContext,
): Promise<PromptParts> {
  // Try loading template, fall back to hardcoded prompts on failure
  try {
    const template = await loadTemplate('gate/security-review')
    const variables = {
      workItem,
      diff,
    }
    return compileTemplate(template, variables)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const warning = `Failed to load template 'gate/security-review': ${errMsg}. Falling back to hardcoded default prompt.`
    console.warn(`[prompt-builder] ${warning}`)
    await logWarning(warning)

    // FALLBACK: Original hardcoded implementation with severity classification
    const systemPrompt = [
      'You are a security review agent in the Orcha pipeline gate.',
      'Your job is to identify security vulnerabilities in the code changes.',
      '',
      'Check for:',
      '- OWASP Top 10 vulnerabilities (injection, XSS, CSRF, broken auth, etc.)',
      '- Hardcoded secrets, API keys, or credentials',
      '- Insecure cryptographic practices',
      '- Path traversal vulnerabilities',
      '- Unsafe deserialization',
      '- Command injection via unsanitized inputs',
      '- SQL injection or NoSQL injection',
      '- Insecure direct object references',
      '- Missing input validation at system boundaries',
      '- Dependency vulnerabilities (if new deps are added)',
      '',
      'Guidelines:',
      '- Focus ONLY on the changed code (the diff), not the entire codebase.',
      '- Be practical: only flag real, exploitable issues — not theoretical concerns.',
      '- Internal helper functions called only by trusted code do NOT need input validation.',
      '- If no security issues found, that is a valid pass.',
      '',
      'SEVERITY CLASSIFICATION (CRITICAL):',
      '- critical: Actively exploitable vulnerabilities with direct user input',
      '  Examples: Command injection with user input, SQL injection on public API, auth bypass',
      '- high: Exploitable with specific conditions or attacker control',
      '  Examples: Prototype pollution IF attacker controls input, XSS on semi-trusted input',
      '- medium: Defense-in-depth issues, not directly exploitable',
      '  Examples: Missing validation on internal functions, weak crypto on non-sensitive data',
      '- low: Theoretical vulnerabilities requiring unlikely conditions',
      '  Examples: ReDoS on unlikely input patterns, timing attacks on non-sensitive operations',
      '- info: Best practices, informational suggestions',
      '  Examples: Could use safer API, consider additional hardening',
      '',
      'Output your verdict as JSON:',
      '{',
      '  "pass": true/false,',
      '  "summary": "Brief overall summary",',
      '  "findings": [',
      '    {',
      '      "severity": "critical|high|medium|low|info",',
      '      "category": "OWASP category or general label",',
      '      "file": "path/to/file.ts",',
      '      "line": 42,',
      '      "description": "What the issue is and how to fix it"',
      '    }',
      '  ]',
      '}',
    ].join('\n')

    const userPrompt = [
      '# Code Changes (git diff)',
      '```diff',
      diff.diff,
      '```',
      '',
      '# Task Description',
      workItem.description,
      '',
      '# Instructions',
      'Review the code changes for security vulnerabilities.',
      'Output your verdict as the JSON structure described in your instructions.',
    ].join('\n')

    return { systemPrompt, userPrompt }
  }
}

// ============================================================================
// Code Review Prompt
// ============================================================================

/**
 * Build the prompt parts for the code review gate agent.
 *
 * Reviews the diff for correctness, conventions, and code quality.
 */
export async function buildCodeReviewPrompt(
  workItem: WorkItemContext,
  diff: DiffContext,
): Promise<PromptParts> {
  // Try loading template, fall back to hardcoded prompts on failure
  try {
    const template = await loadTemplate('gate/code-review')
    const variables = {
      workItem,
      diff,
    }
    return compileTemplate(template, variables)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const warning = `Failed to load template 'gate/code-review': ${errMsg}. Falling back to hardcoded default prompt.`
    console.warn(`[prompt-builder] ${warning}`)
    await logWarning(warning)

    // FALLBACK: Original hardcoded implementation with severity classification
    const systemPrompt = [
      'You are a code review agent in the Orcha pipeline gate.',
      'Your job is to review the code changes for correctness and quality.',
      '',
      'Check for:',
      '- Logic errors, off-by-one bugs, incorrect conditions',
      '- Unhandled error cases that could crash the application',
      '- Resource leaks (unclosed handles, missing cleanup)',
      '- Race conditions in async code',
      '- API contract violations (wrong types, missing fields)',
      '- Dead code or unreachable branches introduced by the changes',
      '- Obvious performance issues (N+1 queries, unbounded loops, missing indexes)',
      '',
      'Guidelines:',
      '- Focus ONLY on the changed code (the diff), not the entire codebase.',
      '- Be practical: only flag real bugs or significant issues.',
      '- Do NOT nitpick style, naming, or formatting — lint handles that.',
      '- Do NOT suggest refactors, abstractions, or "improvements".',
      '- If the code is correct and clean, that is a valid pass.',
      '',
      'SEVERITY CLASSIFICATION (CRITICAL):',
      '- critical: Logic errors causing crashes, data corruption, or complete feature failure',
      '  Examples: Null pointer dereference, type errors, unhandled promise rejections',
      '- major: Unhandled error cases, resource leaks, race conditions',
      '  Examples: Missing error handling, unclosed file handles, deadlocks',
      '- minor: Inefficiencies, code clarity issues that do not affect correctness',
      '  Examples: Suboptimal algorithms, unclear variable names (only if severely confusing)',
      '- suggestion: Refactoring ideas, style improvements, abstractions',
      '  Examples: Could extract this into a helper, consider memoization',
      '',
      'Output your verdict as JSON:',
      '{',
      '  "pass": true/false,',
      '  "summary": "Brief overall summary",',
      '  "findings": [',
      '    {',
      '      "severity": "critical|major|minor|suggestion",',
      '      "file": "path/to/file.ts",',
      '      "line": 42,',
      '      "description": "What the issue is"',
      '    }',
      '  ]',
      '}',
    ].join('\n')

    const userPrompt = [
      '# Code Changes (git diff)',
      '```diff',
      diff.diff,
      '```',
      '',
      '# Task Description',
      workItem.description,
      '',
      '# Instructions',
      'Review the code changes for correctness and quality issues.',
      'Output your verdict as the JSON structure described in your instructions.',
    ].join('\n')

    return { systemPrompt, userPrompt }
  }
}

// ============================================================================
// Fix Loop Prompt
// ============================================================================

/**
 * Build the prompt parts for the fix-loop stage.
 *
 * The fix agent receives the blueprint, the current diff, and a detailed
 * failure report from the gate stage. It must fix the issues without
 * re-implementing from scratch.
 */
export async function buildFixLoopPrompt(
  workItem: WorkItemContext,
  codebase: CodebaseContext,
  ctx: FixLoopContext,
): Promise<PromptParts> {
  // Try loading template, fall back to hardcoded prompts on failure
  try {
    const template = await loadTemplate('fix-loop')
    const variables = {
      workItem,
      codebase,
      ctx,
    }
    return compileTemplate(template, variables)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const warning = `Failed to load template 'fix-loop': ${errMsg}. Falling back to hardcoded default prompt.`
    console.warn(`[prompt-builder] ${warning}`)
    await logWarning(warning)

    // FALLBACK: Enhanced implementation with context builder features
    const enhancedSections: string[] = []

    // Add enhanced context sections if available
    if (ctx.enhancedContext) {
      // Full file contents section
      if (Object.keys(ctx.enhancedContext.fullFileContents).length > 0) {
        enhancedSections.push('## Full File Contents (files with failures)')
        enhancedSections.push('')
        for (const [filePath, content] of Object.entries(ctx.enhancedContext.fullFileContents)) {
          enhancedSections.push(`### ${filePath}`)
          enhancedSections.push('```')
          // Truncate very large files (keep first 500 lines)
          const lines = content.split('\n')
          const truncated = lines.length > 500 ? lines.slice(0, 500).join('\n') + '\n... (truncated)' : content
          enhancedSections.push(truncated)
          enhancedSections.push('```')
          enhancedSections.push('')
        }
      }

      // Attempt history section
      if (ctx.enhancedContext.attemptHistory && ctx.enhancedContext.attemptHistory !== 'No previous fix attempts.') {
        enhancedSections.push('## Attempt History (what previous fixes tried)')
        enhancedSections.push('')
        enhancedSections.push(ctx.enhancedContext.attemptHistory)
        enhancedSections.push('')
      }

      // Successful fix examples section
      if (ctx.enhancedContext.successfulFixExamples) {
        enhancedSections.push('## Similar Failures Fixed Previously')
        enhancedSections.push('')
        enhancedSections.push(ctx.enhancedContext.successfulFixExamples)
        enhancedSections.push('')
      }

      // Affected modules section
      if (ctx.enhancedContext.affectedModules && ctx.enhancedContext.affectedModules !== '(No files identified in failures)') {
        enhancedSections.push('## Affected Modules (directory tree)')
        enhancedSections.push('')
        enhancedSections.push('```')
        enhancedSections.push(ctx.enhancedContext.affectedModules)
        enhancedSections.push('```')
        enhancedSections.push('')
      }

      // Related files section
      if (ctx.enhancedContext.relatedFiles && ctx.enhancedContext.relatedFiles.length > 0) {
        enhancedSections.push('## Related Files (imports/exports in affected modules)')
        enhancedSections.push('')
        enhancedSections.push(ctx.enhancedContext.relatedFiles.map((f) => `- ${f}`).join('\n'))
        enhancedSections.push('')
      }
    }

    const systemPrompt = [
      'You are a fix agent in the Orcha pipeline.',
      'The dev agent\'s implementation failed the quality gate. Your job is to fix the issues.',
      '',
      'Guidelines:',
      '- Read the failure report carefully — it tells you exactly what went wrong.',
      '- You have access to full file contents and previous attempt history below.',
      '- Follow the blueprint and existing code conventions.',
      '- Do NOT run tests — the gate will re-run automatically after your fixes.',
      '- Do NOT commit your changes — the pipeline handles commits automatically.',
      '',
      '## Scope Permissions',
      '',
      'You are NOT limited to "targeted fixes". You may:',
      '- Refactor functions within affected modules',
      '- Extract helper functions for repeated patterns',
      '- Reorganize validation logic',
      '- Change function signatures if it improves safety',
      '',
      'Stay within the affected modules (listed below), but feel free to',
      'make substantial improvements to the code structure.',
      '',
      `This is fix attempt ${ctx.attempt} of ${ctx.maxAttempts}.`,
      '',
      ...enhancedSections,
      '',
      '## Blueprint',
      ctx.blueprintJson,
    ].join('\n')

    const acSection = workItem.acceptanceCriteria.length > 0
      ? ['', '## Acceptance Criteria', ...workItem.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`)]
      : []

    const userPrompt = [
      '# Gate Failure Report',
      ctx.failureReport,
      '',
      '# Current Code Changes (git diff)',
      '```diff',
      ctx.diff,
      '```',
      ...acSection,
      '',
      '# Task Description',
      workItem.description,
      '',
      '# Instructions',
      'Fix the issues described in the gate failure report above.',
      'You may refactor and improve code structure within affected modules.',
      `Source branch: ${codebase.sourceBranch}`,
    ].join('\n')

    return { systemPrompt, userPrompt }
  }
}
