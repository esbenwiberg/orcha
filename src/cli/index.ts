#!/usr/bin/env node
/**
 * Orcha CLI - Main entry point
 */

import { Command } from 'commander'
import { StatusMonitor } from '../core/index.js'
import { formatStatus } from './format.js'

const program = new Command()

program
  .name('orcha')
  .description('Parallel AI session orchestrator')
  .version('0.1.0')

program
  .command('status')
  .description('Show status of all sessions')
  .option('-w, --watch', 'Watch for changes')
  .action(async (options) => {
    const monitor = new StatusMonitor()

    // Suppress internal events - we only care about status-change for display
    monitor.on('error', () => {})
    monitor.on('needs-input', () => {})
    monitor.on('done', () => {})

    await monitor.start()

    const statuses = monitor.getAllStatuses()

    if (statuses.size === 0) {
      console.log('No active sessions.')
      console.log('\nStart sessions with: orcha start -n <count> -r <repo>')
      await monitor.stop()
      return
    }

    console.log(formatStatus(statuses))

    if (options.watch) {
      monitor.on('status-change', (event) => {
        console.clear()
        console.log(formatStatus(monitor.getAllStatuses()))
      })
      console.log('\nWatching for changes... (Ctrl+C to exit)')
    } else {
      await monitor.stop()
    }
  })

program
  .command('demo')
  .description('Run demo with mock sessions')
  .action(async () => {
    const monitor = new StatusMonitor()

    // Set up event handlers before starting
    monitor.on('status-change', () => {})  // handled below with formatting
    monitor.on('needs-input', (id, prompt) => {
      console.log(`\n⚠️  Session ${id} needs input: ${prompt}`)
    })
    monitor.on('error', (id, msg) => {
      console.log(`\n❌ Session ${id} error: ${msg}`)
    })
    monitor.on('done', (id) => {
      console.log(`\n✓ Session ${id} completed`)
    })

    await monitor.start()

    // Register mock sessions
    const sessions = [
      { id: 'session-1', branch: 'feature/auth', state: 'working' as const, message: 'Implementing OAuth2 flow' },
      { id: 'session-2', branch: 'feature/api', state: 'waiting' as const, message: 'Delete 47 files?', needsInput: 'Delete files? (y/n)' },
      { id: 'session-3', branch: 'feature/ui', state: 'idle' as const, message: 'Ready for instructions' },
      { id: 'session-4', branch: 'fix/login-bug', state: 'done' as const, message: 'Task complete' },
      { id: 'session-5', branch: 'feature/tests', state: 'error' as const, message: 'Build failed: missing dependency' },
    ]

    for (const s of sessions) {
      monitor.registerSession(s.id)
      await monitor.updateStatus(s.id, {
        state: s.state,
        message: s.message,
        needsInput: s.needsInput,
      })
      // Write to file so persistence works
      const status = monitor.getStatus(s.id)!
      await monitor.writeStatusFile(s.id, status)
    }

    console.log(formatStatus(monitor.getAllStatuses()))

    // Watch for changes
    monitor.on('status-change', (event) => {
      console.clear()
      console.log(formatStatus(monitor.getAllStatuses()))
    })

    console.log('\nDemo running. Edit files in /tmp/orcha/agents/ to see changes.')
    console.log('Press Ctrl+C to exit.')
  })

program.parse()
