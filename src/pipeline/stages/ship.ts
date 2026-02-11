/**
 * Ship Stage
 *
 * Pushes the pipeline branch to remote and creates a pull request
 * via the appropriate VCS provider (GitHub / Azure DevOps).
 *
 * Steps:
 * 1. Detect VCS provider from git remote
 * 2. Push branch to origin
 * 3. Build PR title and body (blueprint summary, gate results, work item link, usage)
 * 4. Create PR via VcsProvider
 * 5. Save ship artifacts (commit.json, pr.json)
 * 6. Transition state: ship → completed (on success) or ship → error (on failure)
 */

import { writeFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { execAsync } from '../exec-utils.js'
import type { PipelineRun, StageResult, GateResult } from '../types.js'
import { transition, recordStageResult, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { getProvider, parseRemoteUrl } from '../../core/vcs-provider.js'
import type { CreatePrOptions, RepoInfo } from '../../core/types.js'

// ============================================================================
// Types
// ============================================================================

export interface ShipOptions {
  /** Override model for the ship stage (unused — ship is git-only). */
  modelOverride?: string
  /** Override budget for the ship stage (unused — ship is git-only). */
  budgetOverride?: number
}

export interface ShipResult {
  /** Commit SHA that was pushed. */
  commitSha: string
  /** Branch name. */
  branch: string
  /** PR URL (if created). */
  prUrl?: string
  /** PR number (if created). */
  prNumber?: number
}

// ============================================================================
// Ship Stage Runner
// ============================================================================

/**
 * Execute the ship stage for a pipeline run.
 *
 * Expects the pipeline to be in 'ship' state.
 * On success, transitions to 'completed'. On failure, transitions to 'error'.
 */
export async function runShipStage(
  run: PipelineRun,
  _opts?: ShipOptions,
): Promise<PipelineRun> {
  const startedAt = new Date().toISOString()

  try {
    const execOpts = { cwd: run.worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

    // Get current branch and commit SHA
    const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', execOpts); const branch = branchOut.trim()
    const { stdout: shaOut } = await execAsync('git rev-parse HEAD', execOpts); const commitSha = shaOut.trim()

    // Detect VCS provider from remote URL
    let remoteUrl: string
    try {
      const { stdout: remoteOut } = await execAsync('git remote get-url origin', execOpts); remoteUrl = remoteOut.trim()
    } catch {
      return await transitionToError(run, 'Ship stage failed: no git remote "origin" configured')
    }

    const repoInfo = parseRemoteUrl(remoteUrl)
    if (!repoInfo) {
      return await transitionToError(run, `Ship stage failed: unable to parse remote URL: ${remoteUrl}`)
    }

    const provider = getProvider(remoteUrl)
    if (!provider) {
      return await transitionToError(run, `Ship stage failed: no VCS provider for remote: ${remoteUrl}`)
    }

    // Push branch to remote
    try {
      await execAsync(`git push -u origin ${branch}`, {
        ...execOpts,
        timeout: 120000, // 2 minutes for push
      })
    } catch (pushErr) {
      return await transitionToError(
        run,
        `Ship stage failed: git push failed: ${(pushErr as Error).message}`,
      )
    }

    // Build PR title and body
    const prTitle = buildPrTitle(run)
    const prBody = await buildPrBody(run, repoInfo)

    // Create PR
    const prOptions: CreatePrOptions = {
      title: prTitle,
      body: prBody,
      sourceBranch: branch,
      targetBranch: run.sourceBranch,
      repoPath: run.worktreePath,
      repoInfo,
    }

    const prResult = await provider.createPullRequest(prOptions)

    // Save ship artifacts
    const shipDir = join(getPipelineDir(run.id), 'ship')
    await mkdir(shipDir, { recursive: true })

    await writeFile(
      join(shipDir, 'commit.json'),
      JSON.stringify({
        sha: commitSha,
        branch,
        message: `pipeline: ship ${run.id}`,
        timestamp: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    )

    await writeFile(
      join(shipDir, 'pr.json'),
      JSON.stringify({
        url: prResult.prUrl,
        number: prResult.prNumber,
        title: prTitle,
        success: prResult.success,
        error: prResult.error,
        timestamp: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    )

    // Record stage result
    const completedAt = new Date().toISOString()
    const output = prResult.success
      ? `PR created: ${prResult.prUrl}`
      : `Branch pushed but PR creation failed: ${prResult.error}`

    const stageResult: StageResult = {
      stage: 'ship',
      startedAt,
      completedAt,
      output,
    }
    run = await recordStageResult(run, stageResult)

    // Even if PR creation failed, the branch is pushed — transition to completed
    // but log the error. The user can create the PR manually.
    if (!prResult.success) {
      console.warn(`Warning: Branch pushed but PR creation failed: ${prResult.error}`)
      console.warn(`You can create the PR manually from branch: ${branch}`)
    }

    // Transition: ship → completed
    run = await transition(run, 'completed')

    return run
  } catch (err) {
    const errorMsg = `Ship stage error: ${(err as Error).message}`
    try {
      return await transitionToError(run, errorMsg)
    } catch {
      return { ...run, state: 'error', error: errorMsg }
    }
  }
}

// ============================================================================
// PR Content Builders
// ============================================================================

/**
 * Build a concise PR title from the pipeline context.
 */
function buildPrTitle(run: PipelineRun): string {
  const prefix = run.workItemId ? `[${run.workItemId}] ` : ''
  // Truncate description to fit in a reasonable title
  const maxLen = 72 - prefix.length
  const desc = run.description.split('\n')[0].trim()
  const truncated = desc.length > maxLen ? `${desc.slice(0, maxLen - 3)}...` : desc
  return `${prefix}${truncated}`
}

/**
 * Build a structured PR body with all pipeline context.
 */
async function buildPrBody(run: PipelineRun, repoInfo: RepoInfo): Promise<string> {
  const sections: string[] = []

  // Summary
  sections.push('## Summary')
  sections.push(run.description)
  sections.push('')

  // Work item link
  if (run.workItemId) {
    if (repoInfo.type === 'github' && repoInfo.owner) {
      sections.push(`Closes #${run.workItemId}`)
    } else if (repoInfo.type === 'azure-devops') {
      sections.push(`Work Item: ${run.workItemId}`)
    }
    sections.push('')
  }

  // Blueprint summary
  const blueprintSummary = await loadBlueprintSummary(run)
  if (blueprintSummary) {
    sections.push('## Blueprint')
    sections.push(blueprintSummary)
    sections.push('')
  }

  // Gate results
  if (run.gateResults.length > 0) {
    sections.push('## Gate Results')
    sections.push('')
    sections.push('| Check | Verdict |')
    sections.push('|-------|---------|')
    for (const result of run.gateResults) {
      const icon = verdictIcon(result.verdict)
      sections.push(`| ${result.checkName} | ${icon} ${result.verdict} |`)
    }
    sections.push('')
  }

  // Fix loop info
  if (run.fixLoopCount > 0) {
    sections.push(`> Fix loops: ${run.fixLoopCount} iteration(s) before gate passed`)
    sections.push('')
  }

  // Usage info
  if (run.usageSnapshot) {
    sections.push('## Usage')
    sections.push(`Total estimated cost: $${run.usageSnapshot.totalCostUsd.toFixed(2)}`)
    if (run.usageSnapshot.inputTokens || run.usageSnapshot.outputTokens) {
      sections.push(`Tokens: ${(run.usageSnapshot.inputTokens ?? 0).toLocaleString()} in / ${(run.usageSnapshot.outputTokens ?? 0).toLocaleString()} out`)
    }
    sections.push('')
  }

  // Footer
  sections.push('---')
  sections.push(`Pipeline: \`${run.id}\``)
  sections.push('Generated by [Orcha Pipeline](https://github.com/orcha-dev/orcha)')

  return sections.join('\n')
}

function verdictIcon(verdict: string): string {
  switch (verdict) {
    case 'pass': return ':white_check_mark:'
    case 'fail': return ':x:'
    case 'skip': return ':fast_forward:'
    default: return ':question:'
  }
}

/**
 * Load the blueprint and extract the approach summary.
 */
async function loadBlueprintSummary(run: PipelineRun): Promise<string | null> {
  try {
    const blueprintPath = run.blueprintPath || join(getPipelineDir(run.id), 'blueprint.json')
    const raw = await readFile(blueprintPath, 'utf-8')
    const blueprint = JSON.parse(raw)
    return blueprint.approach || blueprint.content || null
  } catch {
    return null
  }
}
