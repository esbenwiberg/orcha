/**
 * ConfigLoader - Handles preset configuration management
 *
 * Presets allow saving and loading session configurations for quick startup.
 * Stored in ~/.orcha/presets/{name}.json
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import type { PresetConfig, SessionMode } from './types.js'

const DEFAULT_PRESETS_DIR = join(homedir(), '.orcha', 'presets')

export interface ConfigLoaderOptions {
  presetsDir?: string
}

export class ConfigLoader {
  private presetsDir: string

  constructor(options: ConfigLoaderOptions = {}) {
    this.presetsDir = options.presetsDir || DEFAULT_PRESETS_DIR
  }

  /**
   * Ensure presets directory exists
   */
  async init(): Promise<void> {
    await mkdir(this.presetsDir, { recursive: true })
  }

  /**
   * Save a preset configuration
   */
  async savePreset(preset: PresetConfig): Promise<string> {
    await this.init()

    const fileName = this.sanitizeName(preset.name) + '.json'
    const filePath = join(this.presetsDir, fileName)

    await writeFile(filePath, JSON.stringify(preset, null, 2))
    return filePath
  }

  /**
   * Load a preset by name
   */
  async loadPreset(name: string): Promise<PresetConfig> {
    const fileName = this.sanitizeName(name) + '.json'
    const filePath = join(this.presetsDir, fileName)

    if (!existsSync(filePath)) {
      throw new Error(`Preset not found: ${name}`)
    }

    const content = await readFile(filePath, 'utf-8')
    const data = JSON.parse(content)

    return this.validatePreset(data)
  }

  /**
   * List all available presets
   */
  async listPresets(): Promise<PresetInfo[]> {
    await this.init()

    if (!existsSync(this.presetsDir)) {
      return []
    }

    const files = await readdir(this.presetsDir)
    const presets: PresetInfo[] = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue

      try {
        const preset = await this.loadPreset(basename(file, '.json'))
        presets.push({
          name: preset.name,
          description: preset.description,
          sessionCount: preset.sessions.length,
          repoPath: preset.repoPath,
        })
      } catch {
        // Skip invalid preset files
      }
    }

    return presets
  }

  /**
   * Delete a preset by name
   */
  async deletePreset(name: string): Promise<boolean> {
    const fileName = this.sanitizeName(name) + '.json'
    const filePath = join(this.presetsDir, fileName)

    if (!existsSync(filePath)) {
      return false
    }

    await unlink(filePath)
    return true
  }

  /**
   * Check if a preset exists
   */
  exists(name: string): boolean {
    const fileName = this.sanitizeName(name) + '.json'
    const filePath = join(this.presetsDir, fileName)
    return existsSync(filePath)
  }

  /**
   * Create a preset from current session state
   */
  createPresetFromSessions(
    name: string,
    sessions: Array<{ branch?: string; mode?: SessionMode }>,
    repoPath: string,
    description?: string
  ): PresetConfig {
    return {
      name,
      description,
      sessions: sessions.map((s) => ({
        branch: s.branch,
        mode: s.mode || 'claude',
      })),
      repoPath,
    }
  }

  /**
   * Sanitize preset name for use as filename
   */
  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  }

  /**
   * Validate preset data structure
   */
  private validatePreset(data: unknown): PresetConfig {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid preset: must be an object')
    }

    const obj = data as Record<string, unknown>

    if (typeof obj.name !== 'string' || !obj.name) {
      throw new Error('Invalid preset: name is required')
    }

    if (typeof obj.repoPath !== 'string' || !obj.repoPath) {
      throw new Error('Invalid preset: repoPath is required')
    }

    if (!Array.isArray(obj.sessions)) {
      throw new Error('Invalid preset: sessions must be an array')
    }

    const validModes: SessionMode[] = ['claude', 'gemini', 'codex', 'shell']

    for (const session of obj.sessions) {
      if (session && typeof session === 'object') {
        const s = session as Record<string, unknown>
        if (s.mode && !validModes.includes(s.mode as SessionMode)) {
          throw new Error(`Invalid preset: invalid mode "${s.mode}"`)
        }
      }
    }

    return {
      name: obj.name,
      description: obj.description as string | undefined,
      sessions: obj.sessions as PresetConfig['sessions'],
      repoPath: obj.repoPath,
    }
  }
}

/**
 * Summary info about a preset (for listing)
 */
export interface PresetInfo {
  name: string
  description?: string
  sessionCount: number
  repoPath: string
}
