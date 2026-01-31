/**
 * Tests for ConfigLoader - Preset management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ConfigLoader } from '../core/config-loader.js'
import { mkdir, rm, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('ConfigLoader', () => {
  let testDir: string
  let configLoader: ConfigLoader

  beforeEach(async () => {
    // Create a temporary directory for tests
    testDir = join(tmpdir(), `orcha-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(testDir, { recursive: true })
    configLoader = new ConfigLoader({ presetsDir: testDir })
  })

  afterEach(async () => {
    // Cleanup test directory
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  describe('savePreset', () => {
    it('should save a valid preset', async () => {
      const preset = {
        name: 'test-preset',
        description: 'A test preset',
        sessions: [
          { branch: 'feature/test', mode: 'claude' as const },
        ],
        repoPath: '/tmp/test-repo',
      }

      const filePath = await configLoader.savePreset(preset)
      expect(filePath).toContain('test-preset.json')
      expect(existsSync(filePath)).toBe(true)
    })

    it('should sanitize preset names', async () => {
      const preset = {
        name: 'My Test Preset!!!',
        sessions: [],
        repoPath: '/tmp/test',
      }

      const filePath = await configLoader.savePreset(preset)
      expect(filePath).toContain('my-test-preset.json')
    })
  })

  describe('loadPreset', () => {
    it('should load a saved preset', async () => {
      const original = {
        name: 'load-test',
        description: 'Test loading',
        sessions: [
          { branch: 'main', mode: 'claude' as const },
          { mode: 'shell' as const },
        ],
        repoPath: '/home/user/project',
      }

      await configLoader.savePreset(original)
      const loaded = await configLoader.loadPreset('load-test')

      expect(loaded.name).toBe(original.name)
      expect(loaded.description).toBe(original.description)
      expect(loaded.repoPath).toBe(original.repoPath)
      expect(loaded.sessions).toHaveLength(2)
      expect(loaded.sessions[0].branch).toBe('main')
    })

    it('should throw for non-existent preset', async () => {
      await expect(configLoader.loadPreset('does-not-exist'))
        .rejects.toThrow('Preset not found')
    })
  })

  describe('listPresets', () => {
    it('should list all presets', async () => {
      await configLoader.savePreset({
        name: 'preset-1',
        sessions: [{ mode: 'claude' as const }],
        repoPath: '/tmp/1',
      })

      await configLoader.savePreset({
        name: 'preset-2',
        description: 'Second preset',
        sessions: [{ mode: 'claude' as const }, { mode: 'shell' as const }],
        repoPath: '/tmp/2',
      })

      const presets = await configLoader.listPresets()

      expect(presets).toHaveLength(2)
      expect(presets.map(p => p.name)).toContain('preset-1')
      expect(presets.map(p => p.name)).toContain('preset-2')

      const preset2 = presets.find(p => p.name === 'preset-2')
      expect(preset2?.sessionCount).toBe(2)
      expect(preset2?.description).toBe('Second preset')
    })

    it('should return empty array when no presets exist', async () => {
      const presets = await configLoader.listPresets()
      expect(presets).toHaveLength(0)
    })
  })

  describe('deletePreset', () => {
    it('should delete an existing preset', async () => {
      await configLoader.savePreset({
        name: 'to-delete',
        sessions: [],
        repoPath: '/tmp/test',
      })

      expect(configLoader.exists('to-delete')).toBe(true)

      const deleted = await configLoader.deletePreset('to-delete')
      expect(deleted).toBe(true)
      expect(configLoader.exists('to-delete')).toBe(false)
    })

    it('should return false for non-existent preset', async () => {
      const deleted = await configLoader.deletePreset('not-there')
      expect(deleted).toBe(false)
    })
  })

  describe('exists', () => {
    it('should return true for existing preset', async () => {
      await configLoader.savePreset({
        name: 'exists-test',
        sessions: [],
        repoPath: '/tmp/test',
      })

      expect(configLoader.exists('exists-test')).toBe(true)
    })

    it('should return false for non-existent preset', () => {
      expect(configLoader.exists('nope')).toBe(false)
    })
  })

  describe('createPresetFromSessions', () => {
    it('should create a preset config from session data', () => {
      const sessions = [
        { branch: 'feature/a', mode: 'claude' as const },
        { branch: 'feature/b' },
        { mode: 'shell' as const },
      ]

      const preset = configLoader.createPresetFromSessions(
        'from-sessions',
        sessions,
        '/home/user/repo',
        'Created from running sessions'
      )

      expect(preset.name).toBe('from-sessions')
      expect(preset.description).toBe('Created from running sessions')
      expect(preset.repoPath).toBe('/home/user/repo')
      expect(preset.sessions).toHaveLength(3)
      expect(preset.sessions[0].branch).toBe('feature/a')
      expect(preset.sessions[1].mode).toBe('claude') // default
      expect(preset.sessions[2].mode).toBe('shell')
    })
  })

  describe('validation', () => {
    it('should reject preset without name', async () => {
      // Manually write invalid JSON
      const filePath = join(testDir, 'invalid.json')
      const fs = await import('fs/promises')
      await fs.writeFile(filePath, JSON.stringify({ sessions: [], repoPath: '/tmp' }))

      await expect(configLoader.loadPreset('invalid'))
        .rejects.toThrow('name is required')
    })

    it('should reject preset without repoPath', async () => {
      const filePath = join(testDir, 'no-repo.json')
      const fs = await import('fs/promises')
      await fs.writeFile(filePath, JSON.stringify({ name: 'test', sessions: [] }))

      await expect(configLoader.loadPreset('no-repo'))
        .rejects.toThrow('repoPath is required')
    })

    it('should reject preset with invalid mode', async () => {
      const filePath = join(testDir, 'bad-mode.json')
      const fs = await import('fs/promises')
      await fs.writeFile(filePath, JSON.stringify({
        name: 'test',
        repoPath: '/tmp',
        sessions: [{ mode: 'invalid-mode' }]
      }))

      await expect(configLoader.loadPreset('bad-mode'))
        .rejects.toThrow('invalid mode')
    })
  })
})
