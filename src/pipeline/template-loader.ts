/**
 * Template Loader for Orcha Pipeline
 *
 * Loads and compiles prompt templates from YAML files using Handlebars.
 * Supports custom overrides and default templates.
 */

import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import Handlebars from 'handlebars'
import * as yaml from 'js-yaml'

// ============================================================================
// Constants
// ============================================================================

const ORCHA_HOME = join(homedir(), '.orcha')
export const CUSTOM_PROMPTS_DIR = join(ORCHA_HOME, 'prompts', 'custom')
export const DEFAULT_PROMPTS_DIR = join(ORCHA_HOME, 'prompts', 'defaults')

// ============================================================================
// Types
// ============================================================================

/**
 * Template metadata and content structure.
 */
export interface TemplateData {
  name: string
  version: string
  description: string
  variables: Record<string, unknown>
  systemPrompt: string
  userPrompt: string
}

/**
 * Compiled prompt parts ready for use.
 */
export interface CompiledPrompt {
  systemPrompt: string
  userPrompt: string
}

// ============================================================================
// Handlebars Helpers
// ============================================================================

/**
 * Register custom Handlebars helpers for template compilation.
 */
function registerHelpers(): void {
  // Add two numbers
  Handlebars.registerHelper('add', (a: number, b: number) => a + b)

  // Join array with separator
  Handlebars.registerHelper('join', (arr: unknown[], sep: string) => {
    if (!Array.isArray(arr)) return ''
    return arr.join(sep)
  })

  // Truncate string to length
  Handlebars.registerHelper('truncate', (str: string, len: number) => {
    if (typeof str !== 'string') return ''
    return str.slice(0, len)
  })
}

// Register helpers on module load
registerHelpers()

// ============================================================================
// File System Utilities
// ============================================================================

/**
 * Check if a file exists.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Parse YAML file content into TemplateData.
 */
async function parseYamlTemplate(path: string): Promise<TemplateData> {
  try {
    const content = await readFile(path, 'utf-8')
    const data = yaml.load(content) as TemplateData

    // Basic validation that required fields exist
    if (!data.name || !data.systemPrompt || !data.userPrompt) {
      throw new Error(
        `Invalid template at ${path}: missing required fields (name, systemPrompt, userPrompt)`
      )
    }

    return data
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Failed to parse template at ${path}: ${err.message}`)
    }
    throw err
  }
}

// ============================================================================
// Template Loading
// ============================================================================

/**
 * Load a template by name.
 *
 * Checks custom overrides first, then falls back to defaults.
 *
 * @param templateName - Template name (e.g., 'architect' or 'gate/adversary')
 * @returns Parsed template data
 * @throws Error if template not found or invalid
 */
export async function loadTemplate(templateName: string): Promise<TemplateData> {
  const customPath = join(CUSTOM_PROMPTS_DIR, `${templateName}.yaml`)
  const defaultPath = join(DEFAULT_PROMPTS_DIR, `${templateName}.yaml`)

  // Try custom first
  if (await exists(customPath)) {
    return parseYamlTemplate(customPath)
  }

  // Fall back to default
  if (await exists(defaultPath)) {
    return parseYamlTemplate(defaultPath)
  }

  throw new Error(
    `Template not found: ${templateName}\n` +
    `Searched:\n` +
    `  - ${customPath}\n` +
    `  - ${defaultPath}`
  )
}

// ============================================================================
// Template Compilation
// ============================================================================

/**
 * Compile a template with the given variables.
 *
 * @param template - Template data to compile
 * @param variables - Variables to interpolate into the template
 * @returns Compiled system and user prompts
 * @throws Error if Handlebars compilation fails
 */
export function compileTemplate(
  template: TemplateData,
  variables: Record<string, unknown>
): CompiledPrompt {
  try {
    const systemPromptCompiled = Handlebars.compile(template.systemPrompt)(variables)
    const userPromptCompiled = Handlebars.compile(template.userPrompt)(variables)

    return {
      systemPrompt: systemPromptCompiled,
      userPrompt: userPromptCompiled,
    }
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Failed to compile template '${template.name}': ${err.message}`)
    }
    throw err
  }
}

// ============================================================================
// Template Validation
// ============================================================================

/**
 * Validate a template's structure and syntax.
 *
 * Checks:
 * - Required fields exist (name, systemPrompt, userPrompt)
 * - Handlebars syntax is valid (can be compiled)
 * - Referenced variables exist in the variables schema
 *
 * @param template - Template to validate
 * @throws Error with descriptive message if validation fails
 */
export function validateTemplate(template: TemplateData): void {
  // Check required fields
  if (!template.name) {
    throw new Error('Template validation failed: missing required field "name"')
  }
  if (!template.systemPrompt) {
    throw new Error(`Template '${template.name}' validation failed: missing required field "systemPrompt"`)
  }
  if (!template.userPrompt) {
    throw new Error(`Template '${template.name}' validation failed: missing required field "userPrompt"`)
  }

  // Validate Handlebars syntax by attempting compilation with empty variables
  try {
    Handlebars.compile(template.systemPrompt)
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(
        `Template '${template.name}' validation failed: invalid Handlebars syntax in systemPrompt\n${err.message}`
      )
    }
    throw err
  }

  try {
    Handlebars.compile(template.userPrompt)
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(
        `Template '${template.name}' validation failed: invalid Handlebars syntax in userPrompt\n${err.message}`
      )
    }
    throw err
  }

  // Extract variable references from template and check against schema
  const extractedVars = extractVariableReferences(template)
  const schemaVars = template.variables ? Object.keys(template.variables) : []

  // Check if any referenced variables are missing from schema
  const missingVars = extractedVars.filter(v => !schemaVars.includes(v))
  if (missingVars.length > 0) {
    console.warn(
      `Template '${template.name}' references variables not in schema: ${missingVars.join(', ')}\n` +
      `This may be intentional if variables are optional or computed.`
    )
  }
}

/**
 * Extract variable references from a template's prompts.
 *
 * Parses Handlebars syntax to find all {{variable}} references.
 *
 * @param template - Template to analyze
 * @returns Array of variable names referenced in the template
 */
function extractVariableReferences(template: TemplateData): string[] {
  const vars = new Set<string>()

  // Simple regex to extract {{variable}} references
  // This doesn't handle all Handlebars syntax (like helpers, nested paths)
  // but catches the common case for validation warnings
  const regex = /\{\{([^}#/]+?)\}\}/g

  const extractFromText = (text: string) => {
    let match
    while ((match = regex.exec(text)) !== null) {
      // Clean up the variable name (remove whitespace, get first word for paths)
      const varName = match[1].trim().split(/[\s.]/)[0]
      if (varName && !varName.startsWith('#') && !varName.startsWith('/')) {
        vars.add(varName)
      }
    }
  }

  extractFromText(template.systemPrompt)
  extractFromText(template.userPrompt)

  return Array.from(vars)
}
