# Blueprint: Web-Based Prompt Template Editor

**Milestones: 6**

## Goal

Add a web-based template editor to the Orcha dashboard, allowing users to view, edit, and reset prompt templates through a Monaco editor interface without leaving the browser.

## Non-Goals

- **Live preview with variable interpolation** — v1 shows raw templates only (preview can be added later)
- **Template sharing UI** — export/import stays CLI-only for now
- **Multi-user/collaboration features** — single-user app, last save wins
- **Template version history** — no git-like diffing/rollback in UI
- **Syntax validation during typing** — basic validation on save only
- **Real-time sync across tabs** — no WebSocket coordination for concurrent edits

## Acceptance Criteria

- [ ] New "Settings" section in sidebar with "Prompts" sub-tab
- [ ] Template list shows all 10+ templates with custom override indicator (✓)
- [ ] Click template → opens in Monaco editor (right panel)
- [ ] Editor shows YAML content with syntax highlighting
- [ ] Save button writes to `~/.orcha/prompts/custom/<name>.yaml`
- [ ] Reset button deletes custom override (with confirmation)
- [ ] Validation on save (YAML syntax, required fields, Handlebars syntax)
- [ ] Error messages displayed in UI (not just console)
- [ ] Template changes reflected immediately in list (✓ indicator updates)
- [ ] Monaco editor bundled via CDN (no build complexity)
- [ ] Works on desktop and mobile layouts

## Architecture

### High-Level Flow

```
User clicks Settings → Prompts tab
  ↓
Frontend fetches /api/prompts (list all templates)
  ↓
User selects template → fetch /api/prompts/:name
  ↓
Monaco editor displays YAML content
  ↓
User edits → clicks Save → POST /api/prompts/:name
  ↓
Backend validates and writes to ~/.orcha/prompts/custom/
  ↓
Frontend refreshes list (✓ indicator updates)
```

### Components

**Backend (src/web/server.ts)**
- `GET /api/prompts` - List all templates with metadata
- `GET /api/prompts/:name` - Get template content (custom or default)
- `PUT /api/prompts/:name` - Save custom override
- `DELETE /api/prompts/:name` - Reset to default
- `POST /api/prompts/:name/validate` - Validate without saving

**Frontend (src/web/public/)**
- New sidebar section: "Settings" with "Prompts" sub-tab
- Template list component (shows name, description, custom indicator)
- Monaco editor panel (right side, replaces terminal grid when active)
- Action buttons: Save, Reset, Close

**Shared (src/pipeline/template-loader.ts)**
- Already has: `loadTemplate()`, `listTemplates()`, `resetTemplate()`, `validateTemplate()`
- Add: `saveTemplate(name, content)` - write to custom directory

### Data Flow

1. **Initial Load**: Frontend fetches template list via `/api/prompts`
2. **Select Template**: Frontend fetches content via `/api/prompts/:name`
3. **Edit**: User types in Monaco editor (local state only)
4. **Save**: Frontend sends YAML content to `PUT /api/prompts/:name`
5. **Backend**: Validates → writes to `~/.orcha/prompts/custom/` → returns success
6. **Reset**: Frontend sends `DELETE /api/prompts/:name` → backend deletes custom file

### UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Sidebar          │  Main Content Area                       │
│                  │                                           │
│ [Sessions]       │  ┌─────────────────────────────────────┐ │
│ [Pipelines]      │  │ Template Editor                     │ │
│ [Presets]        │  │                                     │ │
│ [Settings] ◄──   │  │ ┌─────────────────────────────────┐ │ │
│   └─ Prompts     │  │ │ Monaco Editor                   │ │ │
│                  │  │ │                                 │ │ │
│ Templates:       │  │ │ name: "Architect Stage"         │ │ │
│ ✓ architect      │  │ │ version: "1.0.0"                │ │ │
│   dev            │  │ │ systemPrompt: |                 │ │ │
│   milestone-dev  │  │ │   You are an architect...       │ │ │
│   fix-loop       │  │ │                                 │ │ │
│   gate/          │  │ │                                 │ │ │
│     adversary    │  │ │                                 │ │ │
│     ...          │  │ │                                 │ │ │
│                  │  │ └─────────────────────────────────┘ │ │
│                  │  │                                     │ │ │
│                  │  │ [Save] [Reset] [Close]              │ │ │
│                  │  └─────────────────────────────────────┘ │
│                  │                                           │
└─────────────────────────────────────────────────────────────┘
```

## Key Files

### New Files

- **None** - all changes to existing files

### Modified Files

- `src/web/server.ts` (~2394 lines → +150 lines)
  - Add 5 new API routes for template management
  - Import template-loader functions

- `src/web/public/app.js` (~4020 lines → +400 lines)
  - Add `renderSettings()` function
  - Add `renderPromptsList()` function
  - Add `renderPromptEditor()` function
  - Add `saveTemplate()`, `resetTemplate()` API calls
  - Add Monaco editor initialization

- `src/web/public/index.html` (~54 lines → +2 lines)
  - Add Monaco editor CDN script tags

- `src/web/public/style.css` (~existing → +100 lines)
  - Add styles for settings section
  - Add styles for template list
  - Add styles for Monaco editor container
  - Add styles for action buttons

- `src/pipeline/template-loader.ts` (~280 lines → +50 lines)
  - Add `saveTemplate(name, content)` function
  - Export existing functions for web API use

## Milestones

### M1: Backend API Routes

**Intent:** Add REST API endpoints for template CRUD operations.

**Key files:** `src/web/server.ts`, `src/pipeline/template-loader.ts`

**Details:**
1. In `template-loader.ts`, add `saveTemplate(name: string, content: string)`:
   - Validate template name (no path traversal)
   - Parse YAML content
   - Validate using existing `validateTemplate()`
   - Create custom directory if needed (including subdirs for `gate/`)
   - Write to `~/.orcha/prompts/custom/<name>.yaml`
   - Return success or validation errors

2. In `server.ts`, add API routes:
   - `GET /api/prompts` - Call `listTemplates()`, return JSON array
   - `GET /api/prompts/:name` - Call `loadTemplate(name)`, return template data
   - `PUT /api/prompts/:name` - Call `saveTemplate(name, req.body.content)`, return success/errors
   - `DELETE /api/prompts/:name` - Call `resetTemplate(name)`, return success
   - `POST /api/prompts/:name/validate` - Validate content without saving

3. Error handling:
   - Catch YAML parse errors
   - Catch validation errors
   - Return descriptive error messages in JSON: `{ error: string, details?: string }`

**Verification:**
```bash
npm run build

# Test API endpoints
curl http://localhost:3847/api/prompts
curl http://localhost:3847/api/prompts/architect
curl -X PUT http://localhost:3847/api/prompts/test \
  -H "Content-Type: application/json" \
  -d '{"content": "name: test\nsystemPrompt: hello\nuserPrompt: world"}'
curl -X DELETE http://localhost:3847/api/prompts/test
```

---

### M2: Settings Section UI

**Intent:** Add Settings section to sidebar with Prompts tab.

**Key files:** `src/web/public/app.js`, `src/web/public/style.css`

**Details:**
1. In `app.js`, add `renderSettings()` function:
   - Check if Settings section exists in state
   - Render collapsible Settings header (like Sessions/Pipelines/Presets)
   - Add "Prompts" sub-item
   - Wire up click handler → calls `showPromptsEditor()`

2. Update `render()` or main update function:
   - Call `renderSettings()` after presets section
   - Ensure Settings appears in sidebar DOM

3. In `style.css`, add styles:
   - Match existing sidebar section styles
   - Add hover effects for Prompts item
   - Add active/selected state

4. Add `showPromptsEditor()` stub function:
   - Logs "Opening prompts editor" for now
   - Clear terminal grid (hide sessions/pipelines)
   - Show placeholder: "Prompts editor will go here"

**Verification:**
```bash
npm run build
bash ~/projects/orcha/scripts/vm-redeploy-web.sh

# Open browser → Settings section appears in sidebar
# Click "Prompts" → placeholder message appears
```

---

### M3: Template List Component

**Intent:** Display all templates in the settings panel with custom indicators.

**Key files:** `src/web/public/app.js`, `src/web/public/style.css`

**Details:**
1. In `app.js`, implement `showPromptsEditor()`:
   - Fetch `/api/prompts` (list of templates)
   - Clear terminal grid
   - Render template list in main content area
   - Show: name, description, "✓" if custom override exists
   - Support nested templates (gate/adversary shows as "gate/adversary")

2. Template list layout:
   ```
   ┌──────────────────────────────────────┐
   │ Prompt Templates                     │
   ├──────────────────────────────────────┤
   │ ✓ architect                          │
   │   Designs feature architecture       │
   ├──────────────────────────────────────┤
   │   dev                                │
   │   Implements features                │
   ├──────────────────────────────────────┤
   │   gate/adversary                     │
   │   Adversarial testing                │
   └──────────────────────────────────────┘
   ```

3. Add click handler:
   - Click template → calls `openTemplateEditor(name)`
   - Store selected template in state

4. In `style.css`:
   - List item styles (padding, hover, cursor)
   - Custom indicator (✓) styling
   - Description text (smaller, gray)

**Verification:**
```bash
npm run build
bash ~/projects/orcha/scripts/vm-redeploy-web.sh

# Open Settings → Prompts
# Template list appears with all 10+ templates
# Custom templates show ✓ indicator
# Click opens editor (placeholder for now)
```

---

### M4: Monaco Editor Integration

**Intent:** Embed Monaco editor for YAML editing with syntax highlighting.

**Key files:** `src/web/public/index.html`, `src/web/public/app.js`, `src/web/public/style.css`

**Details:**
1. In `index.html`, add Monaco CDN before closing `</body>`:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.min.js"></script>
   ```

2. In `app.js`, add Monaco initialization:
   ```javascript
   let monacoEditor = null; // Global editor instance

   function initMonaco(container, content, language = 'yaml') {
     require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
     require(['vs/editor/editor.main'], function() {
       monacoEditor = monaco.editor.create(container, {
         value: content,
         language: language,
         theme: 'vs-dark',
         automaticLayout: true,
         minimap: { enabled: false },
         scrollBeyondLastLine: false
       });
     });
   }
   ```

3. Implement `openTemplateEditor(name)`:
   - Fetch `/api/prompts/${name}` to get template content
   - Clear main content area
   - Create editor container div
   - Call `initMonaco(container, templateContent, 'yaml')`
   - Render action buttons: Save, Reset, Close

4. In `style.css`:
   - Editor container: `width: 100%; height: calc(100vh - 120px);`
   - Action buttons bar: fixed at bottom or top of editor
   - Button styles (primary/secondary, hover states)

5. Add cleanup:
   - When closing editor or switching templates, call `monacoEditor.dispose()`
   - Prevent memory leaks from multiple editor instances

**Verification:**
```bash
npm run build
bash ~/projects/orcha/scripts/vm-redeploy-web.sh

# Click a template → Monaco editor loads
# YAML syntax highlighting works
# Can type and edit content
# Close button disposes editor properly
```

---

### M5: Save and Reset Actions

**Intent:** Implement save and reset functionality with validation.

**Key files:** `src/web/public/app.js`

**Details:**
1. Implement `saveTemplate()` function:
   - Get current content from `monacoEditor.getValue()`
   - Show loading indicator on Save button
   - Send `PUT /api/prompts/${templateName}` with `{ content: yamlContent }`
   - On success:
     - Show toast: "Template saved successfully"
     - Update template list (✓ indicator)
     - Keep editor open with saved content
   - On error:
     - Show toast: "Save failed: [error message]"
     - Display validation errors in UI (below editor or in modal)

2. Implement `resetTemplate()` function:
   - Show confirmation dialog: "Reset 'architect' to default? This will delete your custom version."
   - If confirmed:
     - Send `DELETE /api/prompts/${templateName}`
     - On success:
       - Show toast: "Template reset to default"
       - Reload template content (fetch default)
       - Update editor with default content
       - Update list (remove ✓ indicator)
     - On error:
       - Show toast: "Reset failed: [error message]"

3. Implement `closeTemplateEditor()`:
   - Check if editor has unsaved changes (compare with original content)
   - If dirty: show confirmation "Discard unsaved changes?"
   - Dispose Monaco editor
   - Return to template list view

4. Add keyboard shortcuts:
   - Cmd/Ctrl+S → save template
   - Esc → close editor (with confirmation if dirty)

**Verification:**
```bash
npm run build
bash ~/projects/orcha/scripts/vm-redeploy-web.sh

# Edit architect template → add comment → save
# Verify ✓ appears in list
# Verify ~/.orcha/prompts/custom/architect.yaml was created
# Click Reset → confirm → verify ✓ disappears
# Verify custom file was deleted
# Test keyboard shortcuts (Cmd+S, Esc)
```

---

### M6: Validation and Error Handling

**Intent:** Add robust validation and user-friendly error messages.

**Key files:** `src/web/public/app.js`, `src/web/public/style.css`

**Details:**
1. In `app.js`, add `validateAndDisplayErrors()`:
   - Before save, optionally call `POST /api/prompts/:name/validate`
   - Display validation errors in dedicated error panel (above buttons)
   - Show error types:
     - YAML syntax errors (line number, message)
     - Missing required fields (name, systemPrompt, userPrompt)
     - Invalid Handlebars syntax (template compilation errors)
   - Format errors with colors (red) and icons (❌)

2. Add error panel component:
   ```
   ┌─────────────────────────────────────┐
   │ ❌ Validation Errors                │
   ├─────────────────────────────────────┤
   │ Line 5: Invalid YAML syntax         │
   │ Missing required field: systemPrompt│
   └─────────────────────────────────────┘
   ```

3. Monaco editor error markers:
   - If validation returns line numbers, highlight errors in editor
   - Use Monaco's `setModelMarkers()` API

4. In `style.css`:
   - Error panel styles (red border, light red background)
   - Error message list styles
   - Dismiss button for error panel

5. Handle network errors:
   - Catch fetch failures
   - Show: "Unable to connect to server"
   - Retry button

6. Add success indicators:
   - Green checkmark animation on successful save
   - Brief highlight on updated list item

**Verification:**
```bash
npm run build
bash ~/projects/orcha/scripts/vm-redeploy-web.sh

# Test invalid YAML: remove closing quote → save
# Verify error message appears with line number
# Test missing field: delete systemPrompt → save
# Verify error message: "Missing required field: systemPrompt"
# Test invalid Handlebars: {{#if}} without {{/if}} → save
# Verify Handlebars compilation error shown
# Fix errors → save → verify success toast and green indicator
```

---

## Risks & Probes

| Risk | Mitigation |
|------|------------|
| **Monaco CDN loading slow/blocked** | Add loading spinner, fallback message. Consider self-hosting Monaco if CDN unreliable. |
| **Large YAML files (>100KB) freeze UI** | Already enforced in template-loader.ts (MAX_YAML_SIZE = 100KB). Add file size check before opening in editor. |
| **Editor memory leaks on tab switching** | Always call `monacoEditor.dispose()` before creating new instance. Test by opening/closing 10+ times. |
| **YAML indentation breaks on save** | Monaco preserves exact content. Test with complex nested YAML (gate templates). |
| **Mobile layout breaks with Monaco** | Use responsive CSS for editor container. Test on mobile viewport (Settings might need different layout). |
| **Path traversal in template names** | Already validated in saveTemplate() (normalize paths). Add test: try saving "../../etc/passwd.yaml". |
| **Concurrent edits (CLI vs Web)** | Document "last write wins" behavior. Add note in UI: "Changes via CLI won't refresh automatically." |
| **Handlebars syntax errors crash editor** | Wrap validation in try-catch. Display error, keep editor open for fixes. |

## Design Decisions

### Why Monaco Editor from CDN?

**Rationale:**
- Zero build configuration (no webpack/bundler setup needed)
- Industry-standard editor (VS Code)
- YAML syntax highlighting out of the box
- Rich API for validation markers, themes, shortcuts
- ~3MB gzipped, but cached across requests

**Alternatives considered:**
- CodeMirror: smaller but less feature-rich
- Ace Editor: older, less maintained
- Plain textarea: too basic for YAML editing

### Why No Live Preview in V1?

**Rationale:**
- Requires variable interpolation UI (input fields for each variable)
- Each template has different variables (workItem, codebase, milestone, etc.)
- Adds significant complexity (200+ lines of UI code)
- Preview can be added in V2 after editor is proven stable

**Future work:**
- Add "Preview" tab next to editor
- Show sample variable values (hardcoded or user-input)
- Render compiled prompt in read-only view

### Why Single Save/Reset (Not Auto-Save)?

**Rationale:**
- Explicit user control (matches CLI behavior: `orcha prompts edit` → manual save)
- Prevents accidental overwrites
- Allows "undo" by closing without saving
- Simpler implementation (no debouncing, conflict resolution)

**Future work:**
- Add auto-save with 2-second debounce
- Add "Revert" button to undo last save

### Why Settings Section Instead of Standalone Page?

**Rationale:**
- Keeps all dashboard features in one place (no new routes/pages)
- Consistent with existing UI patterns (Sessions, Pipelines, Presets)
- Easy to add more settings later (API keys, preferences, etc.)

**Implementation:**
- Settings section in sidebar (collapsible)
- Main content area switches between terminal grid and editor

## Dependencies

All required libraries already in package.json or used via CDN:
- `monaco-editor` - Via CDN (no npm install needed)
- `js-yaml` - Already installed (used in template-loader.ts)
- `handlebars` - Already installed (used in template-loader.ts)

No new npm dependencies required.

## Open Questions

1. **Should we show file paths in the template list?**
   - Current decision: No, show just template names. Paths visible in CLI.
   - Rationale: Cleaner UI, paths are implementation details.

2. **Should Reset require confirmation?**
   - Current decision: Yes, show confirmation dialog.
   - Rationale: Destructive action (deletes file), prevents accidents.

3. **Should we validate on every keystroke?**
   - Current decision: No, validate only on save (or manual "Validate" button).
   - Rationale: YAML validation is expensive, avoid performance issues.

4. **Should editor remember cursor position per template?**
   - Current decision: No, always scroll to top on open.
   - Rationale: Simpler implementation, users typically edit top sections (systemPrompt).

---

Next: /probe 'M1: Backend API Routes'
