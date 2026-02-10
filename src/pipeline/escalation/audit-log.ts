/**
 * Audit Logger for User Actions
 *
 * Logs all user actions on escalated pipelines for auditing and compliance.
 * Stores audit trail in ~/.orcha/pipelines/{id}/escalation-audit.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { UserAction, AuditEntry, PipelineState } from '../types.js'
import { getPipelineDir } from '../pipeline-store.js'

// ============================================================================
// Audit Logger
// ============================================================================

export class AuditLogger {
  private pipelineId: string
  private auditLogPath: string

  constructor(pipelineId: string) {
    this.pipelineId = pipelineId
    this.auditLogPath = join(getPipelineDir(pipelineId), 'escalation-audit.json')
  }

  /**
   * Log a user action to the audit trail.
   */
  async logAction(
    action: UserAction,
    result: 'success' | 'error',
    details?: { newState?: PipelineState; error?: string },
  ): Promise<void> {
    const entry: AuditEntry = {
      action,
      result,
      error: details?.error,
      newState: details?.newState,
      timestamp: new Date().toISOString(),
    }

    // Load existing audit trail
    const trail = await this.getAuditTrail()

    // Append new entry
    trail.push(entry)

    // Save updated trail
    await writeFile(this.auditLogPath, JSON.stringify(trail, null, 2), 'utf-8')
  }

  /**
   * Get the audit trail for this pipeline.
   */
  async getAuditTrail(): Promise<AuditEntry[]> {
    try {
      const content = await readFile(this.auditLogPath, 'utf-8')
      return JSON.parse(content)
    } catch {
      // No audit log yet, return empty array
      return []
    }
  }
}
