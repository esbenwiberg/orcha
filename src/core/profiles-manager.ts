/**
 * ProfilesManager - Manage provider profiles
 *
 * Handles CRUD operations for named provider configurations.
 * Profiles are stored globally in ~/.orcha/profiles.json (chmod 0o600).
 */

import { readFile, writeFile, mkdir, chmod } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import type { ProviderProfile, ProfilesStore } from './types.js'

const ORCHA_DIR = join(homedir(), '.orcha')
const PROFILES_FILE = join(ORCHA_DIR, 'profiles.json')
const PROFILES_VERSION = 1

/**
 * Load profiles from disk
 */
export async function loadProfiles(): Promise<ProviderProfile[]> {
  try {
    if (!existsSync(PROFILES_FILE)) {
      return []
    }

    const content = await readFile(PROFILES_FILE, 'utf-8')
    const store = JSON.parse(content) as ProfilesStore

    if (!store.version) {
      store.version = PROFILES_VERSION
    }

    return store.profiles || []
  } catch (err) {
    console.error('[ProfilesManager] Failed to load profiles:', err)
    return []
  }
}

/**
 * Save profiles to disk (chmod 0o600 for API key protection)
 */
export async function saveProfiles(profiles: ProviderProfile[]): Promise<void> {
  await mkdir(ORCHA_DIR, { recursive: true })

  const store: ProfilesStore = {
    version: PROFILES_VERSION,
    profiles,
  }

  await writeFile(PROFILES_FILE, JSON.stringify(store, null, 2))
  await chmod(PROFILES_FILE, 0o600)
}

/**
 * Get all profiles
 */
export async function getProfiles(): Promise<ProviderProfile[]> {
  return await loadProfiles()
}

/**
 * Get a single profile by ID
 */
export async function getProfile(id: string): Promise<ProviderProfile | null> {
  const profiles = await loadProfiles()
  return profiles.find(p => p.id === id) || null
}

/**
 * Create a new profile
 */
export async function createProfile(
  name: string,
  model: string,
  baseUrl?: string,
  apiKey?: string,
  useLogin?: boolean
): Promise<ProviderProfile> {
  const profiles = await loadProfiles()

  const now = new Date().toISOString()
  const profile: ProviderProfile = {
    id: randomUUID(),
    name: name.trim(),
    model: model.trim(),
    ...(baseUrl && { baseUrl: baseUrl.trim() }),
    ...(apiKey && !useLogin && { apiKey: apiKey.trim() }),
    ...(useLogin && { useLogin: true }),
    createdAt: now,
    updatedAt: now,
  }

  profiles.push(profile)
  await saveProfiles(profiles)

  return profile
}

/**
 * Update an existing profile
 */
export async function updateProfile(
  id: string,
  updates: Partial<Pick<ProviderProfile, 'name' | 'model' | 'baseUrl' | 'apiKey' | 'useLogin'>>
): Promise<ProviderProfile | null> {
  const profiles = await loadProfiles()
  const index = profiles.findIndex(p => p.id === id)

  if (index === -1) {
    return null
  }

  const profile = profiles[index]

  if (updates.name !== undefined) profile.name = updates.name.trim()
  if (updates.model !== undefined) profile.model = updates.model.trim()
  if (updates.baseUrl !== undefined) profile.baseUrl = updates.baseUrl.trim() || undefined
  if (updates.useLogin !== undefined) {
    profile.useLogin = updates.useLogin || undefined
    if (updates.useLogin) profile.apiKey = undefined // clear apiKey when switching to login
  }
  if (updates.apiKey !== undefined && !profile.useLogin) profile.apiKey = updates.apiKey.trim() || undefined
  profile.updatedAt = new Date().toISOString()

  await saveProfiles(profiles)

  return profile
}

/**
 * Delete a profile
 */
export async function deleteProfile(id: string): Promise<boolean> {
  const profiles = await loadProfiles()
  const initialLength = profiles.length
  const filtered = profiles.filter(p => p.id !== id)

  if (filtered.length === initialLength) {
    return false
  }

  await saveProfiles(filtered)
  return true
}
