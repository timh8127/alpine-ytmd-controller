// YTMD Controller: renderer
//
// Draws the topbar widget (the track, artwork and playback buttons), the popup
// that opens from it (seek bar, like/dislike, shuffle, repeat, volume, Up next)
// and a settings page for connecting to YTMD. All data comes from backend.js
// on one channel; every button sends a command back to it.

const { html, useState, useEffect, useRef, useDarkText, usePluginData, usePluginSetting, sendCommand, PopupMenu } =
  window.alpine

const PLUGIN_ID = 'monkey-creations.ytmd-controller'
const CHANNEL = PLUGIN_ID + '/state'
const INITIAL_VIEW = { status: 'connecting', paired: false, message: null, code: null, player: null }

const TRACK_PLAYING = 1
const REPEAT_OFF = 0
const REPEAT_ALL = 1
const REPEAT_ONE = 2
const LIKED = 2
const DISLIKED = 0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function control(command, data) {
  const payload = data === undefined ? { command } : { command, data }
  return sendCommand(PLUGIN_ID, 'control', payload).then((result) => {
    if (result && !result.ok) console.warn('[ytmd-controller] ' + command + ': ' + result.error)
    return result
  })
}

function backend(name) {
  return sendCommand(PLUGIN_ID, name, null)
}

function useView() {
  return usePluginData(CHANNEL, INITIAL_VIEW) || INITIAL_VIEW
}

function useSetting(key, fallback) {
  const [value] = usePluginSetting(PLUGIN_ID, key)
  return value === undefined || value === null ? fallback : value
}

// Text colour on the topbar and in its popups.
function useInk() {
  const base = useDarkText() ? '0,0,0' : '255,255,255'
  return (alpha) => 'rgba(' + base + ',' + alpha + ')'
}

// A shade of the current text colour, so the same parts work on any surface.
function tint(percent) {
  return 'color-mix(in srgb, currentColor ' + percent + '%, transparent)'
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s
}

// The backend publishes the position a few times a second at most; between
// updates, move it on locally while the track is playing.
function useNow(active) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function livePosition(player, now) {
  const duration = player.track ? player.track.duration : 0
  let position = player.progress
  if (player.trackState === TRACK_PLAYING) position += Math.max(0, (now - player.progressAt) / 1000)
  return duration > 0 ? Math.min(position, duration) : position
}

const ellipsis = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }

const buttonReset = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  transition: 'background-color 120ms ease, opacity 120ms ease',
}

// ---------------------------------------------------------------------------
// Icons (24x24, drawn for this plugin)
// ---------------------------------------------------------------------------

const ICONS = {
  play: { solid: true, d: 'M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z' },
  pause: { solid: true, d: 'M7.5 5h2.8a.7.7 0 0 1 .7.7v12.6a.7.7 0 0 1-.7.7H7.5a.7.7 0 0 1-.7-.7V5.7a.7.7 0 0 1 .7-.7zm6.2 0h2.8a.7.7 0 0 1 .7.7v12.6a.7.7 0 0 1-.7.7h-2.8a.7.7 0 0 1-.7-.7V5.7a.7.7 0 0 1 .7-.7z' },
  next: { solid: true, d: 'M5 6.2v11.6a.9.9 0 0 0 1.42.74l8.2-5.8a.9.9 0 0 0 0-1.48l-8.2-5.8A.9.9 0 0 0 5 6.2zM16.6 5h1.8a.6.6 0 0 1 .6.6v12.8a.6.6 0 0 1-.6.6h-1.8a.6.6 0 0 1-.6-.6V5.6a.6.6 0 0 1 .6-.6z' },
  previous: { solid: true, d: 'M19 6.2v11.6a.9.9 0 0 1-1.42.74l-8.2-5.8a.9.9 0 0 1 0-1.48l8.2-5.8A.9.9 0 0 1 19 6.2zM7.4 5H5.6a.6.6 0 0 0-.6.6v12.8a.6.6 0 0 0 .6.6h1.8a.6.6 0 0 0 .6-.6V5.6a.6.6 0 0 0-.6-.6z' },
  shuffle: { d: 'M3 7h3c2.2 0 3.3 1.2 4.5 3l3 4c1.2 1.8 2.3 3 4.5 3h3M3 17h3c1.4 0 2.4-.5 3.2-1.3M14.8 8.3C15.6 7.5 16.6 7 18 7h3M18 4l3 3-3 3M18 14l3 3-3 3' },
  repeat: { d: 'M17 3l3 3-3 3M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M7 21l-3-3 3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4' },
  like: { d: 'M7 11v9H4.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7zm0 0 3.6-7.2a1.6 1.6 0 0 1 3 1.1L12.8 9h5.4a2 2 0 0 1 2 2.4l-1.3 6.8a2 2 0 0 1-2 1.6H7z' },
  volume: { d: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11' },
  volumeMuted: { d: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5' },
  music: { d: 'M9 18V5.5l11-2V16M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z' },
}

function Icon({ name, size = 16, filled = false, badge = null, style }) {
  const icon = ICONS[name]
  return html`
    <svg
      width=${size}
      height=${size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill=${icon.solid || filled ? 'currentColor' : 'none'}
      stroke=${icon.solid ? 'none' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style=${{ display: 'block', flex: 'none', ...style }}
    >
      <path d=${icon.d} />
      ${badge &&
      html`<text x="12" y="14.5" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none">${badge}</text>`}
    </svg>
  `
}

function IconButton({ icon, label, onClick, size = 24, iconSize = 15, active = false, toggle = false, filled = false, badge = null, flip = false, disabled = false, strong = false }) {
  const [hover, setHover] = useState(false)
  const background = disabled ? 'transparent' : hover ? tint(strong ? 26 : 16) : strong ? tint(14) : active ? tint(10) : 'transparent'
  return html`
    <button
      type="button"
      title=${label}
      aria-label=${label}
      aria-pressed=${toggle ? String(active) : undefined}
      disabled=${disabled}
      onClick=${(event) => {
        event.stopPropagation()
        if (!disabled && onClick) onClick()
      }}
      onMouseEnter=${() => setHover(true)}
      onMouseLeave=${() => setHover(false)}
      style=${{
        ...buttonReset,
        width: size + 'px',
        height: size + 'px',
        borderRadius: strong ? '999px' : '6px',
        background,
        opacity: disabled ? 0.3 : toggle && !active ? 0.55 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <${Icon} name=${icon} size=${iconSize} filled=${filled} badge=${badge} style=${flip ? { transform: 'rotate(180deg)' } : undefined} />
    </button>
  `
}

function TextButton({ label, onClick, disabled = false }) {
  const [hover, setHover] = useState(false)
  return html`
    <button
      type="button"
      disabled=${disabled}
      onClick=${(event) => {
        event.stopPropagation()
        if (!disabled && onClick) onClick()
      }}
      onMouseEnter=${() => setHover(true)}
      onMouseLeave=${() => setHover(false)}
      style=${{
        ...buttonReset,
        padding: '6px 14px',
        borderRadius: '8px',
        fontSize: '12px',
        fontWeight: 600,
        background: tint(hover && !disabled ? 24 : 14),
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      ${label}
    </button>
  `
}

function Artwork({ url, size, radius }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  const box = {
    width: size + 'px',
    height: size + 'px',
    borderRadius: radius + 'px',
    flex: 'none',
    overflow: 'hidden',
    background: tint(12),
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
  if (!url || failed) {
    return html`<div style=${box}><${Icon} name="music" size=${Math.max(10, Math.round(size * 0.5))} style=${{ opacity: 0.6 }} /></div>`
  }
  return html`<img src=${url} alt="" draggable=${false} referrerPolicy="no-referrer" onError=${() => setFailed(true)} style=${{ ...box, objectFit: 'cover' }} />`
}

// ---------------------------------------------------------------------------
// Topbar widget
// ---------------------------------------------------------------------------

// Scrolling over the widget changes the volume in steps of 5.
function useWheelVolume(player) {
  const target = useRef(null)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (event) => {
    if (!player || !event.deltaY) return
    const from = target.current !== null ? target.current : player.volume
    const to = clamp(from + (event.deltaY < 0 ? 5 : -5), 0, 100)
    target.current = to
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      target.current = null
    }, 1500)
    if (to !== from) control('setVolume', to)
  }
}

function TrackSummary({ player, showArtwork, trackText, textWidth, buttons }) {
  const track = player.track
  const playing = player.trackState === TRACK_PLAYING
  const showText = trackText !== 'none'
  return html`
    <div style=${{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
      ${showArtwork && html`<${Artwork} url=${track.artwork} size=${16} radius=${3} />`}
      ${showText &&
      html`
        <span style=${{ ...ellipsis, maxWidth: textWidth + 'px', opacity: playing ? 1 : 0.65 }} title=${track.title + (track.author ? ' - ' + track.author : '')}>
          <span style=${{ fontWeight: 500 }}>${track.title}</span>
          ${trackText === 'title-artist' && track.author && html`<span style=${{ opacity: 0.6 }}>${' · ' + track.author}</span>`}
        </span>
      `}
      ${buttons !== 'none' &&
      html`
        <div style=${{ display: 'flex', alignItems: 'center', gap: '1px' }}>
          ${buttons === 'all' && html`<${IconButton} icon="previous" label="Previous" size=${20} iconSize=${12} onClick=${() => control('previous')} />`}
          <${IconButton} icon=${playing ? 'pause' : 'play'} label=${playing ? 'Pause' : 'Play'} size=${20} iconSize=${13} onClick=${() => control('playPause')} />
          ${buttons === 'all' && html`<${IconButton} icon="next" label="Next" size=${20} iconSize=${12} onClick=${() => control('next')} />`}
        </div>
      `}
    </div>
  `
}

function IdleSummary({ view }) {
  let label = null
  if (view.status === 'pairing' && view.code) label = 'Code ' + view.code
  else if (view.status === 'unpaired') label = 'Connect YTMD'
  const dim = view.status === 'offline' || view.status === 'connecting'
  return html`
    <div style=${{ display: 'flex', alignItems: 'center', gap: '6px', opacity: dim ? 0.55 : 0.9 }}>
      <${Icon} name="music" size=${14} />
      ${label && html`<span>${label}</span>`}
    </div>
  `
}

export default function YtmdWidget() {
  const ink = useInk()
  const view = useView()
  const showArtwork = useSetting('showArtwork', true)
  const trackText = useSetting('trackText', 'title-artist')
  const textWidth = useSetting('textWidth', 180)
  const buttons = useSetting('topbarButtons', 'all')
  const scrollVolume = useSetting('scrollVolume', true)
  const hideWhenClosed = useSetting('hideWhenClosed', false)
  const onWheel = useWheelVolume(view.status === 'connected' ? view.player : null)

  if (hideWhenClosed && view.status === 'offline') return null

  const player = view.status === 'connected' ? view.player : null
  const summary =
    player && player.track
      ? html`<${TrackSummary} player=${player} showArtwork=${showArtwork} trackText=${trackText} textWidth=${textWidth} buttons=${buttons} />`
      : html`<${IdleSummary} view=${view} />`

  const trigger = html`
    <div
      onWheel=${scrollVolume && player ? onWheel : undefined}
      style=${{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 8px', color: ink(0.92), fontSize: '12px', lineHeight: '16px', whiteSpace: 'nowrap', userSelect: 'none' }}
    >
      ${summary}
    </div>
  `
  return html`<${PopupMenu} trigger=${trigger}><${Panel} view=${view} ink=${ink} /><//>`
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

function Panel({ view, ink }) {
  const showUpNext = useSetting('showUpNext', true)
  const player = view.status === 'connected' ? view.player : null
  let body
  if (player && player.track) body = html`<${NowPlaying} player=${player} showUpNext=${showUpNext} />`
  else if (view.status === 'connected') body = html`<${Note} title="Nothing is playing" text="Start something in YouTube Music Desktop and it shows up here." />`
  else body = html`<${ConnectionCard} view=${view} />`
  return html`
    <div style=${{ width: '300px', boxSizing: 'border-box', padding: '12px 14px 14px', color: ink(0.92), fontSize: '12px', lineHeight: 1.4 }}>
      ${body}
    </div>
  `
}

function NowPlaying({ player, showUpNext }) {
  const track = player.track
  const now = useNow(player.trackState === TRACK_PLAYING)
  const position = livePosition(player, now)
  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style=${{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <${Artwork} url=${track.artwork} size=${72} radius=${8} />
        <div style=${{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 }}>
          <div
            title=${track.title}
            style=${{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
          >
            ${track.title}
          </div>
          ${track.author && html`<div style=${{ ...ellipsis, color: tint(72) }} title=${track.author}>${track.author}</div>`}
          ${track.album && html`<div style=${{ ...ellipsis, color: tint(50) }} title=${track.album}>${track.album}</div>`}
          ${player.adPlaying && html`<div style=${{ color: tint(50), fontSize: '11px' }}>Ad playing</div>`}
        </div>
      </div>
      <${SeekBar}
        position=${position}
        duration=${track.duration}
        live=${track.isLive}
        disabled=${track.isLive || player.adPlaying || !track.duration}
      />
      <${Transport} player=${player} />
      <${VolumeRow} player=${player} />
      ${showUpNext && player.upNext.length > 0 && html`<${UpNext} items=${player.upNext} />`}
    </div>
  `
}

function SeekBar({ position, duration, live, disabled }) {
  const [hover, setHover] = useState(null)
  const bar = useRef(null)
  const ratio = duration > 0 ? clamp(position / duration, 0, 1) : 0

  function ratioAt(event) {
    const rect = bar.current.getBoundingClientRect()
    return rect.width ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0
  }

  return html`
    <div>
      <div
        ref=${bar}
        role="slider"
        aria-label="Seek"
        aria-valuemin="0"
        aria-valuemax=${Math.round(duration)}
        aria-valuenow=${Math.round(position)}
        onClick=${disabled ? undefined : (event) => control('seekTo', Math.round(ratioAt(event) * duration))}
        onMouseMove=${disabled ? undefined : (event) => setHover(ratioAt(event))}
        onMouseLeave=${() => setHover(null)}
        style=${{ height: '14px', display: 'flex', alignItems: 'center', cursor: disabled ? 'default' : 'pointer' }}
      >
        <div
          style=${{
            position: 'relative',
            width: '100%',
            height: hover !== null ? '6px' : '4px',
            borderRadius: '999px',
            background: tint(18),
            overflow: 'hidden',
            transition: 'height 120ms ease',
          }}
        >
          ${hover !== null && html`<div style=${{ position: 'absolute', left: 0, top: 0, bottom: 0, width: hover * 100 + '%', background: tint(22) }} />`}
          <div style=${{ position: 'absolute', left: 0, top: 0, bottom: 0, width: ratio * 100 + '%', borderRadius: '999px', background: tint(90) }} />
        </div>
      </div>
      <div style=${{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: tint(60), fontVariantNumeric: 'tabular-nums' }}>
        <span>${formatTime(hover !== null ? hover * duration : position)}</span>
        <span>${live ? 'LIVE' : formatTime(duration)}</span>
      </div>
    </div>
  `
}

function Transport({ player }) {
  const playing = player.trackState === TRACK_PLAYING
  const likeStatus = player.track.likeStatus
  const repeat = player.repeatMode
  const nextRepeat = repeat === REPEAT_ALL ? REPEAT_ONE : repeat === REPEAT_ONE ? REPEAT_OFF : REPEAT_ALL
  const repeatLabel = repeat === REPEAT_ALL ? 'Repeat all' : repeat === REPEAT_ONE ? 'Repeat one' : 'Repeat off'
  return html`
    <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <${IconButton}
        icon="like"
        flip=${true}
        label=${likeStatus === DISLIKED ? 'Remove dislike' : 'Dislike'}
        active=${likeStatus === DISLIKED}
        filled=${likeStatus === DISLIKED}
        onClick=${() => control('toggleDislike')}
      />
      <${IconButton} icon="shuffle" label="Shuffle" toggle=${true} active=${player.shuffle} onClick=${() => control('shuffle')} />
      <${IconButton} icon="previous" label="Previous" size=${30} iconSize=${16} onClick=${() => control('previous')} />
      <${IconButton} icon=${playing ? 'pause' : 'play'} label=${playing ? 'Pause' : 'Play'} size=${38} iconSize=${18} strong=${true} onClick=${() => control('playPause')} />
      <${IconButton} icon="next" label="Next" size=${30} iconSize=${16} onClick=${() => control('next')} />
      <${IconButton}
        icon="repeat"
        badge=${repeat === REPEAT_ONE ? '1' : null}
        label=${repeatLabel}
        toggle=${true}
        active=${repeat === REPEAT_ALL || repeat === REPEAT_ONE}
        onClick=${() => control('repeatMode', nextRepeat)}
      />
      <${IconButton}
        icon="like"
        label=${likeStatus === LIKED ? 'Remove like' : 'Like'}
        active=${likeStatus === LIKED}
        filled=${likeStatus === LIKED}
        onClick=${() => control('toggleLike')}
      />
    </div>
  `
}

function VolumeRow({ player }) {
  // While dragging, show the slider's own value until YTMD catches up.
  const [dragging, setDragging] = useState(null)
  const release = useRef(null)
  useEffect(() => () => clearTimeout(release.current), [])
  const volume = dragging !== null ? dragging : player.volume
  const muted = player.muted || volume === 0

  function onChange(event) {
    const value = Number(event.target.value)
    setDragging(value)
    clearTimeout(release.current)
    release.current = setTimeout(() => setDragging(null), 1200)
    control('setVolume', value)
  }

  return html`
    <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <${IconButton}
        icon=${muted ? 'volumeMuted' : 'volume'}
        label=${player.muted ? 'Unmute' : 'Mute'}
        onClick=${() => control(player.muted ? 'unmute' : 'mute')}
      />
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value=${volume}
        aria-label="Volume"
        onChange=${onChange}
        onClick=${(event) => event.stopPropagation()}
        style=${{ flex: 1, minWidth: 0, margin: 0, height: '4px', accentColor: 'currentColor', cursor: 'pointer', opacity: player.muted ? 0.5 : 1 }}
      />
      <span style=${{ width: '26px', textAlign: 'right', fontSize: '11px', color: tint(60), fontVariantNumeric: 'tabular-nums' }}>${volume}</span>
    </div>
  `
}

function UpNext({ items }) {
  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
      <div style=${{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: tint(55), marginBottom: '4px' }}>
        Up next
      </div>
      ${items.map((item) => html`<${QueueRow} key=${item.index} item=${item} />`)}
    </div>
  `
}

function QueueRow({ item }) {
  const [hover, setHover] = useState(false)
  return html`
    <button
      type="button"
      title=${'Play ' + item.title}
      onClick=${(event) => {
        event.stopPropagation()
        control('playQueueIndex', item.index)
      }}
      onMouseEnter=${() => setHover(true)}
      onMouseLeave=${() => setHover(false)}
      style=${{
        ...buttonReset,
        justifyContent: 'flex-start',
        gap: '8px',
        width: 'calc(100% + 12px)',
        margin: '0 -6px',
        padding: '4px 6px',
        borderRadius: '6px',
        textAlign: 'left',
        background: hover ? tint(10) : 'transparent',
      }}
    >
      <${Artwork} url=${item.thumbnail} size=${30} radius=${4} />
      <span style=${{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span style=${{ ...ellipsis, fontSize: '12px' }}>${item.title}</span>
        <span style=${{ ...ellipsis, fontSize: '11px', color: tint(60) }}>${item.author}</span>
      </span>
      <span style=${{ fontSize: '11px', color: tint(55), fontVariantNumeric: 'tabular-nums' }}>${item.duration}</span>
    </button>
  `
}

function Note({ title, text }) {
  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style=${{ fontSize: '13px', fontWeight: 600 }}>${title}</div>
      ${text && html`<div style=${{ color: tint(70) }}>${text}</div>`}
    </div>
  `
}

// ---------------------------------------------------------------------------
// Connecting to YTMD (popup and settings page)
// ---------------------------------------------------------------------------

function Steps({ items }) {
  return html`
    <ol style=${{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px', color: tint(75) }}>
      ${items.map((text, i) => html`<li key=${i}>${text}</li>`)}
    </ol>
  `
}

function ConnectionCard({ view, onSettingsPage = false }) {
  const { status, paired, code, message } = view
  let title
  let body = null
  let actions = null

  if (status === 'connected') {
    const track = view.player && view.player.track
    title = 'Connected to YTMD'
    body = html`<div style=${{ color: tint(70) }}>${track ? 'Now playing: ' + track.title + (track.author ? ' - ' + track.author : '') : 'Nothing is playing right now.'}</div>`
    if (onSettingsPage) actions = html`<${TextButton} label="Disconnect" onClick=${() => backend('forget')} />`
  } else if (status === 'pairing') {
    title = code ? 'Allow the connection in YTMD' : 'Asking YTMD for a code...'
    body = code
      ? html`
          <div style=${{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style=${{ fontSize: '26px', fontWeight: 700, letterSpacing: '0.3em', fontVariantNumeric: 'tabular-nums' }}>${code}</div>
            <div style=${{ color: tint(70) }}>YTMD opened a window for "Alpine Shell YTMD Controller". Check that it shows this code, then allow it.</div>
          </div>
        `
      : null
  } else if (status === 'connecting') {
    title = 'Connecting to YTMD...'
  } else if (status === 'offline' && paired) {
    title = 'YTMD is not running'
    body = html`<div style=${{ color: tint(70) }}>The widget reconnects by itself once YouTube Music Desktop is open.</div>`
    actions = onSettingsPage
      ? html`<${TextButton} key="retry" label="Try again" onClick=${() => backend('retry')} /><${TextButton} key="forget" label="Disconnect" onClick=${() => backend('forget')} />`
      : html`<${TextButton} label="Try again" onClick=${() => backend('retry')} />`
  } else if (status === 'offline') {
    title = 'YTMD not found'
    body = html`<${Steps}
      items=${[
        'Install and open YouTube Music Desktop App (YTMD) version 2.',
        'In YTMD, open Settings > Integrations and turn on "Companion server".',
      ]}
    />`
    actions = html`<${TextButton} label="Try again" onClick=${() => backend('retry')} />`
  } else {
    title = 'Connect to YTMD'
    body = html`<${Steps}
      items=${[
        'In YTMD, open Settings > Integrations and turn on "Enable companion authorization".',
        'Choose Connect below, then allow the request in the window YTMD opens.',
      ]}
    />`
    actions = html`<${TextButton} label="Connect" onClick=${() => backend('pair')} />`
  }

  const showMessage = message && status !== 'pairing'
  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <${Icon} name="music" size=${16} />
        <div style=${{ fontSize: '13px', fontWeight: 600 }}>${title}</div>
      </div>
      ${body}
      ${showMessage &&
      html`<div style=${{ padding: '8px 10px', borderRadius: '8px', background: tint(10), color: tint(85) }}>${message}</div>`}
      ${actions && html`<div style=${{ display: 'flex', gap: '8px' }}>${actions}</div>`}
    </div>
  `
}

export function SettingsPage() {
  const view = useView()
  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px', lineHeight: 1.45, maxWidth: '560px' }}>
      <${ConnectionCard} view=${view} onSettingsPage=${true} />
      <div style=${{ fontSize: '12px', color: tint(60) }}>
        This plugin only talks to YTMD on this PC (127.0.0.1, port 9863). The key YTMD hands out is stored in the plugin's
        own data folder. To revoke it completely, also remove "Alpine Shell YTMD Controller" under Authorized companions
        in YTMD's Integrations settings.
      </div>
    </div>
  `
}
