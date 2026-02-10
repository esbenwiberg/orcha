/**
 * Orcha Mobile Dashboard
 * Full xterm.js terminal view + pipeline management for phone
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
  // Tab state
  activeTab: 'sessions', // 'sessions' | 'pipelines'
  // Pipeline state
  pipelines: [],
  lastPipelinesJson: '',
  selectedPipeline: null,
  pipelineLogs: {},
  pipelineWs: null,
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

async function fetchPipelines() {
  try {
    const res = await fetch('/api/pipelines')
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
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
// Tab Navigation
// ============================================================================

function switchTab(tab) {
  if (state.activeTab === tab) return
  state.activeTab = tab

  const termContainer = document.getElementById('terminal-container')
  const plContainer = document.getElementById('pipeline-list-container')
  const sessionInfo = document.getElementById('session-info')
  const keyToolbar = document.getElementById('key-toolbar')

  // Update tab buttons
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  })

  if (tab === 'sessions') {
    termContainer.classList.remove('hidden')
    plContainer.classList.add('hidden')
    sessionInfo.style.display = ''
    keyToolbar.style.display = ''

    // Reconnect terminal if we have sessions
    if (state.sessions.length > 0) {
      const activeSession = state.sessions[state.activeIndex]
      if (activeSession && state.activeSessionKey !== getSessionKey(activeSession)) {
        switchToSession(activeSession)
      }
    }

    // Disconnect pipeline WebSocket when leaving pipelines tab
    disconnectPipelineEvents()
  } else {
    termContainer.classList.add('hidden')
    plContainer.classList.remove('hidden')
    sessionInfo.style.display = 'none'
    keyToolbar.style.display = 'none'

    // Render pipeline list
    renderPipelineList()

    // Connect pipeline WebSocket for real-time updates
    connectPipelineEvents()
  }
}

// ============================================================================
// Session Rendering
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
      <button class="info-selector-btn" title="Switch session">&#9776;</button>
      <button class="info-menu-btn" title="Session actions">&#8942;</button>
    </div>
    ${session.message ? `<div class="info-message">${escapeHtml(session.message)}</div>` : ''}
  `

  infoEl.querySelector('.info-selector-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    openSessionSelector()
  })

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
    { icon: '\u2630', label: 'View plan', action: () => showPlanMobile(session) },
    { icon: '\u2193', label: 'Pull', action: () => gitAction('/api/git/pull', instanceId, 'Pull') },
    { icon: '\u2191', label: 'Push', action: () => gitAction('/api/git/push', instanceId, 'Push') },
    { icon: '\u2199', label: 'Merge main', action: () => gitAction('/api/git/pull-main', instanceId, 'Merge') },
    { icon: '\u00d7', label: 'Close session', danger: true, action: () => closeSessionMobile(session, sessionKey) },
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


function switchToSession(session) {
  renderSessionInfo(session)
  // Clear container before connecting new terminal
  const container = document.getElementById('terminal-container')
  disconnectTerminal()
  container.innerHTML = ''
  connectTerminal(session)
}

function escapeHtml(str) {
  if (!str) return ''
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
// Session Selector
// ============================================================================

function openSessionSelector() {
  if (state.sessions.length <= 1) return

  const sheet = document.getElementById('session-selector-sheet')
  const listEl = document.getElementById('session-list')

  // Render session list
  listEl.innerHTML = ''
  state.sessions.forEach((session, index) => {
    const name = session.customName || session.id
    const st = session.state || 'idle'
    const branch = session.branch || 'main'
    const isActive = index === state.activeIndex

    const item = document.createElement('button')
    item.className = 'session-list-item' + (isActive ? ' active' : '')
    item.innerHTML = `
      <div class="status-dot ${st}"></div>
      <div class="session-item-info">
        <div class="session-item-name">${escapeHtml(name)}</div>
        <div class="session-item-meta">${escapeHtml(branch)} &middot; ${st}</div>
      </div>
      <div class="session-item-check">&#10003;</div>
    `

    item.addEventListener('click', () => {
      if (state.activeIndex !== index) {
        state.activeIndex = index
        switchToSession(state.sessions[index])
      }
      closeSessionSelector()
    })

    listEl.appendChild(item)
  })

  sheet.classList.remove('hidden')

  // Close on backdrop click
  const backdrop = sheet.querySelector('.sheet-backdrop')
  backdrop.addEventListener('click', closeSessionSelector, { once: true })
}

function closeSessionSelector() {
  const sheet = document.getElementById('session-selector-sheet')
  sheet.classList.add('hidden')
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

  state._openSessionSheet = openSheet

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
// Pipeline List
// ============================================================================

const PIPELINE_STAGE_ORDER = [
  'created', 'architect', 'checkpoint:arch', 'dev', 'gate',
  'fix-loop', 'checkpoint:ship', 'ship', 'completed'
]

const PIPELINE_STAGE_LABELS = {
  'created': 'Created',
  'architect': 'Architect',
  'checkpoint:arch': 'Review',
  'dev': 'Dev',
  'gate': 'Gate',
  'fix-loop': 'Fix',
  'checkpoint:ship': 'Ship Review',
  'ship': 'Ship',
  'completed': 'Done',
}

function pipelineStateClass(st) {
  const running = ['architect', 'dev', 'gate', 'fix-loop', 'ship']
  const waiting = ['checkpoint:arch', 'checkpoint:ship']
  if (st === 'completed') return 'done'
  if (st === 'cancelled' || st === 'error') return 'error'
  if (st === 'escalated') return 'error'
  if (waiting.includes(st)) return 'waiting'
  if (running.includes(st)) return 'working'
  return 'idle'
}

function renderPipelineList() {
  const container = document.getElementById('pipeline-list-container')
  if (!container) return

  if (!state.pipelines || state.pipelines.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#9881;</div>
        <div>No pipelines yet</div>
        <div style="font-size:13px">Tap + to create one</div>
      </div>`
    return
  }

  let html = '<div class="pl-list">'
  for (const pl of state.pipelines) {
    const stClass = pipelineStateClass(pl.state)
    const displayName = pl.title || pl.description || pl.id
    const truncName = displayName.length > 50 ? displayName.slice(0, 47) + '...' : displayName
    html += `<button class="pl-list-item" data-id="${escapeHtml(pl.id)}">
      <div class="pl-state-dot ${stClass}"></div>
      <div class="pl-item-info">
        <div class="pl-item-name">${escapeHtml(truncName)}</div>
        <div class="pl-item-meta">${escapeHtml(pl.state)} &middot; ${formatTimestamp(pl.updatedAt)}</div>
      </div>
      <div class="pl-item-arrow">&#8250;</div>
    </button>`
  }
  html += '</div>'
  container.innerHTML = html

  // Attach click handlers
  container.querySelectorAll('.pl-list-item').forEach(item => {
    item.addEventListener('click', () => {
      showPipelineDetail(item.dataset.id)
    })
  })
}

// ============================================================================
// Pipeline Detail Overlay
// ============================================================================

function showPipelineDetail(pipelineId) {
  const pipeline = state.pipelines.find(p => p.id === pipelineId)
  if (!pipeline) return

  state.selectedPipeline = pipelineId

  const overlay = document.createElement('div')
  overlay.className = 'pl-detail-overlay'
  overlay.id = 'pl-detail-overlay'

  overlay.innerHTML = renderPipelineDetailHtml(pipeline)

  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('visible'))

  // Attach event handlers
  setupPipelineDetailHandlers(overlay, pipeline)

  // Fetch timeline async
  fetchMobileTimeline(pipelineId)

  // Load ship review if in checkpoint:ship
  if (pipeline.state === 'checkpoint:ship') {
    loadMobileShipReview(pipelineId)
  }
}

function renderPipelineDetailHtml(pipeline) {
  const stClass = pipelineStateClass(pipeline.state)
  let html = ''

  // Header bar
  html += '<div class="pl-detail-header">'
  html += '<button class="pl-detail-back">&larr;</button>'
  html += '<span class="pl-detail-header-title">Pipeline</span>'
  html += '<div class="pl-detail-header-actions">'
  html += renderPipelineActionButtons(pipeline)
  html += '</div>'
  html += '</div>'

  // Scrollable body
  html += '<div class="pl-detail-body">'

  // Title & description card
  html += '<div class="pl-card">'
  if (pipeline.title) {
    html += '<div class="pl-detail-title">' + escapeHtml(pipeline.title) + '</div>'
    html += '<div class="pl-detail-desc">' + escapeHtml(pipeline.description || '') + '</div>'
  } else {
    html += '<div class="pl-detail-title">' + escapeHtml(pipeline.description || 'Pipeline') + '</div>'
  }
  html += '<div class="pl-detail-id">' + escapeHtml(pipeline.id) + '</div>'
  html += '<div class="pl-detail-state"><span class="pl-state-dot ' + stClass + '"></span> ' + escapeHtml(pipeline.state) + '</div>'
  html += '</div>'

  // Stage progress bar
  html += renderMobileStageBar(pipeline)

  // Checkpoint controls
  html += renderMobileCheckpointControls(pipeline)

  // Review points section for completed pipelines
  html += renderMobileReviewPoints(pipeline)

  // Gate failure details
  html += renderMobileGateFailure(pipeline)

  // Ship review container (filled async for checkpoint:ship)
  if (pipeline.state === 'checkpoint:ship') {
    html += '<div id="mobile-ship-review" class="pl-card">'
    html += '<div class="pl-card-title">Ship Review</div>'
    html += '<div class="pl-card-loading">Loading review data...</div>'
    html += '</div>'
  }

  // Details card
  html += '<div class="pl-card">'
  html += '<div class="pl-card-title">Details</div>'
  html += '<div class="pl-info-grid">'
  html += '<span class="pl-info-label">Branch</span><span class="pl-info-value">' + escapeHtml(pipeline.sourceBranch) + '</span>'
  html += '<span class="pl-info-label">Fix loops</span><span class="pl-info-value">' + pipeline.fixLoopCount + ' / ' + (pipeline.config?.maxFixLoops || 3) + '</span>'
  html += '<span class="pl-info-label">Created</span><span class="pl-info-value">' + formatTimestamp(pipeline.createdAt) + '</span>'
  html += '<span class="pl-info-label">Updated</span><span class="pl-info-value">' + formatTimestamp(pipeline.updatedAt) + '</span>'
  if (pipeline.error) {
    html += '<span class="pl-info-label">Error</span><span class="pl-info-value pl-error-text">' + escapeHtml(pipeline.error) + '</span>'
  }
  html += '</div>'
  html += '</div>'

  // Usage card
  if (pipeline.usageSnapshot) {
    html += '<div class="pl-card">'
    html += '<div class="pl-card-title">Usage</div>'
    html += '<div class="pl-usage-row">'
    if (pipeline.usageSnapshot.totalCostUsd !== undefined) {
      html += '<div class="pl-usage-item"><div class="pl-usage-label">Cost</div><div class="pl-usage-value">$' + pipeline.usageSnapshot.totalCostUsd.toFixed(2) + '</div></div>'
    }
    if (pipeline.usageSnapshot.inputTokens) {
      html += '<div class="pl-usage-item"><div class="pl-usage-label">Input</div><div class="pl-usage-value">' + formatTokens(pipeline.usageSnapshot.inputTokens) + '</div></div>'
    }
    if (pipeline.usageSnapshot.outputTokens) {
      html += '<div class="pl-usage-item"><div class="pl-usage-label">Output</div><div class="pl-usage-value">' + formatTokens(pipeline.usageSnapshot.outputTokens) + '</div></div>'
    }
    html += '</div>'
    html += '</div>'
  }

  // Acceptance criteria card
  if (pipeline.acceptanceCriteria && pipeline.acceptanceCriteria.length > 0) {
    html += '<div class="pl-card">'
    html += '<div class="pl-card-title">Acceptance Criteria</div>'
    html += '<ul class="pl-ac-list">'
    for (const ac of pipeline.acceptanceCriteria) {
      html += '<li>' + escapeHtml(ac) + '</li>'
    }
    html += '</ul>'
    html += '</div>'
  }

  // Blueprint card (collapsible)
  const hasArchitect = pipeline.stageHistory && pipeline.stageHistory.some(s => s.stage === 'architect')
  if (hasArchitect) {
    html += '<div class="pl-card pl-collapsible">'
    html += '<button class="pl-collapsible-header" data-action="toggle-blueprint">'
    html += '<span class="pl-collapsible-arrow">&#9656;</span> Blueprint'
    html += '</button>'
    html += '<div class="pl-collapsible-body hidden" id="mobile-blueprint-body">'
    html += '<div class="pl-card-loading">Loading...</div>'
    html += '</div>'
    html += '</div>'
  }

  // Activity timeline card
  html += '<div class="pl-card">'
  html += '<div class="pl-card-title">Activity Timeline</div>'
  html += '<div id="mobile-timeline" class="pl-timeline">'
  html += '<div class="pl-card-loading">Loading activity...</div>'
  html += '</div>'
  html += '</div>'

  // Live output card
  const activeStages = ['architect', 'dev', 'gate', 'fix-loop', 'ship']
  const isActive = activeStages.includes(pipeline.state)
  if (isActive || state.pipelineLogs[pipeline.id]) {
    html += '<div class="pl-card">'
    html += '<div class="pl-card-title">Live Output' + (isActive ? ' <span class="pl-streaming-dot">streaming</span>' : '') + '</div>'
    html += '<pre class="pl-live-log" id="mobile-live-log" data-pipeline-id="' + escapeHtml(pipeline.id) + '">'
    html += escapeHtml(state.pipelineLogs[pipeline.id] || (isActive ? 'Waiting for output...' : ''))
    html += '</pre>'
    html += '</div>'
  }

  html += '</div>' // end pl-detail-body

  return html
}

function renderPipelineActionButtons(pipeline) {
  let html = ''
  const runningStages = ['architect', 'dev', 'gate', 'fix-loop', 'ship']
  if (runningStages.includes(pipeline.state)) {
    html += '<button class="pl-action-btn pl-action-stop" data-action="stop">Stop</button>'
  }
  if (pipeline.state === 'error') {
    html += '<button class="pl-action-btn pl-action-retry" data-action="recover">Retry</button>'
  }
  if (pipeline.state === 'escalated') {
    html += '<button class="pl-action-btn pl-action-retry" data-action="retry-escalated">Retry</button>'
  }
  html += '<button class="pl-action-btn pl-action-delete" data-action="delete">Delete</button>'
  return html
}

function renderMobileStageBar(pipeline) {
  const currentIndex = PIPELINE_STAGE_ORDER.indexOf(pipeline.state)
  const terminalStates = ['completed', 'cancelled', 'escalated', 'error']

  let html = '<div class="pl-stage-bar">'
  for (let i = 0; i < PIPELINE_STAGE_ORDER.length; i++) {
    const stage = PIPELINE_STAGE_ORDER[i]
    let stageClass = ''

    if (terminalStates.includes(pipeline.state)) {
      if (pipeline.state === 'completed') {
        stageClass = 'completed'
      } else if (i <= currentIndex) {
        stageClass = i === currentIndex ? 'failed' : 'completed'
      }
    } else if (i < currentIndex) {
      stageClass = 'completed'
    } else if (i === currentIndex) {
      stageClass = pipeline.state.startsWith('checkpoint') ? 'waiting' : 'active'
    }

    html += '<div class="pl-stage ' + stageClass + '">'
    html += (PIPELINE_STAGE_LABELS[stage] || stage)
    html += '</div>'

    if (i < PIPELINE_STAGE_ORDER.length - 1) {
      html += '<span class="pl-stage-arrow">&rarr;</span>'
    }
  }
  html += '</div>'
  return html
}

function renderMobileCheckpointControls(pipeline) {
  if (pipeline.state !== 'checkpoint:arch') return ''

  let html = '<div class="pl-card pl-checkpoint-card">'
  html += '<div class="pl-card-title">Checkpoint: Architect Review</div>'
  html += '<div class="pl-checkpoint-btns">'
  html += '<button class="pl-ckpt-btn pl-ckpt-approve" data-action="approve">Approve</button>'
  html += '<button class="pl-ckpt-btn pl-ckpt-reject" data-action="reject">Reject</button>'
  html += '<button class="pl-ckpt-btn pl-ckpt-feedback" data-action="show-feedback">Feedback</button>'
  html += '</div>'
  html += '<textarea id="mobile-feedback-text" class="pl-feedback-textarea hidden" placeholder="Enter feedback for the architect..."></textarea>'
  html += '<button id="mobile-send-feedback" class="pl-ckpt-btn pl-ckpt-feedback hidden" data-action="send-feedback" style="margin-top:8px;width:100%;">Send Feedback</button>'
  html += '</div>'
  return html
}

function renderMobileReviewPoints(pipeline) {
  if (pipeline.state !== 'completed') return ''

  let html = '<div class="pl-card">'
  html += '<div class="pl-card-title">Address Review Points</div>'
  html += '<div class="pl-review-desc">Paste PR review comments to re-run dev &rarr; gate &rarr; ship.</div>'
  html += '<textarea id="mobile-review-points" class="pl-feedback-textarea" placeholder="Paste PR review comments here..."></textarea>'
  html += '<button class="pl-ckpt-btn pl-ckpt-feedback" data-action="review-points" style="margin-top:8px;width:100%;">Submit Review Points</button>'
  if (pipeline.reviewRounds) {
    html += '<div class="pl-review-rounds">Review rounds: ' + pipeline.reviewRounds + '</div>'
  }
  html += '</div>'
  return html
}

function renderMobileGateFailure(pipeline) {
  const gateResults = pipeline.gateResults
  if (!gateResults || gateResults.length === 0) return ''

  const failures = gateResults.filter(r => r.verdict === 'fail')
  if (failures.length === 0 && pipeline.state !== 'escalated') return ''

  const passCount = gateResults.filter(r => r.verdict === 'pass').length
  const failCount = failures.length
  const skipCount = gateResults.filter(r => r.verdict === 'skip').length

  let html = '<div class="pl-card pl-gate-card">'
  html += '<div class="pl-card-title">Gate Results</div>'
  html += '<div class="pl-gate-summary">' + passCount + ' passed, ' + failCount + ' failed, ' + skipCount + ' skipped</div>'

  for (const result of gateResults) {
    const vClass = result.verdict === 'pass' ? 'pass' : result.verdict === 'fail' ? 'fail' : 'skip'
    const icon = result.verdict === 'pass' ? '\u2713' : result.verdict === 'fail' ? '\u2717' : '\u2014'
    html += '<div class="pl-gate-check ' + vClass + '">'
    html += '<span class="pl-gate-icon">' + icon + '</span>'
    html += '<span class="pl-gate-name">' + escapeHtml(result.checkName) + '</span>'
    html += '<span class="pl-gate-verdict">' + result.verdict.toUpperCase() + '</span>'
    if (result.summary) {
      html += '<div class="pl-gate-check-summary">' + escapeHtml(result.summary) + '</div>'
    }
    html += '</div>'
  }

  html += '</div>'
  return html
}

function setupPipelineDetailHandlers(overlay, pipeline) {
  // Back button
  overlay.querySelector('.pl-detail-back').addEventListener('click', () => closePipelineDetail())

  // Action buttons
  overlay.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = e.currentTarget.dataset.action
      handlePipelineAction(action, pipeline.id)
    })
  })
}

function closePipelineDetail() {
  state.selectedPipeline = null
  const overlay = document.getElementById('pl-detail-overlay')
  if (overlay) {
    overlay.classList.remove('visible')
    setTimeout(() => overlay.remove(), 250)
  }
}

function refreshPipelineDetail() {
  if (!state.selectedPipeline) return
  const pipeline = state.pipelines.find(p => p.id === state.selectedPipeline)
  if (!pipeline) {
    closePipelineDetail()
    return
  }

  const overlay = document.getElementById('pl-detail-overlay')
  if (!overlay) return

  // Update in place rather than full re-render to preserve scroll position
  overlay.innerHTML = renderPipelineDetailHtml(pipeline)
  setupPipelineDetailHandlers(overlay, pipeline)
  fetchMobileTimeline(pipeline.id)
  if (pipeline.state === 'checkpoint:ship') {
    loadMobileShipReview(pipeline.id)
  }
}

// ============================================================================
// Pipeline Actions
// ============================================================================

async function handlePipelineAction(action, pipelineId) {
  switch (action) {
    case 'stop':
      await mobilePipelineStop(pipelineId)
      break
    case 'recover':
      await mobilePipelineRecover(pipelineId)
      break
    case 'delete':
      await mobilePipelineDelete(pipelineId)
      break
    case 'approve':
      await mobilePipelineApprove(pipelineId)
      break
    case 'reject':
      await mobilePipelineReject(pipelineId)
      break
    case 'show-feedback': {
      const ta = document.getElementById('mobile-feedback-text')
      const sendBtn = document.getElementById('mobile-send-feedback')
      if (ta) { ta.classList.toggle('hidden'); ta.focus() }
      if (sendBtn) sendBtn.classList.toggle('hidden')
      break
    }
    case 'send-feedback':
      await mobilePipelineFeedback(pipelineId)
      break
    case 'review-points':
      await mobilePipelineReviewPoints(pipelineId)
      break
    case 'ship-approve':
      await mobilePipelineApprove(pipelineId)
      break
    case 'show-ship-feedback': {
      const ta = document.getElementById('mobile-ship-feedback-text')
      const sendBtn = document.getElementById('mobile-send-ship-feedback')
      if (ta) { ta.classList.toggle('hidden'); ta.focus() }
      if (sendBtn) sendBtn.classList.toggle('hidden')
      break
    }
    case 'send-ship-feedback':
      await mobilePipelineShipFeedback(pipelineId)
      break
    case 'toggle-blueprint':
      toggleMobileBlueprint(pipelineId)
      break
    case 'retry-escalated':
      await mobilePipelineRetryEscalated(pipelineId)
      break
  }
}

async function mobilePipelineStop(pipelineId) {
  showConfirmSheet('Stop this pipeline?', 'You can retry it later.', async () => {
    showToast('Stopping...', 'info')
    try {
      const res = await fetch('/api/pipelines/' + pipelineId + '/stop', { method: 'POST' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Stop failed')
      }
      showToast('Pipeline stopped', 'success')
      await refreshPipelineData()
    } catch (err) {
      showToast('Stop failed: ' + err.message, 'error')
    }
  })
}

async function mobilePipelineRecover(pipelineId) {
  showToast('Retrying...', 'info')
  try {
    const res = await fetch('/api/pipelines/' + pipelineId + '/recover', { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Retry failed')
    }
    const updated = await res.json()
    showToast('Retrying from: ' + updated.state, 'success')
    await refreshPipelineData()
  } catch (err) {
    showToast('Retry failed: ' + err.message, 'error')
  }
}

async function mobilePipelineRetryEscalated(pipelineId) {
  showToast('Retrying with more fix loops...', 'info')
  try {
    const res = await fetch('/api/pipelines/' + pipelineId + '/retry-escalated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ additionalRetries: 3 }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Retry failed')
    }
    showToast('Pipeline retrying', 'success')
    await refreshPipelineData()
  } catch (err) {
    showToast('Retry failed: ' + err.message, 'error')
  }
}

async function mobilePipelineDelete(pipelineId) {
  showConfirmSheet('Delete this pipeline?', 'This cannot be undone.', async () => {
    showToast('Deleting...', 'info')
    try {
      const res = await fetch('/api/pipelines/' + pipelineId, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Delete failed')
      }
      showToast('Pipeline deleted', 'success')
      closePipelineDetail()
      await refreshPipelineData()
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error')
    }
  })
}

async function mobilePipelineApprove(pipelineId) {
  showToast('Approving...', 'info')
  try {
    const res = await fetch('/api/pipelines/' + pipelineId + '/approve', { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Approve failed')
    }
    showToast('Pipeline approved', 'success')
    await refreshPipelineData()
  } catch (err) {
    showToast('Approve failed: ' + err.message, 'error')
  }
}

async function mobilePipelineReject(pipelineId) {
  showConfirmSheet('Reject this pipeline?', 'This will cancel it.', async () => {
    showToast('Rejecting...', 'info')
    try {
      const res = await fetch('/api/pipelines/' + pipelineId + '/reject', { method: 'POST' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Reject failed')
      }
      showToast('Pipeline rejected', 'success')
      await refreshPipelineData()
    } catch (err) {
      showToast('Reject failed: ' + err.message, 'error')
    }
  })
}

async function mobilePipelineFeedback(pipelineId) {
  const textarea = document.getElementById('mobile-feedback-text')
  if (!textarea) return
  const feedback = textarea.value.trim()
  if (!feedback) {
    showToast('Please enter feedback', 'error')
    return
  }
  showToast('Sending feedback...', 'info')
  try {
    const res = await fetch('/api/pipelines/' + pipelineId + '/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Feedback failed')
    }
    showToast('Feedback sent', 'success')
    await refreshPipelineData()
  } catch (err) {
    showToast('Feedback failed: ' + err.message, 'error')
  }
}

async function mobilePipelineShipFeedback(pipelineId) {
  const textarea = document.getElementById('mobile-ship-feedback-text')
  if (!textarea) return
  const feedback = textarea.value.trim()
  if (!feedback) {
    showToast('Please describe changes needed', 'error')
    return
  }
  showToast('Sending ship feedback...', 'info')
  try {
    const res = await fetch('/api/pipelines/' + pipelineId + '/ship-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Feedback failed')
    }
    showToast('Feedback sent, re-running dev', 'success')
    await refreshPipelineData()
  } catch (err) {
    showToast('Ship feedback failed: ' + err.message, 'error')
  }
}

async function mobilePipelineReviewPoints(pipelineId) {
  const textarea = document.getElementById('mobile-review-points')
  if (!textarea) return
  const reviewPoints = textarea.value.trim()
  if (!reviewPoints) {
    showToast('Please paste review comments', 'error')
    return
  }
  showToast('Submitting review points...', 'info')
  try {
    const res = await fetch('/api/pipelines/' + pipelineId + '/review-points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewPoints }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Review points failed')
    }
    showToast('Review points submitted', 'success')
    await refreshPipelineData()
  } catch (err) {
    showToast('Review points failed: ' + err.message, 'error')
  }
}

// ============================================================================
// Confirmation Sheet (mobile-friendly alternative to confirm())
// ============================================================================

function showConfirmSheet(title, subtitle, onConfirm) {
  const existing = document.querySelector('.confirm-sheet-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'confirm-sheet-overlay'

  const sheet = document.createElement('div')
  sheet.className = 'confirm-sheet'
  sheet.innerHTML = `
    <div class="confirm-sheet-title">${escapeHtml(title)}</div>
    ${subtitle ? '<div class="confirm-sheet-subtitle">' + escapeHtml(subtitle) + '</div>' : ''}
    <div class="confirm-sheet-btns">
      <button class="btn-secondary confirm-sheet-cancel">Cancel</button>
      <button class="btn-primary confirm-sheet-ok" style="background:var(--state-error);">Confirm</button>
    </div>
  `

  overlay.appendChild(sheet)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })
  sheet.querySelector('.confirm-sheet-cancel').addEventListener('click', () => overlay.remove())
  sheet.querySelector('.confirm-sheet-ok').addEventListener('click', () => {
    overlay.remove()
    onConfirm()
  })

  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('visible'))
}

// ============================================================================
// Pipeline Timeline & Blueprint
// ============================================================================

async function fetchMobileTimeline(pipelineId) {
  const container = document.getElementById('mobile-timeline')
  if (!container) return

  try {
    const res = await fetch('/api/pipelines/' + pipelineId + '/progress')
    if (!res.ok) {
      container.innerHTML = '<div class="pl-empty-text">Failed to load activity</div>'
      return
    }
    const entries = await res.json()
    if (!entries || entries.length === 0) {
      container.innerHTML = '<div class="pl-empty-text">No activity yet</div>'
      return
    }
    container.innerHTML = renderMobileTimelineEntries(entries)
  } catch {
    container.innerHTML = '<div class="pl-empty-text">Failed to load activity</div>'
  }
}

function renderMobileTimelineEntries(entries) {
  const reversed = entries.slice().reverse()
  let html = ''
  for (let i = 0; i < reversed.length; i++) {
    const entry = reversed[i]
    const isNewest = (i === 0)
    html += renderMobileTimelineEntry(entry, isNewest)
  }
  return html
}

function renderMobileTimelineEntry(entry, isNewest) {
  const isActivity = entry.type === 'stage-activity'
  const isCompleted = entry.type === 'stage-complete' || entry.type === 'checkpoint' || entry.type === 'info'
  const isError = entry.type === 'stage-error'
  const isRunning = isNewest && (entry.type === 'stage-start' || entry.type === 'competing-start')

  let dotClass = 'pl-tl-dot'
  if (isActivity) dotClass += ' activity'
  else if (isRunning) dotClass += ' running'
  else if (isError) dotClass += ' error'
  else if (isCompleted) dotClass += ' completed'

  const timeStr = formatTimeOnly(entry.timestamp)

  let html = '<div class="pl-tl-entry' + (isActivity ? ' activity' : '') + (isError ? ' error' : '') + '">'
  html += '<div class="' + dotClass + '"></div>'
  html += '<div class="pl-tl-content">'
  html += '<span class="pl-tl-time">' + timeStr + '</span> '
  html += '<span class="pl-tl-title">' + escapeHtml(entry.title) + '</span>'
  if (entry.detail) {
    html += '<div class="pl-tl-detail">' + escapeHtml(entry.detail) + '</div>'
  }

  // Gate check cards
  if (entry.type === 'gate-result' && entry.data && entry.data.checks) {
    html += '<div class="pl-tl-checks">'
    for (const check of entry.data.checks) {
      const v = check.verdict || 'skip'
      const icon = v === 'pass' ? '\u2713' : v === 'fail' ? '\u2717' : '\u2014'
      html += '<span class="pl-tl-check ' + v + '">' + icon + ' ' + escapeHtml(check.checkName || check.name || '') + '</span>'
    }
    html += '</div>'
  }

  html += '</div>'
  html += '</div>'
  return html
}

function toggleMobileBlueprint(pipelineId) {
  const body = document.getElementById('mobile-blueprint-body')
  if (!body) return

  const header = body.previousElementSibling
  const arrow = header?.querySelector('.pl-collapsible-arrow')

  if (body.classList.contains('hidden')) {
    body.classList.remove('hidden')
    if (arrow) arrow.innerHTML = '&#9662;'
    // Lazy load on first expand
    if (!body.dataset.loaded) {
      body.dataset.loaded = '1'
      fetchMobileBlueprint(pipelineId)
    }
  } else {
    body.classList.add('hidden')
    if (arrow) arrow.innerHTML = '&#9656;'
  }
}

async function fetchMobileBlueprint(pipelineId) {
  const body = document.getElementById('mobile-blueprint-body')
  if (!body) return

  try {
    const res = await fetch('/api/pipelines/' + pipelineId + '/blueprint')
    if (!res.ok) {
      body.innerHTML = '<div class="pl-empty-text">Blueprint not available</div>'
      return
    }
    const bp = await res.json()
    body.innerHTML = renderMobileBlueprintHtml(bp)
  } catch {
    body.innerHTML = '<div class="pl-empty-text">Failed to load blueprint</div>'
  }
}

function renderMobileBlueprintHtml(bp) {
  let html = '<div class="pl-blueprint">'
  if (bp.approach) {
    html += '<div class="pl-bp-section"><strong>Approach</strong><p>' + escapeHtml(bp.approach) + '</p></div>'
  }
  if (bp.steps && bp.steps.length > 0) {
    html += '<div class="pl-bp-section"><strong>Steps</strong><ol>'
    for (const step of bp.steps) {
      if (typeof step === 'string') {
        html += '<li>' + escapeHtml(step) + '</li>'
      } else if (step && typeof step === 'object') {
        html += '<li><strong>' + escapeHtml(step.description || step.title || '') + '</strong>'
        if (step.details) html += '<br><span style="color:var(--text-secondary);font-size:12px;">' + escapeHtml(step.details) + '</span>'
        html += '</li>'
      }
    }
    html += '</ol></div>'
  }
  if (bp.filesToTouch && bp.filesToTouch.length > 0) {
    html += '<div class="pl-bp-section"><strong>Files</strong><div class="pl-bp-files">'
    for (const f of bp.filesToTouch) {
      const fname = typeof f === 'string' ? f : (f && (f.path || f.file || ''))
      html += '<code class="pl-bp-file">' + escapeHtml(fname) + '</code> '
    }
    html += '</div></div>'
  }
  if (bp.risks && bp.risks.length > 0) {
    html += '<div class="pl-bp-section"><strong>Risks</strong><ul>'
    for (const r of bp.risks) {
      if (typeof r === 'string') {
        html += '<li>' + escapeHtml(r) + '</li>'
      } else if (r && typeof r === 'object') {
        html += '<li>' + escapeHtml(r.risk || r.description || '') + '</li>'
      }
    }
    html += '</ul></div>'
  }
  html += '</div>'
  return html
}

// ============================================================================
// Ship Review (checkpoint:ship)
// ============================================================================

async function loadMobileShipReview(pipelineId) {
  const container = document.getElementById('mobile-ship-review')
  if (!container) return

  try {
    const [diffRes, summaryRes] = await Promise.all([
      fetch('/api/pipelines/' + pipelineId + '/diff').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/pipelines/' + pipelineId + '/ship-summary').then(r => r.ok ? r.json() : null).catch(() => null),
    ])

    const pipeline = state.pipelines.find(p => p.id === pipelineId)
    if (!pipeline) return

    let html = '<div class="pl-card-title">Ship Review</div>'

    // Summary
    if (summaryRes) {
      if (summaryRes.description) {
        html += '<div class="pl-ship-summary">' + escapeHtml(summaryRes.description) + '</div>'
      }
      if (summaryRes.changes && summaryRes.changes.length > 0) {
        html += '<div class="pl-ship-changes-title">Noteworthy Changes</div>'
        html += '<ul class="pl-ship-changes">'
        for (const c of summaryRes.changes) {
          html += '<li>' + escapeHtml(c) + '</li>'
        }
        html += '</ul>'
      }
    }

    // Diff stats
    if (diffRes) {
      html += '<div class="pl-ship-diff-stats">'
      html += (diffRes.filesChanged || 0) + ' file' + ((diffRes.filesChanged || 0) !== 1 ? 's' : '') + ' changed'
      html += ' &middot; <span style="color:var(--state-done)">+' + (diffRes.insertions || 0) + '</span>'
      html += ' <span style="color:var(--state-error)">-' + (diffRes.deletions || 0) + '</span>'
      html += '</div>'
    }

    // Approve / Request Changes buttons
    html += '<div class="pl-checkpoint-btns" style="margin-top:12px;">'
    html += '<button class="pl-ckpt-btn pl-ckpt-approve" data-action="ship-approve">Approve & Ship</button>'
    html += '<button class="pl-ckpt-btn pl-ckpt-feedback" data-action="show-ship-feedback">Request Changes</button>'
    html += '</div>'
    html += '<textarea id="mobile-ship-feedback-text" class="pl-feedback-textarea hidden" placeholder="Describe what changes are needed..."></textarea>'
    html += '<button id="mobile-send-ship-feedback" class="pl-ckpt-btn pl-ckpt-feedback hidden" data-action="send-ship-feedback" style="margin-top:8px;width:100%;">Send Ship Feedback</button>'

    container.innerHTML = html

    // Re-attach handlers for new buttons
    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        handlePipelineAction(e.currentTarget.dataset.action, pipelineId)
      })
    })
  } catch {
    container.innerHTML = '<div class="pl-card-title">Ship Review</div><div class="pl-empty-text">Failed to load review data</div>'
  }
}

// ============================================================================
// Pipeline WebSocket (real-time events)
// ============================================================================

function connectPipelineEvents() {
  if (state.pipelineWs) return // already connected

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}?mode=pipeline-events`

  try {
    state.pipelineWs = new WebSocket(wsUrl)
  } catch {
    return
  }

  state.pipelineWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)

      if (msg.type === 'pipeline:log' && msg.data) {
        const { id, stream, text } = msg.data
        if (stream === 'stderr') {
          if (!state.pipelineLogs[id]) state.pipelineLogs[id] = ''
          state.pipelineLogs[id] += text
          // Cap at 50KB on mobile
          if (state.pipelineLogs[id].length > 50000) {
            state.pipelineLogs[id] = '... (earlier output trimmed)\n' + state.pipelineLogs[id].slice(-40000)
          }
          // Update live log if viewing this pipeline
          const logEl = document.getElementById('mobile-live-log')
          if (logEl && logEl.dataset.pipelineId === id) {
            logEl.textContent = state.pipelineLogs[id]
            logEl.scrollTop = logEl.scrollHeight
          }
        }
      }

      if (msg.type === 'pipeline:state-change' && msg.data) {
        const existing = state.pipelines.find(p => p.id === msg.data.id)
        if (existing) {
          existing.state = msg.data.state
          existing.updatedAt = msg.data.updatedAt
        }
        // Clear log buffer on stage transitions
        const activeStages = ['architect', 'dev', 'gate', 'fix-loop', 'ship']
        if (activeStages.includes(msg.data.state)) {
          state.pipelineLogs[msg.data.id] = ''
        }
        // Re-render list and detail
        renderPipelineList()
        if (state.selectedPipeline === msg.data.id) {
          // Fetch full data and re-render detail
          fetchPipelines().then(pipelines => {
            state.pipelines = pipelines
            renderPipelineList()
            refreshPipelineDetail()
          })
        }
      }

      if (msg.type === 'pipeline:progress' && msg.data) {
        const { pipelineId, entry } = msg.data
        if (pipelineId && entry && state.selectedPipeline === pipelineId) {
          const container = document.getElementById('mobile-timeline')
          if (container) {
            const placeholder = container.querySelector('.pl-card-loading, .pl-empty-text')
            if (placeholder) placeholder.remove()
            // Prepend new entry
            const wrapper = document.createElement('div')
            wrapper.innerHTML = renderMobileTimelineEntry(entry, true)
            const newNode = wrapper.firstElementChild
            if (newNode) {
              container.insertBefore(newNode, container.firstChild)
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  state.pipelineWs.onclose = () => {
    state.pipelineWs = null
    // Reconnect if still on pipelines tab
    if (state.activeTab === 'pipelines') {
      setTimeout(connectPipelineEvents, 5000)
    }
  }

  state.pipelineWs.onerror = () => {
    // onclose fires after this
  }
}

function disconnectPipelineEvents() {
  if (state.pipelineWs) {
    state.pipelineWs.onclose = null
    state.pipelineWs.close()
    state.pipelineWs = null
  }
}

// ============================================================================
// Create Pipeline Sheet
// ============================================================================

function setupPipelineSheet() {
  const sheet = document.getElementById('pipeline-sheet')
  const backdrop = sheet.querySelector('.sheet-backdrop')
  const cancelBtn = document.getElementById('pl-create-cancel')
  const submitBtn = document.getElementById('pl-create-submit')
  const repoSelect = document.getElementById('pl-create-repo')
  const errorEl = document.getElementById('pl-create-error')

  function openSheet() {
    repoSelect.innerHTML = (state.instances || [])
      .map(i => `<option value="${escapeHtml(i.repoPath)}">${escapeHtml(i.instanceId || i.repoPath)}</option>`)
      .join('')
    document.getElementById('pl-create-title').value = ''
    document.getElementById('pl-create-desc').value = ''
    document.getElementById('pl-create-ac').value = ''
    document.getElementById('pl-create-branch').value = 'main'
    errorEl.classList.add('hidden')
    errorEl.textContent = ''
    sheet.classList.remove('hidden')
  }

  function closeSheet() {
    sheet.classList.add('hidden')
  }

  state._openPipelineSheet = openSheet

  cancelBtn.addEventListener('click', closeSheet)
  backdrop.addEventListener('click', closeSheet)

  submitBtn.addEventListener('click', async () => {
    const worktreePath = repoSelect.value
    if (!worktreePath) {
      errorEl.textContent = 'Please select a repository'
      errorEl.classList.remove('hidden')
      return
    }

    const title = document.getElementById('pl-create-title').value.trim()
    const description = document.getElementById('pl-create-desc').value.trim()
    if (!description) {
      errorEl.textContent = 'Description is required'
      errorEl.classList.remove('hidden')
      return
    }

    const acText = document.getElementById('pl-create-ac').value.trim()
    const acceptanceCriteria = acText ? acText.split('\n').map(l => l.trim()).filter(Boolean) : []
    const sourceBranch = document.getElementById('pl-create-branch').value.trim() || 'main'

    submitBtn.disabled = true
    submitBtn.textContent = 'Starting...'
    errorEl.classList.add('hidden')

    try {
      const res = await fetch('/api/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || undefined, description, acceptanceCriteria, sourceBranch, worktreePath }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to create pipeline')
      }

      const run = await res.json()
      showToast('Pipeline started: ' + (run.title || run.id), 'success')
      closeSheet()
      await refreshPipelineData()
      showPipelineDetail(run.id)
    } catch (err) {
      errorEl.textContent = err.message
      errorEl.classList.remove('hidden')
    } finally {
      submitBtn.disabled = false
      submitBtn.textContent = 'Start Pipeline'
    }
  })
}

// ============================================================================
// FAB button — context-aware
// ============================================================================

function setupFab() {
  const fab = document.getElementById('create-btn')
  fab.addEventListener('click', () => {
    if (state.activeTab === 'pipelines') {
      state._openPipelineSheet()
    } else {
      state._openSessionSheet()
    }
  })
}

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function formatTimeOnly(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch {
    return ''
  }
}

function formatTokens(count) {
  if (!count) return '0'
  if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M'
  if (count >= 1000) return (count / 1000).toFixed(0) + 'K'
  return String(count)
}

async function refreshPipelineData() {
  state.pipelines = await fetchPipelines()
  if (state.activeTab === 'pipelines') {
    renderPipelineList()
  }
  if (state.selectedPipeline) {
    refreshPipelineDetail()
  }
}

async function pollStatus() {
  await refresh()
}

// ============================================================================
// Main loop
// ============================================================================

async function refresh() {
  try {
    const [statusData, instances, pipelines] = await Promise.all([
      fetchStatus(),
      fetchInstances(),
      fetchPipelines(),
    ])

    const sessions = dedupeByTmux(statusData.sessions || [])
    state.instances = instances || []
    state.pipelines = pipelines || []

    checkStateChanges(sessions)

    // Update pipeline list if on pipelines tab
    const plFp = JSON.stringify(pipelines.map(p => p.id + ':' + p.state + ':' + p.updatedAt))
    if (plFp !== state.lastPipelinesJson) {
      state.lastPipelinesJson = plFp
      if (state.activeTab === 'pipelines') {
        renderPipelineList()
      }
    }

    // Sessions
    const fp = sessionsFingerprint(sessions)
    const changed = fp !== state.lastSessionsJson
    const prevSessions = state.sessions
    state.sessions = sessions
    state.lastSessionsJson = fp

    if (sessions.length === 0) {
      if (prevSessions.length !== 0 && state.activeTab === 'sessions') renderEmpty()
      return
    }

    // Clamp active index
    if (state.activeIndex >= sessions.length) state.activeIndex = sessions.length - 1
    if (state.activeIndex < 0) state.activeIndex = 0

    const activeSession = sessions[state.activeIndex]

    if (state.activeTab === 'sessions') {
      // Connect terminal if not connected yet or session changed
      const activeKey = getSessionKey(activeSession)
      if (state.activeSessionKey !== activeKey) {
        switchToSession(activeSession)
      } else if (changed) {
        // Just update the info bar (state/message might have changed)
        renderSessionInfo(activeSession)
      }

    }
  } catch (err) {
    console.error('[Mobile] Refresh failed:', err)
  }
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }

  setupKeyToolbar()
  setupCreateSheet()
  setupPipelineSheet()
  setupFab()

  document.getElementById('notif-btn').addEventListener('click', toggleNotifications)
  document.getElementById('refresh-btn').addEventListener('click', () => location.reload())

  // Tab switching
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  })

  await refresh()

  // Poll status every 5s (terminal output comes via WebSocket, no capture polling needed)
  state.statusInterval = setInterval(refresh, 5000)
}

init()
