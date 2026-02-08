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
// Terminal touch scroll — document-level capture to intercept before xterm
// ============================================================================

function setupTermTouchScroll(container) {
  let startX = 0, startY = 0, lastY = 0
  let scrollMode = false
  let decided = false

  // Send mouse wheel escape sequences to tmux via WebSocket
  // tmux mouse mode interprets these as scroll up/down
  function sendWheelEvents(lines) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
    const up = lines < 0
    const count = Math.abs(lines)
    // SGR mouse encoding: \x1b[<64;col;rowM = wheel up, \x1b[<65;col;rowM = wheel down
    const code = up ? 64 : 65
    const seq = `\x1b[<${code};1;1M`
    for (let i = 0; i < count; i++) {
      state.ws.send(JSON.stringify({ type: 'input', data: seq }))
    }
  }

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return
    if (!container.contains(e.target)) return
    startX = e.touches[0].clientX
    startY = e.touches[0].clientY
    lastY = startY
    scrollMode = false
    decided = false
  }, { capture: true, passive: true })

  document.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return
    if (!container.contains(e.target)) return

    const x = e.touches[0].clientX
    const y = e.touches[0].clientY

    if (!decided) {
      const dx = Math.abs(x - startX)
      const dy = Math.abs(y - startY)
      if (dx < 10 && dy < 10) return
      decided = true
      scrollMode = dy > dx
    }

    if (scrollMode) {
      e.preventDefault()
      e.stopImmediatePropagation()
      const delta = lastY - y
      const lines = Math.trunc(delta / 20)
      if (lines !== 0) {
        sendWheelEvents(lines)
        lastY = y
      }
    }
  }, { capture: true, passive: false })

  document.addEventListener('touchend', () => {
    scrollMode = false
    decided = false
  }, { capture: true, passive: true })
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

  // Enable touch scrolling — sends mouse wheel sequences to tmux via WebSocket
  setupTermTouchScroll(container)

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

  // Terminal input -> WebSocket (with Ctrl modifier support)
  term.onData((data) => {
    if (ws.readyState !== WebSocket.OPEN) return

    // If Ctrl modifier is active, convert a-z/A-Z to Ctrl sequence
    if (state.ctrlActive && data.length === 1) {
      const ch = data.toLowerCase()
      if (ch >= 'a' && ch <= 'z') {
        const ctrlCode = String.fromCharCode(ch.charCodeAt(0) - 96) // Ctrl+a=1, Ctrl+c=3, etc.
        ws.send(JSON.stringify({ type: 'input', data: ctrlCode }))
        state.ctrlActive = false
        const ctrlBtn = document.querySelector('[data-key="ctrl"]')
        if (ctrlBtn) ctrlBtn.classList.remove('active')
        return
      }
    }

    ws.send(JSON.stringify({ type: 'input', data }))
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
      <button class="info-menu-btn" title="Session actions">&#8942;</button>
    </div>
    ${session.message ? `<div class="info-message">${escapeHtml(session.message)}</div>` : ''}
  `

  infoEl.querySelector('.info-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    showSessionMenu(session)
  })
}

function showToast(message, type = 'info') {
  const existing = document.querySelector('.mobile-toast')
  if (existing) existing.remove()

  const toast = document.createElement('div')
  toast.className = `mobile-toast ${type}`
  toast.textContent = message
  document.body.appendChild(toast)
  setTimeout(() => toast.classList.add('visible'), 10)
  setTimeout(() => {
    toast.classList.remove('visible')
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}

function showSessionMenu(session) {
  const existing = document.querySelector('.session-menu-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'session-menu-overlay'

  const instanceId = session.instanceId
  const sessionKey = `${session.instanceId}/${session.tmuxSession}/${session.paneIndex}`

  const actions = [
    { icon: '☰', label: 'View plan', action: () => showPlanMobile(session) },
    { icon: '↓', label: 'Pull', action: () => gitAction('/api/git/pull', instanceId, 'Pull') },
    { icon: '↑', label: 'Push', action: () => gitAction('/api/git/push', instanceId, 'Push') },
    { icon: '↙', label: 'Merge main', action: () => gitAction('/api/git/pull-main', instanceId, 'Merge') },
    { icon: '×', label: 'Close session', danger: true, action: () => closeSessionMobile(session, sessionKey) },
  ]

  const sheet = document.createElement('div')
  sheet.className = 'session-menu-sheet'

  const title = document.createElement('div')
  title.className = 'session-menu-title'
  title.textContent = session.customName || session.id
  sheet.appendChild(title)

  actions.forEach(a => {
    const btn = document.createElement('button')
    btn.className = 'session-menu-item' + (a.danger ? ' danger' : '')
    btn.innerHTML = `<span class="session-menu-icon">${a.icon}</span>${a.label}`
    btn.addEventListener('click', () => {
      overlay.remove()
      a.action()
    })
    sheet.appendChild(btn)
  })

  overlay.appendChild(sheet)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('visible'))
}

async function gitAction(url, instanceId, label) {
  showToast(`${label}ing...`, 'info')
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `${label} failed`)
    showToast(`${label} successful`, 'success')
  } catch (err) {
    showToast(`${label} failed: ${err.message}`, 'error')
  }
}

async function closeSessionMobile(session, sessionKey) {
  try {
    const res = await fetch(`/api/sessions/${session.instanceId}/${session.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error || 'Close failed')
    }
    disconnectTerminal()
    showToast('Session closed', 'success')
    // Re-fetch sessions
    await pollStatus()
  } catch (err) {
    showToast(`Close failed: ${err.message}`, 'error')
  }
}

async function showPlanMobile(session) {
  const overlay = document.createElement('div')
  overlay.className = 'plan-overlay'

  overlay.innerHTML = `
    <div class="plan-dialog-mobile">
      <div class="plan-dialog-header-mobile">
        <span class="plan-dialog-title-mobile">Plan: ${escapeHtml(session.customName || session.id)}</span>
        <button class="plan-dialog-close-mobile">&times;</button>
      </div>
      <div class="plan-dialog-body-mobile">
        <div style="color:var(--text-secondary);padding:20px;text-align:center;">Loading plan...</div>
      </div>
    </div>
  `

  const body = overlay.querySelector('.plan-dialog-body-mobile')
  const closeBtn = overlay.querySelector('.plan-dialog-close-mobile')

  closeBtn.addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })

  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('visible'))

  try {
    const res = await fetch(`/api/sessions/${session.instanceId}/${session.id}/plan`)
    if (!res.ok) {
      body.innerHTML = `<div style="color:var(--text-secondary);padding:20px;text-align:center;">No plan found.<br><br><span style="font-size:12px;">Create a plan file at <code>.claude/plan.md</code></span></div>`
      return
    }
    const data = await res.json()
    body.innerHTML = `<div class="plan-markdown">${marked.parse(data.content)}</div>`
  } catch (err) {
    body.innerHTML = `<div style="color:var(--state-error);padding:20px;">Failed to load: ${escapeHtml(err.message)}</div>`
  }
}

// simpleMarkdown removed - using marked.js instead

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
  const targets = [
    document.getElementById('session-info'),
    document.getElementById('bottom-nav'),
  ]
  let startX = 0, startTime = 0, swiping = false

  function onTouchStart(e) {
    if (state.sessions.length <= 1) return
    startX = e.touches[0].clientX
    startTime = Date.now()
    swiping = true
  }

  function onTouchEnd(e) {
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
  }

  targets.forEach(el => {
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
  })

}

// ============================================================================
// Key toolbar
// ============================================================================

function setupKeyToolbar() {
  const toolbar = document.getElementById('key-toolbar')

  // Ctrl modifier state lives on the shared state so onData can see it
  state.ctrlActive = false

  function sendKey(data) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
    state.ws.send(JSON.stringify({ type: 'input', data }))
  }

  function updateCtrlBtn() {
    const ctrlBtn = toolbar.querySelector('[data-key="ctrl"]')
    if (ctrlBtn) ctrlBtn.classList.toggle('active', state.ctrlActive)
  }

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.key-btn')
    if (!btn) return

    const key = btn.dataset.key

    // Ctrl is a modifier toggle
    if (key === 'ctrl') {
      state.ctrlActive = !state.ctrlActive
      updateCtrlBtn()
      return
    }

    // Map key names to escape sequences
    const keyMap = {
      esc: '\x1b',
      tab: '\t',
      up: '\x1b[A',
      down: '\x1b[B',
      right: '\x1b[C',
      left: '\x1b[D',
    }

    let seq = keyMap[key]
    if (!seq) return

    // Clear Ctrl after sending a toolbar key
    if (state.ctrlActive) {
      state.ctrlActive = false
      updateCtrlBtn()
    }

    sendKey(seq)

    // Refocus terminal so it stays interactive
    if (state.terminal) state.terminal.focus()
  })
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
  setupKeyToolbar()
  setupCreateSheet()
  document.getElementById('notif-btn').addEventListener('click', toggleNotifications)
  document.getElementById('refresh-btn').addEventListener('click', () => location.reload())

  await refresh()

  // Poll status every 5s (terminal output comes via WebSocket, no capture polling needed)
  state.statusInterval = setInterval(refresh, 5000)
}

init()
