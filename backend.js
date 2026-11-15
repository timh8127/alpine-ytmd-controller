// YTMD Controller: backend
//
// Talks to the Companion Server that is built into YouTube Music Desktop App
// (YTMD, https://github.com/ytmdesktop/ytmdesktop) on http://127.0.0.1:9863.
//
//   1. Pairing: YTMD hands out a 4-digit code, the user approves it inside
//      YTMD, and YTMD returns a key. The key is kept in this plugin's own data
//      folder so pairing happens only once.
//   2. Live state: the backend follows YTMD's realtime feed (Socket.IO over a
//      WebSocket) and publishes a trimmed player state on one channel.
//   3. Commands: the topbar widget sends playback commands, which are checked
//      against an allow-list and forwarded to YTMD's REST API.
//
// The backend has no dependencies. It uses Node's built-in fetch and WebSocket
// and handles the handful of Socket.IO packets it needs itself (see
// "Realtime feed" below). It only ever connects to 127.0.0.1.

'use strict'

const fs = require('fs')
const path = require('path')

const PLUGIN_ID = 'monkey-creations.ytmd-controller'
const CHANNEL = PLUGIN_ID + '/state'

const ORIGIN = 'http://127.0.0.1:9863'
const API = ORIGIN + '/api/v1'
const REALTIME_URL = 'ws://127.0.0.1:9863/socket.io/?EIO=4&transport=websocket'
const REALTIME_NAMESPACE = '/api/v1/realtime'

// How this plugin appears in YTMD under Settings > Integrations > Authorized companions.
const APP_ID = 'alpine-ytmd-controller'
const APP_NAME = 'Alpine Shell YTMD Controller'

const TOKEN_FILE = 'ytmd-token.json'
const RETRY_MIN_MS = 2000
const RETRY_MAX_MS = 15000
const PUBLISH_EVERY_MS = 250
const UP_NEXT_COUNT = 6

// YTMD allows 2 commands per second per app.
const COMMANDS_PER_SECOND = 2

// Commands the widget may send, with a check for their data.
const isIndex = (v) => Number.isInteger(v) && v >= 0
const ALLOWED_COMMANDS = {
  playPause: null,
  play: null,
  pause: null,
  next: null,
  previous: null,
  volumeUp: null,
  volumeDown: null,
  mute: null,
  unmute: null,
  shuffle: null,
  toggleLike: null,
  toggleDislike: null,
  setVolume: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
  seekTo: (v) => Number.isFinite(v) && v >= 0,
  repeatMode: (v) => v === 0 || v === 1 || v === 2,
  playQueueIndex: isIndex,
}

// Friendly text for the error codes YTMD's API returns.
const ERROR_TEXT = {
  AUTHORIZATION_DISABLED:
    'YTMD is not accepting new connections. In YTMD open Settings > Integrations, turn on "Enable companion authorization", then try again.',
  AUTHORIZATION_DENIED: 'The request was denied in YTMD, or nobody answered it within 30 seconds.',
  AUTHORIZATION_TIME_OUT: 'YTMD took too long to answer. Try again.',
  AUTHORIZATION_INVALID: 'The pairing code expired. Try again.',
  AUTHORIZATION_TOO_MANY: 'YTMD has too many open connection requests. Close them and try again.',
  UNAUTHENTICATED: 'YTMD no longer accepts this plugin. Connect again.',
  YOUTUBE_MUSIC_UNVAILABLE: 'YouTube Music is not ready yet.',
  YOUTUBE_MUSIC_TIME_OUT: 'YouTube Music took too long to answer.',
}

function explainError(res) {
  const body = res && res.data
  if (body && ERROR_TEXT[body.code]) return ERROR_TEXT[body.code]
  if (res && res.status === 429) return 'Too many requests to YTMD. Wait a moment and try again.'
  if (body && typeof body.message === 'string' && body.message) return 'YTMD: ' + body.message
  return 'YTMD answered with an error' + (res && res.status ? ' (' + res.status + ').' : '.')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------

// Smallest thumbnail at least `size` pixels wide, or the largest one there is.
function pickThumbnail(thumbnails, size) {
  if (!Array.isArray(thumbnails)) return null
  const sorted = thumbnails.filter((t) => t && typeof t.url === 'string').sort((a, b) => (a.width || 0) - (b.width || 0))
  if (!sorted.length) return null
  const fit = sorted.find((t) => (t.width || 0) >= size)
  return (fit || sorted[sorted.length - 1]).url
}

function upNextFrom(queue) {
  if (!queue || !Array.isArray(queue.items)) return []
  const out = []
  const start = (Number.isInteger(queue.selectedItemIndex) ? queue.selectedItemIndex : -1) + 1
  for (let i = Math.max(0, start); i < queue.items.length && out.length < UP_NEXT_COUNT; i++) {
    const item = queue.items[i]
    if (!item || !item.title) continue
    out.push({
      index: i,
      title: item.title,
      author: item.author || '',
      duration: item.duration || '',
      thumbnail: pickThumbnail(item.thumbnails, 60),
    })
  }
  return out
}

// Turns YTMD's state (see transformPlayerState in YTMD's companion server)
// into the smaller shape the widget draws.
function toPlayer(state) {
  const player = (state && state.player) || {}
  const queue = player.queue || null
  const video = state && state.video
  return {
    trackState: typeof player.trackState === 'number' ? player.trackState : -1, // -1 unknown, 0 paused, 1 playing, 2 buffering
    progress: Number(player.videoProgress) || 0,
    progressAt: Date.now(),
    volume: typeof player.volume === 'number' ? Math.round(player.volume) : 0,
    muted: player.muted === true,
    adPlaying: player.adPlaying === true,
    repeatMode: queue && typeof queue.repeatMode === 'number' ? queue.repeatMode : -1, // -1 unknown, 0 off, 1 all, 2 one
    shuffle: !!(queue && queue.shuffleEnabled),
    track: video
      ? {
          id: video.id || null,
          title: video.title || '',
          author: video.author || '',
          album: video.album || null,
          likeStatus: typeof video.likeStatus === 'number' ? video.likeStatus : -1, // -1 unknown, 0 disliked, 1 neutral, 2 liked
          duration: Number(video.durationSeconds) || 0,
          isLive: video.isLive === true,
          artwork: pickThumbnail(video.thumbnails, 180),
        }
      : null,
    upNext: upNextFrom(queue),
  }
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

module.exports = function start(ctx) {
  const appVersion = readPluginVersion(ctx.pluginDir)
  const tokenPath = path.join(ctx.dataDir, TOKEN_FILE)

  let token = readToken(tokenPath)
  let stopped = false

  // What the widget sees. `status` is one of:
  //   connecting  - a saved key exists and the backend is connecting to YTMD
  //   connected   - live; `player` holds the current state
  //   offline     - YTMD is not running, or its Companion server is off
  //   unpaired    - YTMD is running but this plugin is not connected to it yet
  //   pairing     - waiting for the user to approve `code` inside YTMD
  const view = { status: token ? 'connecting' : 'offline', message: null, code: null, player: null }

  let publishTimer = null
  let lastPublishAt = 0

  function publishNow() {
    publishTimer = null
    lastPublishAt = Date.now()
    ctx.publish(CHANNEL, { ...view, paired: !!token, updatedAt: lastPublishAt })
  }

  // YTMD sends updates many times a second while playing; pass on at most 4.
  function publishSoon() {
    if (publishTimer || stopped) return
    publishTimer = setTimeout(publishNow, Math.max(0, PUBLISH_EVERY_MS - (Date.now() - lastPublishAt)))
  }

  function setView(patch) {
    if (patch.status && patch.status !== view.status && !('message' in patch)) patch.message = null
    Object.assign(view, patch)
    if (view.status !== 'connected') view.player = null
    if (view.status !== 'pairing') view.code = null
    publishSoon()
  }

  // --- HTTP -----------------------------------------------------------------

  async function request(method, route, body, timeoutMs) {
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = token
    const res = await fetch(route.startsWith('http') ? route : API + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || 5000),
    })
    const text = await res.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    return { ok: res.ok, status: res.status, data }
  }

  async function isYtmdReachable() {
    try {
      const res = await request('GET', ORIGIN + '/metadata', undefined, 2000)
      return res.ok
    } catch {
      return false
    }
  }

  // --- Key storage ----------------------------------------------------------

  function saveToken(value) {
    token = value
    try {
      fs.mkdirSync(ctx.dataDir, { recursive: true })
      fs.writeFileSync(tokenPath, JSON.stringify({ token: value, savedAt: new Date().toISOString() }), { mode: 0o600 })
    } catch (e) {
      ctx.log('could not save the YTMD key: ' + e.message)
    }
  }

  function forgetToken(message) {
    token = null
    try {
      fs.rmSync(tokenPath, { force: true })
    } catch {}
    closeRealtime()
    setView({ status: 'unpaired', message: message || null })
    scheduleCheck(RETRY_MIN_MS)
  }

  // --- Realtime feed ----------------------------------------------------------
  //
  // YTMD runs Socket.IO v4 with the WebSocket transport only. The packets used:
  //   from YTMD  0{"pingInterval":...}                    Engine.IO open
  //   to YTMD    40/api/v1/realtime,{"token":"..."}       join the namespace with our key
  //   from YTMD  40/api/v1/realtime,{"sid":"..."}         joined
  //   from YTMD  44/api/v1/realtime,{"message":"..."}     refused (bad key)
  //   from YTMD  42/api/v1/realtime,["state-update",{..}] player state changed
  //   from YTMD  2  /  to YTMD 3                          heartbeat ping / pong

  let socket = null
  let heartbeatTimer = null
  let heartbeatWindowMs = 45000
  let retryTimer = null
  let retryDelay = RETRY_MIN_MS

  function armHeartbeat(ws) {
    clearTimeout(heartbeatTimer)
    heartbeatTimer = setTimeout(() => {
      ctx.log('YTMD realtime feed went quiet; reconnecting')
      ws.close()
    }, heartbeatWindowMs)
  }

  function closeRealtime() {
    clearTimeout(heartbeatTimer)
    const ws = socket
    socket = null
    if (ws) {
      try {
        ws.close()
      } catch {}
    }
  }

  function connectRealtime() {
    closeRealtime()
    if (!token || stopped) return
    if (typeof WebSocket !== 'function') {
      // Very old runtimes have no WebSocket; fall back to polling.
      pollState()
      return
    }
    if (view.status !== 'connected') setView({ status: 'connecting' })

    const ws = new WebSocket(REALTIME_URL)
    socket = ws

    ws.onmessage = (event) => {
      if (socket !== ws || typeof event.data !== 'string') return
      try {
        onEnginePacket(ws, event.data)
      } catch (e) {
        ctx.log('could not read a realtime packet: ' + e.message)
      }
    }
    ws.onerror = () => {
      // A close event always follows; handled there.
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      clearTimeout(heartbeatTimer)
      onRealtimeLost()
    }
  }

  function onEnginePacket(ws, text) {
    const type = text[0]
    if (type === '0') {
      const info = JSON.parse(text.slice(1))
      heartbeatWindowMs = (Number(info.pingInterval) || 25000) + (Number(info.pingTimeout) || 20000)
      armHeartbeat(ws)
      ws.send('40' + REALTIME_NAMESPACE + ',' + JSON.stringify({ token }))
    } else if (type === '2') {
      ws.send('3')
      armHeartbeat(ws)
    } else if (type === '4') {
      onSocketPacket(ws, text.slice(1))
    } else if (type === '1') {
      ws.close()
    }
  }

  function onSocketPacket(ws, text) {
    const type = text[0]
    let rest = text.slice(1)
    if (!rest.startsWith(REALTIME_NAMESPACE)) return
    rest = rest.slice(REALTIME_NAMESPACE.length).replace(/^,/, '').replace(/^\d+/, '')

    if (type === '0') {
      retryDelay = RETRY_MIN_MS
      setView({ status: 'connected' })
      fetchState()
    } else if (type === '4') {
      // YTMD only refuses the namespace when the key is missing or unknown.
      forgetToken(ERROR_TEXT.UNAUTHENTICATED)
    } else if (type === '2') {
      const [event, data] = JSON.parse(rest)
      if (event === 'state-update') onState(data)
    } else if (type === '1') {
      ws.close()
    }
  }

  function onState(state) {
    if (view.status !== 'connected') return
    view.player = toPlayer(state)
    publishSoon()
  }

  // The feed only sends changes, so ask once for the state after connecting.
  // YTMD allows one /state request per 5 seconds, so wait and retry on 429.
  let fetchRetryTimer = null
  async function fetchState() {
    clearTimeout(fetchRetryTimer)
    try {
      const res = await request('GET', '/state')
      if (res.ok && res.data) onState(res.data)
      else if (res.status === 401) forgetToken(ERROR_TEXT.UNAUTHENTICATED)
      else if (res.status === 429 && view.status === 'connected') fetchRetryTimer = setTimeout(fetchState, 5500)
    } catch {}
  }

  function onRealtimeLost() {
    if (stopped || !token) return
    setView({ status: 'offline' })
    scheduleCheck(retryDelay)
    retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.5))
  }

  // Fallback without WebSocket: YTMD allows one /state request per 5 seconds.
  let pollTimer = null
  async function pollState() {
    clearTimeout(pollTimer)
    if (stopped || !token) return
    try {
      const res = await request('GET', '/state')
      if (res.ok && res.data) {
        if (view.status !== 'connected') setView({ status: 'connected' })
        onState(res.data)
      } else if (res.status === 401) {
        forgetToken(ERROR_TEXT.UNAUTHENTICATED)
        return
      }
    } catch {
      setView({ status: 'offline' })
    }
    pollTimer = setTimeout(pollState, 5500)
  }

  // --- Connection loop --------------------------------------------------------

  function scheduleCheck(delay) {
    clearTimeout(retryTimer)
    if (!stopped) retryTimer = setTimeout(check, delay)
  }

  async function check() {
    if (stopped || pairing) return
    if (token) {
      if (!socket) connectRealtime()
      return
    }
    // Not paired yet: tell the widget whether YTMD is there to pair with.
    const reachable = await isYtmdReachable()
    if (!token && !pairing) setView({ status: reachable ? 'unpaired' : 'offline' })
    scheduleCheck(reachable ? RETRY_MAX_MS : RETRY_MAX_MS / 2)
  }

  // --- Pairing ----------------------------------------------------------------

  let pairing = false

  async function startPairing() {
    // With a saved key there is nothing to pair; "forget" drops the key first.
    if (pairing || token) return
    pairing = true
    clearTimeout(retryTimer)
    setView({ status: 'pairing', message: 'Asking YTMD for a code...' })
    try {
      let res
      try {
        res = await request('POST', '/auth/requestcode', { appId: APP_ID, appName: APP_NAME, appVersion }, 10000)
      } catch {
        return setView({ status: 'offline', message: 'YTMD is not running, or its Companion server is turned off.' })
      }
      if (!res.ok || !res.data || !res.data.code) return setView({ status: 'unpaired', message: explainError(res) })

      const code = String(res.data.code)
      setView({ status: 'pairing', code, message: 'YTMD opened a window. Check that it shows ' + code + ' and allow it.' })

      try {
        // YTMD keeps this request open until the user answers (30 seconds at most).
        res = await request('POST', '/auth/request', { appId: APP_ID, code }, 45000)
      } catch {
        return setView({ status: 'unpaired', message: 'YTMD did not answer. Try again.' })
      }
      if (!res.ok || !res.data || !res.data.token) return setView({ status: 'unpaired', message: explainError(res) })

      saveToken(String(res.data.token))
      closeRealtime()
      retryDelay = RETRY_MIN_MS
      setView({ status: 'connecting', message: null })
    } finally {
      pairing = false
      scheduleCheck(0)
    }
  }

  // --- Commands ---------------------------------------------------------------

  // Commands go out in order, at most COMMANDS_PER_SECOND per second. Repeated
  // setVolume or seekTo commands that are still waiting are merged, so dragging
  // a slider sends only the latest value.
  const commandQueue = []
  const sentAt = []
  let sending = false

  function queueCommand(command, data) {
    return new Promise((resolve, reject) => {
      if (command === 'setVolume' || command === 'seekTo') {
        const waiting = commandQueue.find((c) => c.command === command)
        if (waiting) {
          waiting.data = data
          waiting.waiters.push({ resolve, reject })
          return
        }
      }
      commandQueue.push({ command, data, waiters: [{ resolve, reject }] })
      sendQueued()
    })
  }

  async function sendQueued() {
    if (sending) return
    sending = true
    try {
      while (commandQueue.length && !stopped) {
        while (sentAt.length && Date.now() - sentAt[0] >= 1000) sentAt.shift()
        if (sentAt.length >= COMMANDS_PER_SECOND) {
          await sleep(1000 - (Date.now() - sentAt[0]) + 10)
          continue
        }
        const item = commandQueue.shift()
        sentAt.push(Date.now())
        try {
          await sendCommand(item.command, item.data)
          item.waiters.forEach((w) => w.resolve(true))
        } catch (e) {
          item.waiters.forEach((w) => w.reject(e))
        }
      }
    } finally {
      sending = false
    }
  }

  async function sendCommand(command, data) {
    if (!token) throw new Error('Not connected to YTMD.')
    let res
    try {
      res = await request('POST', '/command', data === undefined ? { command } : { command, data })
    } catch {
      throw new Error('YTMD is not reachable.')
    }
    if (res.status === 401) {
      forgetToken(ERROR_TEXT.UNAUTHENTICATED)
      throw new Error(ERROR_TEXT.UNAUTHENTICATED)
    }
    if (!res.ok) throw new Error(explainError(res))
  }

  function control(payload) {
    const command = payload && payload.command
    if (typeof command !== 'string' || !Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, command)) {
      throw new Error('Unknown YTMD command: ' + command)
    }
    const check = ALLOWED_COMMANDS[command]
    if (check && !check(payload.data)) throw new Error('Invalid value for ' + command)
    if (view.status !== 'connected') throw new Error('Not connected to YTMD.')
    return queueCommand(command, check ? payload.data : undefined)
  }

  ctx.onCommand(async (name, payload) => {
    if (name === 'control') return control(payload)
    if (name === 'pair') {
      startPairing().catch((e) => ctx.log('pairing failed: ' + e.message))
      return true
    }
    if (name === 'forget') {
      forgetToken(null)
      return true
    }
    if (name === 'retry') {
      retryDelay = RETRY_MIN_MS
      scheduleCheck(0)
      return true
    }
    throw new Error('Unknown command: ' + name)
  })

  ctx.onStop(() => {
    stopped = true
    clearTimeout(retryTimer)
    clearTimeout(pollTimer)
    clearTimeout(publishTimer)
    clearTimeout(fetchRetryTimer)
    closeRealtime()
  })

  publishNow()
  scheduleCheck(0)
}

function readPluginVersion(pluginDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'))
    if (typeof manifest.version === 'string') return manifest.version
  } catch {}
  return '1.0.0'
}

function readToken(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof saved.token === 'string' && saved.token ? saved.token : null
  } catch {
    return null
  }
}
