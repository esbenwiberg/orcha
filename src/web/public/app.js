/**
 * Orcha Web Dashboard - Client Application
 *
 * Connects to the orcha server and displays interactive terminal panels
 * for each session using xterm.js
 */

// State
const state = {
  sessions: [],
  terminals: new Map(), // sessionKey -> { term, ws, fitAddon, exited }
  focusedSession: null,
  fullscreenKey: null, // Key of panel in fullscreen mode, or null
  visibleSessions: null, // Set<string> of visible session keys, or null for all
  refreshInterval: null,
  usage: null, // { date, tokens, messages, sessions } or null
  gridLayout: { cols: 1, rows: 1 }, // Current grid layout for 2D navigation
};

// DOM elements
const sessionList = document.getElementById('session-list');

/**
 * Show a toast notification
 */
function showToast(message, type = 'success') {
  // Remove existing toast
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  // Remove after 3 seconds
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * Copy text to clipboard with fallback for non-HTTPS
 */
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Copied to clipboard', 'success');
    }).catch(() => {
      copyToClipboardFallback(text);
    });
  } else {
    copyToClipboardFallback(text);
  }
}

/**
 * Fallback copy using textarea + execCommand (works on HTTP)
 */
function copyToClipboardFallback(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const success = document.execCommand('copy');
    if (success) {
      showToast('Copied to clipboard', 'success');
    } else {
      showToast('Copy failed', 'error');
    }
  } catch (err) {
    console.error('Copy fallback failed:', err);
    showToast('Copy failed', 'error');
  }
  document.body.removeChild(textarea);
}

/**
 * Close any open actions menu
 */
function closeActionsMenu() {
  const existing = document.querySelector('.actions-menu');
  if (existing) existing.remove();
}

/**
 * Toggle git actions menu on a panel
 */
function toggleActionsMenu(panel, session) {
  // If menu already open on this panel, close it
  const existing = panel.querySelector('.actions-menu');
  if (existing) {
    existing.remove();
    return;
  }

  // Close any other open menus
  closeActionsMenu();

  const menu = document.createElement('div');
  menu.className = 'actions-menu';

  const actions = [
    { id: 'commit', label: 'Commit...', icon: '●' },
    { id: 'push', label: 'Push', icon: '↑' },
    { id: 'pull-main', label: 'Merge origin/main', icon: '↓' },
    { id: 'create-pr', label: 'Create PR...', icon: '⎇' },
  ];

  for (const action of actions) {
    const item = document.createElement('button');
    item.className = 'actions-menu-item';
    item.innerHTML = `<span class="actions-menu-icon">${action.icon}</span>${action.label}`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closeActionsMenu();
      handleGitAction(action.id, session);
    });
    menu.appendChild(item);
  }

  // Position menu below the actions button
  const header = panel.querySelector('.panel-header');
  header.appendChild(menu);

  // Close on click outside
  const closeHandler = (e) => {
    if (!menu.contains(e.target) && !e.target.closest('.panel-actions-btn')) {
      closeActionsMenu();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

/**
 * Handle git action from menu
 */
async function handleGitAction(action, session) {
  const instanceId = session.instanceId;

  switch (action) {
    case 'commit':
      showCommitDialog(instanceId);
      break;
    case 'push':
      await handleGitPush(instanceId);
      break;
    case 'pull-main':
      await handleGitPullMain(instanceId);
      break;
    case 'create-pr':
      showCreatePrDialog(instanceId);
      break;
  }
}

/**
 * Show keyboard shortcuts help dialog
 */
function showHelpDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;';

  overlay.innerHTML = `
    <div class="help-dialog" style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;min-width:320px;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <h3 style="margin:0 0 16px;font-size:1rem;color:#e0e0e0;display:flex;align-items:center;gap:8px;">
        <span style="color:#9b59b6;">⌨</span> Keyboard Shortcuts
      </h3>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:0.85rem;">
        <div style="color:#888;margin-bottom:4px;">All shortcuts use <kbd style="background:#333;padding:2px 6px;border-radius:3px;color:#e0e0e0;">Ctrl+A</kbd> prefix:</div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#888;">Navigate sessions</span><kbd style="background:#333;padding:2px 6px;border-radius:3px;color:#e0e0e0;">Ctrl+A, ↑↓←→</kbd></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#888;">Focus panel 1-9</span><kbd style="background:#333;padding:2px 6px;border-radius:3px;color:#e0e0e0;">Ctrl+A, 1-9</kbd></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#888;">Toggle fullscreen</span><kbd style="background:#333;padding:2px 6px;border-radius:3px;color:#e0e0e0;">Ctrl+A, Enter</kbd></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#888;">File manager (yazi)</span><kbd style="background:#333;padding:2px 6px;border-radius:3px;color:#e0e0e0;">Ctrl+A, F</kbd></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#888;">Git actions menu</span><kbd style="background:#333;padding:2px 6px;border-radius:3px;color:#e0e0e0;">Ctrl+A, G</kbd></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#888;">Review changes</span><kbd style="background:#333;padding:2px 6px;border-radius:3px;color:#e0e0e0;">Ctrl+A, R</kbd></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:#888;">Show this help</span><kbd style="background:#333;padding:2px 6px;border-radius:3px;color:#e0e0e0;">Ctrl+A, H</kbd></div>
      </div>
      <div style="margin-top:16px;text-align:right;">
        <button class="help-close" style="background:#9b59b6;border:none;color:white;font-size:0.85rem;padding:8px 16px;border-radius:4px;cursor:pointer;">Close</button>
      </div>
    </div>
  `;

  const closeBtn = overlay.querySelector('.help-close');
  const closeDialog = () => overlay.remove();

  closeBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
  });

  document.body.appendChild(overlay);
  closeBtn.focus();
}

/**
 * Show commit dialog
 */
function showCommitDialog(instanceId) {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  overlay.innerHTML = `
    <div class="new-session-dialog" style="min-width:400px;">
      <h3>Commit Changes</h3>
      <div class="dialog-instance">${instanceId}</div>
      <div class="new-session-form">
        <div>
          <label>Commit message</label>
          <textarea class="commit-message" rows="4" placeholder="Describe your changes..." style="width:100%;background:var(--bg-primary);border:1px solid var(--border-color);color:var(--text-primary);font-size:0.85rem;padding:8px 12px;border-radius:4px;resize:vertical;font-family:inherit;"></textarea>
          <div class="commit-error error-text"></div>
        </div>
      </div>
      <div class="new-session-buttons">
        <button class="new-session-cancel">Cancel</button>
        <button class="new-session-create">Stage All & Commit</button>
      </div>
    </div>
  `;

  const messageInput = overlay.querySelector('.commit-message');
  const errorEl = overlay.querySelector('.commit-error');
  const submitBtn = overlay.querySelector('.new-session-create');
  const cancelBtn = overlay.querySelector('.new-session-cancel');

  const closeDialog = () => overlay.remove();

  submitBtn.addEventListener('click', async () => {
    const message = messageInput.value.trim();
    if (!message) {
      errorEl.textContent = 'Please enter a commit message';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Committing...';
    errorEl.textContent = '';

    try {
      const res = await fetch('/api/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId, message }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Commit failed');

      closeDialog();
      showToast(`Committed: ${data.commitHash}`, 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Stage All & Commit';
    }
  });

  cancelBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
    if (e.key === 'Enter' && e.ctrlKey && !submitBtn.disabled) submitBtn.click();
  });

  document.body.appendChild(overlay);
  messageInput.focus();
}

/**
 * Handle git push
 */
async function handleGitPush(instanceId) {
  if (!confirm('Push to origin?')) return;

  showToast('Pushing...', 'info');

  try {
    const res = await fetch('/api/git/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Push failed');

    showToast('Push successful', 'success');
  } catch (err) {
    showToast(`Push failed: ${err.message}`, 'error');
  }
}

/**
 * Handle git pull main (merge origin/main)
 */
async function handleGitPullMain(instanceId) {
  if (!confirm('Fetch and merge origin/main into current branch?')) return;

  showToast('Merging origin/main...', 'info');

  try {
    const res = await fetch('/api/git/pull-main', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Merge failed');

    showToast('Merged origin/main successfully', 'success');
  } catch (err) {
    showToast(`Merge failed: ${err.message}`, 'error');
  }
}

/**
 * Show create PR dialog
 */
async function showCreatePrDialog(instanceId) {
  // First fetch git status to check for uncommitted changes and get commits
  let gitStatus;
  try {
    const res = await fetch('/api/git/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId }),
    });
    gitStatus = await res.json();
  } catch (err) {
    showToast('Failed to fetch git status', 'error');
    return;
  }

  // Check for uncommitted changes
  if (gitStatus.hasChanges) {
    showToast('You have uncommitted changes. Please commit first.', 'error');
    return;
  }

  // Check if there are commits to create a PR from
  if (!gitStatus.commits || gitStatus.commits.length === 0) {
    showToast('No commits to create a PR from. Push your changes first.', 'error');
    return;
  }

  // Generate PR body from commits
  const commitList = gitStatus.commits.map(c => `- ${c.message}`).join('\n');
  const firstCommitMsg = gitStatus.commits[0]?.message || '';

  // Generate a smart title from first commit or branch name
  let suggestedTitle = firstCommitMsg;
  if (gitStatus.commits.length > 1) {
    // If multiple commits, use branch name as title
    const branchName = gitStatus.branch || '';
    if (branchName && branchName !== 'main' && branchName !== 'master') {
      // Convert branch name to title (e.g., "feat/add-git-menu" -> "Add git menu")
      suggestedTitle = branchName
        .replace(/^(feat|fix|chore|docs|refactor|test)[\/-]?/i, '')
        .replace(/[-_]/g, ' ')
        .replace(/^\w/, c => c.toUpperCase());
    }
  }

  const prBody = `## What?

${commitList}

## Why?

<!-- Why is this change needed? -->

## How?

<!-- How was this implemented? -->
`;

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  overlay.innerHTML = `
    <div class="new-session-dialog" style="min-width:500px;max-width:600px;">
      <h3>Create Pull Request</h3>
      <div class="dialog-instance">${instanceId} · ${gitStatus.branch} · ${gitStatus.commits.length} commit${gitStatus.commits.length > 1 ? 's' : ''}</div>
      <div class="new-session-form">
        <div>
          <label>Title</label>
          <input type="text" class="pr-title" placeholder="PR title" style="width:100%;background:var(--bg-primary);border:1px solid var(--border-color);color:var(--text-primary);font-size:0.85rem;padding:8px 12px;border-radius:4px;">
        </div>
        <div>
          <label>Description</label>
          <textarea class="pr-body" rows="12" style="width:100%;background:var(--bg-primary);border:1px solid var(--border-color);color:var(--text-primary);font-size:0.85rem;padding:8px 12px;border-radius:4px;resize:vertical;font-family:'SF Mono',Monaco,monospace;font-size:0.8rem;"></textarea>
          <div class="pr-error error-text"></div>
        </div>
      </div>
      <div class="new-session-buttons">
        <button class="new-session-cancel">Cancel</button>
        <button class="new-session-create">Create PR</button>
      </div>
    </div>
  `;

  const titleInput = overlay.querySelector('.pr-title');
  const bodyInput = overlay.querySelector('.pr-body');
  const errorEl = overlay.querySelector('.pr-error');
  const submitBtn = overlay.querySelector('.new-session-create');
  const cancelBtn = overlay.querySelector('.new-session-cancel');

  // Pre-fill with generated content
  titleInput.value = suggestedTitle;
  bodyInput.value = prBody;

  const closeDialog = () => overlay.remove();

  submitBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) {
      errorEl.textContent = 'Please enter a PR title';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating PR...';
    errorEl.textContent = '';

    try {
      const res = await fetch('/api/git/create-pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId,
          title,
          body: bodyInput.value,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create PR');

      closeDialog();
      showToast('PR created!', 'success');

      // Open PR URL in new tab
      if (data.prUrl) {
        window.open(data.prUrl, '_blank');
      }
    } catch (err) {
      errorEl.textContent = err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create PR';
    }
  });

  cancelBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
  });

  document.body.appendChild(overlay);
  titleInput.focus();
}

/**
 * Show diff viewer dialog for pre-review
 */
async function showDiffViewerDialog(instanceId) {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay diff-viewer-overlay';

  overlay.innerHTML = `
    <div class="diff-viewer-dialog">
      <div class="diff-viewer-header">
        <div class="diff-viewer-title">
          <span class="diff-viewer-icon">📋</span>
          <span class="diff-viewer-heading">Review Changes</span>
          <span class="diff-viewer-branch"></span>
        </div>
        <button class="diff-viewer-close">×</button>
      </div>
      <div class="diff-viewer-content">
        <div class="diff-viewer-sidebar">
          <div class="diff-sidebar-section">
            <div class="diff-sidebar-label">Commits</div>
            <div class="diff-commits-list"></div>
          </div>
          <div class="diff-sidebar-section">
            <div class="diff-sidebar-label">Files</div>
            <div class="diff-files-list"></div>
          </div>
        </div>
        <div class="diff-viewer-main">
          <div class="diff-viewer-loading">Loading diff...</div>
        </div>
      </div>
      <div class="diff-viewer-footer">
        <span class="diff-stats"></span>
      </div>
    </div>
  `;

  const closeBtn = overlay.querySelector('.diff-viewer-close');
  const branchEl = overlay.querySelector('.diff-viewer-branch');
  const commitsListEl = overlay.querySelector('.diff-commits-list');
  const filesListEl = overlay.querySelector('.diff-files-list');
  const mainEl = overlay.querySelector('.diff-viewer-main');
  const statsEl = overlay.querySelector('.diff-stats');

  const closeDialog = () => overlay.remove();

  closeBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
  });

  document.body.appendChild(overlay);

  // Fetch diff data
  try {
    const res = await fetch('/api/git/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to fetch diff');
    }

    const data = await res.json();

    // Update branch info
    branchEl.textContent = `${data.branch} → ${data.baseBranch}`;

    // Populate commits list
    if (data.commits.length === 0) {
      commitsListEl.innerHTML = '<div class="diff-empty">No commits</div>';
    } else {
      commitsListEl.innerHTML = data.commits.map(c => `
        <div class="diff-commit-item" title="${escapeHtml(c.message)}">
          <span class="diff-commit-hash">${c.hash}</span>
          <span class="diff-commit-msg">${escapeHtml(c.message)}</span>
        </div>
      `).join('');
    }

    // Populate files list
    if (data.files.length === 0) {
      filesListEl.innerHTML = '<div class="diff-empty">No changes</div>';
    } else {
      filesListEl.innerHTML = data.files.map(f => {
        const statusClass = f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : 'modified';
        const uncommittedMark = !f.committed ? ' *' : '';
        return `
          <div class="diff-file-item ${statusClass}" data-path="${escapeHtml(f.path)}">
            <span class="diff-file-status">${f.status}</span>
            <span class="diff-file-path">${escapeHtml(f.path)}${uncommittedMark}</span>
          </div>
        `;
      }).join('');

      // Click file to show its diff
      filesListEl.querySelectorAll('.diff-file-item').forEach(item => {
        item.addEventListener('click', () => {
          // Highlight selected file
          filesListEl.querySelectorAll('.diff-file-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');

          const path = item.dataset.path;
          showFileDiff(mainEl, data.diff, path);
        });
      });
    }

    // Show full diff initially
    if (data.diff) {
      renderDiff(mainEl, data.diff);
    } else {
      mainEl.innerHTML = '<div class="diff-empty">No changes to display</div>';
    }

    // Update stats
    statsEl.textContent = `${data.commits.length} commit${data.commits.length !== 1 ? 's' : ''} · ${data.stats.files} file${data.stats.files !== 1 ? 's' : ''} changed · +${data.stats.insertions} -${data.stats.deletions} lines`;

  } catch (err) {
    mainEl.innerHTML = `<div class="diff-error">Error: ${escapeHtml(err.message)}</div>`;
  }
}

/**
 * Escape HTML for safe rendering
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Render full diff with syntax coloring
 */
function renderDiff(container, diffText) {
  if (!diffText.trim()) {
    container.innerHTML = '<div class="diff-empty">No changes to display</div>';
    return;
  }

  const lines = diffText.split('\n');
  const html = lines.map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith('+++') || line.startsWith('---')) {
      return `<div class="diff-line diff-file-header">${escaped}</div>`;
    } else if (line.startsWith('@@')) {
      return `<div class="diff-line diff-hunk-header">${escaped}</div>`;
    } else if (line.startsWith('+')) {
      return `<div class="diff-line diff-add">${escaped}</div>`;
    } else if (line.startsWith('-')) {
      return `<div class="diff-line diff-del">${escaped}</div>`;
    } else if (line.startsWith('diff ')) {
      return `<div class="diff-line diff-meta">${escaped}</div>`;
    } else if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      return `<div class="diff-line diff-meta">${escaped}</div>`;
    } else {
      return `<div class="diff-line diff-context">${escaped}</div>`;
    }
  }).join('');

  container.innerHTML = `<pre class="diff-content">${html}</pre>`;
}

/**
 * Show diff for a specific file
 */
function showFileDiff(container, fullDiff, filePath) {
  const lines = fullDiff.split('\n');
  const fileLines = [];
  let inFile = false;

  for (const line of lines) {
    // Start of a new file diff
    if (line.startsWith('diff --git')) {
      if (inFile) break; // We've passed our file
      // Check if this is our file
      if (line.includes(filePath)) {
        inFile = true;
      }
    }
    if (inFile) {
      fileLines.push(line);
    }
  }

  if (fileLines.length === 0) {
    container.innerHTML = `<div class="diff-empty">No diff available for ${escapeHtml(filePath)}</div>`;
    return;
  }

  renderDiff(container, fileLines.join('\n'));
}

/**
 * Show plan dialog - fetches and displays plan.md from session worktree
 */
async function showPlanDialog(session) {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay plan-dialog-overlay';

  overlay.innerHTML = `
    <div class="plan-dialog">
      <div class="plan-dialog-header">
        <span class="plan-dialog-title">📋 Plan: ${getSessionDisplayName(session)}</span>
        <button class="plan-dialog-close">×</button>
      </div>
      <div class="plan-dialog-content">
        <div class="plan-loading">Loading plan...</div>
      </div>
    </div>
  `;

  const contentEl = overlay.querySelector('.plan-dialog-content');
  const closeBtn = overlay.querySelector('.plan-dialog-close');

  const closeDialog = () => overlay.remove();

  closeBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
  });

  document.body.appendChild(overlay);
  closeBtn.focus();

  // Fetch plan content
  try {
    const res = await fetch(`/api/sessions/${session.instanceId}/${session.id}/plan`);
    if (!res.ok) {
      const data = await res.json();
      contentEl.innerHTML = `
        <div class="plan-empty">
          <div style="font-size: 64px; margin-bottom: 20px; color: #a78bfa;">☰</div>
          <h3 style="margin: 0 0 16px 0; color: var(--text-color);">No Plan Found</h3>
          <p style="margin: 0 0 24px 0; color: var(--text-muted); line-height: 1.6;">
            Plans help organize implementation work. Create one to see it here.
          </p>
          <div style="text-align: left; background: var(--bg-darker); padding: 16px; border-radius: 8px; margin-bottom: 16px;">
            <div style="font-weight: 600; margin-bottom: 12px; color: var(--text-color);">How to create a plan:</div>
            <div style="margin-left: 20px; color: var(--text-muted);">
              <div style="margin-bottom: 8px;">• Ask Claude to create an implementation plan</div>
              <div style="margin-bottom: 8px;">• Use plan mode to design your approach</div>
              <div>• Manually create a plan file at the location below</div>
            </div>
          </div>
          <div style="text-align: left; background: var(--bg-darker); padding: 16px; border-radius: 8px; font-size: 13px;">
            <div style="font-weight: 600; margin-bottom: 8px; color: var(--text-color);">Default location:</div>
            <div style="color: var(--text-muted); font-family: monospace; margin-left: 20px;">
              .claude/plan.md
            </div>
            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color); color: var(--text-muted);">
              <em>Tip:</em> Customize the path in <code>.orcha/config.json</code> with <code>"planPath"</code>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const data = await res.json();
    // Render markdown as preformatted text with basic styling
    contentEl.innerHTML = `<pre class="plan-content">${escapeHtml(data.content)}</pre>`;
  } catch (err) {
    contentEl.innerHTML = `<div class="plan-error">Failed to load plan: ${err.message}</div>`;
  }
}

/**
 * Open file manager (yazi) in a modal
 */
function openFileManager(instanceId, sessionId) {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay file-manager-overlay';

  const displayName = sessionId ? `${instanceId}/${sessionId}` : instanceId;
  overlay.innerHTML = `
    <div class="file-manager-dialog">
      <div class="file-manager-header">
        <span class="file-manager-title"><svg class="file-manager-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg> ${displayName}</span>
        <button class="file-manager-close">×</button>
      </div>
      <div class="file-manager-terminal"></div>
    </div>
  `;

  const termContainer = overlay.querySelector('.file-manager-terminal');
  const closeBtn = overlay.querySelector('.file-manager-close');

  const closeDialog = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    overlay.remove();
  };

  closeBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  document.body.appendChild(overlay);

  // Create terminal
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'SF Mono', Monaco, 'Courier New', monospace",
    theme: {
      background: '#0f0f0f',
      foreground: '#e0e0e0',
      cursor: '#e0e0e0',
      cursorAccent: '#0f0f0f',
      selectionBackground: 'rgba(155, 89, 182, 0.3)',
    },
    scrollback: 1000,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(termContainer);

  // Intercept Escape key to close dialog (before xterm processes it)
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Escape' && e.type === 'keydown') {
      closeDialog();
      return false; // Prevent xterm from processing this key
    }
    return true; // Let xterm handle all other keys
  });

  // Connect via WebSocket to yazi
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${wsProtocol}//${location.host}?mode=yazi&instanceId=${encodeURIComponent(instanceId)}`;
  if (sessionId) {
    wsUrl += `&sessionId=${encodeURIComponent(sessionId)}`;
  }
  const ws = new WebSocket(wsUrl);

  // Fit terminal after dialog fully renders and send size to server
  const fitAndResize = () => {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };

  // Multiple fit attempts to catch layout settling
  setTimeout(fitAndResize, 50);
  setTimeout(fitAndResize, 150);
  setTimeout(fitAndResize, 300);

  ws.onopen = () => {
    console.log('[FileManager] Connected');
    // Send initial size after fit
    fitAndResize();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        closeDialog();
      }
    } catch {
      term.write(event.data);
    }
  };

  ws.onerror = (err) => {
    console.error('[FileManager] WebSocket error:', err);
    term.write('\r\n\x1b[31mConnection error. Is yazi installed?\x1b[0m\r\n');
  };

  ws.onclose = () => {
    console.log('[FileManager] Disconnected');
  };

  // Terminal input -> WebSocket
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  });
  resizeObserver.observe(termContainer);

  // Focus terminal
  term.focus();
}

const terminalGrid = document.getElementById('terminal-grid');
const summaryEl = document.getElementById('summary');
const usageStatsEl = document.getElementById('usage-stats');

/**
 * Fetch sessions from server
 */
async function fetchSessions() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('Failed to fetch sessions:', err);
    return { sessions: [], summary: {} };
  }
}

/**
 * Fetch all registered instances from server
 */
async function fetchInstances() {
  try {
    const res = await fetch('/api/instances');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.instances || [];
  } catch (err) {
    console.error('Failed to fetch instances:', err);
    return [];
  }
}

/**
 * Fetch Claude usage stats from server
 */
async function fetchUsage() {
  try {
    const res = await fetch('/api/usage');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) return null;
    return data;
  } catch (err) {
    console.error('Failed to fetch usage:', err);
    return null;
  }
}

/**
 * Format large numbers with K/M suffix
 */
function formatNumber(num) {
  if (num == null) return '0';
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return num.toString();
}

/**
 * Calculate days since a date
 */
function daysSince(dateStr) {
  if (!dateStr) return 0;
  const start = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - start) / (1000 * 60 * 60 * 24));
}

/**
 * Update usage stats display - shows fun all-time stats
 */
function updateUsageDisplay(usage) {
  if (!usage || !usageStatsEl || usage.error) {
    if (usageStatsEl) usageStatsEl.innerHTML = '';
    return;
  }

  const days = daysSince(usage.firstSessionDate);

  usageStatsEl.innerHTML = `
    <div class="usage-label">All Time</div>
    <div class="usage-row">
      <span class="usage-value">${formatNumber(usage.totalSessions)}</span>
      <span class="usage-unit">sessions</span>
    </div>
    <div class="usage-row">
      <span class="usage-value">${formatNumber(usage.totalMessages)}</span>
      <span class="usage-unit">messages</span>
    </div>
    <div class="usage-row">
      <span class="usage-value">${formatNumber(usage.cacheReadTokens)}</span>
      <span class="usage-unit">cache tokens</span>
    </div>
    <div class="usage-row usage-days">
      <span class="usage-unit">${days} days of Claude</span>
    </div>
  `;
}

/**
 * Create session key for terminal mapping - keyed by tmux session (not individual panes)
 */
function getSessionKey(session) {
  return session.tmuxSession;
}

/**
 * Close/delete a session via API
 */
async function closeSession(instanceId, sessionId, sessionKey) {
  try {
    const res = await fetch(`/api/sessions/${instanceId}/${sessionId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Unknown error');
    }

    // Clean up local state
    const terminal = state.terminals.get(sessionKey);
    if (terminal) {
      terminal.ws.close();
      terminal.term.dispose();
      state.terminals.delete(sessionKey);
    }

    // Remove from visible sessions filter if active
    if (state.visibleSessions?.has(sessionKey)) {
      state.visibleSessions.delete(sessionKey);
      if (state.visibleSessions.size === 0) {
        state.visibleSessions = null;
      }
    }

    // Exit fullscreen if this panel was fullscreen
    if (state.fullscreenKey === sessionKey) {
      exitFullscreen();
    }

    // Remove panel immediately
    const panel = document.querySelector(`.terminal-panel[data-session-key="${sessionKey}"]`);
    if (panel) panel.remove();

    // Trigger re-render to update sidebar and grid
    await render();

    console.log(`[Close] Session closed: ${sessionKey}`);
    return true;
  } catch (err) {
    console.error('[Close] Error:', err);
    return false;
  }
}

/**
 * Remove an instance (repo), closing all sessions if needed
 */
async function removeInstance(instanceId, instanceSessions = []) {
  const displayName = instanceId.replace('orcha-', '');

  // Build warning message
  let confirmMessage = `Remove repo "${displayName}" from the dashboard?`;
  if (instanceSessions.length > 0) {
    confirmMessage = `Remove repo "${displayName}"?\n\nThis will close ${instanceSessions.length} active session(s) and clean up any worktrees.`;
  }

  if (!confirm(confirmMessage)) {
    return false;
  }

  try {
    // If there are sessions, close them all first
    if (instanceSessions.length > 0) {
      console.log(`[Remove] Closing ${instanceSessions.length} session(s) for ${instanceId}...`);

      for (const session of instanceSessions) {
        try {
          const res = await fetch(`/api/sessions/${instanceId}/${session.id}`, {
            method: 'DELETE',
          });

          if (!res.ok) {
            console.warn(`[Remove] Failed to close session ${session.id}`);
          }
        } catch (err) {
          console.warn(`[Remove] Error closing session ${session.id}:`, err);
        }
      }

      // Wait a bit for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Now remove the instance
    const res = await fetch(`/api/instances/${instanceId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Unknown error');
    }

    // Trigger re-render to update sidebar
    await render();

    showToast(`Removed repo "${displayName}"`, 'success');
    console.log(`[Remove] Instance removed: ${instanceId}`);
    return true;
  } catch (err) {
    console.error('[Remove] Error:', err);
    alert(`Failed to remove repo: ${err.message}`);
    return false;
  }
}

/**
 * Get display name for a session (customName > branch > tmux session)
 */
function getSessionDisplayName(session) {
  if (session.customName) {
    return session.customName;
  }
  if (session.branch) {
    // Strip orcha/ prefix if present
    return session.branch.replace(/^orcha\//, '');
  }
  // Fall back to repo name from tmux session
  return session.tmuxSession.replace('orcha-', '');
}

/**
 * Make a title element editable
 */
function makeEditableTitle(titleEl, session) {
  // Already editing
  if (titleEl.querySelector('input')) return;

  const currentName = titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'panel-title-input';
  input.value = session.customName || '';
  input.placeholder = getSessionDisplayName({ ...session, customName: null });

  // Replace text with input
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();

  // Track if we should save on blur
  let shouldSave = true;

  // Save function
  const save = async () => {
    if (!shouldSave) {
      titleEl.textContent = currentName;
      return;
    }

    const newName = input.value.trim();
    titleEl.textContent = newName || getSessionDisplayName({ ...session, customName: null });

    // Save to server
    try {
      console.log(`[Rename] Saving: ${session.instanceId}/${session.id} -> "${newName}"`);
      const res = await fetch(`/api/sessions/${session.instanceId}/${session.id}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName || null }),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('[Rename] Failed:', errText);
        titleEl.textContent = currentName; // Revert on error
      } else {
        console.log('[Rename] Saved successfully');
        // Update local session data
        session.customName = newName || undefined;
      }
    } catch (err) {
      console.error('[Rename] Error:', err);
      titleEl.textContent = currentName; // Revert on error
    }
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      shouldSave = false;
      input.blur();
    }
  });
}

/**
 * Show the new session dialog for an instance
 */
function showNewSessionDialog(instanceId) {
  console.log('[Dialog] Opening for:', instanceId);

  // Remove any existing dialog
  const existingDialog = document.querySelector('.new-session-overlay');
  if (existingDialog) {
    existingDialog.remove();
  }

  // Create overlay with inline styles as fallback
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;';

  overlay.innerHTML = `
    <div class="new-session-dialog" style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;min-width:300px;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <h3 style="margin:0 0 16px;font-size:1rem;color:#e0e0e0;">New Session</h3>
      <div class="dialog-instance" style="font-size:0.75rem;color:#9b59b6;margin-bottom:16px;">${instanceId}</div>
      <div class="new-session-form" style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:0.75rem;color:#888;display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" class="new-session-use-worktree" checked style="width:16px;height:16px;accent-color:#9b59b6;">
            <span>Use worktree (separate branch)</span>
          </label>
        </div>
        <div class="branch-input-container">
          <label style="font-size:0.75rem;color:#888;display:block;margin-bottom:4px;">Branch name (optional)</label>
          <input type="text" class="new-session-branch" placeholder="Auto-generated if empty" style="width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-size:0.85rem;padding:8px 12px;border-radius:4px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:0.75rem;color:#888;display:block;margin-bottom:4px;">Mode</label>
          <select class="new-session-mode" style="width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-size:0.85rem;padding:8px 12px;border-radius:4px;">
            <option value="claude">Claude (Recommended)</option>
            <option value="gemini">Gemini</option>
            <option value="codex">Codex</option>
            <option value="shell">Shell</option>
          </select>
        </div>
        <div class="new-session-buttons" style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end;">
          <button class="new-session-cancel" style="background:transparent;border:1px solid #333;color:#888;font-size:0.85rem;padding:8px 16px;border-radius:4px;cursor:pointer;">Cancel</button>
          <button class="new-session-create" style="background:#9b59b6;border:none;color:white;font-size:0.85rem;padding:8px 16px;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:8px;">Create</button>
        </div>
      </div>
    </div>
  `;

  const useWorktreeCheckbox = overlay.querySelector('.new-session-use-worktree');
  const branchInputContainer = overlay.querySelector('.branch-input-container');
  const branchInput = overlay.querySelector('.new-session-branch');
  const modeSelect = overlay.querySelector('.new-session-mode');
  const createBtn = overlay.querySelector('.new-session-create');
  const cancelBtn = overlay.querySelector('.new-session-cancel');

  // Toggle branch input visibility based on worktree checkbox
  const updateBranchInputState = () => {
    if (useWorktreeCheckbox.checked) {
      branchInputContainer.style.opacity = '1';
      branchInputContainer.style.pointerEvents = 'auto';
      branchInput.disabled = false;
    } else {
      branchInputContainer.style.opacity = '0.5';
      branchInputContainer.style.pointerEvents = 'none';
      branchInput.disabled = true;
    }
  };
  useWorktreeCheckbox.addEventListener('change', updateBranchInputState);
  updateBranchInputState(); // Set initial state

  const closeDialog = () => overlay.remove();

  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    cancelBtn.disabled = true;
    createBtn.innerHTML = '<span style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;display:inline-block;"></span> Creating...';
    // Add spinner keyframes if not present
    if (!document.getElementById('spinner-style')) {
      const style = document.createElement('style');
      style.id = 'spinner-style';
      style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
    }

    try {
      await createSession(instanceId, branchInput.value, modeSelect.value, useWorktreeCheckbox.checked);
      closeDialog();
      // Trigger refresh to show new session
      await render();
    } catch (err) {
      console.error('Failed to create session:', err);
      createBtn.disabled = false;
      cancelBtn.disabled = false;
      createBtn.textContent = 'Create';
      alert('Failed to create session: ' + err.message);
    }
  });

  cancelBtn.addEventListener('click', closeDialog);

  // Close on overlay click (outside dialog)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  // Keyboard handling
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
    if (e.key === 'Enter' && !createBtn.disabled) createBtn.click();
  });

  document.body.appendChild(overlay);
  branchInput.focus();
}

/**
 * Toggle the new session form for an instance (legacy, now opens dialog)
 */
function toggleNewSessionForm(instanceId, containerEl) {
  showNewSessionDialog(instanceId);
}

/**
 * Parse repository URL to extract info (supports GitHub and Azure DevOps)
 * Returns: { provider: 'github'|'azure-devops', owner, repo, project?, preview }
 */
function parseRepoUrl(url) {
  // Azure DevOps patterns
  const adoHttpsPattern = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/;
  const adoVsPattern = /^https?:\/\/([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/;
  const adoShorthand = /^([^/]+)\/([^/]+)\/([^/]+)$/;

  // Try Azure DevOps HTTPS (dev.azure.com)
  let match = url.match(adoHttpsPattern);
  if (match) {
    return {
      provider: 'azure-devops',
      owner: match[1],
      project: match[2],
      repo: match[3],
      preview: `${match[1]}/${match[2]}/${match[3]}`
    };
  }

  // Try Azure DevOps (visualstudio.com)
  match = url.match(adoVsPattern);
  if (match) {
    return {
      provider: 'azure-devops',
      owner: match[1],
      project: match[2],
      repo: match[3],
      preview: `${match[1]}/${match[2]}/${match[3]}`
    };
  }

  // Try Azure DevOps shorthand (org/project/repo)
  match = url.match(adoShorthand);
  if (match) {
    return {
      provider: 'azure-devops',
      owner: match[1],
      project: match[2],
      repo: match[3],
      preview: `${match[1]}/${match[2]}/${match[3]}`
    };
  }

  // GitHub patterns
  const githubPatterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
    /^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
    /^([^/]+)\/([^/]+)$/,
  ];

  for (const pattern of githubPatterns) {
    match = url.match(pattern);
    if (match) {
      return {
        provider: 'github',
        owner: match[1],
        repo: match[2],
        preview: `${match[1]}/${match[2]}`
      };
    }
  }

  return null;
}

/**
 * Legacy function for backward compatibility
 */
function parseGitHubUrl(url) {
  const parsed = parseRepoUrl(url);
  if (parsed && parsed.provider === 'github') {
    return { owner: parsed.owner, repo: parsed.repo };
  }
  return null;
}

/**
 * Parse issue references from text input (GitHub)
 * Supports: #123, 123, owner/repo#123, full GitHub issue URLs
 * Returns array of { number, owner?, repo?, url? }
 */
function parseIssueReferences(text) {
  const issues = [];
  const seen = new Set();

  // Split by newlines, commas, spaces
  const tokens = text.split(/[\n,\s]+/).filter(Boolean);

  for (const token of tokens) {
    let parsed = null;

    // Full GitHub URL: https://github.com/owner/repo/issues/123
    const urlMatch = token.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (urlMatch) {
      parsed = {
        number: parseInt(urlMatch[3], 10),
        owner: urlMatch[1],
        repo: urlMatch[2],
        url: token,
      };
    }

    // owner/repo#123
    if (!parsed) {
      const crossRepoMatch = token.match(/^([^/]+)\/([^#]+)#(\d+)$/);
      if (crossRepoMatch) {
        parsed = {
          number: parseInt(crossRepoMatch[3], 10),
          owner: crossRepoMatch[1],
          repo: crossRepoMatch[2],
        };
      }
    }

    // #123 or just 123
    if (!parsed) {
      const simpleMatch = token.match(/^#?(\d+)$/);
      if (simpleMatch) {
        parsed = {
          number: parseInt(simpleMatch[1], 10),
        };
      }
    }

    if (parsed && !seen.has(parsed.number)) {
      seen.add(parsed.number);
      issues.push(parsed);
    }
  }

  return issues;
}

/**
 * Parse work item references from text input (Azure DevOps)
 * Supports: 123, AB#123, full Azure DevOps work item URLs
 * Returns array of { number, url? }
 */
function parseWorkItemReferences(text) {
  const items = [];
  const seen = new Set();

  // Split by newlines, commas, spaces
  const tokens = text.split(/[\n,\s]+/).filter(Boolean);

  for (const token of tokens) {
    let parsed = null;

    // Full Azure DevOps URL: https://dev.azure.com/org/project/_workitems/edit/123
    const urlMatch = token.match(/^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)/);
    if (urlMatch) {
      parsed = {
        number: parseInt(urlMatch[3], 10),
        url: token,
      };
    }

    // Also support visualstudio.com URL format
    if (!parsed) {
      const vsUrlMatch = token.match(/^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_workitems\/edit\/(\d+)/);
      if (vsUrlMatch) {
        parsed = {
          number: parseInt(vsUrlMatch[3], 10),
          url: token,
        };
      }
    }

    // AB#123 format (Azure Boards reference)
    if (!parsed) {
      const abMatch = token.match(/^AB#(\d+)$/i);
      if (abMatch) {
        parsed = {
          number: parseInt(abMatch[1], 10),
        };
      }
    }

    // Just a number: 123
    if (!parsed) {
      const simpleMatch = token.match(/^(\d+)$/);
      if (simpleMatch) {
        parsed = {
          number: parseInt(simpleMatch[1], 10),
        };
      }
    }

    if (parsed && !seen.has(parsed.number)) {
      seen.add(parsed.number);
      items.push(parsed);
    }
  }

  return items;
}

/**
 * Show the batch issues dialog for an instance
 */
function showBatchIssuesDialog(instanceId) {
  const providerType = getProviderType(instanceId);
  const workItemLabel = getWorkItemLabel(providerType);
  const isAdo = providerType === 'azure-devops';

  console.log(`[Dialog] Opening Batch ${workItemLabel} for:`, instanceId, `(${providerType})`);

  // Remove any existing dialog
  const existingDialog = document.querySelector('.new-session-overlay');
  if (existingDialog) {
    existingDialog.remove();
  }

  // Provider-specific placeholders and hints
  const placeholder = isAdo
    ? `123, 456
https://dev.azure.com/org/project/_workitems/edit/789`
    : `#123, #456
https://github.com/owner/repo/issues/789
owner/repo#101`;

  const hint = isAdo
    ? 'Supports: work item IDs (123, 456) or Azure DevOps URLs'
    : 'Supports: #123, 123, owner/repo#123, or full GitHub URLs';

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  // Load saved preferences from localStorage
  const savedSkipPermissions = localStorage.getItem('orcha.batchSkipPermissions');
  const savedStartupCommand = localStorage.getItem('orcha.batchStartupCommand');
  const defaultSkipPermissions = savedSkipPermissions === null ? true : savedSkipPermissions === 'true';
  const defaultStartupCommand = savedStartupCommand || '/flow-auto';

  overlay.innerHTML = `
    <div class="new-session-dialog batch-issues-dialog">
      <h3>🚀 Batch Process ${workItemLabel}</h3>
      <div class="dialog-instance">${instanceId}</div>
      <div class="new-session-form">
        <div>
          <label>${workItemLabel.slice(0, -1)} references (one per line or comma-separated)</label>
          <textarea class="batch-issues-input" rows="6" placeholder="${placeholder}"></textarea>
          <div class="batch-issues-hint">${hint}</div>
        </div>
        <div class="batch-issues-preview">
          <div class="batch-preview-label">Preview</div>
          <div class="batch-preview-list"></div>
        </div>
        <div class="batch-options">
          <div class="batch-option-row">
            <label class="batch-checkbox-label">
              <input type="checkbox" class="batch-skip-permissions" ${defaultSkipPermissions ? 'checked' : ''}>
              Skip permission prompts
            </label>
          </div>
          <div class="batch-option-row">
            <label class="batch-input-label">Startup command</label>
            <input type="text" class="batch-startup-command" value="${defaultStartupCommand}" placeholder="/flow-auto">
          </div>
        </div>
        <div class="batch-issues-error error-text"></div>
      </div>
      <div class="new-session-buttons">
        <button class="new-session-cancel">Cancel</button>
        <button class="batch-issues-submit" disabled>Process 0 Issues</button>
      </div>
    </div>
  `;

  const textarea = overlay.querySelector('.batch-issues-input');
  const previewList = overlay.querySelector('.batch-preview-list');
  const errorEl = overlay.querySelector('.batch-issues-error');
  const submitBtn = overlay.querySelector('.batch-issues-submit');
  const cancelBtn = overlay.querySelector('.new-session-cancel');
  const skipPermissionsCheckbox = overlay.querySelector('.batch-skip-permissions');
  const startupCommandInput = overlay.querySelector('.batch-startup-command');

  // Save preferences to localStorage on change
  skipPermissionsCheckbox.addEventListener('change', () => {
    localStorage.setItem('orcha.batchSkipPermissions', skipPermissionsCheckbox.checked);
  });
  startupCommandInput.addEventListener('input', () => {
    localStorage.setItem('orcha.batchStartupCommand', startupCommandInput.value);
  });

  let parsedIssues = [];
  let fetchedTitles = new Map(); // number -> { title, state, url, type? }
  let fetchDebounce = null;

  // Choose the correct parser based on provider type
  const parseReferences = isAdo ? parseWorkItemReferences : parseIssueReferences;

  // Fetch issue/work item titles for preview
  const fetchItemTitles = async (numbers) => {
    if (numbers.length === 0) return;

    // Only fetch items without explicit URL (local repo items)
    const localNumbers = parsedIssues
      .filter(i => !i.url)
      .map(i => i.number);

    if (localNumbers.length === 0) return;

    try {
      const res = await fetch(`/api/github/issues?instanceId=${encodeURIComponent(instanceId)}&numbers=${localNumbers.join(',')}`);
      if (res.ok) {
        const data = await res.json();
        for (const item of data.issues || []) {
          fetchedTitles.set(item.number, { title: item.title, state: item.state, url: item.url, type: item.type });
        }
        // Re-render preview with titles
        renderPreview();
      }
    } catch (err) {
      console.log('[BatchItems] Failed to fetch titles:', err);
    }
  };

  // Render preview (separate from parsing for async title updates)
  const renderPreview = () => {
    previewList.innerHTML = '';

    const itemLabel = isAdo ? 'work items' : 'issues';
    const itemLabelSingular = isAdo ? 'Work Item' : 'Issue';

    if (parsedIssues.length === 0) {
      previewList.innerHTML = `<div class="batch-preview-empty">No ${itemLabel} detected</div>`;
      submitBtn.disabled = true;
      submitBtn.textContent = `Process 0 ${workItemLabel}`;
      return;
    }

    for (const issue of parsedIssues) {
      const item = document.createElement('div');
      item.className = 'batch-preview-item';

      const fetched = fetchedTitles.get(issue.number);
      if (issue.owner && issue.repo) {
        // GitHub cross-repo reference
        item.innerHTML = `<span class="batch-issue-num">#${issue.number}</span> <span class="batch-issue-repo">${issue.owner}/${issue.repo}</span>`;
      } else if (fetched) {
        const stateClass = fetched.state === 'OPEN' || fetched.state === 'Active' || fetched.state === 'New' ? 'open' : 'closed';
        // Show work item type for ADO (e.g., "Bug", "User Story")
        const typeTag = fetched.type ? `<span class="batch-issue-type">${fetched.type}</span>` : '';
        item.innerHTML = `<span class="batch-issue-num">${isAdo ? '' : '#'}${issue.number}</span> ${typeTag}<span class="batch-issue-title">${escapeHtml(fetched.title)}</span> <span class="batch-issue-state ${stateClass}">${fetched.state}</span>`;
      } else {
        item.innerHTML = `<span class="batch-issue-num">${isAdo ? '' : '#'}${issue.number}</span> <span class="batch-issue-loading"><span class="spinner-small"></span> loading...</span>`;
      }
      previewList.appendChild(item);
    }

    submitBtn.disabled = false;
    submitBtn.textContent = `Process ${parsedIssues.length} ${workItemLabel.slice(0, -1)}${parsedIssues.length > 1 ? 's' : ''}`;
  };

  // Helper to escape HTML
  const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  // Update preview on input
  const updatePreview = () => {
    parsedIssues = parseReferences(textarea.value);
    renderPreview();

    // Debounce fetching titles
    clearTimeout(fetchDebounce);
    fetchDebounce = setTimeout(() => {
      fetchItemTitles(parsedIssues.map(i => i.number));
    }, 300);
  };

  textarea.addEventListener('input', updatePreview);

  // Close dialog with cleanup
  const closeDialog = () => {
    document.removeEventListener('keydown', handleKeydown);
    overlay.remove();
  };

  // Keyboard handling
  function handleKeydown(e) {
    if (!document.body.contains(overlay)) {
      document.removeEventListener('keydown', handleKeydown);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDialog();
    }
  }
  document.addEventListener('keydown', handleKeydown);

  // Show results in the preview area
  const showResults = (sessions, errors) => {
    previewList.innerHTML = '';
    previewList.className = 'batch-preview-list batch-results';

    // Show successful sessions
    for (const session of sessions) {
      const item = document.createElement('div');
      item.className = 'batch-preview-item batch-result-success';
      item.innerHTML = `
        <span class="batch-result-icon">✓</span>
        <span class="batch-issue-num">#${session.issueNumber}</span>
        <span class="batch-result-branch">${session.branch}</span>
      `;
      previewList.appendChild(item);
    }

    // Show errors
    for (const err of errors) {
      const item = document.createElement('div');
      item.className = 'batch-preview-item batch-result-error';
      item.innerHTML = `
        <span class="batch-result-icon">✗</span>
        <span class="batch-issue-num">#${err.issueNumber}</span>
        <span class="batch-result-message">${escapeHtml(err.error)}</span>
      `;
      previewList.appendChild(item);
    }
  };

  // Prevent double-submission
  let isSubmitting = false;

  // Submit handler
  submitBtn.addEventListener('click', async () => {
    if (parsedIssues.length === 0) return;
    if (isSubmitting) return; // Guard against double-click
    isSubmitting = true;

    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    textarea.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Creating sessions...';
    errorEl.textContent = '';

    // Update preview to show processing state
    previewList.innerHTML = '';
    for (const issue of parsedIssues) {
      const item = document.createElement('div');
      item.className = 'batch-preview-item batch-processing';
      item.innerHTML = `
        <span class="batch-result-icon"><span class="spinner-small"></span></span>
        <span class="batch-issue-num">#${issue.number}</span>
        <span class="batch-issue-loading">creating session...</span>
      `;
      previewList.appendChild(item);
    }

    try {
      const res = await fetch('/api/batch-issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId,
          issues: parsedIssues,
          skipPermissions: skipPermissionsCheckbox.checked,
          startupCommand: startupCommandInput.value || '/flow-auto',
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start batch processing');
      }

      const sessions = data.sessions || [];
      const errors = data.errors || [];

      // Show results
      showResults(sessions, errors);

      if (sessions.length > 0) {
        // Update button to show success and allow closing
        submitBtn.innerHTML = `✓ Started ${sessions.length} session${sessions.length > 1 ? 's' : ''}`;
        submitBtn.className = 'batch-issues-submit batch-success';
        submitBtn.disabled = false;
        submitBtn.onclick = () => {
          closeDialog();
          render();
        };
        cancelBtn.textContent = 'Close';
        cancelBtn.disabled = false;

        const itemType = isAdo ? 'work item' : 'issue';
        showToast(`Started ${sessions.length} session(s) for ${itemType} processing`, 'success');
      }

      if (errors.length > 0 && sessions.length === 0) {
        // All failed
        const itemType = isAdo ? 'work item(s)' : 'issue(s)';
        throw new Error(`All ${errors.length} ${itemType} failed to process`);
      } else if (errors.length > 0) {
        // Partial success
        const itemType = isAdo ? 'work item(s)' : 'issue(s)';
        errorEl.textContent = `${errors.length} ${itemType} failed - see details above`;
      }

      // Refresh dashboard in background
      render();
    } catch (err) {
      console.error('Batch issues error:', err);
      errorEl.textContent = err.message;
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      textarea.disabled = false;
      isSubmitting = false; // Allow retry on error
      submitBtn.innerHTML = `Process ${parsedIssues.length} Issue${parsedIssues.length > 1 ? 's' : ''}`;
      submitBtn.className = 'batch-issues-submit';
      // Re-render original preview
      renderPreview();
    }
  });

  cancelBtn.addEventListener('click', closeDialog);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  document.body.appendChild(overlay);
  textarea.focus();

  // Initial preview update
  updatePreview();
}

/**
 * Show the add repository dialog
 */
function showAddRepoDialog() {
  console.log('[Dialog] Opening Add Repo dialog');

  // Remove any existing dialog
  const existingDialog = document.querySelector('.new-session-overlay');
  if (existingDialog) {
    existingDialog.remove();
  }

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;';

  overlay.innerHTML = `
    <div class="new-session-dialog" style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;min-width:380px;max-width:450px;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <h3 style="margin:0 0 16px;font-size:1rem;color:#e0e0e0;">Add Repository</h3>

      <div class="dialog-tabs">
        <button class="dialog-tab active" data-tab="local">Local Folder</button>
        <button class="dialog-tab" data-tab="github">Clone from URL</button>
      </div>

      <div class="tab-content active" data-tab="local">
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:0.75rem;color:#888;display:block;margin-bottom:4px;">Repository path</label>
            <input type="text" class="local-path-input" placeholder="/home/user/projects/myrepo" style="width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-size:0.85rem;padding:8px 12px;border-radius:4px;box-sizing:border-box;">
            <div class="local-error error-text"></div>
          </div>
        </div>
      </div>

      <div class="tab-content" data-tab="github">
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:0.75rem;color:#888;display:block;margin-bottom:4px;">Repository URL</label>
            <input type="text" class="github-url-input" placeholder="github.com/owner/repo or dev.azure.com/org/project/_git/repo" style="width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-size:0.85rem;padding:8px 12px;border-radius:4px;box-sizing:border-box;">
            <div class="github-preview preview-text"></div>
            <div class="github-error error-text"></div>
          </div>
        </div>
      </div>

      <div class="new-session-buttons" style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
        <button class="new-session-cancel" style="background:transparent;border:1px solid #333;color:#888;font-size:0.85rem;padding:8px 16px;border-radius:4px;cursor:pointer;">Cancel</button>
        <button class="add-repo-submit" style="background:#9b59b6;border:none;color:white;font-size:0.85rem;padding:8px 16px;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:8px;">Add</button>
      </div>
    </div>
  `;

  // Get elements
  const tabs = overlay.querySelectorAll('.dialog-tab');
  const tabContents = overlay.querySelectorAll('.tab-content');
  const localPathInput = overlay.querySelector('.local-path-input');
  const githubUrlInput = overlay.querySelector('.github-url-input');
  const githubPreview = overlay.querySelector('.github-preview');
  const localError = overlay.querySelector('.local-error');
  const githubError = overlay.querySelector('.github-error');
  const submitBtn = overlay.querySelector('.add-repo-submit');
  const cancelBtn = overlay.querySelector('.new-session-cancel');

  let activeTab = 'local';

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      activeTab = tabName;

      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
      tabContents.forEach(c => c.classList.toggle('active', c.dataset.tab === tabName));

      // Update button text
      submitBtn.textContent = tabName === 'github' ? 'Clone & Add' : 'Add';

      // Focus the relevant input
      if (tabName === 'local') {
        localPathInput.focus();
      } else {
        githubUrlInput.focus();
      }
    });
  });

  // Repository URL preview
  githubUrlInput.addEventListener('input', () => {
    const parsed = parseRepoUrl(githubUrlInput.value.trim());
    if (parsed) {
      const providerLabel = parsed.provider === 'github' ? 'GitHub' : 'Azure DevOps';
      githubPreview.textContent = `Will clone: ${parsed.preview} (${providerLabel})`;
      githubError.textContent = '';
    } else if (githubUrlInput.value.trim()) {
      githubPreview.textContent = '';
      githubError.textContent = 'Invalid repository URL format';
    } else {
      githubPreview.textContent = '';
      githubError.textContent = '';
    }
  });

  // Close dialog with cleanup
  const closeDialog = () => {
    document.removeEventListener('keydown', handleKeydown);
    overlay.remove();
  };

  // Keyboard handling (document-level for reliable escape)
  function handleKeydown(e) {
    if (!document.body.contains(overlay)) {
      document.removeEventListener('keydown', handleKeydown);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDialog();
    }
    if (e.key === 'Enter' && !submitBtn.disabled) submitBtn.click();
  }
  document.addEventListener('keydown', handleKeydown);

  // Submit handler
  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    cancelBtn.disabled = true;

    // Add spinner
    if (!document.getElementById('spinner-style')) {
      const style = document.createElement('style');
      style.id = 'spinner-style';
      style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
    }

    const originalText = submitBtn.textContent;
    submitBtn.innerHTML = '<span style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;display:inline-block;"></span> ' + (activeTab === 'github' ? 'Cloning...' : 'Adding...');

    try {
      let successMessage;
      if (activeTab === 'local') {
        const path = localPathInput.value.trim();
        if (!path) {
          throw new Error('Please enter a path');
        }
        // Accept Unix absolute paths and tilde paths
        const isUnixAbsolute = path.startsWith('/');
        const isTildePath = path.startsWith('~');
        const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(path);

        if (isWindowsAbsolute) {
          // Convert Windows path to WSL path (e.g., C:\Users -> /mnt/c/Users)
          const drive = path[0].toLowerCase();
          const rest = path.slice(2).replace(/\\/g, '/');
          throw new Error(`On WSL, use: /mnt/${drive}${rest}`);
        }

        if (!isUnixAbsolute && !isTildePath) {
          throw new Error('Please enter an absolute path (starting with / or ~)');
        }

        const result = await createInstance(path);
        successMessage = result.existing
          ? `Using existing: ${result.instance.instanceId}`
          : `Added: ${result.instance.instanceId}`;
      } else {
        const url = githubUrlInput.value.trim();
        if (!url) {
          throw new Error('Please enter a repository URL');
        }
        const parsed = parseRepoUrl(url);
        if (!parsed) {
          throw new Error('Invalid repository URL format. Supported: GitHub (owner/repo) or Azure DevOps (org/project/repo)');
        }

        const result = await cloneAndCreateInstance(url);
        successMessage = result.cloned
          ? `Cloned & added: ${result.instance.instanceId}`
          : `Added: ${result.instance.instanceId} (already existed)`;
      }

      closeDialog();
      showToast(successMessage, 'success');
      await render();
    } catch (err) {
      console.error('Failed to add repository:', err);
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = originalText;

      if (activeTab === 'local') {
        localError.textContent = err.message;
      } else {
        githubError.textContent = err.message;
      }
    }
  });

  cancelBtn.addEventListener('click', closeDialog);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  document.body.appendChild(overlay);
  localPathInput.focus();
}

/**
 * Create a new instance (local folder) via API
 */
async function createInstance(repoPath) {
  const res = await fetch('/api/instances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Unknown error');
  }

  return data;
}

/**
 * Clone from GitHub and create instance via API
 */
async function cloneAndCreateInstance(githubUrl) {
  const res = await fetch('/api/instances/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubUrl }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Unknown error');
  }

  return data;
}

/**
 * Create a new session via API
 */
async function createSession(instanceId, branch, mode, useWorktree = true) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instanceId,
      branch: branch || undefined,
      mode: mode || 'claude',
      useWorktree,
    }),
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Unknown error');
  }

  return res.json();
}

/**
 * Deduplicate sessions by tmux session - only one panel per tmux session
 * Returns array of "representative" sessions (first session per tmux session)
 * with paneCount added
 */
// Priority order for states (higher = more important to show)
const STATE_PRIORITY = {
  'error': 5,
  'waiting': 4,
  'working': 3,
  'initializing': 2,
  'idle': 1,
  'done': 0,
};

function dedupeByTmuxSession(sessions) {
  const byTmux = new Map();
  for (const session of sessions) {
    if (!byTmux.has(session.tmuxSession)) {
      byTmux.set(session.tmuxSession, { ...session, paneCount: 1 });
    } else {
      const existing = byTmux.get(session.tmuxSession);
      existing.paneCount++;
      // Use the most "active" state from all sessions
      const existingPriority = STATE_PRIORITY[existing.state] ?? 0;
      const newPriority = STATE_PRIORITY[session.state] ?? 0;
      if (newPriority > existingPriority) {
        existing.state = session.state;
        existing.message = session.message;
      }
    }
  }
  return Array.from(byTmux.values());
}

/**
 * Create a terminal panel for a session
 */
function createTerminalPanel(session) {
  const key = getSessionKey(session);

  // Create panel container
  const panel = document.createElement('div');
  panel.className = 'terminal-panel';
  panel.dataset.sessionKey = key;

  // Header
  const header = document.createElement('div');
  header.className = 'panel-header';

  const dot = document.createElement('div');
  dot.className = `panel-dot ${session.state}`;

  const title = document.createElement('div');
  title.className = 'panel-title';
  title.dataset.sessionId = session.id;
  title.dataset.instanceId = session.instanceId;
  // Show custom name, or fall back to branch/tmux session name
  const displayName = getSessionDisplayName(session);
  title.textContent = displayName;
  title.title = 'Click to rename';

  // Track if we just copied text (to skip click handler)
  let justCopied = false;

  // Handle text selection on mouseup (before click clears it)
  title.addEventListener('mouseup', (e) => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      e.stopPropagation();
      justCopied = true;
      copyToClipboard(selection.toString());
      // Reset flag after a tick (after click event fires)
      setTimeout(() => { justCopied = false; }, 0);
    }
  });

  // Make title editable on click (but allow text selection)
  title.addEventListener('click', (e) => {
    e.stopPropagation();
    if (justCopied) {
      return; // Selection was handled by mouseup
    }
    makeEditableTitle(title, session);
  });

  // Repo name (centered in header)
  const repo = document.createElement('div');
  repo.className = 'panel-repo';
  repo.textContent = session.instanceId.replace('orcha-', '');
  repo.title = session.instanceId.replace('orcha-', '');

  const status = document.createElement('div');
  status.className = 'panel-status';
  status.textContent = session.state;

  // Plan button (view plan.md)
  const planBtn = document.createElement('button');
  planBtn.className = 'panel-plan-btn';
  planBtn.innerHTML = '☰';
  planBtn.title = 'View plan';
  planBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showPlanDialog(session);
  });

  // Git actions menu button
  const actionsBtn = document.createElement('button');
  actionsBtn.className = 'panel-actions-btn';
  actionsBtn.innerHTML = '⎇';
  actionsBtn.title = 'Git actions (Ctrl+A, G)';
  actionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleActionsMenu(panel, session);
  });

  // File manager button (yazi)
  const folderBtn = document.createElement('button');
  folderBtn.className = 'panel-folder-btn';
  folderBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  folderBtn.title = 'Open in file manager (Ctrl+A, F)';
  folderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFileManager(session.instanceId, session.id);
  });

  // Review changes button
  const reviewBtn = document.createElement('button');
  reviewBtn.className = 'panel-review-btn';
  reviewBtn.innerHTML = '👁';
  reviewBtn.title = 'Review changes (Ctrl+A, R)';
  reviewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showDiffViewerDialog(session.instanceId);
  });

  // Fullscreen toggle button
  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.className = 'panel-fullscreen-btn';
  fullscreenBtn.innerHTML = '⛶';
  fullscreenBtn.title = 'Toggle fullscreen (double-click panel or Ctrl+A, Enter)';
  fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen(key);
  });

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'panel-close-btn';
  closeBtn.innerHTML = '×';
  closeBtn.title = 'Close session';
  closeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Close session "${getSessionDisplayName(session)}"? This will terminate the process and remove the worktree.`)) {
      closeBtn.disabled = true;
      closeBtn.innerHTML = '...';
      await closeSession(session.instanceId, session.id, key);
    }
  });

  header.appendChild(dot);
  header.appendChild(title);
  header.appendChild(repo);
  header.appendChild(status);
  header.appendChild(planBtn);
  header.appendChild(actionsBtn);
  header.appendChild(folderBtn);
  header.appendChild(reviewBtn);
  header.appendChild(fullscreenBtn);
  header.appendChild(closeBtn);

  // Terminal container
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = `term-${key}`;

  panel.appendChild(header);
  panel.appendChild(container);

  // Focus handling (Ctrl+click toggles visibility filter)
  // Use capture phase (true) to intercept clicks before xterm.js handles them
  panel.addEventListener('click', (e) => {
    // Don't interfere with Shift+click (used for text selection/copy)
    if (e.shiftKey) {
      return;
    }
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      return; // Selection handled by child mouseup handlers
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleSessionVisibility(key);
    } else {
      focusPanel(key);
    }
  }, true);

  // Double-click to toggle fullscreen (only on header, not terminal)
  panel.addEventListener('dblclick', (e) => {
    // Don't trigger on header buttons or terminal area
    if (e.target.closest('.panel-fullscreen-btn')) return;
    if (e.target.closest('.terminal-container')) return;
    toggleFullscreen(key);
  });

  return panel;
}

/**
 * Initialize xterm.js terminal for a session
 */
function initTerminal(session) {
  const key = getSessionKey(session);
  const container = document.getElementById(`term-${key}`);

  if (!container || state.terminals.has(key)) return;

  // Create terminal
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', Monaco, 'Courier New', monospace",
    theme: {
      background: '#0f0f0f',
      foreground: '#e0e0e0',
      cursor: '#e0e0e0',
      cursorAccent: '#0f0f0f',
      selectionBackground: 'rgba(155, 89, 182, 0.3)',
      black: '#1a1a1a',
      red: '#e74c3c',
      green: '#2ecc71',
      yellow: '#f1c40f',
      blue: '#3498db',
      magenta: '#9b59b6',
      cyan: '#1abc9c',
      white: '#e0e0e0',
      brightBlack: '#555',
      brightRed: '#ff6b6b',
      brightGreen: '#54d98c',
      brightYellow: '#ffeb3b',
      brightBlue: '#5dade2',
      brightMagenta: '#bb8fce',
      brightCyan: '#48c9b0',
      brightWhite: '#fff',
    },
    scrollback: 5000,
    allowProposedApi: true,
  });

  // Add fit addon
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // Add web links addon
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(webLinksAddon);

  // Open terminal
  term.open(container);

  // Fit to container
  setTimeout(() => fitAddon.fit(), 0);

  // Connect WebSocket - attach to tmux session (shows all panes via tmux's native layout)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}?session=${key}&tmux=${session.tmuxSession}`;

  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log(`[WS] Connected: ${key}`);
    // Send initial resize
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output' && msg.data) {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        term.write('\r\n\x1b[33m[Session ended]\x1b[0m\r\n');
        // Mark as exited
        const terminal = state.terminals.get(key);
        if (terminal) terminal.exited = true;
        const panel = document.querySelector(`.terminal-panel[data-session-key="${key}"]`);
        if (panel) {
          panel.classList.add('exited');
          const status = panel.querySelector('.panel-status');
          if (status) status.textContent = 'exited';
        }
      }
    } catch {
      // Raw data fallback
      term.write(event.data);
    }
  };

  ws.onerror = (err) => {
    console.error(`[WS] Error: ${key}`, err);
    term.write('\r\n\x1b[31m[Connection error]\x1b[0m\r\n');
  };

  ws.onclose = () => {
    console.log(`[WS] Disconnected: ${key}`);
    term.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
    // Mark as disconnected (if not already exited)
    const terminal = state.terminals.get(key);
    if (terminal && !terminal.exited) {
      terminal.disconnected = true;
      const panel = document.querySelector(`.terminal-panel[data-session-key="${key}"]`);
      if (panel && !panel.classList.contains('exited')) {
        panel.classList.add('exited');
        const status = panel.querySelector('.panel-status');
        if (status) status.textContent = 'disconnected';
      }
    }
  };

  // Terminal input -> WebSocket
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // Handle resize
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  // Manual selection tracking since xterm.js mouse selection doesn't work with tmux
  // Use term.element (the actual xterm DOM) to capture events
  let selectionStart = null;
  const termEl = term.element;

  termEl.addEventListener('mousedown', (e) => {
    if (e.shiftKey) {
      const rect = termEl.getBoundingClientRect();
      const cellWidth = rect.width / term.cols;
      const cellHeight = rect.height / term.rows;
      selectionStart = {
        col: Math.floor((e.clientX - rect.left) / cellWidth),
        row: Math.floor((e.clientY - rect.top) / cellHeight)
      };
    }
  });

  termEl.addEventListener('mouseup', (e) => {
    if (selectionStart && e.shiftKey) {
      const rect = termEl.getBoundingClientRect();
      const cellWidth = rect.width / term.cols;
      const cellHeight = rect.height / term.rows;
      const endCol = Math.floor((e.clientX - rect.left) / cellWidth);
      const endRow = Math.floor((e.clientY - rect.top) / cellHeight);

      // Determine start and end positions
      const startRow = Math.min(selectionStart.row, endRow);
      const startCol = selectionStart.row < endRow ? selectionStart.col :
                       selectionStart.row > endRow ? endCol :
                       Math.min(selectionStart.col, endCol);

      // Build selection text manually from buffer
      let text = '';
      const rowStart = Math.min(selectionStart.row, endRow);
      const rowEnd = Math.max(selectionStart.row, endRow);

      for (let r = rowStart; r <= rowEnd; r++) {
        const line = term.buffer.active.getLine(r);
        if (line) {
          const lineText = line.translateToString();
          if (r === rowStart && r === rowEnd) {
            // Single line selection
            const cStart = Math.min(selectionStart.col, endCol);
            const cEnd = Math.max(selectionStart.col, endCol);
            text += lineText.substring(cStart, cEnd);
          } else if (r === rowStart) {
            text += lineText.substring(selectionStart.row < endRow ? selectionStart.col : endCol) + '\n';
          } else if (r === rowEnd) {
            text += lineText.substring(0, selectionStart.row < endRow ? endCol : selectionStart.col);
          } else {
            text += lineText + '\n';
          }
        }
      }

      if (text.trim().length > 0) {
        copyToClipboard(text.trim());
      }

      selectionStart = null;
    }
  });

  // Store references
  state.terminals.set(key, { term, ws, fitAddon, exited: false, disconnected: false });
}

/**
 * Focus a terminal panel
 */
function focusPanel(key) {
  // Update panel styles
  document.querySelectorAll('.terminal-panel').forEach(p => {
    p.classList.toggle('focused', p.dataset.sessionKey === key);
  });

  // Update sidebar
  document.querySelectorAll('.session-item').forEach(item => {
    item.classList.toggle('active', item.dataset.sessionKey === key);
  });

  // Focus terminal
  const terminal = state.terminals.get(key);
  if (terminal) {
    terminal.term.focus();
  }

  state.focusedSession = key;
}

/**
 * Toggle fullscreen mode for a panel
 */
function toggleFullscreen(key) {
  const wasFullscreen = state.fullscreenKey === key;

  // Exit current fullscreen
  if (state.fullscreenKey) {
    const oldPanel = document.querySelector(`.terminal-panel[data-session-key="${state.fullscreenKey}"]`);
    if (oldPanel) {
      oldPanel.classList.remove('fullscreen');
    }
    terminalGrid.classList.remove('has-fullscreen');
  }

  // Enter fullscreen if toggling to a different panel or first time
  if (!wasFullscreen) {
    const panel = document.querySelector(`.terminal-panel[data-session-key="${key}"]`);
    if (panel) {
      panel.classList.add('fullscreen');
      terminalGrid.classList.add('has-fullscreen');
      state.fullscreenKey = key;
      focusPanel(key);
    }
  } else {
    state.fullscreenKey = null;
  }

  // Resize terminals after layout change
  requestAnimationFrame(() => {
    handleResize();
  });
}

/**
 * Exit fullscreen mode
 */
function exitFullscreen() {
  if (state.fullscreenKey) {
    toggleFullscreen(state.fullscreenKey);
  }
}

/**
 * Check if a session is visible (passes filter)
 */
function isSessionVisible(key) {
  return state.visibleSessions === null || state.visibleSessions.has(key);
}

/**
 * Toggle visibility of a session (Ctrl+click)
 */
function toggleSessionVisibility(key) {
  // If no filter active, create filter with ONLY this session visible
  if (state.visibleSessions === null) {
    state.visibleSessions = new Set([key]);
  } else if (state.visibleSessions.has(key)) {
    // Remove from visible set
    state.visibleSessions.delete(key);
    // If all hidden, reset to show all
    if (state.visibleSessions.size === 0) {
      state.visibleSessions = null;
    }
  } else {
    // Add back to visible set
    state.visibleSessions.add(key);
    // If all visible, reset to null (show all)
    if (state.visibleSessions.size >= state.terminals.size) {
      state.visibleSessions = null;
    }
  }
  applyVisibilityFilter();
}

/**
 * Filter to show only sessions from a specific instance
 */
function filterByInstance(instanceId) {
  const keys = state.sessions
    .filter(s => s.instanceId === instanceId)
    .map(s => getSessionKey(s));

  state.visibleSessions = new Set(keys);
  applyVisibilityFilter();
}

/**
 * Show all sessions (clear filter)
 */
function showAllSessions() {
  state.visibleSessions = null;
  applyVisibilityFilter();
}

/**
 * Apply the current visibility filter to panels
 */
function applyVisibilityFilter() {
  // Update panel visibility
  document.querySelectorAll('.terminal-panel').forEach(panel => {
    const key = panel.dataset.sessionKey;
    const visible = isSessionVisible(key);
    panel.classList.toggle('filtered-out', !visible);
  });

  // Update sidebar items
  document.querySelectorAll('.session-item').forEach(item => {
    const key = item.dataset.sessionKey;
    const visible = isSessionVisible(key);
    item.classList.toggle('filtered-out', !visible);
  });

  // Update filter indicator
  updateFilterIndicator();

  // Recalculate grid for visible panels only
  const visibleCount = state.visibleSessions === null
    ? state.terminals.size
    : state.visibleSessions.size;
  applyGridLayout(visibleCount);

  // Resize terminals
  requestAnimationFrame(() => handleResize());
}

/**
 * Update the filter indicator in sidebar
 */
function updateFilterIndicator() {
  let indicator = document.getElementById('filter-indicator');
  const isFiltering = state.visibleSessions !== null;

  if (isFiltering && !indicator) {
    // Create indicator
    indicator = document.createElement('div');
    indicator.id = 'filter-indicator';
    indicator.innerHTML = `
      <span class="filter-text">Filtered</span>
      <button class="filter-clear-btn" title="Show all sessions">Show All</button>
    `;
    indicator.querySelector('.filter-clear-btn').addEventListener('click', showAllSessions);

    const sidebarHeader = document.querySelector('.sidebar-header');
    sidebarHeader.appendChild(indicator);
  } else if (!isFiltering && indicator) {
    indicator.remove();
  }
}

/**
 * Group sessions by instance
 */
function groupByInstance(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const instanceId = session.instanceId;
    if (!groups.has(instanceId)) {
      groups.set(instanceId, []);
    }
    groups.get(instanceId).push(session);
  }
  return groups;
}

/**
 * Get provider type for an instance
 */
function getProviderType(instanceId) {
  const instance = state.instances?.find(i => i.instanceId === instanceId);
  return instance?.providerType || 'generic';
}

/**
 * Get work item label based on provider type
 */
function getWorkItemLabel(providerType) {
  switch (providerType) {
    case 'azure-devops':
      return 'Work Items';
    case 'github':
      return 'Issues';
    default:
      return 'Issues';
  }
}

/**
 * Get provider badge HTML
 */
function getProviderBadge(providerType) {
  switch (providerType) {
    case 'github':
      return '<span class="provider-badge provider-github" title="GitHub">gh</span>';
    case 'azure-devops':
      return '<span class="provider-badge provider-ado" title="Azure DevOps">ado</span>';
    default:
      return '';
  }
}

/**
 * Update sidebar session list - shows one entry per tmux session
 * Also shows instances with 0 sessions
 */
function updateSidebar(tmuxSessions, instances = []) {
  // Don't rebuild sidebar if a form is open (would destroy it)
  if (document.querySelector('.new-session-form')) {
    return;
  }

  sessionList.innerHTML = '';

  // Group sessions by instance
  const groups = groupByInstance(tmuxSessions);

  // Add empty instances (those with no sessions)
  for (const inst of instances) {
    if (!groups.has(inst.instanceId)) {
      groups.set(inst.instanceId, []);
    }
  }

  for (const [instanceId, instanceSessions] of groups) {
    const providerType = getProviderType(instanceId);

    // Instance header container
    const headerContainer = document.createElement('div');
    headerContainer.className = 'instance-header-container';

    // Instance header (clickable to filter)
    const header = document.createElement('div');
    header.className = 'instance-header';
    // Add provider badge before repo name
    const providerBadge = getProviderBadge(providerType);
    const repoName = instanceId.replace('orcha-', '');
    header.innerHTML = providerBadge + '<span class="instance-name">' + repoName + '</span>';
    header.title = 'Click to show only this repo';
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => filterByInstance(instanceId));

    // Batch issues/work items button (only for GitHub and Azure DevOps)
    const batchBtn = document.createElement('button');
    batchBtn.className = 'batch-issues-btn';
    batchBtn.innerHTML = '⚡';
    const workItemLabel = getWorkItemLabel(providerType);
    batchBtn.title = `Batch process ${workItemLabel}`;
    // Disable batch button for generic repos (no issue/work item tracking)
    if (providerType === 'generic') {
      batchBtn.disabled = true;
      batchBtn.title = 'No issue tracking available for this repository';
      batchBtn.style.opacity = '0.3';
    }
    batchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (providerType !== 'generic') {
        showBatchIssuesDialog(instanceId);
      }
    });

    // Add session button
    const addBtn = document.createElement('button');
    addBtn.className = 'add-session-btn';
    addBtn.innerHTML = '+';
    addBtn.title = 'Add new session';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleNewSessionForm(instanceId, headerContainer);
    });

    headerContainer.appendChild(header);
    headerContainer.appendChild(batchBtn);
    headerContainer.appendChild(addBtn);

    // Always show remove button (it will handle closing sessions if needed)
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-instance-btn';
    removeBtn.innerHTML = '×';
    removeBtn.title = instanceSessions.length > 0
      ? 'Remove repo (will close all sessions)'
      : 'Remove empty repo';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeInstance(instanceId, instanceSessions);
    });
    headerContainer.appendChild(removeBtn);

    sessionList.appendChild(headerContainer);

    // One entry per tmux session
    for (const session of instanceSessions) {
      const key = getSessionKey(session);

      const item = document.createElement('div');
      item.className = 'session-item';
      item.dataset.sessionKey = key;
      if (state.focusedSession === key) {
        item.classList.add('active');
      }
      // Apply filtered-out class if not visible
      if (!isSessionVisible(key)) {
        item.classList.add('filtered-out');
      }

      const dot = document.createElement('div');
      dot.className = `session-dot ${session.state}`;

      const info = document.createElement('div');
      info.className = 'session-info';

      const name = document.createElement('div');
      name.className = 'session-name';
      // Show display name (customName > branch > tmux session) with pane count if multi-pane
      const paneInfo = session.paneCount > 1 ? ` (${session.paneCount})` : '';
      name.textContent = getSessionDisplayName(session) + paneInfo;

      const branch = document.createElement('div');
      branch.className = 'session-branch';
      branch.textContent = session.message || session.state;

      info.appendChild(name);
      info.appendChild(branch);

      item.appendChild(dot);
      item.appendChild(info);

      // Track if we just copied text (to skip click handler)
      let justCopied = false;

      // Handle text selection on mouseup (before click clears it)
      info.addEventListener('mouseup', (e) => {
        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 0) {
          e.stopPropagation();
          justCopied = true;
          copyToClipboard(selection.toString());
          // Reset flag after a tick (after click event fires)
          setTimeout(() => { justCopied = false; }, 0);
        }
      });

      // Click to focus, Ctrl+click to toggle filter
      item.addEventListener('click', (e) => {
        if (justCopied) {
          return; // Selection was handled by mouseup
        }
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          toggleSessionVisibility(key);
        } else {
          focusPanel(key);
        }
      });

      sessionList.appendChild(item);
    }
  }
}

/**
 * Update summary display
 */
function updateSummary(summary) {
  const items = [
    { state: 'working', label: 'Working', count: summary.working || 0 },
    { state: 'waiting', label: 'Waiting', count: summary.waiting || 0 },
    { state: 'idle', label: 'Idle', count: summary.idle || 0 },
    { state: 'done', label: 'Done', count: summary.done || 0 },
    { state: 'error', label: 'Error', count: summary.error || 0 },
  ].filter(item => item.count > 0);

  summaryEl.innerHTML = items.map(item => `
    <div class="summary-item">
      <div class="summary-dot ${item.state}" style="background: var(--status-${item.state})"></div>
      <span>${item.count}</span>
    </div>
  `).join('');
}

/**
 * Update terminal panel headers (status badges and titles)
 */
function updatePanelHeaders(sessions) {
  for (const session of sessions) {
    const key = getSessionKey(session);
    const panel = document.querySelector(`.terminal-panel[data-session-key="${key}"]`);
    if (!panel) continue;

    const dot = panel.querySelector('.panel-dot');
    const status = panel.querySelector('.panel-status');
    const title = panel.querySelector('.panel-title');

    if (dot) {
      dot.className = `panel-dot ${session.state}`;
    }
    if (status) {
      status.textContent = session.state;
    }
    // Update title (unless currently being edited)
    if (title && !title.querySelector('input')) {
      title.textContent = getSessionDisplayName(session);
      // Update data attributes for rename functionality
      title.dataset.sessionId = session.id;
      title.dataset.instanceId = session.instanceId;
    }
  }
}

/**
 * Show empty state
 */
function showEmptyState() {
  terminalGrid.innerHTML = `
    <div class="empty-state">
      <h2>No sessions running</h2>
      <p>Start some sessions with <code>orcha start -n 3</code></p>
    </div>
  `;
}

/**
 * Calculate optimal grid layout
 */
function calculateGridLayout(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count <= 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  if (count <= 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: Math.ceil(count / 4) };
}

/**
 * Apply grid layout based on session count
 */
function applyGridLayout(count) {
  const { cols, rows } = calculateGridLayout(count);
  terminalGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  terminalGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  // Store layout for 2D navigation
  state.gridLayout = { cols, rows };
}

/**
 * Main render function
 */
async function render() {
  // Fetch sessions, instances, and usage in parallel
  const [{ sessions, summary }, instances, usage] = await Promise.all([
    fetchSessions(),
    fetchInstances(),
    fetchUsage(),
  ]);

  // Store all sessions (for sidebar)
  state.sessions = sessions;
  state.instances = instances;
  state.usage = usage;

  // Dedupe by tmux session for terminal panels (1 panel per tmux session)
  const tmuxSessions = dedupeByTmuxSession(sessions);

  // Update sidebar (1 entry per tmux session, matching panels)
  // Pass instances to show empty repos too
  updateSidebar(tmuxSessions, instances);
  updateSummary(summary);
  updateUsageDisplay(usage);

  if (tmuxSessions.length === 0) {
    showEmptyState();
    return;
  }

  // Apply optimal grid layout based on VISIBLE session count (respects filter)
  const visibleCount = state.visibleSessions === null
    ? tmuxSessions.length
    : tmuxSessions.filter(s => state.visibleSessions.has(getSessionKey(s))).length;
  applyGridLayout(visibleCount || tmuxSessions.length);

  // Find sessions that need terminal panels
  const existingKeys = new Set(
    Array.from(document.querySelectorAll('.terminal-panel'))
      .map(p => p.dataset.sessionKey)
  );

  const currentKeys = new Set(tmuxSessions.map(s => getSessionKey(s)));

  // Remove panels for sessions that no longer exist
  for (const key of existingKeys) {
    if (!currentKeys.has(key)) {
      // Exit fullscreen if removing the fullscreen panel
      if (state.fullscreenKey === key) {
        exitFullscreen();
      }

      const panel = document.querySelector(`.terminal-panel[data-session-key="${key}"]`);
      if (panel) panel.remove();

      // Cleanup terminal
      const terminal = state.terminals.get(key);
      if (terminal) {
        terminal.ws.close();
        terminal.term.dispose();
        state.terminals.delete(key);
      }
    }
  }

  // Add panels for new tmux sessions (1 panel per tmux session)
  for (const session of tmuxSessions) {
    const key = getSessionKey(session);
    if (!existingKeys.has(key)) {
      const panel = createTerminalPanel(session);
      terminalGrid.appendChild(panel);

      // Initialize terminal after DOM update
      requestAnimationFrame(() => initTerminal(session));
    }
  }

  // Update existing panel headers
  updatePanelHeaders(tmuxSessions);

  // Auto-focus first terminal if none focused
  if (!state.focusedSession && tmuxSessions.length > 0) {
    focusPanel(getSessionKey(tmuxSessions[0]));
  }
}

/**
 * Handle window resize
 */
function handleResize() {
  for (const { fitAddon } of state.terminals.values()) {
    fitAddon.fit();
  }
}

/**
 * Initialize the app
 */
async function init() {
  // Initial render
  await render();

  // Poll for status updates every 3 seconds
  state.refreshInterval = setInterval(render, 3000);

  // Handle window resize
  window.addEventListener('resize', handleResize);

  // Add Repo button
  const addRepoBtn = document.getElementById('add-repo-btn');
  if (addRepoBtn) {
    addRepoBtn.addEventListener('click', showAddRepoDialog);
  }

  // Keyboard shortcuts with Ctrl+A prefix (tmux-style)
  // Use capture phase (true) to intercept before xterm.js handles the event
  let prefixActive = false;
  let prefixTimeout = null;

  document.addEventListener('keydown', (e) => {

    // Ctrl+A activates prefix mode
    if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      prefixActive = true;
      // Clear prefix after 2 seconds if no follow-up key
      clearTimeout(prefixTimeout);
      prefixTimeout = setTimeout(() => {
        prefixActive = false;
      }, 2000);
      return;
    }

    // If prefix is active, handle the action key
    if (prefixActive) {
      prefixActive = false;
      clearTimeout(prefixTimeout);

      // Enter to toggle fullscreen on focused panel
      if (e.key === 'Enter' && state.focusedSession) {
        toggleFullscreen(state.focusedSession);
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // 1-9 to focus panel by number
      if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (state.sessions[idx]) {
          focusPanel(getSessionKey(state.sessions[idx]));
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      // G to open git actions menu on focused panel
      if (e.key.toLowerCase() === 'g' && state.focusedSession) {
        e.preventDefault();
        e.stopPropagation();
        const panel = document.querySelector(`.terminal-panel[data-session-key="${state.focusedSession}"]`);
        if (panel) {
          const session = state.sessions.find(s => getSessionKey(s) === state.focusedSession);
          if (session) {
            toggleActionsMenu(panel, session);
          }
        }
        return;
      }

      // F to open file manager (yazi) on focused panel
      if (e.key.toLowerCase() === 'f' && state.focusedSession) {
        e.preventDefault();
        e.stopPropagation();
        const session = state.sessions.find(s => getSessionKey(s) === state.focusedSession);
        if (session) {
          openFileManager(session.instanceId, session.id);
        }
        return;
      }

      // H to show help dialog
      if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        e.stopPropagation();
        showHelpDialog();
        return;
      }

      // R to open review changes dialog on focused panel
      if (e.key.toLowerCase() === 'r' && state.focusedSession) {
        e.preventDefault();
        e.stopPropagation();
        const session = state.sessions.find(s => getSessionKey(s) === state.focusedSession);
        if (session) {
          showDiffViewerDialog(session.instanceId);
        }
        return;
      }

      // Arrow keys to navigate through sessions
      if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowRight') && state.sessions.length > 0) {
        e.preventDefault();
        e.stopPropagation();

        // Find current session index
        let currentIndex = -1;
        if (state.focusedSession) {
          currentIndex = state.sessions.findIndex(s => getSessionKey(s) === state.focusedSession);
        }

        // Default to first session if none focused
        if (currentIndex < 0) {
          focusPanel(getSessionKey(state.sessions[0]));
          return;
        }

        const { cols, rows } = state.gridLayout;
        const totalSessions = state.sessions.length;

        // Calculate current position in grid
        const currentRow = Math.floor(currentIndex / cols);
        const currentCol = currentIndex % cols;

        let newIndex = currentIndex;

        if (e.key === 'ArrowUp') {
          // Move up one row (same column)
          if (currentRow > 0) {
            newIndex = (currentRow - 1) * cols + currentCol;
            // If new index is out of bounds, go to last session in that column
            if (newIndex >= totalSessions) {
              newIndex = currentIndex; // Stay in place
            }
          } else {
            // At top row, wrap to bottom row in same column
            const bottomRow = Math.floor((totalSessions - 1) / cols);
            newIndex = bottomRow * cols + currentCol;
            // If that position doesn't exist, move left until we find a session
            while (newIndex >= totalSessions && newIndex >= bottomRow * cols) {
              newIndex--;
            }
          }
        } else if (e.key === 'ArrowDown') {
          // Move down one row (same column)
          const nextIndex = (currentRow + 1) * cols + currentCol;
          if (nextIndex < totalSessions) {
            newIndex = nextIndex;
          } else {
            // At bottom row or next position doesn't exist, wrap to top row in same column
            newIndex = currentCol;
            if (newIndex >= totalSessions) {
              newIndex = 0; // Fallback to first session
            }
          }
        } else if (e.key === 'ArrowLeft') {
          // Move left one column (same row)
          if (currentCol > 0) {
            newIndex = currentIndex - 1;
          } else {
            // At leftmost column, wrap to rightmost in same row
            const rowStart = currentRow * cols;
            const rowEnd = Math.min((currentRow + 1) * cols - 1, totalSessions - 1);
            newIndex = rowEnd;
          }
        } else if (e.key === 'ArrowRight') {
          // Move right one column (same row)
          const rowStart = currentRow * cols;
          const rowEnd = Math.min((currentRow + 1) * cols, totalSessions) - 1;
          if (currentIndex < rowEnd) {
            newIndex = currentIndex + 1;
          } else {
            // At rightmost position in row, wrap to leftmost in same row
            newIndex = rowStart;
          }
        }

        // Focus the new session
        if (newIndex >= 0 && newIndex < totalSessions && newIndex !== currentIndex) {
          focusPanel(getSessionKey(state.sessions[newIndex]));
        }
        return;
      }
    }
  }, true);  // true = capture phase
}

// Rotating catchphrases
const catchphrases = [
  'herd your AI agents',
  'orchestrate the chaos',
  'agents in harmony',
  'parallel power unleashed',
  'swarm intelligence, tamed'
];

function initCatchphrases() {
  const el = document.getElementById('catchphrase');
  if (!el) return;

  let idx = 0;

  function rotate() {
    idx = (idx + 1) % catchphrases.length;
    el.style.opacity = '0';
    setTimeout(() => {
      el.textContent = catchphrases[idx];
      el.style.opacity = '1';
    }, 150);
  }

  // Auto-rotate every 10 seconds
  setInterval(rotate, 10000);

  // Also allow click to rotate
  el.style.cursor = 'pointer';
  el.addEventListener('click', rotate);
}

// Start app
init();
initCatchphrases();
