/**
 * Escalation Manager
 *
 * Manages escalation state for pipelines that have failed after max fix loops.
 * Provides methods to escalate, retrieve escalation details, and list escalated pipelines.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import type { PipelineRun, EscalationState, AttemptHistoryEntry } from '../types.js'
import { getPipelineDir, listPipelineRuns, loadPipelineRun, savePipelineRun } from '../pipeline-store.js'

// ============================================================================
// Escalation Manager
// ============================================================================

export class EscalationManager {
  /**
   * Escalate a pipeline with a given reason.
   * Captures attempt history and failure report.
   */
  async escalate(pipelineId: string, reason: string): Promise<void> {
    const run = await loadPipelineRun(pipelineId)
    if (!run) {
      throw new Error(`Pipeline ${pipelineId} not found`)
    }

    // Build attempt history from fix-loops directory
    const attemptHistory = await this.buildAttemptHistory(pipelineId)

    // Build failure report from current gate results
    const failureReport = this.buildFailureReport(run)

    const escalationState: EscalationState = {
      reason,
      escalatedAt: new Date().toISOString(),
      attemptHistory,
      failureReport,
    }

    // Update pipeline with escalation state
    const updatedRun: PipelineRun = {
      ...run,
      escalation: escalationState,
      updatedAt: new Date().toISOString(),
    }

    await savePipelineRun(updatedRun)
  }

  /**
   * Get all escalated pipelines.
   */
  async getEscalatedPipelines(): Promise<PipelineRun[]> {
    const allRuns = await listPipelineRuns()
    return allRuns.filter((run) => run.state === 'escalated')
  }

  /**
   * Get escalation details for a specific pipeline.
   */
  async getEscalationDetails(pipelineId: string): Promise<EscalationState | null> {
    const run = await loadPipelineRun(pipelineId)
    if (!run) {
      return null
    }
    return run.escalation ?? null
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Build attempt history from fix-loops directory metadata.
   */
  private async buildAttemptHistory(pipelineId: string): Promise<AttemptHistoryEntry[]> {
    const pipelineDir = getPipelineDir(pipelineId)
    const fixLoopsDir = join(pipelineDir, 'fix-loops')

    try {
      const entries = await readdir(fixLoopsDir)
      const attemptDirs = entries.filter((e) => e.startsWith('attempt-')).sort()

      const history: AttemptHistoryEntry[] = []

      for (const dir of attemptDirs) {
        const metaPath = join(fixLoopsDir, dir, 'meta.json')
        try {
          const metaContent = await readFile(metaPath, 'utf-8')
          const meta = JSON.parse(metaContent)

          history.push({
            attempt: meta.attempt,
            commitSha: meta.commitSha,
            model: meta.model,
            startedAt: meta.startedAt ?? meta.completedAt, // Fallback for older runs
            completedAt: meta.completedAt,
            gateResults: meta.gateResults, // May be undefined for older runs
          })
        } catch {
          // Skip if meta.json is missing or invalid
        }
      }

      return history
    } catch {
      // No fix-loops directory or can't read it
      return []
    }
  }

  /**
   * Build a human-readable failure report from gate results.
   */
  private buildFailureReport(run: PipelineRun): string {
    const failures = run.gateResults.filter((r) => r.verdict === 'fail')

    if (failures.length === 0) {
      return 'No failures reported.'
    }

    const sections = failures.map((f) => {
      const lines = [
        `## ${f.checkName} — FAILED`,
        f.summary,
      ]
      if (f.details) {
        lines.push('')
        lines.push('Details:')
        lines.push('```json')
        try {
          lines.push(JSON.stringify(f.details, null, 2))
        } catch {
          lines.push('(details could not be serialized)')
        }
        lines.push('```')
      }
      return lines.join('\n')
    })

    return [
      `# Gate Failures (${failures.length} check(s) failed)`,
      '',
      ...sections,
    ].join('\n\n')
  }
}
