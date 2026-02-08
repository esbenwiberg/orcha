/**
 * Orcha MCP Server - Allows AI agents to report their status
 *
 * Provides the `orcha_status` tool that agents call to report their current state.
 * Status updates are written to files that the StatusMonitor watches.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { writeFile, mkdir, rename } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import type { SessionState, StatusFileContent } from '../core/types.js'
import { pipelineEvents } from '../pipeline/events.js'

// Map MCP states to internal SessionState
const STATE_MAP: Record<string, SessionState> = {
  idle: 'idle',
  working: 'working',
  needs_input: 'waiting',
  finished: 'done',
  error: 'error',
}

// Default status directory (same as StatusMonitor)
const DEFAULT_STATUS_DIR = '/tmp/orcha/agents'

/**
 * Create and configure the MCP server
 */
export function createMcpServer(statusDir = DEFAULT_STATUS_DIR): McpServer {
  const server = new McpServer(
    {
      name: 'orcha',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // Register the orcha_status tool
  server.registerTool(
    'orcha_status',
    {
      description: 'Report your current status to the Orcha orchestrator',
      inputSchema: {
        state: z
          .enum(['idle', 'working', 'needs_input', 'finished', 'error'])
          .describe('Current state of the agent'),
        message: z.string().describe("What you're currently doing"),
        needsInputPrompt: z
          .string()
          .optional()
          .describe('Question for user (when state=needs_input)'),
      },
    },
    async (args) => {
      const sessionId = process.env.ORCHA_SESSION_ID
      if (!sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'Warning: ORCHA_SESSION_ID not set. Status not recorded.',
            },
          ],
        }
      }

      // Use env var for status dir if set, otherwise use the configured default
      const effectiveStatusDir = process.env.ORCHA_STATUS_DIR || statusDir

      // Map the state
      const state = STATE_MAP[args.state] || 'idle'

      // Build status file content
      const statusContent: StatusFileContent = {
        agentId: sessionId,
        state,
        message: args.message,
        timestamp: new Date().toISOString(),
        needsInputPrompt: args.needsInputPrompt,
      }

      // Ensure directory exists
      await mkdir(effectiveStatusDir, { recursive: true })

      // Write status file
      const filePath = join(effectiveStatusDir, `${sessionId}.json`)
      await writeFile(filePath, JSON.stringify(statusContent, null, 2))

      return {
        content: [
          {
            type: 'text',
            text: `Status updated: ${state} - ${args.message}`,
          },
        ],
      }
    }
  )

  // Register the orcha_pipeline_status tool
  server.registerTool(
    'orcha_pipeline_status',
    {
      description:
        'Report pipeline stage progress from within an agent session. ' +
        'Use this to let the orchestrator and dashboard know what you are doing.',
      inputSchema: {
        pipelineId: z.string().describe('The pipeline run ID (e.g. pl-20260208...)'),
        stage: z.string().describe('Current stage name (e.g. architect, dev, gate)'),
        status: z
          .enum(['working', 'completed', 'error'])
          .describe('Current status of the agent within the stage'),
        details: z
          .string()
          .optional()
          .describe('Human-readable status message describing what you are doing'),
      },
    },
    async (args) => {
      const pipelinesDir = join(homedir(), '.orcha', 'pipelines')
      const dir = join(pipelinesDir, args.pipelineId)

      // Ensure pipeline directory exists
      await mkdir(dir, { recursive: true })

      const statusContent = {
        pipelineId: args.pipelineId,
        stage: args.stage,
        status: args.status,
        details: args.details,
        timestamp: new Date().toISOString(),
      }

      // Atomic write: temp file + rename
      const tmpFile = join(dir, `agent-status.json.tmp.${randomBytes(4).toString('hex')}`)
      const targetFile = join(dir, 'agent-status.json')
      await writeFile(tmpFile, JSON.stringify(statusContent, null, 2))
      await rename(tmpFile, targetFile)

      // Emit event for real-time dashboard updates
      pipelineEvents.emitAgentStatus({
        pipelineId: args.pipelineId,
        stage: args.stage,
        status: args.status,
        details: args.details,
        timestamp: statusContent.timestamp,
      })

      return {
        content: [
          {
            type: 'text',
            text: `Pipeline status updated: ${args.stage} → ${args.status}${args.details ? ` (${args.details})` : ''}`,
          },
        ],
      }
    }
  )

  return server
}

/**
 * Start the MCP server on stdio
 */
export async function startMcpServer(statusDir?: string): Promise<McpServer> {
  const server = createMcpServer(statusDir)
  const transport = new StdioServerTransport()

  await server.connect(transport)

  return server
}

// Entry point when run directly
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/mcp/server.js')

if (isMainModule) {
  startMcpServer().catch((err) => {
    console.error('Failed to start MCP server:', err)
    process.exit(1)
  })
}
