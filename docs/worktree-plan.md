# Blueprint: Pipeline Worktree Isolation

## Goal

Auto-create an isolated git worktree when `orcha pipeline run` is invoked (unless `--worktree-path` overrides), so dev and fix-loop stages never modify the user's current branch. Clean up the worktree on pipeline deletion.

## Non-Goals

- Changing how competing agents create their own worktrees (already works)
- Modifying the stage runner or individual stage implementations (they already use `run.worktreePath` correctly)
- Adding SessionManager integration (pipeline manages its own Claude processes via stage-runner)
- Auto-cleanup on pipeline completion (user wants to inspect the worktree; cleanup only on delete)

## Acceptance Criteria

- [ ] `orcha pipeline run --description "..."` without `--worktree-path` creates a worktree at `~/.orcha/worktrees/{repo}/pipeline-{id}/` on a new branch
- [ ] Dev and fix-loop stages write to the auto-created worktree, not the user's current branch
- [ ] `--worktree-path <path>` still works as before (no auto-creation)
- [ ] Pipeline state.json records `worktreeManaged: true/false` to distinguish auto vs user-provided
- [ ] `orcha pipeline delete <id>` removes managed worktrees (via WorktreeManager) and prunes git refs
- [ ] `DELETE /api/pipelines/:id` also cleans up managed worktrees
- [ ] Pipeline resume/recover still works (worktreePath persisted in state.json, unchanged)

## Architecture

```
CLI: orcha pipeline run
  │
  ├─ --worktree-path provided?
  │    YES → use it, worktreeManaged = false
  │    NO  → WorktreeManager.create(pipelineId, branch, sourceBranch)
  │          worktreeManaged = true
  │
  ▼
createPipelineRun(opts)
  → PipelineRun { worktreePath, worktreeManaged, repoPath }
  → state.json persisted to ~/.orcha/pipelines/{id}/

... stages run using run.worktreePath (no change) ...

deletePipelineRun(id)  ← enhanced
  → load state.json
  → if worktreeManaged: WorktreeManager.remove(id) + prune
  → rm ~/.orcha/pipelines/{id}/
```

**Key integration:** Use `WorktreeManager` directly (not `SessionManager`). The pipeline doesn't need session lifecycle — it spawns Claude processes via its own stage-runner. WorktreeManager gives us worktree create/remove without the session overhead.

## Key Files

| File | Role |
|------|------|
| `src/pipeline/types.ts` | Add `worktreeManaged`, `repoPath` to PipelineRun |
| `src/pipeline/pipeline-engine.ts` | Update `createPipelineRun` to auto-create worktree |
| `src/pipeline/pipeline-store.ts` | Update `deletePipelineRun` to clean up worktrees |
| `src/cli/index.ts` | Update `pipeline run` CLI, add `pipeline delete` command |
| `src/web/server.ts` | Update `DELETE /api/pipelines/:id` to clean up worktrees |

## Milestones

### M1: Add worktree fields to PipelineRun type

**Intent:** Extend PipelineRun with `worktreeManaged` and `repoPath` so we can track whether the worktree was auto-created and where the original repo lives.

**Files:**
- `src/pipeline/types.ts` — Add `worktreeManaged?: boolean` and `repoPath?: string` to `PipelineRun`

**Verify:**
```bash
npx tsc --noEmit
```

### M2: Auto-create worktree in pipeline creation

**Intent:** When `worktreePath` is not explicitly provided, use `WorktreeManager` to create an isolated worktree on a new branch `pipeline/{id}`.

**Files:**
- `src/pipeline/pipeline-engine.ts` — Update `createPipelineRun`:
  - Import `WorktreeManager` from `../core/worktree-manager`
  - If `opts.worktreePath` not provided, create worktree via `new WorktreeManager(opts.repoPath).create(pipelineId, 'pipeline/' + pipelineId, opts.sourceBranch)`
  - Set `worktreeManaged = true`, store `repoPath`
  - If `opts.worktreePath` IS provided, set `worktreeManaged = false`
- `src/pipeline/pipeline-engine.ts` — Update `CreatePipelineRunOptions`:
  - Add `repoPath: string` (required)
  - Make `worktreePath` optional (`worktreePath?: string`)
- `src/cli/index.ts` — Update `pipeline run` command:
  - Resolve `repoPath` from cwd
  - Only pass `worktreePath` when `--worktree-path` is explicitly provided
  - Always pass `repoPath`

**Verify:**
```bash
npx tsc --noEmit
# Manual: run `orcha pipeline run --description "test"` without --worktree-path
# Verify: ls ~/.orcha/worktrees/ shows new worktree
# Verify: git worktree list shows new worktree on pipeline/* branch
```

### M3: Clean up worktrees on pipeline deletion

**Intent:** When deleting a pipeline with `worktreeManaged: true`, remove the worktree before deleting pipeline state. Add CLI `pipeline delete` command.

**Files:**
- `src/pipeline/pipeline-store.ts` — Update `deletePipelineRun`:
  - Load `state.json` before deletion to get `worktreeManaged`, `repoPath`, `worktreePath`
  - If `worktreeManaged && repoPath`, instantiate `WorktreeManager(repoPath)` and call `remove(pipelineId)` + `prune()`
  - Errors during worktree removal are non-fatal (log and continue)
  - Then delete pipeline directory as before
- `src/web/server.ts` — `DELETE /api/pipelines/:id` already calls `deletePipelineRun`, so it inherits the cleanup automatically
- `src/cli/index.ts` — Add `orcha pipeline delete <id>` command that calls `deletePipelineRun`

**Verify:**
```bash
npx tsc --noEmit
# Manual: create pipeline → verify worktree exists → delete pipeline → verify worktree gone
# Manual: verify `git worktree list` no longer shows the removed worktree
```

## Risks / Unknowns

| Risk | Mitigation |
|------|-----------|
| `WorktreeManager.create` fetches from origin — may fail offline | Catch and fall back to local-only branch creation. Low priority — existing behavior for all orcha worktrees. |
| Pipeline IDs contain chars invalid for branch names | IDs are `pl-{timestamp}-{hex}` — all valid for git branches. No issue. |
| Existing pipelines lack `worktreeManaged` field | Default to `false` when missing — safe, means "don't touch worktree on delete". |
| User runs from inside an existing worktree | `WorktreeManager(cwd)` works from any git directory. No issue. |
| `deletePipelineRun` signature change | Currently `(id: string) → Promise<boolean>`. Must add repoPath param OR load state internally. Loading state internally is cleaner — no caller changes needed. |

---

Next: /flow 'M1: Add worktree fields to PipelineRun type'
