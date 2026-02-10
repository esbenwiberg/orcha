# Prompt Templates

Orcha uses customizable prompt templates powered by [Handlebars](https://handlebarsjs.com/) for all pipeline phases. This allows you to tailor AI behavior to your codebase, coding standards, and workflow preferences.

## Overview

Templates define the system and user prompts sent to AI agents during pipeline execution. Each template is a YAML file containing:

- **Metadata**: Name, version, description
- **Variables Schema**: Available template variables with default values
- **System Prompt**: Context and role definition for the AI
- **User Prompt**: The actual task instructions

## Template Loading Precedence

Orcha loads templates in the following order:

1. **Custom overrides**: `~/.orcha/prompts/custom/<template-name>.yaml`
2. **Default templates**: `~/.orcha/prompts/defaults/<template-name>.yaml`
3. **Hardcoded fallback**: Built-in prompts (used if no files found)

This allows you to override specific templates while keeping others at defaults.

## Viewing Templates

### List All Templates

```bash
orcha prompts list
```

Output:
```
TEMPLATE              HAS CUSTOM  DESCRIPTION
architect             no          Designs feature architecture from milestone specs
dev                   yes         Implements features with tests and docs
gate/adversary        no          Adversarial code review to find edge cases
gate/ac-validator     no          Validates acceptance criteria completion
gate/code-review      no          Standard code quality review
gate/security-review  no          Security vulnerability scanning
gate/test-runner      no          Runs test suite and validates output
milestone-dev         no          Implements milestone with focus on deliverables
fix-loop              no          Fixes issues found during gate phase
test                  no          Test template for development
```

### Show Template Content

```bash
# View default template
orcha prompts show architect

# View custom override (if it exists)
orcha prompts show architect --custom

# Export template to file for editing
orcha prompts show architect > my-architect-template.yaml
```

## Customizing Templates

### Edit a Template

```bash
orcha prompts edit architect
```

This:
1. Creates a custom override at `~/.orcha/prompts/custom/architect.yaml`
2. Opens it in your default editor (`$EDITOR` or `vim`)
3. Validates the template on save

### Reset to Default

```bash
orcha prompts reset architect
```

Deletes the custom override and reverts to the default template.

### Validate Template Syntax

```bash
orcha prompts validate architect
```

Checks:
- YAML syntax
- Required fields (name, systemPrompt, userPrompt)
- Handlebars syntax
- Variable references match schema

## Handlebars Syntax Reference

### Basic Variable Interpolation

```handlebars
{{variableName}}
```

Example:
```yaml
userPrompt: |
  Implement the following feature:
  {{featureDescription}}

  Target milestone: {{milestoneName}}
```

### Conditionals

```handlebars
{{#if condition}}
  Content when true
{{else}}
  Content when false
{{/if}}
```

Example:
```yaml
systemPrompt: |
  {{#if hasTests}}
  Ensure all code has 100% test coverage.
  {{else}}
  Write tests for critical paths only.
  {{/if}}
```

### Loops

```handlebars
{{#each items}}
  - {{this}}
{{/each}}
```

Example:
```yaml
userPrompt: |
  Acceptance criteria:
  {{#each acceptanceCriteria}}
  - {{this}}
  {{/each}}
```

### Custom Helpers

Orcha provides custom Handlebars helpers:

#### `add`
```handlebars
{{add a b}}  <!-- Returns a + b -->
```

#### `join`
```handlebars
{{join array ", "}}  <!-- Joins array elements with separator -->
```

Example:
```yaml
userPrompt: |
  Modified files: {{join modifiedFiles ", "}}
```

#### `truncate`
```handlebars
{{truncate longString 100}}  <!-- Truncates to 100 characters -->
```

## Available Templates

### Core Pipeline Templates

#### `architect`
Designs feature architecture from milestone specifications.

**Variables:**
- `milestoneName` (string): Milestone identifier
- `milestoneDetails` (string): Full milestone specification
- `blueprintContext` (string): Blueprint overview
- `repoPath` (string): Repository path
- `currentBranch` (string): Git branch name

**Usage:** Automatically invoked during pipeline architect phase.

#### `dev`
Implements features with tests and documentation.

**Variables:**
- `architectOutput` (string): Architecture design from architect phase
- `milestoneName` (string): Milestone identifier
- `milestoneDetails` (string): Full milestone specification
- `repoPath` (string): Repository path

**Usage:** Automatically invoked during pipeline dev phase.

#### `milestone-dev`
Alternative dev template focused on milestone deliverables.

**Variables:** Same as `dev` template.

**Usage:** Can be specified with `orcha pipeline run --dev-template milestone-dev`.

#### `fix-loop`
Fixes issues identified during gate phase.

**Variables:**
- `gateVerdicts` (array): List of gate review results
- `failedGates` (array): Gates that failed validation
- `milestoneName` (string): Milestone identifier
- `attemptNumber` (number): Current fix attempt count

**Usage:** Automatically invoked when gates fail.

### Gate Templates

All gate templates are in the `gate/` subdirectory.

#### `gate/adversary`
Adversarial review to find edge cases and potential issues.

**Variables:**
- `devOutput` (string): Development phase output
- `architectOutput` (string): Architecture design
- `milestoneName` (string): Milestone identifier
- `repoPath` (string): Repository path

#### `gate/ac-validator`
Validates that acceptance criteria are met.

**Variables:**
- `devOutput` (string): Development phase output
- `acceptanceCriteria` (array): List of criteria to validate
- `milestoneName` (string): Milestone identifier

#### `gate/code-review`
Standard code quality review.

**Variables:**
- `devOutput` (string): Development phase output
- `modifiedFiles` (array): List of changed files
- `repoPath` (string): Repository path

#### `gate/security-review`
Security vulnerability scanning and best practices check.

**Variables:**
- `devOutput` (string): Development phase output
- `modifiedFiles` (array): List of changed files
- `repoPath` (string): Repository path

#### `gate/test-runner`
Runs test suite and validates output.

**Variables:**
- `devOutput` (string): Development phase output
- `testCommand` (string): Command to run tests
- `repoPath` (string): Repository path

## Template Structure

### YAML Schema

```yaml
name: template-name
version: "1.0"
description: Brief description of template purpose

variables:
  # Schema defining available variables
  variableName:
    type: string
    description: What this variable contains
    default: optional-default-value

  arrayVariable:
    type: array
    description: List of items
    default: []

systemPrompt: |
  You are a {{role}} working on {{projectName}}.

  Your responsibilities:
  - {{#each responsibilities}}
    - {{this}}
    {{/each}}

userPrompt: |
  {{#if hasContext}}
  Context: {{context}}
  {{/if}}

  Task: {{taskDescription}}

  Requirements:
  {{#each requirements}}
  - {{this}}
  {{/each}}
```

### Required Fields

- `name` (string): Template identifier
- `systemPrompt` (string): System message defining AI role/context
- `userPrompt` (string): Task instructions for the AI

### Optional Fields

- `version` (string): Template version for tracking changes
- `description` (string): Human-readable description
- `variables` (object): Schema documenting available variables

## Best Practices

### 1. Keep System Prompts Focused

Define clear roles and boundaries:

```yaml
systemPrompt: |
  You are a senior software architect.

  Your role is to design system architecture, NOT to implement code.

  Focus on:
  - High-level design decisions
  - Component interactions
  - Technology choices
  - Scalability considerations
```

### 2. Be Specific in User Prompts

Provide concrete acceptance criteria:

```yaml
userPrompt: |
  Implement user authentication with the following requirements:

  {{#each acceptanceCriteria}}
  - {{this}}
  {{/each}}

  Verification:
  1. All tests pass
  2. No security vulnerabilities introduced
  3. Error handling for all edge cases
```

### 3. Use Variables for Flexibility

Make templates reusable across different contexts:

```yaml
variables:
  testingStrategy:
    type: string
    description: Testing approach (unit, integration, e2e)
    default: "unit and integration"

  coverageThreshold:
    type: number
    description: Minimum test coverage percentage
    default: 80

userPrompt: |
  Testing requirements:
  - Strategy: {{testingStrategy}}
  - Coverage: {{coverageThreshold}}% minimum
```

### 4. Document Variable Schemas

Help users understand what data is available:

```yaml
variables:
  milestoneName:
    type: string
    description: "Unique identifier for the milestone (e.g., 'M10: Documentation')"
    example: "M10: Documentation and Package Defaults"

  modifiedFiles:
    type: array
    description: "List of file paths changed during development"
    example: ["src/index.ts", "README.md"]
```

### 5. Validate Before Committing

Always validate custom templates:

```bash
orcha prompts validate my-template
```

Common issues:
- Unclosed Handlebars tags (`{{#if}}` without `{{/if}}`)
- Variable references that don't exist in schema
- Invalid YAML indentation

## Sharing Templates

### Export Custom Templates

```bash
# Export all custom templates to tarball
orcha prompts export

# Export to specific file
orcha prompts export my-templates.tar.gz
```

Creates a gzipped tarball containing:
- All custom template overrides
- Manifest with metadata

### Import Templates

```bash
# Import templates from tarball
orcha prompts import my-templates.tar.gz
```

This:
1. Validates all templates in the archive
2. Prompts for confirmation if overwriting existing custom templates
3. Creates backup of existing custom directory
4. Imports templates to `~/.orcha/prompts/custom/`

### Share via Git

Store templates in version control:

```bash
# Create templates repository
mkdir my-orcha-templates
cd my-orcha-templates
git init

# Copy custom templates
cp -r ~/.orcha/prompts/custom/* ./

# Add README with usage instructions
echo "# My Orcha Templates" > README.md

git add .
git commit -m "Add custom Orcha templates"
git push
```

Team members can then clone and install:

```bash
git clone https://github.com/myorg/orcha-templates.git
cp -r orcha-templates/* ~/.orcha/prompts/custom/
```

## Troubleshooting

### Template Not Found

```
Error: Template not found: my-template
Searched:
  - ~/.orcha/prompts/custom/my-template.yaml
  - ~/.orcha/prompts/defaults/my-template.yaml
```

**Solution:** Check template name spelling. Use `orcha prompts list` to see available templates.

### Invalid Handlebars Syntax

```
Error: Template 'architect' validation failed: invalid Handlebars syntax in userPrompt
Parse error on line 5: Expecting 'ID', 'STRING', 'NUMBER', 'BOOLEAN', 'UNDEFINED', 'NULL', 'DATA', got 'INVALID'
```

**Solution:** Check for:
- Unclosed tags (`{{#if}}` without `{{/if}}`)
- Mismatched block helpers
- Invalid helper usage

### Variable Not Found

```
Warning: Template 'dev' references variables not in schema: unknownVar
This may be intentional if variables are optional or computed.
```

**Solution:** Either:
- Add variable to schema in `variables:` section
- Remove reference if it was a typo
- Ignore warning if variable is provided at runtime

### YAML Parsing Error

```
Error: Failed to parse template: bad indentation of a mapping entry
```

**Solution:** Check YAML indentation. Use 2 spaces, not tabs.

## Advanced Topics

### Nested Templates

For gate templates, use subdirectories:

```
~/.orcha/prompts/
├── custom/
│   └── gate/
│       └── adversary.yaml
└── defaults/
    └── gate/
        ├── adversary.yaml
        ├── code-review.yaml
        └── test-runner.yaml
```

Reference with path: `orcha prompts show gate/adversary`

### Dynamic Variable Types

Variables can be complex objects:

```yaml
variables:
  milestone:
    type: object
    description: Milestone metadata
    properties:
      name: string
      details: string
      acceptanceCriteria: array

userPrompt: |
  Milestone: {{milestone.name}}

  Criteria:
  {{#each milestone.acceptanceCriteria}}
  - {{this}}
  {{/each}}
```

### Template Versioning

Use version field to track changes:

```yaml
name: architect
version: "2.1"
description: Enhanced architect template with security focus

# When updating:
# v1.0: Initial version
# v2.0: Added security requirements
# v2.1: Improved acceptance criteria formatting
```

### Security Considerations

Templates are parsed with `yaml.FAILSAFE_SCHEMA`:
- Only allows strings, arrays, objects
- Prevents arbitrary code execution
- No special YAML tags like `!!python/object`

Limits enforced:
- Maximum file size: 100KB
- Maximum field length: 50KB
- Maximum object nesting: 10 levels

These prevent memory exhaustion and stack overflow attacks.

## Examples

### Custom Architect Template

```yaml
name: architect-python-ml
version: "1.0"
description: Architecture template for Python ML projects

variables:
  milestoneName:
    type: string
    description: Milestone identifier

  milestoneDetails:
    type: string
    description: Full milestone specification

systemPrompt: |
  You are a machine learning architect specializing in Python.

  Your designs should follow these principles:
  - Scikit-learn pipeline patterns
  - Clear separation of data/training/inference
  - Reproducible experiments with seed control
  - Modular components for easy A/B testing

userPrompt: |
  Design the architecture for: {{milestoneName}}

  Specification:
  {{milestoneDetails}}

  Deliverables:
  1. Component diagram (Mermaid)
  2. Data flow specification
  3. Model architecture decisions
  4. Training pipeline design
  5. Evaluation strategy

  Format your design as markdown with clear sections.
```

### Custom Gate Template

```yaml
name: gate/performance-check
version: "1.0"
description: Validates performance requirements

variables:
  devOutput:
    type: string
    description: Development phase output

  performanceTargets:
    type: object
    description: Performance benchmarks
    properties:
      responseTime: string
      throughput: string
      memoryUsage: string

systemPrompt: |
  You are a performance engineer focused on benchmarking and optimization.

userPrompt: |
  Review the implementation and verify performance requirements:

  Targets:
  - Response time: {{performanceTargets.responseTime}}
  - Throughput: {{performanceTargets.throughput}}
  - Memory usage: {{performanceTargets.memoryUsage}}

  Development output:
  {{devOutput}}

  Steps:
  1. Analyze code for performance bottlenecks
  2. Run performance tests (use existing test suite)
  3. Compare results against targets
  4. Report PASS/FAIL with detailed metrics

  Format:
  ```json
  {
    "verdict": "pass|fail",
    "metrics": { ... },
    "issues": [ ... ]
  }
  ```
```

## Related Documentation

- [Orcha Pipeline Blueprint](pipeline.md) - Full pipeline architecture
- [CLI Reference](../README.md#commands) - Command documentation
- [Handlebars Guide](https://handlebarsjs.com/guide/) - Template syntax reference

## File Locations

- Custom templates: `~/.orcha/prompts/custom/`
- Default templates: `~/.orcha/prompts/defaults/`
- Package templates: `node_modules/@esbenwiberg/orcha/prompts/defaults/`

## Support

Questions or issues with templates?
- [Open an issue](https://github.com/esbenwiberg/orcha/issues)
- [View examples](https://github.com/esbenwiberg/orcha/tree/main/prompts/defaults)
