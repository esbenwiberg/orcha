/**
 * Orcha Web Dashboard - Client Application
 *
 * Connects to the orcha server and displays interactive terminal panels
 * for each session using xterm.js
 */

// State
const state = {
  sessions: [],
  terminals: new Map(), // sessionKey -> { term, ws, fitAddon }
  focusedSession: null,
  refreshInterval: null,
  prefixMode: false,      // Ctrl+A prefix active
  prefixTimeout: null,    // Auto-cancel prefix after timeout
  fullscreen: false,      // Fullscreen mode active
};

// DOM elements
const sessionList = document.getElementById('session-list');
const terminalGrid = document.getElementById('terminal-grid');
const summaryEl = document.getElementById('summary');

/**
 * Show a toast notification
 */
function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
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
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
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
  if (!res.ok) throw new Error(data.error || 'Unknown error');
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
  if (!res.ok) throw new Error(data.error || 'Unknown error');
  return data;
}

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
 * Create session key for terminal mapping - keyed by tmux session (not individual panes)
 */
function getSessionKey(session) {
  return session.tmuxSession;
}

/**
 * Deduplicate sessions by tmux session - only one panel per tmux session
 * Returns array of "representative" sessions (first session per tmux session)
 * with paneCount added
 */
function dedupeByTmuxSession(sessions) {
  const byTmux = new Map();
  for (const session of sessions) {
    if (!byTmux.has(session.tmuxSession)) {
      byTmux.set(session.tmuxSession, { ...session, paneCount: 1 });
    } else {
      byTmux.get(session.tmuxSession).paneCount++;
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
  // Show tmux session name and pane count if multi-pane
  const paneInfo = session.paneCount > 1 ? ` (${session.paneCount} panes)` : '';
  title.textContent = `${session.tmuxSession}${paneInfo}`;
  title.title = `${session.instanceId} - ${session.tmuxSession}`;

  const status = document.createElement('div');
  status.className = 'panel-status';
  status.textContent = session.state;

  header.appendChild(dot);
  header.appendChild(title);
  header.appendChild(status);

  // Terminal container
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = `term-${key}`;

  panel.appendChild(header);
  panel.appendChild(container);

  // Focus handling
  panel.addEventListener('click', () => focusPanel(key));

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
  state.terminals.set(key, { term, ws, fitAddon });
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
 */
function updateSidebar(tmuxSessions) {
  sessionList.innerHTML = '';

  // Group by instance for headers
  const groups = groupByInstance(tmuxSessions);

  for (const [instanceId, instanceSessions] of groups) {
    // Instance header container
    const headerContainer = document.createElement('div');
    headerContainer.className = 'instance-header-container';

    // Instance header
    const header = document.createElement('div');
    header.className = 'instance-header';
    header.textContent = instanceId;
    header.title = 'Click to filter by this repo';

    // Add session button
    const addBtn = document.createElement('button');
    addBtn.className = 'add-session-btn';
    addBtn.innerHTML = '+';
    addBtn.title = 'Add new session (Ctrl+A c)';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      newSession();
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

      item.addEventListener('click', () => focusPanel(key));

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
 * Update terminal panel headers (status badges)
 */
function updatePanelHeaders(sessions) {
  for (const session of sessions) {
    const key = getSessionKey(session);
    const panel = document.querySelector(`.terminal-panel[data-session-key="${key}"]`);
    if (!panel) continue;

    const dot = panel.querySelector('.panel-dot');
    const status = panel.querySelector('.panel-status');

    if (dot) {
      dot.className = `panel-dot ${session.state}`;
    }
    if (status) {
      status.textContent = session.state;
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
  const { sessions, summary } = await fetchSessions();

  // Store all sessions (for sidebar)
  state.sessions = sessions;

  // Dedupe by tmux session for terminal panels (1 panel per tmux session)
  const tmuxSessions = dedupeByTmuxSession(sessions);

  // Update sidebar (1 entry per tmux session, matching panels)
  updateSidebar(tmuxSessions);
  updateSummary(summary);

  if (tmuxSessions.length === 0) {
    showEmptyState();
    return;
  }

  // Apply optimal grid layout based on tmux session count
  applyGridLayout(tmuxSessions.length);

  // Find sessions that need terminal panels
  const existingKeys = new Set(
    Array.from(document.querySelectorAll('.terminal-panel'))
      .map(p => p.dataset.sessionKey)
  );

  const currentKeys = new Set(tmuxSessions.map(s => getSessionKey(s)));

  // Remove panels for sessions that no longer exist
  for (const key of existingKeys) {
    if (!currentKeys.has(key)) {
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

  // Keyboard shortcuts - tmux style with Ctrl+A prefix
  setupKeyboardShortcuts();
}

/**
 * Get ordered list of tmux sessions for navigation
 */
function getTmuxSessions() {
  return dedupeByTmuxSession(state.sessions);
}

/**
 * Navigate to next session
 */
function nextSession() {
  const sessions = getTmuxSessions();
  if (sessions.length === 0) return;

  const currentIdx = sessions.findIndex(s => getSessionKey(s) === state.focusedSession);
  const nextIdx = (currentIdx + 1) % sessions.length;
  focusPanel(getSessionKey(sessions[nextIdx]));
}

/**
 * Navigate to previous session
 */
function prevSession() {
  const sessions = getTmuxSessions();
  if (sessions.length === 0) return;

  const currentIdx = sessions.findIndex(s => getSessionKey(s) === state.focusedSession);
  const prevIdx = currentIdx <= 0 ? sessions.length - 1 : currentIdx - 1;
  focusPanel(getSessionKey(sessions[prevIdx]));
}

/**
 * Toggle fullscreen mode for focused panel
 */
function toggleFullscreen() {
  state.fullscreen = !state.fullscreen;
  document.body.classList.toggle('fullscreen-mode', state.fullscreen);

  // Refit all terminals after layout change
  setTimeout(() => {
    for (const { fitAddon } of state.terminals.values()) {
      fitAddon.fit();
    }
  }, 100);
}

/**
 * Kill session with confirmation
 */
async function killSession() {
  if (!state.focusedSession) return;

  const confirmed = confirm(`Kill session "${state.focusedSession}"?`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(state.focusedSession)}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Refresh to update UI
    await render();
  } catch (err) {
    console.error('Failed to kill session:', err);
    alert('Failed to kill session: ' + err.message);
  }
}

/**
 * Create new session
 */
async function newSession() {
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'new' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Refresh to show new session
    await render();
  } catch (err) {
    console.error('Failed to create session:', err);
    alert('Failed to create session: ' + err.message);
  }
}

/**
 * Show the add repository dialog (Ctrl+A r shortcut)
 */
function newRepo() {
  showAddRepoDialog();
}

/**
 * Show the add repository dialog
 */
function showAddRepoDialog() {
  const existing = document.querySelector('.add-repo-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'add-repo-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;';

  overlay.innerHTML = `
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;min-width:380px;max-width:450px;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <h3 style="margin:0 0 16px;font-size:1rem;color:#e0e0e0;">Add Repository</h3>
      <div class="dialog-tabs" style="display:flex;gap:0;margin-bottom:16px;border-bottom:1px solid #333;">
        <button class="dialog-tab active" data-tab="local" style="flex:1;padding:10px 16px;background:transparent;border:none;color:#9b59b6;font-size:0.85rem;cursor:pointer;border-bottom:2px solid #9b59b6;">Local Folder</button>
        <button class="dialog-tab" data-tab="github" style="flex:1;padding:10px 16px;background:transparent;border:none;color:#888;font-size:0.85rem;cursor:pointer;border-bottom:2px solid transparent;">GitHub URL</button>
      </div>
      <div class="tab-content active" data-tab="local">
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:0.75rem;color:#888;display:block;margin-bottom:4px;">Repository path</label>
            <input type="text" class="local-path-input" placeholder="/home/user/projects/myrepo" style="width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-size:0.85rem;padding:8px 12px;border-radius:4px;box-sizing:border-box;">
            <div class="local-error" style="font-size:0.75rem;color:#e74c3c;margin-top:8px;"></div>
          </div>
        </div>
      </div>
      <div class="tab-content" data-tab="github" style="display:none;">
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:0.75rem;color:#888;display:block;margin-bottom:4px;">GitHub URL or owner/repo</label>
            <input type="text" class="github-url-input" placeholder="https://github.com/owner/repo" style="width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-size:0.85rem;padding:8px 12px;border-radius:4px;box-sizing:border-box;">
            <div class="github-preview" style="font-size:0.75rem;color:#9b59b6;margin-top:8px;min-height:1.2em;"></div>
            <div class="github-error" style="font-size:0.75rem;color:#e74c3c;margin-top:4px;"></div>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
        <button class="cancel-btn" style="background:transparent;border:1px solid #333;color:#888;font-size:0.85rem;padding:8px 16px;border-radius:4px;cursor:pointer;">Cancel</button>
        <button class="submit-btn" style="background:#9b59b6;border:none;color:white;font-size:0.85rem;padding:8px 16px;border-radius:4px;cursor:pointer;">Add</button>
      </div>
    </div>
  `;

  const tabs = overlay.querySelectorAll('.dialog-tab');
  const tabContents = overlay.querySelectorAll('.tab-content');
  const localPathInput = overlay.querySelector('.local-path-input');
  const githubUrlInput = overlay.querySelector('.github-url-input');
  const githubPreview = overlay.querySelector('.github-preview');
  const localError = overlay.querySelector('.local-error');
  const githubError = overlay.querySelector('.github-error');
  const submitBtn = overlay.querySelector('.submit-btn');
  const cancelBtn = overlay.querySelector('.cancel-btn');

  let activeTab = 'local';

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      activeTab = tabName;
      tabs.forEach(t => {
        t.style.color = t.dataset.tab === tabName ? '#9b59b6' : '#888';
        t.style.borderBottomColor = t.dataset.tab === tabName ? '#9b59b6' : 'transparent';
      });
      tabContents.forEach(c => c.style.display = c.dataset.tab === tabName ? 'block' : 'none');
      submitBtn.textContent = tabName === 'github' ? 'Clone & Add' : 'Add';
      (tabName === 'local' ? localPathInput : githubUrlInput).focus();
    });
  });

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

  const closeDialog = () => overlay.remove();

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = activeTab === 'github' ? 'Cloning...' : 'Adding...';

    try {
      let successMessage;
      if (activeTab === 'local') {
        const path = localPathInput.value.trim();
        if (!path) throw new Error('Please enter a path');
        if (!path.startsWith('/')) throw new Error('Please enter an absolute path (starting with /)');
        const result = await createInstance(path);
        successMessage = `Added: ${result.instance.instanceId}`;
      } else {
        const url = githubUrlInput.value.trim();
        if (!url) throw new Error('Please enter a GitHub URL');
        if (!parseGitHubUrl(url)) throw new Error('Invalid GitHub URL format');
        const result = await cloneAndCreateInstance(url);
        successMessage = result.cloned ? `Cloned & added: ${result.instance.instanceId}` : `Added: ${result.instance.instanceId}`;
      }
      closeDialog();
      showToast(successMessage, 'success');
      await render();
    } catch (err) {
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = originalText;
      (activeTab === 'local' ? localError : githubError).textContent = err.message;
    }
  });

  cancelBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
    if (e.key === 'Enter' && !submitBtn.disabled) submitBtn.click();
  });

  document.body.appendChild(overlay);
  localPathInput.focus();
}

/**
 * Show/hide prefix mode indicator
 */
function showPrefixIndicator(show) {
  let indicator = document.getElementById('prefix-indicator');

  if (show && !indicator) {
    indicator = document.createElement('div');
    indicator.id = 'prefix-indicator';
    indicator.innerHTML = '<kbd>Ctrl+A</kbd> <span>waiting for command...</span>';
    document.body.appendChild(indicator);
  } else if (!show && indicator) {
    indicator.remove();
  }
}

/**
 * Show shortcut help overlay
 */
function showShortcutHelp() {
  let help = document.getElementById('shortcut-help');
  if (help) {
    help.remove();
    return;
  }

  help = document.createElement('div');
  help.id = 'shortcut-help';
  help.innerHTML = `
    <div class="help-content">
      <h3>Keyboard Shortcuts</h3>
      <p class="help-subtitle">Press <kbd>Ctrl+A</kbd> then:</p>
      <div class="help-grid">
        <div class="help-item"><kbd>n</kbd> <span>Next session</span></div>
        <div class="help-item"><kbd>p</kbd> <span>Previous session</span></div>
        <div class="help-item"><kbd>c</kbd> <span>New session</span></div>
        <div class="help-item"><kbd>r</kbd> <span>New repo</span></div>
        <div class="help-item"><kbd>f</kbd> <span>Toggle fullscreen</span></div>
        <div class="help-item"><kbd>x</kbd> <span>Kill session</span></div>
        <div class="help-item"><kbd>?</kbd> <span>This help</span></div>
        <div class="help-item"><kbd>Esc</kbd> <span>Cancel</span></div>
      </div>
      <p class="help-footer">Press <kbd>Esc</kbd> or <kbd>Ctrl+A ?</kbd> to close</p>
    </div>
  `;
  help.addEventListener('click', (e) => {
    if (e.target === help) help.remove();
  });
  document.body.appendChild(help);
}

/**
 * Setup tmux-style keyboard shortcuts with Ctrl+A prefix
 */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Close help on Escape
    if (e.key === 'Escape') {
      const help = document.getElementById('shortcut-help');
      if (help) {
        help.remove();
        e.preventDefault();
        return;
      }

      // Exit prefix mode
      if (state.prefixMode) {
        state.prefixMode = false;
        clearTimeout(state.prefixTimeout);
        showPrefixIndicator(false);
        e.preventDefault();
        return;
      }

      // Exit fullscreen
      if (state.fullscreen) {
        toggleFullscreen();
        e.preventDefault();
        return;
      }
    }

    // Ctrl+A to enter prefix mode
    if (e.ctrlKey && e.key === 'a') {
      // If already in prefix mode, send literal Ctrl+A to terminal
      if (state.prefixMode) {
        state.prefixMode = false;
        clearTimeout(state.prefixTimeout);
        showPrefixIndicator(false);
        // Let it pass through to terminal
        return;
      }

      state.prefixMode = true;
      showPrefixIndicator(true);

      // Auto-cancel after 2 seconds
      state.prefixTimeout = setTimeout(() => {
        state.prefixMode = false;
        showPrefixIndicator(false);
      }, 2000);

      e.preventDefault();
      return;
    }

    // Handle prefix commands
    if (state.prefixMode) {
      state.prefixMode = false;
      clearTimeout(state.prefixTimeout);
      showPrefixIndicator(false);

      switch (e.key.toLowerCase()) {
        case 'n':
          nextSession();
          break;
        case 'p':
          prevSession();
          break;
        case 'c':
          newSession();
          break;
        case 'r':
          newRepo();
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'x':
        case 'k':
          killSession();
          break;
        case '?':
          showShortcutHelp();
          break;
        default:
          // Unknown command, ignore
          return;
      }

      e.preventDefault();
      return;
    }

    // Direct shortcuts (not in prefix mode)
    // Ctrl+1-9 to focus panel by number
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      const sessions = getTmuxSessions();
      if (sessions[idx]) {
        focusPanel(getSessionKey(sessions[idx]));
        e.preventDefault();
      }
    }
  });
}

// Start app
init();
