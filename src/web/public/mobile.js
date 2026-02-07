/**
 * Orcha Mobile Dashboard
 * Full xterm.js terminal view for phone
 */

const state = {
  sessions: [],
  instances: [],
  activeIndex: 0,
  statusInterval: null,
  previousStates: new Map(),
  notificationsEnabled: false,
  lastSessionsJson: '',
  // Terminal state
  terminal: null,    // current xterm Terminal instance
  fitAddon: null,
  ws: null,          // current WebSocket
  activeSessionKey: null,
}

// ============================================================================
// API
// ============================================================================

async function fetchStatus() {
  const res = await fetch('/api/status')
  return res.json()
}

async function fetchInstances() {
  const res = await fetch('/api/instances')
  const data = await res.json()
  return data.instances || []
}

async function createSession(instanceId, branch, mode) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId, branch, mode }),
  })
  return res.json()
}

// ============================================================================
// Terminal
// ============================================================================

function getSessionKey(session) {
  return `${session.instanceId}:${session.tmuxSession}`
}

function dedupeByTmux(sessions) {
  const seen = new Map()
  for (const s of sessions) {
    const key = getSessionKey(s)
    if (!seen.has(key)) seen.set(key, s)
  }
  return Array.from(seen.values())
}

function connectTerminal(session) {
  const key = getSessionKey(session)

  // Already connected to this session
  if (state.activeSessionKey === key && state.ws && state.ws.readyState === WebSocket.OPEN) {
    return
  }

  // Tear down previous connection
  disconnectTerminal()

  const container = document.getElementById('terminal-container')

  // Create terminal
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: "'SF Mono', Monaco, 'Courier New', monospace",
    theme: {
      background: '#0d0d0d',
      foreground: '#e0e0e0',
      cursor: '#e0e0e0',
      cursorAccent: '#0d0d0d',
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
    scrollback: 3000,
    allowProposedApi: true,
  })

  const fitAddon = new FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)

  // Connect WebSocket
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}?session=${encodeURIComponent(key)}&tmux=${encodeURIComponent(session.tmuxSession)}`
  const ws = new WebSocket(wsUrl)

  const fitAndResize = () => {
    fitAddon.fit()
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  }

  setTimeout(fitAndResize, 50)
  setTimeout(fitAndResize, 150)
  setTimeout(fitAndResize, 300)

  ws.onopen = () => {
    fitAndResize()
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'output' && msg.data) {
        term.write(msg.data)
      }
    } catch {
      term.write(event.data)
    }
  }

  ws.onerror = () => {
    term.write('\r\n\x1b[31mConnection error\x1b[0m\r\n')
  }

  ws.onclose = () => {
    term.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n')
  }

  // Terminal input -> WebSocket
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }))
    }
  })

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit()
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  })
  resizeObserver.observe(container)

  state.terminal = term
  state.fitAddon = fitAddon
  state.ws = ws
  state.activeSessionKey = key
  state._resizeObserver = resizeObserver
}

function disconnectTerminal() {
  if (state.ws) {
    state.ws.onclose = null // prevent "Disconnected" message on intentional close
    state.ws.close()
    state.ws = null
  }
  if (state._resizeObserver) {
    state._resizeObserver.disconnect()
    state._resizeObserver = null
  }
  if (state.terminal) {
    state.terminal.dispose()
    state.terminal = null
  }
  state.fitAddon = null
  state.activeSessionKey = null
}

// ============================================================================
// Rendering
// ============================================================================

function sessionsFingerprint(sessions) {
  return JSON.stringify(sessions.map(s => ({
    id: s.id,
    state: s.state,
    message: s.message,
    customName: s.customName,
    branch: s.branch,
    instanceId: s.instanceId,
  })))
}

function renderSessionInfo(session) {
  const infoEl = document.getElementById('session-info')
  if (!session) {
    infoEl.innerHTML = ''
    return
  }

  const name = session.customName || session.id
  const st = session.state || 'idle'

  infoEl.innerHTML = `
    <div class="info-row">
      <div class="status-dot ${st}"></div>
      <span class="info-name">${escapeHtml(name)}</span>
      <span class="card-state ${st}">${st}</span>
    </div>
    ${session.message ? `<div class="info-message">${escapeHtml(session.message)}</div>` : ''}
  `
}

function renderEmpty() {
  const container = document.getElementById('terminal-container')
  disconnectTerminal()
  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">&#127793;</div>
      <div>No sessions running</div>
      <div style="font-size:13px">Tap + to create one</div>
    </div>`
  document.getElementById('session-info').innerHTML = ''
}

function renderDots(sessions) {
  const dotsEl = document.getElementById('session-dots')
  dotsEl.innerHTML = ''

  sessions.forEach((session, i) => {
    const dot = document.createElement('button')
    dot.className = `nav-dot ${session.state || 'idle'}`
    if (i === state.activeIndex) dot.classList.add('active')
    dot.title = session.customName || session.id
    dot.addEventListener('click', () => {
      if (state.activeIndex !== i) {
        state.activeIndex = i
        switchToSession(sessions[i])
        renderDots(sessions)
      }
    })
    dotsEl.appendChild(dot)
  })
}

function switchToSession(session) {
  renderSessionInfo(session)
  // Clear container before connecting new terminal
  const container = document.getElementById('terminal-container')
  disconnectTerminal()
  container.innerHTML = ''
  connectTerminal(session)
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// ============================================================================
// Notifications
// ============================================================================

function checkStateChanges(sessions) {
  if (!state.notificationsEnabled) return

  const notifyTransitions = new Set([
    'working->waiting',
    'working->done',
    'working->error',
    'waiting->done',
    'waiting->error',
    'idle->error',
    'initializing->error',
  ])

  for (const session of sessions) {
    const prevState = state.previousStates.get(session.id)
    const currState = session.state

    if (prevState && prevState !== currState) {
      const transition = `${prevState}->${currState}`
      if (notifyTransitions.has(transition)) {
        const name = session.customName || session.id
        const body = session.message || `${prevState} -> ${currState}`
        new Notification(`Orcha: ${name}`, {
          body,
          icon: '/favicon.png',
          tag: session.id,
        })
      }
    }

    state.previousStates.set(session.id, currState)
  }
}

async function toggleNotifications() {
  const btn = document.getElementById('notif-btn')

  if (!state.notificationsEnabled) {
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') return
    } else if (Notification.permission !== 'granted') {
      return
    }
    state.notificationsEnabled = true
    btn.classList.add('active')
  } else {
    state.notificationsEnabled = false
    btn.classList.remove('active')
  }
}

// ============================================================================
// Swipe navigation
// ============================================================================

function setupSwipe() {
  const container = document.getElementById('session-info')
  let startX = 0, startTime = 0, swiping = false

  container.addEventListener('touchstart', (e) => {
    if (state.sessions.length <= 1) return
    startX = e.touches[0].clientX
    startTime = Date.now()
    swiping = true
  }, { passive: true })

  container.addEventListener('touchend', (e) => {
    if (!swiping) return
    swiping = false

    const dx = e.changedTouches[0].clientX - startX
    const dt = Date.now() - startTime
    const velocity = Math.abs(dx) / dt

    if (Math.abs(dx) > 50 && velocity > 0.3) {
      let newIndex = state.activeIndex
      if (dx < 0 && state.activeIndex < state.sessions.length - 1) {
        newIndex = state.activeIndex + 1
      } else if (dx > 0 && state.activeIndex > 0) {
        newIndex = state.activeIndex - 1
      }
      if (newIndex !== state.activeIndex) {
        state.activeIndex = newIndex
        switchToSession(state.sessions[state.activeIndex])
        renderDots(state.sessions)
      }
    }
  }, { passive: true })
}

// ============================================================================
// Create session
// ============================================================================

function setupCreateSheet() {
  const sheet = document.getElementById('create-sheet')
  const backdrop = sheet.querySelector('.sheet-backdrop')
  const fab = document.getElementById('create-btn')
  const cancelBtn = document.getElementById('create-cancel')
  const submitBtn = document.getElementById('create-submit')
  const instanceSelect = document.getElementById('create-instance')

  function openSheet() {
    instanceSelect.innerHTML = state.instances
      .map(i => `<option value="${i.instanceId}">${i.instanceId}</option>`)
      .join('')
    document.getElementById('create-branch').value = ''
    sheet.classList.remove('hidden')
  }

  function closeSheet() {
    sheet.classList.add('hidden')
  }

  fab.addEventListener('click', openSheet)
  cancelBtn.addEventListener('click', closeSheet)
  backdrop.addEventListener('click', closeSheet)

  submitBtn.addEventListener('click', async () => {
    const instanceId = instanceSelect.value
    const branch = document.getElementById('create-branch').value.trim()
    const mode = document.getElementById('create-mode').value

    if (!instanceId) return

    submitBtn.disabled = true
    submitBtn.textContent = 'Creating...'

    try {
      await createSession(instanceId, branch || undefined, mode)
      closeSheet()
      await refresh()
    } catch (err) {
      alert('Failed to create session: ' + err.message)
    } finally {
      submitBtn.disabled = false
      submitBtn.textContent = 'Create'
    }
  })
}

// ============================================================================
// Main loop
// ============================================================================

async function refresh() {
  try {
    const [statusData, instances] = await Promise.all([
      fetchStatus(),
      fetchInstances(),
    ])

    const sessions = dedupeByTmux(statusData.sessions || [])
    state.instances = instances || []

    checkStateChanges(sessions)

    const fp = sessionsFingerprint(sessions)
    const changed = fp !== state.lastSessionsJson
    const prevSessions = state.sessions
    state.sessions = sessions
    state.lastSessionsJson = fp

    if (sessions.length === 0) {
      if (prevSessions.length !== 0) renderEmpty()
      return
    }

    // Clamp active index
    if (state.activeIndex >= sessions.length) state.activeIndex = sessions.length - 1
    if (state.activeIndex < 0) state.activeIndex = 0

    const activeSession = sessions[state.activeIndex]

    // Connect terminal if not connected yet or session changed
    const activeKey = getSessionKey(activeSession)
    if (state.activeSessionKey !== activeKey) {
      switchToSession(activeSession)
    } else if (changed) {
      // Just update the info bar (state/message might have changed)
      renderSessionInfo(activeSession)
    }

    if (changed) {
      renderDots(sessions)
    }
  } catch (err) {
    console.error('[Mobile] Refresh failed:', err)
  }
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }

  setupSwipe()
  setupCreateSheet()
  document.getElementById('notif-btn').addEventListener('click', toggleNotifications)
  document.getElementById('refresh-btn').addEventListener('click', refresh)

  await refresh()

  // Poll status every 5s (terminal output comes via WebSocket, no capture polling needed)
  state.statusInterval = setInterval(refresh, 5000)
}

init()
