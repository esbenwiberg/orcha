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
 * Open file manager (yazi) in a modal
 */
function openFileManager(instanceId) {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay file-manager-overlay';

  overlay.innerHTML = `
    <div class="file-manager-dialog">
      <div class="file-manager-header">
        <span class="file-manager-title"><svg class="file-manager-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg> ${instanceId}</span>
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
  const wsUrl = `${wsProtocol}//${location.host}?mode=yazi&instanceId=${encodeURIComponent(instanceId)}`;
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
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return num.toString();
}

/**
 * Update usage stats display
 */
function updateUsageDisplay(usage) {
  if (!usage || !usageStatsEl) {
    if (usageStatsEl) usageStatsEl.innerHTML = '';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const dateLabel = usage.date === today ? 'Today' : usage.date;

  usageStatsEl.innerHTML = `
    <div class="usage-label">${dateLabel}</div>
    <div class="usage-row">
      <span class="usage-value">${formatNumber(usage.tokens)}</span>
      <span class="usage-unit">tokens</span>
    </div>
    <div class="usage-row">
      <span class="usage-value">${usage.messages}</span>
      <span class="usage-unit">messages</span>
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
          <label style="font-size:0.75rem;color:#888;display:block;margin-bottom:4px;">Branch name (optional)</label>
          <input type="text" class="new-session-branch" placeholder="Auto-generated if empty" style="width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-size:0.85rem;padding:8px 12px;border-radius:4px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:0.75rem;color:#888;display:block;margin-bottom:4px;">Mode</label>
          <select class="new-session-mode" style="width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-size:0.85rem;padding:8px 12px;border-radius:4px;">
            <option value="claude">Claude</option>
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

  const branchInput = overlay.querySelector('.new-session-branch');
  const modeSelect = overlay.querySelector('.new-session-mode');
  const createBtn = overlay.querySelector('.new-session-create');
  const cancelBtn = overlay.querySelector('.new-session-cancel');

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
      await createSession(instanceId, branchInput.value, modeSelect.value);
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
 * Parse GitHub URL to extract owner/repo
 */
function parseGitHubUrl(url) {
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
    /^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
    /^([^/]+)\/([^/]+)$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
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
        <button class="dialog-tab" data-tab="github">GitHub URL</button>
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
            <label style="font-size:0.75rem;color:#888;display:block;margin-bottom:4px;">GitHub URL or owner/repo</label>
            <input type="text" class="github-url-input" placeholder="https://github.com/owner/repo" style="width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-size:0.85rem;padding:8px 12px;border-radius:4px;box-sizing:border-box;">
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

  // GitHub URL preview
  githubUrlInput.addEventListener('input', () => {
    const parsed = parseGitHubUrl(githubUrlInput.value.trim());
    if (parsed) {
      githubPreview.textContent = `Will clone: ${parsed.owner}/${parsed.repo}`;
      githubError.textContent = '';
    } else if (githubUrlInput.value.trim()) {
      githubPreview.textContent = '';
      githubError.textContent = 'Invalid GitHub URL format';
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
          throw new Error('Please enter a GitHub URL');
        }
        const parsed = parseGitHubUrl(url);
        if (!parsed) {
          throw new Error('Invalid GitHub URL format');
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
async function createSession(instanceId, branch, mode) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instanceId,
      branch: branch || undefined,
      mode: mode || 'claude',
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

  // Make title editable on click
  title.addEventListener('click', (e) => {
    e.stopPropagation();
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

  // Git actions menu button
  const actionsBtn = document.createElement('button');
  actionsBtn.className = 'panel-actions-btn';
  actionsBtn.innerHTML = '⋮';
  actionsBtn.title = 'Git actions (Ctrl+G)';
  actionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleActionsMenu(panel, session);
  });

  // File manager button (yazi)
  const folderBtn = document.createElement('button');
  folderBtn.className = 'panel-folder-btn';
  folderBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  folderBtn.title = 'Open in file manager (yazi)';
  folderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFileManager(session.instanceId);
  });

  // Fullscreen toggle button
  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.className = 'panel-fullscreen-btn';
  fullscreenBtn.innerHTML = '⛶';
  fullscreenBtn.title = 'Toggle fullscreen (double-click panel or Ctrl+Enter)';
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
  header.appendChild(actionsBtn);
  header.appendChild(folderBtn);
  header.appendChild(fullscreenBtn);
  header.appendChild(closeBtn);

  // Terminal container
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = `term-${key}`;

  panel.appendChild(header);
  panel.appendChild(container);

  // Focus handling (Ctrl+click toggles visibility filter)
  panel.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleSessionVisibility(key);
    } else {
      focusPanel(key);
    }
  });

  // Double-click to toggle fullscreen
  panel.addEventListener('dblclick', (e) => {
    // Don't trigger on header buttons
    if (e.target.closest('.panel-fullscreen-btn')) return;
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
    // Instance header container
    const headerContainer = document.createElement('div');
    headerContainer.className = 'instance-header-container';

    // Instance header (clickable to filter)
    const header = document.createElement('div');
    header.className = 'instance-header';
    header.textContent = instanceId.replace('orcha-', '');
    header.title = 'Click to show only this repo';
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => filterByInstance(instanceId));

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
    headerContainer.appendChild(addBtn);
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
      // Show tmux session name with pane count if multi-pane
      const paneInfo = session.paneCount > 1 ? ` (${session.paneCount})` : '';
      name.textContent = session.tmuxSession.replace('orcha-', '') + paneInfo;

      const branch = document.createElement('div');
      branch.className = 'session-branch';
      branch.textContent = session.message || session.state;

      info.appendChild(name);
      info.appendChild(branch);

      item.appendChild(dot);
      item.appendChild(info);

      // Click to focus, Ctrl+click to toggle filter
      item.addEventListener('click', (e) => {
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

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Escape to exit fullscreen
    if (e.key === 'Escape' && state.fullscreenKey) {
      exitFullscreen();
      e.preventDefault();
      return;
    }

    // Ctrl+Enter to toggle fullscreen on focused panel
    if (e.ctrlKey && e.key === 'Enter' && state.focusedSession) {
      toggleFullscreen(state.focusedSession);
      e.preventDefault();
      return;
    }

    // Ctrl+1-9 to focus panel by number
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      if (state.sessions[idx]) {
        focusPanel(getSessionKey(state.sessions[idx]));
        e.preventDefault();
      }
    }

    // Ctrl+G to open git actions menu on focused panel
    if (e.ctrlKey && e.key.toLowerCase() === 'g' && state.focusedSession) {
      e.preventDefault();
      const panel = document.querySelector(`.terminal-panel[data-session-key="${state.focusedSession}"]`);
      if (panel) {
        const session = state.sessions.find(s => getSessionKey(s) === state.focusedSession);
        if (session) {
          toggleActionsMenu(panel, session);
        }
      }
    }
  });
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
