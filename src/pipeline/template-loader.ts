/**
 * Template Loader for Orcha Pipeline
 *
 * Loads and compiles prompt templates from YAML files using Handlebars.
 * Supports custom overrides and default templates.
 */

import { readFile, access, mkdir, writeFile, readdir, rm, cp, unlink, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, normalize, relative, isAbsolute, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import HandlebarsImport from 'handlebars'
import * as yaml from 'js-yaml'
import * as tar from 'tar'

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

/** Maximum nesting depth for objects in variables. Prevents stack overflow during validation. */
const MAX_OBJECT_DEPTH = 10

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
// Object Validation Helpers
// ============================================================================

/**
 * Recursively validate object depth and check for circular references.
 *
 * Security: Deeply nested objects can cause stack overflow during Handlebars
 * compilation. Circular references would cause infinite loops.
 *
 * @param obj - Object to validate
 * @param maxDepth - Maximum allowed nesting depth
 * @param seen - WeakSet to track visited objects for circular reference detection
 * @returns Error message string if validation fails, null if valid
 */
function validateObjectDepth(obj: unknown, maxDepth: number, seen: WeakSet<object>): string | null {
  if (maxDepth < 0) {
    return `exceeds maximum nesting depth (${MAX_OBJECT_DEPTH} levels)`
  }

  if (typeof obj !== 'object' || obj === null) {
    return null // Primitives are always valid
  }

  // Check for circular references
  if (seen.has(obj)) {
    return 'contains circular reference'
  }
  seen.add(obj)

  // Recursively check all properties
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const error = validateObjectDepth(item, maxDepth - 1, seen)
      if (error) return error
    }
  } else {
    for (const key of Object.keys(obj)) {
      const value = (obj as Record<string, unknown>)[key]
      const error = validateObjectDepth(value, maxDepth - 1, seen)
      if (error) return error
    }
  }

  return null
}

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
      // Validate nested object depth and check for circular references
      // This prevents stack overflow during Handlebars compilation
      const depthError = validateObjectDepth(data.variables, MAX_OBJECT_DEPTH, new WeakSet())
      if (depthError) {
        throw new Error(
          `Invalid template at ${path}: "variables" field ${depthError}`
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
  // Reject absolute paths (including UNC paths on Windows which start with //)
  if (templateName.startsWith('/')) {
    throw new Error(`Invalid template name (absolute path): ${templateName}`)
  }
  // Reject UNC paths that might be encoded or use backslashes
  // UNC paths like '//server/share' or '\\server\share' could escape the directory
  if (templateName.startsWith('\\') || templateName.includes('\\\\')) {
    throw new Error(`Invalid template name (UNC path): ${templateName}`)
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
 * Validates template structure and Handlebars syntax.
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

  // Defense-in-depth: verify resolved paths are within expected directories
  // This catches any edge cases the name validation might miss.
  //
  // Security: Use path.resolve() to get absolute paths, then verify they don't
  // escape the expected directory using relative() checks.
  //
  // NOTE: resolve() does NOT follow symlinks — it only normalizes the path string.
  // This is INTENTIONAL for the following reasons:
  //
  // 1. Symlinks within ~/.orcha/prompts/ are a USER CONFIGURATION CHOICE
  //    - The user controls this directory and has write access anyway
  //    - A user creating a symlink is explicitly opting into that behavior
  //    - Symlinks don't escalate privilege since the user already has access
  //
  // 2. Using realpath() would break legitimate use cases:
  //    - It fails on non-existent paths (we check both custom and default)
  //    - Users may want to symlink templates from a shared location
  //
  // 3. Defense-in-depth is still provided by:
  //    - assertSafeTemplateName rejecting '..' and absolute paths
  //    - The relative() check below catching path escape via normalized paths
  //    - File permissions (only the user can write to ~/.orcha/)
  //
  // The resolve() call normalizes the path including:
  // - Normalizing slashes
  // - Resolving . and .. segments
  // - Converting to absolute path
  const resolvedCustom = resolve(customPath)
  const resolvedDefault = resolve(defaultPath)
  const resolvedCustomDir = resolve(CUSTOM_PROMPTS_DIR)
  const resolvedDefaultDir = resolve(DEFAULT_PROMPTS_DIR)

  // Check custom path is contained within custom directory
  // Use relative() on resolved paths - if it starts with '..' the path escapes
  const relativeToCustom = relative(resolvedCustomDir, resolvedCustom)
  if (relativeToCustom.startsWith('..') || isAbsolute(relativeToCustom)) {
    throw new Error(`Invalid template path (escapes custom directory): ${templateName}`)
  }

  // Check default path is contained within default directory
  const relativeToDefault = relative(resolvedDefaultDir, resolvedDefault)
  if (relativeToDefault.startsWith('..') || isAbsolute(relativeToDefault)) {
    throw new Error(`Invalid template path (escapes default directory): ${templateName}`)
  }

  // Try custom first
  if (await exists(resolvedCustom)) {
    const template = await parseYamlTemplate(resolvedCustom)
    // Validate template structure and syntax
    validateTemplate(template)
    return template
  }

  // Fall back to default
  if (await exists(resolvedDefault)) {
    const template = await parseYamlTemplate(resolvedDefault)
    // Validate template structure and syntax
    validateTemplate(template)
    return template
  }

  throw new Error(
    `Template not found: ${templateName}\n` +
    `Searched:\n` +
    `  - ${resolvedCustom}\n` +
    `  - ${resolvedDefault}`
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
 * - Test compilation with empty variables to catch syntax errors
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
    const compiledSystem = Handlebars.compile(template.systemPrompt)
    // Test execution with empty object to catch runtime errors
    compiledSystem({})
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(
        `Template '${template.name}' validation failed: invalid Handlebars syntax in systemPrompt\n${err.message}`
      )
    }
    throw err
  }

  try {
    const compiledUser = Handlebars.compile(template.userPrompt)
    // Test execution with empty object to catch runtime errors
    compiledUser({})
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

// ============================================================================
// Template Saving
// ============================================================================

/**
 * Save a custom template override.
 *
 * Validates the template name and content before writing to disk.
 * Creates the custom directory and any subdirectories as needed.
 *
 * @param templateName - Template name (e.g., 'architect', 'gate/adversary')
 * @param content - YAML content as string
 * @throws Error if validation fails or file write fails
 */
export async function saveTemplate(templateName: string, content: string): Promise<void> {
  // Validate template name to prevent path traversal
  assertSafeTemplateName(templateName)

  // Validate content size
  if (content.length > MAX_YAML_SIZE) {
    throw new Error(
      `Template content too large (${content.length} bytes, max ${MAX_YAML_SIZE})`
    )
  }

  // Parse YAML content
  let rawData: unknown
  try {
    rawData = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA })
  } catch (err) {
    throw new Error(`YAML parse error: ${(err as Error).message}`)
  }

  // Validate that the parsed data is an object
  if (typeof rawData !== 'object' || rawData === null || Array.isArray(rawData)) {
    throw new Error('Invalid template: expected an object at root level')
  }

  const data = rawData as Record<string, unknown>

  // Validate required fields exist and have correct types
  if (typeof data.name !== 'string' || !data.name) {
    throw new Error('Missing or invalid required field "name" (expected non-empty string)')
  }
  if (typeof data.systemPrompt !== 'string' || !data.systemPrompt) {
    throw new Error('Missing or invalid required field "systemPrompt" (expected non-empty string)')
  }
  if (typeof data.userPrompt !== 'string' || !data.userPrompt) {
    throw new Error('Missing or invalid required field "userPrompt" (expected non-empty string)')
  }

  // Validate optional fields have correct types if present
  if (data.version !== undefined && typeof data.version !== 'string') {
    throw new Error('"version" field must be a string')
  }
  if (data.description !== undefined && typeof data.description !== 'string') {
    throw new Error('"description" field must be a string')
  }
  if (data.variables !== undefined) {
    if (typeof data.variables !== 'object' || data.variables === null || Array.isArray(data.variables)) {
      throw new Error('"variables" field must be an object')
    }
    // Validate nested object depth
    const depthError = validateObjectDepth(data.variables, MAX_OBJECT_DEPTH, new WeakSet())
    if (depthError) {
      throw new Error(`"variables" field ${depthError}`)
    }
  }

  // Validate field lengths
  const systemPromptStr = data.systemPrompt as string
  const userPromptStr = data.userPrompt as string
  if (systemPromptStr.length > MAX_FIELD_LENGTH) {
    throw new Error(`"systemPrompt" exceeds max length (${systemPromptStr.length} > ${MAX_FIELD_LENGTH})`)
  }
  if (userPromptStr.length > MAX_FIELD_LENGTH) {
    throw new Error(`"userPrompt" exceeds max length (${userPromptStr.length} > ${MAX_FIELD_LENGTH})`)
  }

  // Build template data object
  const template: TemplateData = {
    name: data.name,
    version: (data.version as string) ?? '',
    description: (data.description as string) ?? '',
    variables: (data.variables as Record<string, unknown>) ?? {},
    systemPrompt: data.systemPrompt,
    userPrompt: data.userPrompt,
  }

  // Validate using existing validateTemplate function
  validateTemplate(template)

  // Determine output path
  const customPath = join(CUSTOM_PROMPTS_DIR, `${templateName}.yaml`)

  // Defense-in-depth: verify resolved path is within custom directory
  const resolvedCustom = resolve(customPath)
  const resolvedCustomDir = resolve(CUSTOM_PROMPTS_DIR)
  const relativeToCustom = relative(resolvedCustomDir, resolvedCustom)
  if (relativeToCustom.startsWith('..') || isAbsolute(relativeToCustom)) {
    throw new Error('Invalid template path (escapes custom directory)')
  }

  // Create custom directory and any subdirectories (e.g., gate/)
  const customDir = dirname(resolvedCustom)
  await mkdir(customDir, { recursive: true })

  // Write template to file
  try {
    await writeFile(resolvedCustom, content, 'utf-8')
  } catch (err) {
    throw new Error(`Failed to write template file: ${(err as Error).message}`)
  }
}

// ============================================================================
// Template Export/Import
// ============================================================================

/**
 * Export custom templates to a tarball.
 *
 * Creates a gzipped tarball containing all custom template overrides
 * along with a manifest file containing metadata.
 *
 * @param outputPath - Path for output tarball (default: ./orcha-prompts-export.tar.gz)
 * @throws Error if export fails
 */
export async function exportTemplates(outputPath: string = './orcha-prompts-export.tar.gz'): Promise<void> {
  // Check if custom directory exists and has files
  if (!existsSync(CUSTOM_PROMPTS_DIR)) {
    throw new Error('No custom templates to export (custom directory does not exist)')
  }

  const files = await readdir(CUSTOM_PROMPTS_DIR, { recursive: true })
  const yamlFiles = files.filter(f => typeof f === 'string' && f.endsWith('.yaml'))

  if (yamlFiles.length === 0) {
    throw new Error('No custom templates to export (no .yaml files found)')
  }

  // Create export manifest
  const manifest = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    orchaVersion: '0.1.0', // TODO: Read from package.json if needed
    templateCount: yamlFiles.length,
    templates: yamlFiles,
  }

  // Create temporary directory for manifest
  const tempDir = join(tmpdir(), `orcha-export-${Date.now()}`)
  await mkdir(tempDir, { recursive: true })
  const manifestPath = join(tempDir, 'export-manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  try {
    // Copy custom directory to temp dir to bundle with manifest
    const tempCustomDir = join(tempDir, 'custom')
    await cp(CUSTOM_PROMPTS_DIR, tempCustomDir, { recursive: true })

    // Create tarball with both custom templates and manifest
    await tar.create(
      {
        gzip: true,
        file: outputPath,
        cwd: tempDir,
      },
      ['custom', 'export-manifest.json']
    )
  } finally {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true })
  }
}

/**
 * Import custom templates from a tarball.
 *
 * Extracts templates from a tarball and validates them.
 * Prompts for confirmation before overwriting existing custom templates.
 *
 * @param inputPath - Path to tarball to import
 * @param confirmOverwrite - Callback to confirm overwriting existing files
 * @throws Error if import fails or validation fails
 */
export async function importTemplates(
  inputPath: string,
  confirmOverwrite?: () => Promise<boolean>
): Promise<void> {
  // Check if input file exists
  if (!existsSync(inputPath)) {
    throw new Error(`Import file not found: ${inputPath}`)
  }

  // Create temporary directory for extraction
  const tempDir = join(tmpdir(), `orcha-import-${Date.now()}`)
  await mkdir(tempDir, { recursive: true })

  try {
    // Extract tarball to temp directory
    await tar.extract({
      file: inputPath,
      cwd: tempDir,
    })

    // Check if custom directory was extracted
    const extractedCustomDir = join(tempDir, 'custom')
    if (!existsSync(extractedCustomDir)) {
      throw new Error('Invalid export: no custom directory found in tarball')
    }

    // List files that will be imported
    const files = await readdir(extractedCustomDir, { recursive: true })
    const yamlFiles = files.filter(f => typeof f === 'string' && f.endsWith('.yaml'))

    if (yamlFiles.length === 0) {
      throw new Error('Invalid export: no .yaml files found in custom directory')
    }

    // Check for existing custom templates
    const existingFiles: string[] = []
    if (existsSync(CUSTOM_PROMPTS_DIR)) {
      for (const file of yamlFiles) {
        const targetPath = join(CUSTOM_PROMPTS_DIR, file)
        if (existsSync(targetPath)) {
          existingFiles.push(file)
        }
      }
    }

    // Confirm overwrite if there are existing files
    if (existingFiles.length > 0 && confirmOverwrite) {
      const shouldOverwrite = await confirmOverwrite()
      if (!shouldOverwrite) {
        throw new Error('Import cancelled by user')
      }
    }

    // Validate all templates before importing
    const invalidTemplates: string[] = []
    for (const file of yamlFiles) {
      const filePath = join(extractedCustomDir, file)
      try {
        const template = await parseYamlTemplate(filePath)
        validateTemplate(template)
      } catch (err) {
        invalidTemplates.push(`${file}: ${(err as Error).message}`)
      }
    }

    if (invalidTemplates.length > 0) {
      throw new Error(
        `Template validation failed:\n${invalidTemplates.map(e => `  - ${e}`).join('\n')}`
      )
    }

    // Create backup of existing custom directory
    let backupDir: string | null = null
    if (existsSync(CUSTOM_PROMPTS_DIR)) {
      backupDir = `${CUSTOM_PROMPTS_DIR}.backup-${Date.now()}`
      await rename(CUSTOM_PROMPTS_DIR, backupDir)
    }

    try {
      // Ensure custom directory exists
      await mkdir(CUSTOM_PROMPTS_DIR, { recursive: true })

      // Copy files from temp to custom directory
      await cp(extractedCustomDir, CUSTOM_PROMPTS_DIR, { recursive: true })

      // Clean up backup ONLY after import fully succeeded
      // Note: If the process crashes between cp() and rm(), the backup remains
      // but this is acceptable — user can manually clean up, and data is safe
      if (backupDir) {
        await rm(backupDir, { recursive: true, force: true })
      }
    } catch (err) {
      // Rollback: restore backup if it exists
      // Order is critical: rename backup FIRST, then clean up failed import
      // This ensures we never lose both directories if process crashes mid-rollback
      if (backupDir && existsSync(backupDir)) {
        // Step 1: Rename backup to a temp location first
        const tempRestoreDir = `${CUSTOM_PROMPTS_DIR}.restore-${Date.now()}`
        try {
          await rename(backupDir, tempRestoreDir)
          // Step 2: Now safe to remove the failed import directory
          if (existsSync(CUSTOM_PROMPTS_DIR)) {
            await rm(CUSTOM_PROMPTS_DIR, { recursive: true, force: true })
          }
          // Step 3: Move restored backup to final location
          await rename(tempRestoreDir, CUSTOM_PROMPTS_DIR)
        } catch (rollbackErr) {
          // If rollback fails, leave backup in place so user can recover
          console.error(`Rollback failed: ${(rollbackErr as Error).message}`)
          console.error(`Backup preserved at: ${backupDir}`)
        }
      }
      throw new Error(`Failed to import templates: ${(err as Error).message}`)
    }
  } finally {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true })
  }
}
