#!/usr/bin/env node

/**
 * Post-install script for Orcha
 *
 * Copies default prompt templates from the npm package to ~/.orcha/prompts/defaults/
 * Only copies if target doesn't exist (doesn't overwrite user's defaults)
 * Idempotent - safe to run multiple times
 */

import { cp, mkdir, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ORCHA_HOME = join(homedir(), '.orcha')
const TARGET_DEFAULTS_DIR = join(ORCHA_HOME, 'prompts', 'defaults')

// Source directory is relative to this script
// scripts/install-defaults.js -> look for prompts/defaults/ at package root
const PACKAGE_ROOT = join(__dirname, '..')
const SOURCE_DEFAULTS_DIR = join(PACKAGE_ROOT, 'prompts', 'defaults')

/**
 * Check if a file or directory exists
 */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function installDefaults() {
  try {
    // Check if source directory exists (it should in the npm package)
    if (!(await exists(SOURCE_DEFAULTS_DIR))) {
      console.log('[orcha] No default templates to install (source directory not found)')
      return
    }

    // Check if target already exists
    if (await exists(TARGET_DEFAULTS_DIR)) {
      console.log('[orcha] Default templates already exist at ~/.orcha/prompts/defaults/ - skipping installation')
      console.log('[orcha] (To reset templates, use: orcha prompts reset <template-name>)')
      return
    }

    // Create target directory structure
    await mkdir(TARGET_DEFAULTS_DIR, { recursive: true })

    // Copy default templates
    await cp(SOURCE_DEFAULTS_DIR, TARGET_DEFAULTS_DIR, { recursive: true })

    console.log('[orcha] Installed default prompt templates to ~/.orcha/prompts/defaults/')
    console.log('[orcha] View templates with: orcha prompts list')
    console.log('[orcha] Customize templates with: orcha prompts edit <template-name>')
  } catch (err) {
    console.error('[orcha] Warning: Failed to install default templates:', err.message)
    console.error('[orcha] You can manually copy them from:', SOURCE_DEFAULTS_DIR)
  }
}

// Run installation
installDefaults()
