/**
 * Pipeline Events — Singleton EventEmitter
 *
 * Allows loose coupling between the pipeline engine and consumers
 * (e.g. web dashboard) without circular dependencies.
 */

import { EventEmitter } from 'events'
import type { PipelineState } from './types.js'
import type { ProgressEntry } from './progress.js'

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

export interface PipelineLogEvent {
  pipelineId: string
  stage: string
  stream: 'stdout' | 'stderr'
  data: string
  timestamp: string
}

export interface PipelineProgressEvent {
  pipelineId: string
  entry: ProgressEntry
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

  emitLog(event: PipelineLogEvent): void {
    this.emit('log', event)
  }

  onLog(listener: (event: PipelineLogEvent) => void): this {
    return this.on('log', listener)
  }

  emitProgress(event: PipelineProgressEvent): void {
    this.emit('progress', event)
  }

  onProgress(listener: (event: PipelineProgressEvent) => void): this {
    return this.on('progress', listener)
  }
}

/** Singleton instance — import this wherever you need pipeline events. */
export const pipelineEvents = new PipelineEventEmitter()
