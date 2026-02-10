# Milestone 9: Fallback Mechanism and Error Handling - Summary

## Objective
Ensure the pipeline doesn't break if templates are missing or invalid by implementing robust fallback mechanisms and comprehensive error handling.

## Changes Implemented

### 1. Enhanced Template Validation (`src/pipeline/template-loader.ts`)

#### Improvements to `validateTemplate()`:
- **Handlebars Compilation Test**: Now compiles templates with empty variables to catch syntax errors at load time, not just at runtime
- **Runtime Execution Test**: Executes compiled templates with `{}` to catch errors that only appear during evaluation
- **Better Error Messages**: More descriptive validation errors that pinpoint the issue

#### Improvements to `loadTemplate()`:
- **Automatic Validation**: Calls `validateTemplate()` on every loaded template (custom and default)
- **Early Error Detection**: Catches template issues before they reach prompt building

**Key validation checks:**
- Required fields exist (name, systemPrompt, userPrompt)
- YAML syntax is valid (via js-yaml FAILSAFE_SCHEMA)
- Handlebars syntax is valid (compile-time check)
- Handlebars execution works (runtime check with empty object)
- Field length limits to prevent memory exhaustion

### 2. Persistent Logging (`src/pipeline/prompt-builder.ts`)

#### New Logging Infrastructure:
```typescript
const PIPELINE_WARNINGS_LOG = join(ORCHA_HOME, 'pipeline-warnings.log')

async function logWarning(message: string): Promise<void> {
  // Appends timestamped warnings to ~/.orcha/pipeline-warnings.log
  // Silently fails if log file is not writable (doesn't break pipeline)
}
```

#### Enhanced Fallback Logging:
All `build*Prompt()` functions now:
1. Construct descriptive warning messages
2. Log to console for immediate visibility
3. Append to persistent log file for debugging
4. Continue with hardcoded fallback prompts

**Example:**
```typescript
const errMsg = err instanceof Error ? err.message : String(err)
const warning = `Failed to load template 'architect': ${errMsg}. Falling back to hardcoded default prompt.`
console.warn(`[prompt-builder] ${warning}`)
await logWarning(warning)
```

### 3. Hardcoded Fallback Documentation

Added documentation explaining the fallback strategy:
- Fallbacks are implemented inline in each `build*Prompt()` function
- Keeps variable handling type-safe (no generic wrappers)
- Uses original hardcoded prompts from before template migration
- Ensures pipeline never breaks on template errors

## Error Scenarios Handled

### 1. Missing Template File
- **Error**: Template file doesn't exist in custom or default directories
- **Handling**: Logs warning, uses hardcoded fallback
- **Verification**: Tested by moving both custom and default templates

### 2. Invalid YAML Syntax
- **Error**: YAML parser fails (unclosed brackets, invalid structure, etc.)
- **Handling**: Descriptive error with line number and position
- **Verification**: Created template with `invalid: [yaml`

### 3. Missing Required Fields
- **Error**: Template missing systemPrompt or userPrompt
- **Handling**: Caught during parsing with field-specific error message
- **Verification**: Created template with only name and description

### 4. Invalid Handlebars Syntax
- **Error**: Handlebars parser fails (unclosed tags, invalid syntax)
- **Handling**: Caught during validation with parse error details
- **Verification**: Created template with `{{unclosed` tag

### 5. Handlebars Compilation Errors
- **Error**: Template compiles but fails during execution
- **Handling**: Caught during validation's test execution
- **Verification**: Created template with `{{#if}} broken {{/if}}`

## Verification Results

All tests passed successfully:

```
✓ Missing template file - fallback to hardcoded prompts
✓ Invalid YAML syntax - descriptive error with location
✓ Missing required fields - validation catches at load time
✓ Invalid Handlebars syntax - caught during compilation
✓ Handlebars runtime errors - caught during validation
✓ All prompt builders have fallback mechanism
✓ Persistent warnings log at ~/.orcha/pipeline-warnings.log
```

## Files Modified

1. **`src/pipeline/template-loader.ts`**
   - Enhanced `validateTemplate()` with compilation test
   - Added validation calls in `loadTemplate()`

2. **`src/pipeline/prompt-builder.ts`**
   - Added `logWarning()` function
   - Added `PIPELINE_WARNINGS_LOG` constant
   - Updated all `build*Prompt()` try-catch blocks with logging

## Key Benefits

1. **Graceful Degradation**: Pipeline never breaks on template errors
2. **Better Debugging**: Persistent log file shows all template loading issues
3. **Early Error Detection**: Validation catches issues at load time, not runtime
4. **Clear Error Messages**: Users know exactly what's wrong and where
5. **Type Safety**: Inline fallbacks maintain type safety for variables

## Future Enhancements (Out of Scope)

These were considered but deemed unnecessary for milestone 9:
- Centralized `getHardcodedFallback()` function (inline approach is simpler)
- Template hot-reloading (templates are loaded once per run)
- Template versioning/migration system (not needed yet)
- User prompts on template errors (automated fallback is better)

## Log File Location

Warnings are logged to: **`~/.orcha/pipeline-warnings.log`**

Example log entry:
```
[2026-02-10T11:50:54.116Z] Failed to load template 'architect': Template not found: architect
Searched:
  - /home/user/.orcha/prompts/custom/architect.yaml
  - /home/user/.orcha/prompts/defaults/architect.yaml. Falling back to hardcoded default prompt.
```

## Conclusion

Milestone 9 successfully implemented comprehensive error handling and fallback mechanisms. The pipeline is now resilient to template errors and provides clear debugging information while maintaining full functionality through hardcoded fallbacks.
