/**
 * Orcha MCP Server - Allows AI agents to report their status
 *
 * Provides the `orcha_status` tool that agents call to report their current state.
 * Status updates are written to files that the StatusMonitor watches.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { SessionState, StatusFileContent } from '../core/types.js'

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
      await mkdir(statusDir, { recursive: true })

      // Write status file
      const filePath = join(statusDir, `${sessionId}.json`)
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
