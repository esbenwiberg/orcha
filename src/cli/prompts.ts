/**
 * Orcha CLI - Prompts Commands
 *
 * Commands for viewing and managing pipeline prompt templates.
 */

import chalk from 'chalk'
import { spawn } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  loadTemplate,
  listTemplates,
  resetTemplate as resetTemplateImpl,
  CUSTOM_PROMPTS_DIR,
  DEFAULT_PROMPTS_DIR,
} from '../pipeline/template-loader.js'

/**
 * List all available prompt templates.
 *
 * Displays a table showing:
 * - Template name
 * - Whether it has a custom override
 * - Description
 */
export async function listPrompts(): Promise<void> {
  try {
    const templates = await listTemplates()

    if (templates.length === 0) {
      console.log('No prompt templates found.')
      console.log('\nTemplates should be located in:')
      console.log('  ~/.orcha/prompts/defaults/')
      console.log('  ~/.orcha/prompts/custom/ (for overrides)')
      return
    }

    // Table header
    console.log(
      chalk.bold('NAME'.padEnd(25)) +
      chalk.bold('CUSTOMIZED'.padEnd(13)) +
      chalk.bold('DESCRIPTION')
    )
    console.log('-'.repeat(80))

    // Sort by name for consistent display
    const sorted = templates.sort((a, b) => a.name.localeCompare(b.name))

    for (const template of sorted) {
      const customMark = template.hasCustom ? chalk.green('✓') : ' '
      const name = template.name.padEnd(25)
      const custom = customMark.padEnd(13)
      const desc = template.description || chalk.dim('(no description)')

      console.log(`${name}${custom}${desc}`)
    }

    console.log(`\n${templates.length} template(s) available`)
    console.log('\nCommands:')
    console.log('  orcha prompts show <name>   - View template details')
    console.log('  orcha prompts edit <name>   - Edit template in your editor')
    console.log('  orcha prompts reset <name>  - Reset template to default')
  } catch (err) {
    console.error(chalk.red('Error listing templates:'), (err as Error).message)
    process.exit(1)
  }
}

/**
 * Show details of a specific prompt template.
 *
 * Displays:
 * - Template metadata (name, version, description)
 * - Variables schema
 * - System prompt
 * - User prompt
 *
 * Applies syntax highlighting for better readability.
 *
 * @param name - Template name (e.g., 'architect', 'gate/adversary')
 */
export async function showPrompt(name: string): Promise<void> {
  try {
    const template = await loadTemplate(name)

    // Header
    console.log(chalk.bold.cyan(`\n${'='.repeat(80)}`))
    console.log(chalk.bold.cyan(`Template: ${template.name}`))
    console.log(chalk.bold.cyan(`${'='.repeat(80)}\n`))

    // Metadata
    if (template.version) {
      console.log(chalk.bold('Version:     ') + template.version)
    }
    if (template.description) {
      console.log(chalk.bold('Description: ') + template.description)
    }
    console.log()

    // Variables schema
    if (template.variables && Object.keys(template.variables).length > 0) {
      console.log(chalk.bold.yellow('Variables Schema:'))
      console.log(chalk.dim('-'.repeat(80)))
      const vars = template.variables as Record<string, unknown>
      for (const [key, value] of Object.entries(vars)) {
        const valueType = typeof value === 'object' && value !== null
          ? JSON.stringify(value, null, 2).split('\n').map((line, idx) =>
              idx === 0 ? line : '  ' + line
            ).join('\n')
          : JSON.stringify(value)
        console.log(chalk.cyan(`  ${key}:`) + ` ${valueType}`)
      }
      console.log()
    } else {
      console.log(chalk.dim('(No variables schema defined)\n'))
    }

    // System prompt
    console.log(chalk.bold.green('System Prompt:'))
    console.log(chalk.dim('-'.repeat(80)))
    console.log(highlightHandlebars(template.systemPrompt))
    console.log()

    // User prompt
    console.log(chalk.bold.green('User Prompt:'))
    console.log(chalk.dim('-'.repeat(80)))
    console.log(highlightHandlebars(template.userPrompt))
    console.log()

    console.log(chalk.dim(`Template loaded from: ~/.orcha/prompts/`))
  } catch (err) {
    console.error(chalk.red(`Error loading template '${name}':`), (err as Error).message)
    process.exit(1)
  }
}

/**
 * Apply basic syntax highlighting for Handlebars templates.
 *
 * Highlights:
 * - {{variables}} in magenta
 * - Markdown headers (#, ##, ###) in bold
 * - Markdown code blocks (```) in dim
 *
 * @param text - Template text to highlight
 * @returns Highlighted text with ANSI color codes
 */
function highlightHandlebars(text: string): string {
  const lines = text.split('\n')
  const highlighted = lines.map(line => {
    let result = line

    // Highlight Handlebars variables {{...}}
    result = result.replace(/\{\{([^}]+)\}\}/g, (_match, varName) => {
      return chalk.magenta(`{{${varName}}}`)
    })

    // Highlight markdown headers
    if (/^#{1,6}\s/.test(result)) {
      result = chalk.bold(result)
    }

    // Dim code block markers
    if (result.trim() === '```') {
      result = chalk.dim(result)
    }

    return result
  })

  return highlighted.join('\n')
}

/**
 * Edit a prompt template in the user's preferred editor.
 *
 * If a custom override doesn't exist, copies from defaults first.
 * Opens the file in $EDITOR (default: nano, fallback: vi).
 * Validates the template after editing.
 *
 * @param name - Template name (e.g., 'architect', 'gate/adversary')
 */
export async function editPrompt(name: string): Promise<void> {
  try {
    const customPath = join(CUSTOM_PROMPTS_DIR, `${name}.yaml`)
    const defaultPath = join(DEFAULT_PROMPTS_DIR, `${name}.yaml`)

    // Check if default exists
    if (!existsSync(defaultPath)) {
      console.error(chalk.red(`Error: Template '${name}' does not exist.`))
      console.log('\nAvailable templates:')
      await listPrompts()
      process.exit(1)
    }

    // If custom doesn't exist, copy from default
    if (!existsSync(customPath)) {
      console.log(chalk.dim(`Creating custom override for '${name}'...`))
      // Ensure directory exists
      await mkdir(dirname(customPath), { recursive: true })
      await copyFile(defaultPath, customPath)
      console.log(chalk.green(`Copied default template to: ${customPath}`))
    }

    // Determine editor
    const editor = process.env.EDITOR || 'nano'
    console.log(chalk.dim(`Opening ${customPath} in ${editor}...`))

    // Open editor
    const editorProcess = spawn(editor, [customPath], {
      stdio: 'inherit',
    })

    // Wait for editor to close
    await new Promise<void>((resolve, reject) => {
      editorProcess.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Editor exited with code ${code}`))
        }
      })
      editorProcess.on('error', (err) => {
        reject(err)
      })
    })

    // Validate template after editing
    console.log(chalk.dim('\nValidating template...'))
    try {
      const template = await loadTemplate(name)
      // validateTemplate is not exported, but loadTemplate calls parseYamlTemplate which validates structure
      // We can do a basic compilation test
      console.log(chalk.green('Template is valid!'))
    } catch (err) {
      console.error(chalk.red('\nValidation failed:'), (err as Error).message)
      console.log('\nWould you like to:')
      console.log('  1. Edit again (fix the error)')
      console.log('  2. Discard changes (delete custom override)')
      console.log('  3. Keep as-is (ignore validation warning)')

      const answer = await promptUser('\nChoice (1/2/3): ')

      if (answer === '1') {
        // Edit again
        await editPrompt(name)
      } else if (answer === '2') {
        // Discard changes
        const { unlink } = await import('node:fs/promises')
        await unlink(customPath)
        console.log(chalk.yellow('Custom override discarded.'))
      } else {
        // Keep as-is
        console.log(chalk.yellow('Keeping template as-is. Warning: template may not work correctly.'))
      }
    }
  } catch (err) {
    console.error(chalk.red('Error editing template:'), (err as Error).message)
    process.exit(1)
  }
}

/**
 * Reset a prompt template to its default by deleting the custom override.
 *
 * @param name - Template name (e.g., 'architect', 'gate/adversary')
 */
export async function resetPrompt(name: string): Promise<void> {
  try {
    const customPath = join(CUSTOM_PROMPTS_DIR, `${name}.yaml`)

    // Check if custom exists
    if (!existsSync(customPath)) {
      console.log(chalk.yellow(`Template '${name}' has no custom override.`))
      return
    }

    // Confirm with user
    const answer = await promptUser(
      chalk.yellow(`Are you sure you want to reset '${name}' to default? (y/N): `)
    )

    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('Reset cancelled.')
      return
    }

    // Delete custom override
    await resetTemplateImpl(name)
    console.log(chalk.green(`Template '${name}' reset to default.`))
  } catch (err) {
    console.error(chalk.red('Error resetting template:'), (err as Error).message)
    process.exit(1)
  }
}

/**
 * Prompt user for input.
 *
 * @param question - Question to ask
 * @returns User's answer
 */
function promptUser(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}
