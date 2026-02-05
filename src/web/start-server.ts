#!/usr/bin/env node
/**
 * Standalone web dashboard server entry point
 * Usage: node dist/web/start-server.js
 */

import { startWebDashboard } from './server.js'

const port = parseInt(process.env.PORT || '3000')
const openBrowser = process.env.NO_OPEN !== '1'

startWebDashboard(port, openBrowser)
