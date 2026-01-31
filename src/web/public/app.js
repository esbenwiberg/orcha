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
};

// DOM elements
const sessionList = document.getElementById('session-list');
const terminalGrid = document.getElementById('terminal-grid');
const summaryEl = document.getElementById('summary');

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
 * Create session key for terminal mapping
 */
function getSessionKey(session) {
  return `${session.instanceId}-${session.id}`;
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
  // Show instance name (shortened) + session number + branch
  const shortInstance = session.instanceId.replace('orcha-', '');
  title.textContent = session.branch
    ? `#${session.displayId} ${session.branch}`
    : `#${session.displayId}`;
  title.title = `${session.instanceId} - ${session.branch || 'no branch'}`;

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

  // Connect WebSocket
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}?session=${key}&tmux=${session.tmuxSession}&pane=${session.paneIndex}`;

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
 * Update sidebar session list
 */
function updateSidebar(sessions) {
  sessionList.innerHTML = '';

  // Group sessions by instance
  const groups = groupByInstance(sessions);

  for (const [instanceId, instanceSessions] of groups) {
    // Instance header
    const header = document.createElement('div');
    header.className = 'instance-header';
    header.textContent = instanceId;
    sessionList.appendChild(header);

    // Sessions for this instance
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
      name.textContent = `#${session.displayId}`;

      const branch = document.createElement('div');
      branch.className = 'session-branch';
      branch.textContent = session.branch || session.message || session.state;

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

  // Store sessions
  state.sessions = sessions;

  // Update sidebar
  updateSidebar(sessions);
  updateSummary(summary);

  if (sessions.length === 0) {
    showEmptyState();
    return;
  }

  // Apply optimal grid layout
  applyGridLayout(sessions.length);

  // Find sessions that need terminal panels
  const existingKeys = new Set(
    Array.from(document.querySelectorAll('.terminal-panel'))
      .map(p => p.dataset.sessionKey)
  );

  const currentKeys = new Set(sessions.map(s => getSessionKey(s)));

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

  // Add panels for new sessions
  for (const session of sessions) {
    const key = getSessionKey(session);
    if (!existingKeys.has(key)) {
      const panel = createTerminalPanel(session);
      terminalGrid.appendChild(panel);

      // Initialize terminal after DOM update
      requestAnimationFrame(() => initTerminal(session));
    }
  }

  // Update existing panel headers
  updatePanelHeaders(sessions);

  // Auto-focus first terminal if none focused
  if (!state.focusedSession && sessions.length > 0) {
    focusPanel(getSessionKey(sessions[0]));
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

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+1-9 to focus panel by number
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      if (state.sessions[idx]) {
        focusPanel(getSessionKey(state.sessions[idx]));
        e.preventDefault();
      }
    }
  });
}

// Start app
init();
