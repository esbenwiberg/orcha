/**
 * Pipeline Events — Singleton EventEmitter
 *
 * Allows loose coupling between the pipeline engine and consumers
 * (e.g. web dashboard) without circular dependencies.
 */

import { EventEmitter } from 'events'
import type { PipelineState } from './types.js'

export interface PipelineStateChangeEvent {
  pipelineId: string
  from: PipelineState
  to: PipelineState
  updatedAt: string
}

export interface PipelineAgentStatusEvent {
  pipelineId: string
  stage: string
  status: 'working' | 'completed' | 'error'
  details?: string
  timestamp: string
}

class PipelineEventEmitter extends EventEmitter {
  emitStateChange(event: PipelineStateChangeEvent): void {
    this.emit('state-change', event)
  }

  onStateChange(listener: (event: PipelineStateChangeEvent) => void): this {
    return this.on('state-change', listener)
  }

  emitAgentStatus(event: PipelineAgentStatusEvent): void {
    this.emit('agent-status', event)
  }

  onAgentStatus(listener: (event: PipelineAgentStatusEvent) => void): this {
    return this.on('agent-status', listener)
  }
}

/** Singleton instance — import this wherever you need pipeline events. */
export const pipelineEvents = new PipelineEventEmitter()
