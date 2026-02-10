#!/usr/bin/env node
/**
 * Standalone web dashboard server entry point
 * Usage: node dist/web/start-server.js
 */

import { startWebDashboard } from './server.js'

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
