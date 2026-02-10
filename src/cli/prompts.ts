/**
 * Orcha CLI - Prompts Commands
 *
 * Commands for viewing and managing pipeline prompt templates.
 */

import chalk from 'chalk'
import { loadTemplate, listTemplates } from '../pipeline/template-loader.js'

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
    console.log('  orcha prompts show <name>  - View template details')
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
