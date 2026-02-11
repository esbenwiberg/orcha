# Finetune Orcha Prompt Templates - Remove Blockers

**Milestones: 4**

## Goal

Update Orcha's prompt templates (architect, dev, milestone-dev, fix-loop, gate agents) to remove overly restrictive constraints that prevent agents from successfully completing tasks. Align templates with the balanced, pragmatic approach used in /flow, /probe, and /patch skills, and match the better hardcoded fallback prompts.

## Non-Goals

- Changing the pipeline architecture or data flow
- Modifying how prompts are loaded or compiled
- Altering the gate stage logic or fix-loop mechanics
- Making agents completely unrestricted (maintain focus while removing blockers)

## Acceptance Criteria

1. ✅ Fix-loop agents can refactor code and address root causes (not just apply band-aids)
2. ✅ Dev agents can create helper files and utilities when needed (not locked to filesToTouch)
3. ✅ All prompts align with the /flow skill approach: "Touch only listed files unless absolutely necessary"
4. ✅ Prompts reference current system features (enhanced context, circuit breaker, competing agents)
5. ✅ Gate agents maintain appropriate rigor without being overly pedantic
6. ✅ Templates are more permissive than current YAML but less permissive than fully autonomous

## Architecture

### Current System

**Prompt Loading Precedence:**
1. Custom overrides: `~/.orcha/prompts/custom/<template>.yaml`
2. Default templates: `~/.orcha/prompts/defaults/<template>.yaml`
3. Hardcoded fallback: `src/pipeline/prompt-builder.ts` (if template fails to load)

**Problem Identified:**
- YAML templates are MORE restrictive than hardcoded fallbacks
- When templates load successfully, they override better fallback prompts
- This causes fix-loop failures and blocks dev agents from creating necessary files

**Templates to Update:**
```
prompts/defaults/
├── architect.yaml          # Blueprint generator
├── dev.yaml               # Single-milestone implementation
├── milestone-dev.yaml     # Multi-milestone implementation
├── fix-loop.yaml          # Fix gate failures
└── gate/
    ├── adversary.yaml     # Write adversarial tests
    ├── code-review.yaml   # Review correctness
    ├── security-review.yaml # Security audit
    ├── ac-validator.yaml  # Check acceptance criteria
    └── test-runner.yaml   # Placeholder (not used by LLM)
```

### Approach

**Guiding Principles** (from /flow skills):
- "Touch only files you state up front. If you need more, stop and explain before editing them" (/patch)
- "Do not over-engineer. Implement exactly what the milestone describes" (/flow-all)
- Balance: Focused scope + flexibility when needed

**Changes by Template:**

1. **fix-loop.yaml** - MAJOR CHANGES
   - Remove: "Fix ONLY the issues identified. Do not refactor or re-implement unrelated code"
   - Add: Scope permissions matching hardcoded fallback (lines 1095-1102 of prompt-builder.ts)
   - Add: Reference to enhanced context (full file contents, attempt history, successful fix examples)
   - Allow refactoring within affected modules

2. **dev.yaml & milestone-dev.yaml** - MODERATE CHANGES
   - Remove: "Create and modify only the files listed in filesToTouch"
   - Add: "Create and modify files as needed. If you need to create helper utilities or modules beyond what's listed, that's expected and allowed"
   - Keep: Focus on blueprint adherence and code quality
   - Add: "If the blueprint's file list is incomplete, use your judgment to add necessary files"

3. **architect.yaml** - MINOR CHANGES
   - Add: Reference to new system features (circuit breaker, competing agents, enhanced fix context)
   - Clarify: filesToTouch is a GUIDE, not a restriction
   - Update: Milestone guidance to mention they execute with fresh context

4. **gate/*.yaml** - MINOR CHANGES
   - code-review.yaml: Clarify "be practical, not pedantic"
   - security-review.yaml: Already balanced, minimal changes
   - adversary.yaml: Already good, no changes needed
   - ac-validator.yaml: Already focused, no changes needed

## Folder/File Layout

```
prompts/defaults/
├── architect.yaml          # Update: Add system features, clarify filesToTouch
├── dev.yaml               # Update: Remove filesToTouch restriction
├── milestone-dev.yaml     # Update: Remove filesToTouch restriction
├── fix-loop.yaml          # Update: Add scope permissions, refactoring allowed
└── gate/
    ├── code-review.yaml   # Update: Clarify practical over pedantic
    ├── security-review.yaml # Minor: Clarify internal function guidance
    └── (others unchanged)
```

## Milestones

### Milestone 1: Update fix-loop.yaml

**Intent:** Make fix-loop agents more effective by allowing refactoring and root cause fixes

**Files:**
- `prompts/defaults/fix-loop.yaml`

**Changes:**
1. Replace restrictive guidelines with scope permissions from hardcoded fallback
2. Add section explaining enhanced context features (full files, history, examples)
3. Update system prompt to reference circuit breaker and attempt tracking
4. Change from "Fix ONLY the issues" to "Fix the issues. You may refactor within affected modules"
5. Add guidance on when refactoring is appropriate vs when to stay targeted

**Verification:**
- Read updated template with `orcha prompts show fix-loop`
- Manually review that scope permissions match lines 1095-1102 of prompt-builder.ts
- Check that enhanced context features are mentioned

### Milestone 2: Update dev.yaml and milestone-dev.yaml

**Intent:** Allow dev agents to create helper files and utilities when needed

**Files:**
- `prompts/defaults/dev.yaml`
- `prompts/defaults/milestone-dev.yaml`

**Changes:**
1. Remove "Create and modify only the files listed in filesToTouch"
2. Add flexible guideline: "The blueprint lists expected files. Create additional helpers/utilities as needed"
3. Add instruction: "If you create files beyond the blueprint, briefly note why in your work"
4. Keep focus on blueprint adherence
5. Update variable documentation to clarify filesToTouch is a guide

**Verification:**
- Read both templates with `orcha prompts show dev` and `orcha prompts show milestone-dev`
- Verify filesToTouch restriction is removed
- Confirm balanced flexibility language is present

### Milestone 3: Update architect.yaml

**Intent:** Modernize architect template to reference current system features and clarify filesToTouch intent

**Files:**
- `prompts/defaults/architect.yaml`

**Changes:**
1. Add note that milestones execute with fresh context (prevents context pollution)
2. Reference competing agents feature in system description
3. Clarify filesToTouch: "List expected files — dev agent may create additional helpers as needed"
4. Add note about circuit breaker and fix-loop enhancements
5. Update learning hints section to mention it now includes successful fix patterns

**Verification:**
- Read template with `orcha prompts show architect`
- Verify system features are mentioned
- Confirm filesToTouch is described as a guide

### Milestone 4: Refine gate agent prompts

**Intent:** Ensure gate agents are practical and balanced, not overly pedantic

**Files:**
- `prompts/defaults/gate/code-review.yaml`
- `prompts/defaults/gate/security-review.yaml`

**Changes:**

**code-review.yaml:**
1. Add explicit guidance: "Be practical, not pedantic. Focus on real bugs and significant issues"
2. Emphasize: "If the code is correct and clean, that is a valid pass"
3. Add note: "Do NOT flag style issues - linters handle that"
4. Clarify severity levels with examples

**security-review.yaml:**
1. Clarify: "Internal helper functions called only by trusted code do NOT need extensive input validation"
2. Add: "Focus on security at system boundaries (user input, external APIs, file operations)"
3. Keep OWASP Top 10 focus

**Verification:**
- Read templates with `orcha prompts show gate/code-review` and `orcha prompts show gate/security-review`
- Verify balanced, practical language
- Confirm focus on real issues over theoretical concerns

## Risks/Unknowns

1. **Risk:** Making prompts too permissive could lead to scope creep
   - **Mitigation:** Language like "Touch only listed files unless absolutely necessary" maintains focus
   - **Test:** Monitor fix-loop success rate after changes

2. **Risk:** Users with custom templates in `~/.orcha/prompts/custom/` won't get updates
   - **Mitigation:** Document that users should review custom templates, or reset with `orcha prompts reset <name>`
   - **Note:** Custom templates override defaults by design

3. **Risk:** Changing prompts might affect existing pipeline runs
   - **Mitigation:** Templates are loaded per-run, no retroactive effect
   - **Safe:** Each pipeline run is isolated

4. **Unknown:** What is the actual fix-loop success rate currently?
   - **Probe:** Could add telemetry to track circuit breaker triggers and fix success
   - **For now:** Changes are based on clear evidence (hardcoded fallback is better)

## Test Strategy

**Manual Testing:**
1. Read all updated templates with `orcha prompts show <name>`
2. Compare updated YAML against hardcoded fallbacks in prompt-builder.ts
3. Verify variables section accurately documents context passed to agents
4. Check that Handlebars syntax is valid (no compilation errors)

**Integration Testing:**
1. Run a test pipeline with a task that previously failed fix-loop
2. Verify dev agents can create helper files when needed
3. Check that gate agents pass clean code (not overly pedantic)
4. Confirm fix-loop can refactor code to address root causes

**Validation:**
- Template YAML syntax is valid (validated by template-loader.ts)
- Handlebars expressions compile without errors
- Variable references match what's passed from prompt-builder.ts

## Next Steps After Blueprint

1. `/probe 'Milestone 1'` - Investigate fix-loop.yaml structure and hardcoded fallback
2. `/patch` - Implement milestone 1 changes
3. `/gate` - Validate changes
4. Repeat for milestones 2-4
5. Test with a real pipeline run
