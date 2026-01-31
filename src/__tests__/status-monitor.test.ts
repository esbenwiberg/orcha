/**
 * Tests for StatusMonitor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StatusMonitor } from '../core/status-monitor.js'
import { mkdir, rm, writeFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('StatusMonitor', () => {
  let testDir: string
  let monitor: StatusMonitor

  beforeEach(async () => {
    // Create a temporary directory for tests
    testDir = join(tmpdir(), `orcha-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(testDir, { recursive: true })
    monitor = new StatusMonitor({ statusDir: testDir })
  })

  afterEach(async () => {
    // Stop monitor and cleanup
    await monitor.stop()
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  describe('registerSession', () => {
    it('should register a new session with initializing state', async () => {
      await monitor.start()
      monitor.registerSession('test-session')

      const status = monitor.getStatus('test-session')
      expect(status).toBeDefined()
      expect(status?.state).toBe('initializing')
      expect(status?.message).toBe('Starting up...')
    })

    it('should not overwrite existing session', async () => {
      await monitor.start()
      monitor.registerSession('test-session')

      await monitor.updateStatus('test-session', {
        state: 'working',
        message: 'Doing stuff',
      })

      monitor.registerSession('test-session')

      const status = monitor.getStatus('test-session')
      expect(status?.state).toBe('working')
    })
  })

  describe('updateStatus', () => {
    it('should update session status', async () => {
      await monitor.start()
      monitor.registerSession('update-test')

      await monitor.updateStatus('update-test', {
        state: 'working',
        message: 'Implementing feature',
        progress: 50,
      })

      const status = monitor.getStatus('update-test')
      expect(status?.state).toBe('working')
      expect(status?.message).toBe('Implementing feature')
      expect(status?.progress).toBe(50)
    })

    it('should emit status-change event', async () => {
      await monitor.start()
      monitor.registerSession('event-test')

      const events: any[] = []
      monitor.on('status-change', (event) => {
        events.push(event)
      })

      await monitor.updateStatus('event-test', {
        state: 'working',
        message: 'Test',
      })

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(events.length).toBeGreaterThan(0)
      const lastEvent = events[events.length - 1]
      expect(lastEvent.sessionId).toBe('event-test')
      expect(lastEvent.status.state).toBe('working')
    })

    it('should emit needs-input event when waiting', async () => {
      await monitor.start()
      monitor.registerSession('input-test')

      const inputPrompts: string[] = []
      monitor.on('needs-input', (sessionId, prompt) => {
        inputPrompts.push(prompt)
      })

      await monitor.updateStatus('input-test', {
        state: 'waiting',
        message: 'Waiting for input',
        needsInput: 'Delete files? (y/n)',
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      expect(inputPrompts).toContain('Delete files? (y/n)')
    })
  })

  describe('getAllStatuses', () => {
    it('should return all session statuses', async () => {
      await monitor.start()

      monitor.registerSession('session-1')
      monitor.registerSession('session-2')
      monitor.registerSession('session-3')

      await monitor.updateStatus('session-1', { state: 'working', message: 'A' })
      await monitor.updateStatus('session-2', { state: 'idle', message: 'B' })
      await monitor.updateStatus('session-3', { state: 'done', message: 'C' })

      const statuses = monitor.getAllStatuses()

      expect(statuses.size).toBe(3)
      expect(statuses.get('session-1')?.state).toBe('working')
      expect(statuses.get('session-2')?.state).toBe('idle')
      expect(statuses.get('session-3')?.state).toBe('done')
    })
  })

  describe('unregisterSession', () => {
    it('should remove session and cleanup status file', async () => {
      await monitor.start()
      monitor.registerSession('unregister-test')

      // Write status file
      await monitor.writeStatusFile('unregister-test', {
        state: 'working',
        message: 'Test',
        lastActivity: new Date(),
      })

      const statusFilePath = join(testDir, 'unregister-test.json')
      expect(existsSync(statusFilePath)).toBe(true)

      await monitor.unregisterSession('unregister-test')

      expect(monitor.getStatus('unregister-test')).toBeUndefined()
      expect(existsSync(statusFilePath)).toBe(false)
    })
  })

  describe('writeStatusFile', () => {
    it('should write status to JSON file', async () => {
      await monitor.start()
      monitor.registerSession('file-test')

      await monitor.writeStatusFile('file-test', {
        state: 'working',
        message: 'Writing to file',
        lastActivity: new Date(),
        progress: 75,
      })

      const statusFilePath = join(testDir, 'file-test.json')
      expect(existsSync(statusFilePath)).toBe(true)

      const fs = await import('fs/promises')
      const content = JSON.parse(await fs.readFile(statusFilePath, 'utf-8'))

      expect(content.agentId).toBe('file-test')
      expect(content.state).toBe('working')
      expect(content.message).toBe('Writing to file')
      expect(content.progress).toBe(75)
    })
  })

  describe('file watching', () => {
    it('should load existing status files on start', async () => {
      // Write a status file BEFORE starting the monitor
      const statusContent = {
        agentId: 'preexisting-session',
        state: 'working',
        message: 'Already running',
        timestamp: new Date().toISOString(),
      }

      await writeFile(
        join(testDir, 'preexisting-session.json'),
        JSON.stringify(statusContent)
      )

      // Now start the monitor - it should load existing files
      await monitor.start()

      // Give it time to load
      await new Promise(resolve => setTimeout(resolve, 100))

      const status = monitor.getStatus('preexisting-session')
      expect(status?.state).toBe('working')
      expect(status?.message).toBe('Already running')
    })

    it('should detect file changes to existing status files', async () => {
      // Create initial file
      const initialContent = {
        agentId: 'change-test',
        state: 'idle',
        message: 'Initial state',
        timestamp: new Date().toISOString(),
      }

      await writeFile(
        join(testDir, 'change-test.json'),
        JSON.stringify(initialContent)
      )

      await monitor.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Verify initial state loaded
      let status = monitor.getStatus('change-test')
      expect(status?.state).toBe('idle')

      // Now modify the file
      const updatedContent = {
        agentId: 'change-test',
        state: 'working',
        message: 'Updated state',
        timestamp: new Date().toISOString(),
      }

      await writeFile(
        join(testDir, 'change-test.json'),
        JSON.stringify(updatedContent)
      )

      // Wait for watcher to pick up change
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        status = monitor.getStatus('change-test')
        if (status?.state === 'working') break
      }

      expect(status?.state).toBe('working')
      expect(status?.message).toBe('Updated state')
    })
  })
})
