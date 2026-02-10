/**
 * Template Loader for Orcha Pipeline
 *
 * Loads and compiles prompt templates from YAML files using Handlebars.
 * Supports custom overrides and default templates.
 */

import { readFile, access } from 'node:fs/promises'
import { join, normalize, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import HandlebarsImport from 'handlebars'
import * as yaml from 'js-yaml'

// Access Handlebars from default export
const Handlebars = HandlebarsImport

// ============================================================================
// Constants
// ============================================================================

const ORCHA_HOME = join(homedir(), '.orcha')
export const CUSTOM_PROMPTS_DIR = join(ORCHA_HOME, 'prompts', 'custom')
export const DEFAULT_PROMPTS_DIR = join(ORCHA_HOME, 'prompts', 'defaults')

/** Maximum YAML file size to parse (100KB). Prevents memory exhaustion from large files. */
const MAX_YAML_SIZE = 100 * 1024

/** Maximum string length for any single field in the template. Prevents memory exhaustion. */
const MAX_FIELD_LENGTH = 50 * 1024

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
 *
 * Security: Uses FAILSAFE_SCHEMA (the most restrictive schema) to prevent
 * arbitrary code execution via malicious YAML tags. FAILSAFE_SCHEMA only
 * allows strings, arrays, and objects — no special types like !!python/object,
 * !!js/function, or even !!int/!!float (they remain strings).
 */
async function parseYamlTemplate(path: string): Promise<TemplateData> {
  try {
    const content = await readFile(path, 'utf-8')

    // Check file size to prevent memory exhaustion
    if (content.length > MAX_YAML_SIZE) {
      throw new Error(
        `Template file too large (${content.length} bytes, max ${MAX_YAML_SIZE})`
      )
    }

    // Use FAILSAFE_SCHEMA — the most restrictive schema that only allows
    // strings, arrays, and plain objects. This completely prevents arbitrary
    // code execution from malicious YAML tags (e.g., !!python/object, !!js/function).
    const rawData = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA })

    // Validate that the parsed data is an object (not null, array, or primitive)
    if (typeof rawData !== 'object' || rawData === null || Array.isArray(rawData)) {
      throw new Error(
        `Invalid template at ${path}: expected an object at root level`
      )
    }

    const data = rawData as Record<string, unknown>

    // Validate required fields exist and have correct types
    if (typeof data.name !== 'string' || !data.name) {
      throw new Error(
        `Invalid template at ${path}: missing or invalid required field "name" (expected non-empty string)`
      )
    }
    if (typeof data.systemPrompt !== 'string' || !data.systemPrompt) {
      throw new Error(
        `Invalid template at ${path}: missing or invalid required field "systemPrompt" (expected non-empty string)`
      )
    }
    if (typeof data.userPrompt !== 'string' || !data.userPrompt) {
      throw new Error(
        `Invalid template at ${path}: missing or invalid required field "userPrompt" (expected non-empty string)`
      )
    }

    // Validate optional fields have correct types if present
    if (data.version !== undefined && typeof data.version !== 'string') {
      throw new Error(
        `Invalid template at ${path}: "version" field must be a string`
      )
    }
    if (data.description !== undefined && typeof data.description !== 'string') {
      throw new Error(
        `Invalid template at ${path}: "description" field must be a string`
      )
    }
    if (data.variables !== undefined) {
      if (typeof data.variables !== 'object' || data.variables === null || Array.isArray(data.variables)) {
        throw new Error(
          `Invalid template at ${path}: "variables" field must be an object (Record<string, unknown>)`
        )
      }
    }

    // Validate field lengths to prevent memory exhaustion from extremely large strings
    const systemPromptStr = data.systemPrompt as string
    const userPromptStr = data.userPrompt as string
    if (systemPromptStr.length > MAX_FIELD_LENGTH) {
      throw new Error(
        `Invalid template at ${path}: "systemPrompt" exceeds max length (${systemPromptStr.length} > ${MAX_FIELD_LENGTH})`
      )
    }
    if (userPromptStr.length > MAX_FIELD_LENGTH) {
      throw new Error(
        `Invalid template at ${path}: "userPrompt" exceeds max length (${userPromptStr.length} > ${MAX_FIELD_LENGTH})`
      )
    }

    // Cast to TemplateData now that we've validated structure
    return {
      name: data.name,
      version: (data.version as string) ?? '',
      description: (data.description as string) ?? '',
      variables: (data.variables as Record<string, unknown>) ?? {},
      systemPrompt: data.systemPrompt,
      userPrompt: data.userPrompt,
    }
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Failed to parse template at ${path}: ${err.message}`)
    }
    throw err
  }
}

// ============================================================================
// Template Discovery
// ============================================================================

/**
 * Template metadata for listing.
 */
export interface TemplateInfo {
  name: string
  path: string
  hasCustom: boolean
  description: string
}

/**
 * List all available templates in the defaults directory.
 *
 * Scans ~/.orcha/prompts/defaults/ for *.yaml files and checks if
 * corresponding custom overrides exist in ~/.orcha/prompts/custom/.
 *
 * @returns Array of template metadata
 */
export async function listTemplates(): Promise<TemplateInfo[]> {
  const { readdir } = await import('node:fs/promises')
  const templates: TemplateInfo[] = []

  try {
    // Scan defaults directory
    const defaultFiles = await readdir(DEFAULT_PROMPTS_DIR, { withFileTypes: true, recursive: true })

    for (const entry of defaultFiles) {
      // Only process .yaml files
      if (!entry.isFile() || !entry.name.endsWith('.yaml')) {
        continue
      }

      // Build relative path from defaults directory
      // entry.path is the directory containing the file
      const relativeDir = entry.path.replace(DEFAULT_PROMPTS_DIR, '').replace(/^\//, '')
      const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name

      // Remove .yaml extension to get template name
      const templateName = relativePath.replace(/\.yaml$/, '')

      // Check if custom override exists
      const customPath = join(CUSTOM_PROMPTS_DIR, relativePath)
      const hasCustom = await exists(customPath)

      // Load template to get description
      let description = ''
      try {
        const defaultPath = join(DEFAULT_PROMPTS_DIR, relativePath)
        const template = await parseYamlTemplate(defaultPath)
        description = template.description
      } catch {
        // If we can't parse it, just skip the description
        description = '(invalid template)'
      }

      templates.push({
        name: templateName,
        path: join(DEFAULT_PROMPTS_DIR, relativePath),
        hasCustom,
        description,
      })
    }

    return templates
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Defaults directory doesn't exist - return empty list
      return []
    }
    throw new Error(`Failed to list templates: ${(err as Error).message}`)
  }
}

// ============================================================================
// Template Loading
// ============================================================================

/**
 * Validate that a template name is safe (no path traversal).
 * Only allows alphanumeric characters, hyphens, underscores, and forward slashes.
 *
 * Security: Prevents path traversal attacks like '../../../etc/passwd'.
 */
const SAFE_TEMPLATE_NAME_RE = /^[a-zA-Z0-9_/-]+$/

function assertSafeTemplateName(templateName: string): void {
  // Reject empty names
  if (!templateName) {
    throw new Error('Template name cannot be empty')
  }
  // Reject names that are too long (prevent DoS)
  if (templateName.length > 100) {
    throw new Error(`Template name too long: ${templateName.slice(0, 20)}...`)
  }
  // Reject path traversal sequences
  if (templateName.includes('..')) {
    throw new Error(`Invalid template name (path traversal): ${templateName}`)
  }
  // Reject absolute paths
  if (templateName.startsWith('/')) {
    throw new Error(`Invalid template name (absolute path): ${templateName}`)
  }
  // Only allow safe characters
  if (!SAFE_TEMPLATE_NAME_RE.test(templateName)) {
    throw new Error(`Invalid template name (unsafe characters): ${templateName}`)
  }
  // Validate each path segment individually to catch edge cases like 'foo//bar'
  // or segments that are empty after split (which would indicate consecutive slashes)
  const segments = templateName.split('/')
  for (const segment of segments) {
    if (!segment) {
      throw new Error(`Invalid template name (empty path segment): ${templateName}`)
    }
    // Each segment must not be a relative path indicator
    if (segment === '.' || segment === '..') {
      throw new Error(`Invalid template name (relative path segment): ${templateName}`)
    }
  }
}

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
  // Validate template name to prevent path traversal
  assertSafeTemplateName(templateName)

  const customPath = join(CUSTOM_PROMPTS_DIR, `${templateName}.yaml`)
  const defaultPath = join(DEFAULT_PROMPTS_DIR, `${templateName}.yaml`)

  // Defense-in-depth: verify normalized paths are within expected directories
  // This catches any edge cases the name validation might miss
  const normalizedCustom = normalize(customPath)
  const normalizedDefault = normalize(defaultPath)

  if (!normalizedCustom.startsWith(CUSTOM_PROMPTS_DIR) || isAbsolute(templateName)) {
    throw new Error(`Invalid template path (escapes custom directory): ${templateName}`)
  }
  if (!normalizedDefault.startsWith(DEFAULT_PROMPTS_DIR) || isAbsolute(templateName)) {
    throw new Error(`Invalid template path (escapes default directory): ${templateName}`)
  }

  // Try custom first
  if (await exists(normalizedCustom)) {
    return parseYamlTemplate(normalizedCustom)
  }

  // Fall back to default
  if (await exists(normalizedDefault)) {
    return parseYamlTemplate(normalizedDefault)
  }

  throw new Error(
    `Template not found: ${templateName}\n` +
    `Searched:\n` +
    `  - ${normalizedCustom}\n` +
    `  - ${normalizedDefault}`
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

// ============================================================================
// Template Management
// ============================================================================

/**
 * Reset a template to its default by deleting the custom override.
 *
 * @param templateName - Template name (e.g., 'architect', 'gate/adversary')
 * @throws Error if template doesn't exist or deletion fails
 */
export async function resetTemplate(templateName: string): Promise<void> {
  // Validate template name to prevent path traversal
  assertSafeTemplateName(templateName)

  const customPath = join(CUSTOM_PROMPTS_DIR, `${templateName}.yaml`)
  const defaultPath = join(DEFAULT_PROMPTS_DIR, `${templateName}.yaml`)

  // Check if default exists
  if (!(await exists(defaultPath))) {
    throw new Error(`Template '${templateName}' does not exist in defaults`)
  }

  // Check if custom override exists
  if (!(await exists(customPath))) {
    throw new Error(`Template '${templateName}' has no custom override to reset`)
  }

  // Delete custom override
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(customPath)
  } catch (err) {
    throw new Error(`Failed to delete custom override: ${(err as Error).message}`)
  }
}
