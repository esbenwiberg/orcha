#!/usr/bin/env node
/**
 * Standalone web dashboard server entry point
 * Usage: node dist/web/start-server.js
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { startWebDashboard } from './server.js'

// Load .env file if present (no external dependency)
try {
  const envPath = resolve(import.meta.dirname || '.', '../../.env')
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
} catch {
  // No .env file, that's fine
}

// Prevent PTY/child process errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (kept alive):', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection (kept alive):', reason)
})

const port = parseInt(process.env.PORT || '3000')
const openBrowser = process.env.NO_OPEN !== '1'

startWebDashboard(port, openBrowser)
