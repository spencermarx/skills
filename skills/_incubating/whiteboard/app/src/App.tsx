// Live whiteboard client (SPEC §3–§7, v3 multi-peer via tldraw sync).
//
// This app is a PEER on a tldraw sync room, split by ROLE (read from the URL):
//   role=human — the operator's surface: full <Tldraw> + side panel (boards,
//     agent-message log, compose/Send with selection, collapsible zen panel).
//     Receives `agent-message` over the /events control WS; draws + watches
//     agents via sync. Does not run /exec.
//   role=agent — the headless render-canvas (Playwright), the agents' shared
//     Editor: renders <Tldraw> (so screenshots + editor exist) with the operator
//     panel hidden, and handles exec / export-image / get-shapes / presence over
//     the /events WS. Its synced edits propagate to every human peer.
//
// The board itself lives in the sync room (joined via @tldraw/sync `useSync`),
// which the sync server owns and persists — this app no longer posts snapshots.
// The exact bridge endpoints + WS frames are documented in ./bridge.ts.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  Tldraw,
  Box,
  createShapeId,
  createBindingId,
  toRichText,
  inlineBase64AssetStore,
} from 'tldraw'
import type { Editor, TLShapeId } from 'tldraw'
import { useSync } from '@tldraw/sync'
import 'tldraw/tldraw.css'
import './App.css'
import {
  fetchBoards,
  fetchCanvasStatus,
  fetchMessages,
  newBoard,
  openBoard,
  postMessage,
  requestTeardown,
  readAuthor,
  readRole,
  readRoom,
  readSession,
  syncUrl,
  uploadImage,
  wsUrl,
  type AgentStatus,
  type AuthorIdentity,
  type AuthorStamp,
  type BoardEntry,
  type Message,
  type Recipient,
  type SendState,
} from './bridge'
import { MultiAgentPresence, type PresenceFrame } from './presence'

// ── PNG export caps (render-canvas OOM guard) ───────────────────────────────
// A whole-board export renders EVERY shape; on a large board the default bitmap
// export (pixelRatio 2 ⇒ 4× the pixels) rasterizes a canvas big enough to hang
// or OOM the degraded headless Chromium. We cap the raster's longest side and
// pin pixelRatio to 1, so a big board downscales to a bird's-eye instead of
// exploding. A REGION export (bounds passed) stays at scale 1 up to the same
// cap, so an agent zooming in on a piece of the diagram gets finer detail — the
// human-like "step back for the whole, then lean in on a part" workflow.
const EXPORT_MAX_PX = 2200
// Bound the render in TIME as well: a suspend-degraded Chromium can hang inside
// toImage without throwing. Kept below the bridge's WS_REQUEST_TIMEOUT_MS (15s)
// so the app reports ok:false FIRST, populating lastExportError instead of the
// bridge waiter timing out into a null-health silence.
//
// COUPLED INVARIANT: this MUST stay below the bridge's WS_REQUEST_TIMEOUT_MS (server/index.ts,
// default 15s). If the bridge value is lowered under 12s the ordering inverts — the bridge times
// out first and a real toImage hang is misreported as its generic "no frame from render-canvas"
// instead of the specific error here. The two consts live in different files; keep this one the
// smaller. (The bridge value is env-tunable; the render-cap test lowers it deliberately, but
// with no app running there is no client timeout to invert.)
const EXPORT_TIMEOUT_MS = 12_000

// A page-coordinate export region an agent can request to zoom in on a piece of
// the board (x/y = top-left, w/h = size, all in page units from GET /shapes).
// MIRROR of server/index.ts's ExportRegion + parseBoundsParam — this app re-validates whatever
// the bridge forwards rather than trusting it (a genuine trust boundary; keep both). A validation
// rule added on one side belongs on the other too.
type ExportRegion = { x: number; y: number; w: number; h: number }

// Validate a region off an inbound frame: all four finite numbers, positive size.
function parseRegion(v: unknown): ExportRegion | undefined {
  if (!v || typeof v !== 'object') return undefined
  const b = v as Record<string, unknown>
  const { x, y, w, h } = b
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  if ((w as number) <= 0 || (h as number) <= 0) return undefined
  return { x: x as number, y: y as number, w: w as number, h: h as number }
}

// The panel's log line (SPEC §8.2 read model). `id` is the stable Message id —
// the operator's own Send tags its optimistic echo with the SAME id it posts as
// the idempotencyKey, so the stored copy (via GET or the `message` WS frame)
// reconciles against the echo instead of duplicating. `mine` keeps the "You:"
// label + styling for the operator's own lines across reconciliation.
type LogLine = {
  id: string
  kind: 'human' | 'agent'
  name: string
  text: string
  ts: number
  mine: boolean
  // [v5.1, SPEC §8.2] Server-authoritative Send lifecycle on the operator's own lines
  // (queued → working → done, or stalled if a lead's lease expired). Undefined on agent lines.
  state?: SendState
  // [v6, SPEC §4/§8.2] The Send's routing target, so the log line can show its addressee
  // ("You → Claude-2:"). Absent / kind 'lead' == the lead default (rendered clean as "You:").
  recipient?: Recipient
}

// [v6, SPEC §4] The addressee shown alongside the author on a human Send: a worker's
// display name, or "Everyone" for a broadcast. Returns null for a plain lead-addressed
// Send (the v5 default) and for agent lines, so those render clean ("You:" / "Claude:").
function addresseeLabel(line: LogLine): string | null {
  if (!line.mine || line.kind !== 'human') return null
  const r = line.recipient
  if (!r || r.kind === 'lead') return null
  if (r.kind === 'broadcast') return 'Everyone'
  return r.name || r.id || 'worker'
}

// [v5.1, SPEC §8.2] The lifecycle badge for one log line, or null when the line is not
// one of the operator's own Sends. The panel renders the server's `state` directly.
// queued (awaiting a lead) → working (a lead is drawing it) → done. [v9.3] `stalled` is a
// WORKER-only state now: a lead's liveness is leadAlive-driven, not a lease, so a lead line
// never carries stalled — the guard below renders any such stray state as queued for the lead.
function lifecycleLabel(line: LogLine): { text: string; cls: string } | null {
  if (!line.mine || line.kind !== 'human') return null
  switch (line.state) {
    case 'done':
      return { text: 'done', cls: 'done' }
    case 'working':
      return { text: 'working', cls: 'working' }
    case 'stalled': {
      // [v9.3] Workers still stall; a LEAD never does (its liveness is leadAlive-driven, not a
      // lease sweep). A lead-addressed line must never render a stalled badge even if a stale
      // frame carried the state — fall it through to queued. Absent / kind 'lead' == the lead.
      const isLead = !line.recipient || line.recipient.kind === 'lead'
      return isLead ? { text: 'queued', cls: 'queued' } : { text: 'stalled', cls: 'stalled' }
    }
    default:
      return { text: 'queued', cls: 'queued' }
  }
}

// [v5.1] A Send is "waiting for a lead" — the state that lights the no-agent banner when
// no lead is parked. `working` (being drawn) and `done` never do.
function needsLead(line: LogLine): boolean {
  return line.mine && line.kind === 'human' && (line.state === 'queued' || line.state === 'stalled' || line.state === undefined)
}

// A fresh id, doubling as a message idempotencyKey (SPEC §4).
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `wb-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// Project a stored Message into a log line. `mine` marks the operator's own Sends
// (matched by the ids this session posted) so they read as "You:". The Send
// lifecycle fields (SPEC §8.2) ride along so the panel can render queued/delivered/done.
function toLine(msg: Message, mine: boolean): LogLine {
  return {
    id: msg.id,
    kind: msg.author.kind,
    name: msg.author.name,
    text: msg.text,
    ts: msg.ts,
    mine,
    state: msg.state,
    recipient: msg.recipient,
  }
}

// Fixed for the life of the page: the bridge launches each surface with its role
// and room in the URL. A reload with a different ?room= re-joins another room.
const ROLE = readRole()
const ROOM = readRoom()
// [decision #54] The bound CC session's semantic name, for the browser-tab title.
const SESSION = readSession()

// ── Per-object authorship (SPEC §8.6, decisions #30/#31) ─────────────────────────
// Every shape carries who created it (immutable) and who last edited it, stamped by
// an `editor.sideEffects` handler that runs on THIS surface's LOCAL edits only. The
// author identity resolves differently per surface:
//   agent  — the current /exec's author context (set around the blob, below).
//   human  — the operator identity the skill passed in the URL, fixed for the page.

// [v5] The author of the /exec blob currently running on the agent render-canvas.
// Set immediately before the blob runs and cleared in a `finally` (below); because
// /exec is serialized server-side (SPEC §4), the create/change handlers read an
// unambiguous author. `null` between blobs → the agent surface skips stamping.
let currentExecAuthor: AuthorIdentity | null = null

// [v5] The operator's identity on the human surface, resolved once from the URL.
const HUMAN_AUTHOR: AuthorIdentity = (() => {
  const { name, authorKey } = readAuthor()
  const a: AuthorIdentity = { kind: 'human', name }
  if (authorKey) a.sessionId = authorKey
  return a
})()

// Who is authoring a local edit on THIS surface right now, or null if unknown (an
// agent-surface edit outside any /exec) → skip stamping.
function resolveAuthor(): AuthorIdentity | null {
  return ROLE === 'agent' ? currentExecAuthor : HUMAN_AUTHOR
}

// Coerce an untrusted WS `author` frame field into an AuthorIdentity (SPEC §8.6:
// the exec frame carries {kind:'agent',sessionId,name,color}). Returns null when the
// field is absent/malformed so stamping is simply skipped rather than throwing.
function coerceAuthor(raw: unknown): AuthorIdentity | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' && o.name ? o.name : 'Agent'
  const a: AuthorIdentity = { kind: o.kind === 'human' ? 'human' : 'agent', name }
  if (typeof o.sessionId === 'string') a.sessionId = o.sessionId
  if (typeof o.color === 'string') a.color = o.color
  return a
}

// [v6, SEAM §1] Reserved recipient ids. `LEAD_ID` is the default recipient (the v5
// behavior); `EVERYONE_ID` is the broadcast pseudo-target (never a real session).
const LEAD_ID = 'lead'
const EVERYONE_ID = 'everyone'

// [v6, SEAM §7] Coerce one untrusted `agent-status` / `/canvas-status` roster entry into
// an AgentStatus, dropping anything malformed (returns null) so a bad frame never throws.
function coerceAgentStatus(raw: unknown): AgentStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const role = o.role === 'worker' ? 'worker' : 'lead'
  const life = o.lifecycle
  const lifecycle =
    life === 'queued' || life === 'working' || life === 'stalled' || life === 'absent' || life === 'idle'
      ? life
      : 'idle'
  return {
    id: o.id,
    name: typeof o.name === 'string' && o.name ? o.name : o.id,
    role,
    parked: o.parked === true,
    lifecycle,
    // [redesign] Identity color (SEAM): pass the server hex through when present; an empty
    // string falls back to a deterministic per-identity color in `agentColor`.
    color: typeof o.color === 'string' ? o.color : '',
  }
}

function coerceAgents(raw: unknown): AgentStatus[] {
  if (!Array.isArray(raw)) return []
  const out: AgentStatus[] = []
  for (const item of raw) {
    const a = coerceAgentStatus(item)
    if (a) out.push(a)
  }
  return out
}

// [v6, SEAM §2/§4] Coerce the optional `recipient` on a `message-state` frame. Only the
// shape is validated; the panel renders the aggregate `state`, so this just lets the line
// backfill its addressee if it arrived without one.
function coerceRecipient(raw: unknown): Recipient | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (o.kind !== 'lead' && o.kind !== 'worker' && o.kind !== 'broadcast') return undefined
  const r: Recipient = { kind: o.kind }
  if (typeof o.id === 'string') r.id = o.id
  if (typeof o.name === 'string') r.name = o.name
  return r
}

// [v6, SEAM §2/§3] Build the Recipient a Send carries from the selected recipient id.
// Lead → undefined (omitted from the POST body == the v5 default). Everyone → a broadcast.
// A worker → its stable id plus a display name pulled from the live roster if known.
function recipientFor(id: string, agents: AgentStatus[]): Recipient | undefined {
  if (id === LEAD_ID) return undefined
  if (id === EVERYONE_ID) return { kind: 'broadcast' }
  const a = agents.find((x) => x.role === 'worker' && x.id === id)
  return a?.name ? { kind: 'worker', id, name: a.name } : { kind: 'worker', id }
}

// [redesign] Identity color for an avatar / chat attribution. Prefers the server-populated
// `agent.color` (SEAM: a hex string like '#7C4DFF' added concurrently to AgentStatus); until
// that field lands the type has no `color`, so we read it defensively and fall back to a
// deterministic per-identity color so avatars stay distinguishable in the meantime. The lead
// always renders in the product accent.
const WORKER_FALLBACK_COLORS = [
  '#2FBF71', '#F09A28', '#3B82F6', '#EC4899', '#14B8A6', '#F43F5E', '#8B5CF6', '#0EA5E9',
]
function hashId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h
}
// [reskin] The lead falls back to the product accent. This is the light-theme accent hex (kept in
// step with --wb-accent in App.css) rather than a CSS var, because discLabelColor needs a real hex
// to pick the disc label's contrast color; a server-supplied `color` still overrides it.
const LEAD_FALLBACK_COLOR = '#5e6ad2'
function agentColor(a: AgentStatus): string {
  const c = (a as AgentStatus & { color?: string }).color
  if (typeof c === 'string' && c) return c
  if (a.role === 'lead') return LEAD_FALLBACK_COLOR
  return WORKER_FALLBACK_COLORS[hashId(a.id) % WORKER_FALLBACK_COLORS.length]
}

// [reskin] Label color for an avatar disc — now a small SOLID identity-hue fill on every avatar,
// not just the selected one. We pick white vs near-black from the pure hue's relative luminance
// (theme-independent: the fill is the identity color, not a themed surface). The 0.19 threshold is
// the WCAG-AA crossover for white (#fff) vs near-black (#141518) text over the swatch, so the label
// clears AA on both the lightest (→ dark label) and darkest (→ white label) palette hues.
function discLabelColor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  const chan = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const L = 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255)
  return L > 0.19 ? '#141518' : '#ffffff'
}

// [redesign] A short, glanceable avatar label: a leading initial plus any trailing index, so
// "Lead" → "L", "Claude" → "C", "Claude-2" → "C2".
function avatarLabel(name: string): string {
  const digits = name.match(/(\d+)\s*$/)?.[1]
  const first = (name.match(/[a-zA-Z]/)?.[0] || '?').toUpperCase()
  return digits ? `${first}${digits}` : first
}

// [redesign] The status a collaborator's avatar dot conveys, collapsing lifecycle + parked into
// one glanceable state. Rendered as a colored corner dot (see .wb-av-dot-* in App.css).
function avatarState(a: AgentStatus): 'listening' | 'active' | 'stalled' | 'absent' | 'idle' {
  if (a.lifecycle === 'absent') return 'absent'
  if (a.lifecycle === 'stalled') return 'stalled'
  if (a.lifecycle === 'working' || a.lifecycle === 'queued') return 'active'
  return a.parked ? 'listening' : 'idle'
}

// A fresh authorship stamp: identity + when. A new object per stamp so createdBy and
// lastEditedBy never alias, and so each edit's timestamp is its own.
function authorStamp(a: AuthorIdentity): AuthorStamp {
  const s: AuthorStamp = { kind: a.kind, name: a.name, at: Date.now() }
  if (a.sessionId !== undefined) s.sessionId = a.sessionId
  if (a.color !== undefined) s.color = a.color
  return s
}

// Run agent-supplied JS against the live editor. Supports async code and
// top-level `await`. Tolerant by design: the caller wraps this in try/catch and
// reports failures up the WS so a bad blob never crashes the app (SPEC §5).
// The exec scope exposes `editor` plus the tldraw helpers the reference doc
// documents (createShapeId, createBindingId, toRichText) so blobs can use them
// bare, exactly as reference/tldraw-editor-api.md shows.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

// ── [v9.5, SPEC §5] Validate-first exec write guard ───────────────────────────
// Reject a schema-invalid shape record from an /exec blob BEFORE it reaches
// store.put, so the store is never flagged corrupted.
//
// WHY this is load-bearing: tldraw validates a record INSIDE editor.run()'s history
// batch (createShapes/updateShapes → this.run → store.put → schema.validateRecord).
// A validation throw there makes the editor call store.markAsPossiblyCorrupted()
// (@tldraw/editor Editor: history.batch annotateError with willCrashApp:true, then
// crash()). That flag is STICKY with no public reset, and while it is set
// @tldraw/sync-core suppresses EVERY outbound push (sendUnsentChanges early-returns
// on store.isPossiblyCorrupted()) while the socket stays open, silently freezing the
// board at the poison point. Validating an equivalent record against the SAME store
// schema OUTSIDE editor.run() throws where WE catch it and leaves isPossiblyCorrupted()
// false. Proven headless against tldraw 5.4.2: a geo shape with a top-level `w` is
// rejected with "At shape(type=geo).w: Unexpected property" and the store stays
// uncorrupted; a well-formed partial (props under `props`) passes unchanged.
//
// LIMIT (the honest boundary): this guards the COMMON write path — createShape(s) /
// updateShape(s) — against the classic structural error (a prop placed on the record
// instead of under `props`). It is NOT exhaustive for arbitrary blob code. A blob can
// still corrupt the store by (a) writing editor.store.put(...) directly, (b) calling
// an editor method we do not wrap, (c) wrapping its own write in editor.run(...) so our
// pre-validation throw lands inside a history batch after all, or (d) a props VALUE that
// only a shape util's onBeforeCreate would repair. Those remain the server-owned
// detect → harvest → reload → reapply recovery's job (SPEC §5, slice C); this guard only
// REDUCES how often recovery has to fire. It is installed on the agent render-canvas
// only (the sole surface that runs /exec); remote sync merges bypass these methods, so
// human peers are never guarded.

type ExecShapePartial = Record<string, unknown>

// Merge an update partial onto an existing shape the way tldraw's internal
// applyPartialToRecordWithProps does — deep-merge props/meta, copy other top-level keys,
// skip id/type/typeName — so an update is validated against the exact record tldraw would
// commit, including any stray top-level key the partial carries.
function applyUpdatePartial(prev: Record<string, unknown>, partial: ExecShapePartial): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev }
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined) continue
    if (k === 'id' || k === 'type' || k === 'typeName') continue
    if (k === 'props' || k === 'meta') {
      next[k] = { ...(prev[k] as Record<string, unknown>), ...(v as Record<string, unknown>) }
      continue
    }
    next[k] = v
  }
  return next
}

// Validate every shape a create/update exec blob is about to write, throwing the schema's
// own message on the first invalid one. Mirrors how tldraw builds the record
// (schema.types.shape.create with the shape util's default props merged under
// partial.props) so a well-formed partial is never falsely rejected and the classic
// top-level-prop bug always is. Runs OUTSIDE editor.run(), so a throw here never trips
// isPossiblyCorrupted().
function validateExecShapes(
  editor: Editor,
  partials: unknown[],
  phase: 'createRecord' | 'updateRecord',
): void {
  const schema = editor.store.schema
  const shapeType = schema.types.shape
  type CreateArg = Parameters<typeof shapeType.create>[0]
  type ShapeRecord = ReturnType<typeof shapeType.create>
  const utilOf = (editor as unknown as {
    getShapeUtil(t: unknown): { getDefaultProps(): Record<string, unknown> }
  }).getShapeUtil.bind(editor)
  for (const raw of partials) {
    if (!raw || typeof raw !== 'object') continue
    const partial = raw as ExecShapePartial
    if (phase === 'updateRecord') {
      const before = editor.getShape(partial.id as TLShapeId)
      if (!before) continue // tldraw skips an update to an unknown id; nothing to validate
      const record = applyUpdatePartial(before as unknown as Record<string, unknown>, partial)
      schema.validateRecord(editor.store, record as unknown as ShapeRecord, 'updateRecord', before)
    } else {
      const initialProps = utilOf(partial.type).getDefaultProps()
      const props =
        'props' in partial
          ? { ...initialProps, ...(partial.props as Record<string, unknown>) }
          : initialProps
      const record = shapeType.create({
        ...partial,
        index: partial.index ?? 'a1', // any valid IndexKey; tldraw computes the real one
        parentId: partial.parentId ?? editor.getCurrentPageId(),
        props,
      } as unknown as CreateArg)
      schema.validateRecord(editor.store, record, 'createRecord', null)
    }
  }
}

// Patch the agent render-canvas's shape-write methods to validate-first. createShape and
// updateShape both delegate to these plurals internally, so wrapping the two covers all
// four. Returns a disposer that restores the original methods.
function installExecShapeGuard(editor: Editor): () => void {
  const target = editor as unknown as {
    createShapes: (shapes: unknown[]) => unknown
    updateShapes: (partials: unknown[]) => unknown
  }
  const origCreate = target.createShapes.bind(editor)
  const origUpdate = target.updateShapes.bind(editor)
  target.createShapes = (shapes: unknown[]) => {
    validateExecShapes(editor, Array.isArray(shapes) ? shapes : [], 'createRecord')
    return origCreate(shapes)
  }
  target.updateShapes = (partials: unknown[]) => {
    validateExecShapes(editor, Array.isArray(partials) ? partials : [], 'updateRecord')
    return origUpdate(partials)
  }
  return () => {
    target.createShapes = origCreate
    target.updateShapes = origUpdate
  }
}

function App() {
  // The synced store IS the board (SPEC §3). Passing the status wrapper straight
  // to <Tldraw> lets tldraw render its own loading/error state. Verified against
  // @tldraw/sync 5.4.2: useSync({uri, assets, getUserPresence?}) →
  // RemoteTLStoreWithStatus; TldrawEditorWithStoreProps.store accepts it.
  // The render-canvas is a headless robot, so it hides its own cursor
  // (getUserPresence → null); the operator broadcasts a real cursor (default).
  const store = useSync({
    uri: syncUrl(ROOM),
    assets: inlineBase64AssetStore,
    ...(ROLE === 'agent' ? { getUserPresence: () => null } : {}),
  })

  // [v9.5, SPEC §5] Keep the latest useSync store-status wrapper reachable from the WS
  // frame handler, so the `sync-health` command can report room connectivity even when
  // the raw sync client is not exposed on window (see the sync-health case).
  const syncStatusRef = useRef(store)
  useEffect(() => {
    syncStatusRef.current = store
  })

  // [v9.6, fix 4] The store wrapper is reactive (App re-renders on change), so read "are we
  // actually syncing" straight from it, using the exact expression the `sync-health` probe uses.
  const syncOnline = store.status === 'synced-remote' && store.connectionStatus === 'online'
  // Only alarm on a DROP from a previously-synced state, never on the initial connect: a first
  // handshake slower than the debounce would otherwise flash "not being saved" before the board
  // ever connected. This latches true once we first go online and never resets.
  const wasEverOnline = useRef(false)
  if (syncOnline) wasEverOnline.current = true

  // Debounce the disconnect banner: only raise it after ~2.5s of continuous disconnection, so a
  // normal short auto-reconnect blip stays silent; clear it the moment sync returns.
  useEffect(() => {
    if (syncOnline || !wasEverOnline.current) {
      setShowDisconnected(false)
      return
    }
    const timer = setTimeout(() => setShowDisconnected(true), 2500)
    return () => clearTimeout(timer)
  }, [syncOnline])

  const editorRef = useRef<Editor | null>(null)
  const presenceRef = useRef<MultiAgentPresence | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const diffTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDiff = useRef({
    added: new Set<string>(),
    updated: new Set<string>(),
    removed: new Set<string>(),
  })

  const [editorReady, setEditorReady] = useState(false)
  const [log, setLog] = useState<LogLine[]>([])
  const [text, setText] = useState('')
  const [boards, setBoards] = useState<BoardEntry[]>([])
  const [wsConnected, setWsConnected] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  // [redesign] The board switcher is a button that opens a popover (Miro/tldraw pattern),
  // replacing the always-open scrolling board list. Local UI state only.
  const [boardMenuOpen, setBoardMenuOpen] = useState(false)
  const boardMenuRef = useRef<HTMLDivElement | null>(null)

  // [v9.1, SPEC §8.2/§8.4, decision #53] The operator's confirm-gated close-session affordance.
  // `closeArm` is the two-step confirm (the control expands to Confirm/Cancel in-app — never a
  // browser confirm()); `closing` is the optimistic "we posted the teardown request" latch. The
  // room-wide `teardownRequested` flag (from /canvas-status) is the authoritative signal a second
  // browser also reflects; the panel's "closing…" state is either of them.
  const [closeArm, setCloseArm] = useState(false)
  const [closing, setClosing] = useState(false)
  const [teardownRequested, setTeardownRequested] = useState(false)

  // [v9.6, fix 4] Silent-data-loss guard. `useSync` holds NO local persistence, so a tab whose
  // sync server died keeps accepting edits into an in-memory store that syncs nowhere. Two signals
  // drive the human disconnect banner: `serverClosing` is definitive (the `server-closing` frame —
  // the room is being torn down, no reconnect coming), while `showDisconnected` is the debounced
  // read of the sync store's own status (see the syncOnline effect), so tldraw's normal brief
  // auto-reconnect blips don't raise a false alarm.
  const [serverClosing, setServerClosing] = useState(false)
  const [showDisconnected, setShowDisconnected] = useState(false)

  // [v5, SPEC §8.6/decision #29] Whether a lead is parked (long-polling). `null`
  // until the first /canvas-status or `parked` frame — unknown, so the no-agent
  // banner stays hidden until we actually know nobody is listening.
  const [agentParked, setAgentParked] = useState<boolean | null>(null)
  // [v9.3, SPEC §7] Server-computed lead liveness: true while the lead is alive/listening
  // (bridged THROUGH the wake→re-arm gap by the server's grace window), false only when the
  // lead is CONFIRMED dead (grace elapsed), `null` until first known. This is the "session
  // ended" signal now, NOT transient `agentParked === false` (which drops on every normal turn
  // when poll.sh tears down to wake the agent). Seeded from `/canvas-status`, kept live by the
  // `lead-alive` WS frame — mirrors `agentParked` exactly (same three-valued discipline).
  const [leadAlive, setLeadAlive] = useState<boolean | null>(null)
  // [v6, SPEC §7, SEAM §7/§10] The live per-agent roster: the recipient selector's worker
  // list and the status strip both read it. Seeded from `/canvas-status` on load/reconnect,
  // kept current by the `agent-status` WS frame. `rosterLoadedRef` gates the recipient
  // fallback below so a persisted worker id survives until the roster has actually arrived.
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const rosterLoadedRef = useRef(false)
  // [v6, SPEC §8.2, SEAM §10] The selected recipient id ('lead' default, a worker clientKey,
  // or 'everyone'), persisted like the panel-open state.
  const [recipientId, setRecipientId] = useState<string>(() => {
    try {
      return localStorage.getItem('wb.recipient') || LEAD_ID
    } catch {
      return LEAD_ID
    }
  })
  // [v5.1] Latest Send-lifecycle state keyed by message id, from `message-state` frames,
  // so a state that arrives before/after its line still lands. Last-write-wins (a Send can
  // go working → stalled → working), unlike the monotonic timestamps it replaced.
  const msgState = useRef<Map<string, SendState>>(new Map())

  // Panel read-model bookkeeping (SPEC §8.2). `seenIds` guards every append so a
  // message never doubles; `lastSeenTs` is the high-water server ts fed to
  // `GET /messages?since=` on reconnect; `myIds` are the idempotencyKeys this
  // session posted, so a stored human message is recognized as the operator's
  // own; `hydrated` gates the reconnect fetch until the first full load lands.
  const seenIds = useRef<Set<string>>(new Set())
  const lastSeenTs = useRef(0)
  const myIds = useRef<Set<string>>(new Set())
  const hydratedRef = useRef(false)

  // Collapsible "zen mode" panel: persisted, with an unread ping so a clarifying
  // question from Claude still surfaces while the panel is hidden.
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('wb.panelOpen') !== '0'
    } catch {
      return true
    }
  })
  const [unread, setUnread] = useState(false)
  const panelOpenRef = useRef(panelOpen)
  useEffect(() => {
    panelOpenRef.current = panelOpen
  }, [panelOpen])

  // Specialize the browser-tab title to the bound CC session's semantic name so each
  // session's tab is distinguishable ("Whiteboard: my-repo: whiteboard session 10"),
  // truncated to keep the tab legible. SESSION is fixed for the life of the page (a
  // board switch is a full navigation via gotoRoom/gotoBoardAt, which reloads and
  // re-resolves it), so this runs once; index.html keeps the plain "Whiteboard" as the
  // pre-hydration default. Falls back to plain "Whiteboard" when no session name was
  // passed (decision #54).
  useEffect(() => {
    const truncate = (s: string, max = 40) => (s.length > max ? `${s.slice(0, max)}…` : s)
    document.title = SESSION ? `Whiteboard: ${truncate(SESSION)}` : 'Whiteboard'
  }, [])

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      const next = !open
      try {
        localStorage.setItem('wb.panelOpen', next ? '1' : '0')
      } catch {
        /* storage may be unavailable; the toggle still works this session */
      }
      if (next) setUnread(false)
      return next
    })
  }, [])

  // [v6] Change + persist the selected recipient (SEAM §10), like the panel-open state.
  const onRecipientChange = useCallback((id: string) => {
    setRecipientId(id)
    try {
      localStorage.setItem('wb.recipient', id)
    } catch {
      /* storage may be unavailable; the selection still works this session */
    }
  }, [])

  // [v9.1, #53] Confirm step of the close-session control: post the distinct teardown-request
  // control signal (not a chat Send), latch the optimistic "closing…" state, and close the
  // popover. On a POST failure, drop back out of "closing…" so the operator can retry rather than
  // be stranded — the room-wide `teardownRequested` flag would still resurface it on next refresh
  // if the request actually landed. The LEAD performs the graceful /done; this only signals it.
  const onConfirmClose = useCallback(async () => {
    setCloseArm(false)
    setBoardMenuOpen(false)
    setClosing(true)
    try {
      await requestTeardown(ROOM)
    } catch (err) {
      console.error('request teardown failed', err)
      setClosing(false)
    }
  }, [])

  // [v6, SEAM §10] Fall back to the lead when the selected worker is gone from the roster.
  // Gated on `rosterLoadedRef` so a persisted worker id is NOT reset in the gap before the
  // first roster arrives (which would otherwise clobber the restore on a fresh reload). An
  // `absent` worker still appears in the roster (SEAM §7), so addressing a dead worker — the
  // thing that revives it — is preserved; only a worker that has dropped out entirely resets.
  useEffect(() => {
    if (recipientId === LEAD_ID || recipientId === EVERYONE_ID) return
    if (!rosterLoadedRef.current) return
    if (!agents.some((a) => a.role === 'worker' && a.id === recipientId)) {
      onRecipientChange(LEAD_ID)
    }
  }, [agents, recipientId, onRecipientChange])

  // Cmd/Ctrl + \  toggles the panel (window-level so it fires with the canvas
  // focused). Human surface only.
  useEffect(() => {
    if (ROLE !== 'human') return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        togglePanel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePanel])

  // [redesign] Dismiss the board popover on an outside click or Escape, the expected
  // affordance for a menu opened from a trigger button.
  useEffect(() => {
    if (!boardMenuOpen) return
    const onDown = (e: PointerEvent) => {
      if (!boardMenuRef.current?.contains(e.target as Node)) setBoardMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBoardMenuOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [boardMenuOpen])

  // [v9.1, #53] The two-step close confirm never persists past the popover: dismissing it (outside
  // click, Escape, or reopening) re-arms the safe "Close session" resting state, so a stray click
  // can never land on a pre-expanded Confirm.
  useEffect(() => {
    if (!boardMenuOpen) setCloseArm(false)
  }, [boardMenuOpen])

  // Append one line to the log, deduped by `id` (SPEC §8.2). A repeat `id`
  // reconciles in place — the stored copy's authoritative text/ts/name replace a
  // provisional echo, while the local `mine` label survives — so the operator's
  // optimistic Send is replaced by its persisted twin instead of duplicated. The
  // setLog updater stays pure (idempotent under StrictMode double-invoke); the
  // seen-set and unread side effects run once, outside it.
  const ingest = useCallback((line: LogLine) => {
    const isNew = !seenIds.current.has(line.id)
    seenIds.current.add(line.id)
    if (line.ts > lastSeenTs.current) lastSeenTs.current = line.ts
    // Fold in any lifecycle state that arrived out of order for this id, so an optimistic
    // echo (no state) is not rendered as forever-queued once a `message-state` frame has
    // already been seen. A defined line state (a fresh server seed) wins over a remembered
    // frame; otherwise the remembered frame fills in (SPEC §8.2).
    const state = line.state ?? msgState.current.get(line.id)
    setLog((prev) => {
      const idx = prev.findIndex((l) => l.id === line.id)
      if (idx !== -1) {
        const cur = prev[idx]
        const merged: LogLine = {
          ...cur,
          kind: line.kind,
          name: line.name,
          text: line.text,
          ts: line.ts,
          mine: cur.mine || line.mine,
          state: state ?? cur.state,
        }
        const next = prev.slice()
        next[idx] = merged
        return next.sort((a, b) => a.ts - b.ts)
      }
      return [...prev, { ...line, state }].sort((a, b) => a.ts - b.ts)
    })
    // A clarifying question from an agent should surface even while collapsed.
    if (isNew && line.kind === 'agent' && !panelOpenRef.current) setUnread(true)
  }, [])

  // [v5.1, SPEC §8.2] Apply a Send-lifecycle change: remember the latest state by id (so it
  // survives a not-yet-rendered line) and patch the matching log line in place. Last-write-wins
  // — the server is authoritative and a Send can move backward (working → stalled) on a lease
  // expiry.
  // [v6] `recipient` (SEAM §4) rides the frame; the badge renders the aggregate `state`, so
  // we don't key the badge per recipient — we only backfill a line's addressee if it arrived
  // without one (e.g. a state frame seen before the `message` frame that carries the target).
  const applyMessageState = useCallback((id: string, state: SendState, recipient?: Recipient) => {
    msgState.current.set(id, state)
    setLog((prev) => {
      const idx = prev.findIndex((l) => l.id === id)
      if (idx === -1) return prev
      const next = prev.slice()
      const cur = next[idx]
      next[idx] = { ...cur, state, recipient: cur.recipient ?? recipient }
      return next
    })
  }, [])

  // Seed the log from a full GET /messages (mount / room load): server truth
  // replaces local state, and the seen-set + high-water ts are rebuilt from it.
  const seedFromServer = useCallback((msgs: Message[]) => {
    const lines = msgs
      .map((m) => toLine(m, m.author.kind === 'human' && myIds.current.has(m.id)))
      .sort((a, b) => a.ts - b.ts)
    seenIds.current = new Set(lines.map((l) => l.id))
    lastSeenTs.current = lines.reduce((max, l) => Math.max(max, l.ts), 0)
    setLog(lines)
  }, [])

  const send = useCallback((frame: unknown) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
  }, [])

  // Export the page (or a requested region) to a PNG blob (SPEC §5/§6). Verified
  // 5.4.2 API: editor.toImage(shapeIds, opts) → { blob, width, height }.
  //
  // Two modes, one raster cap (EXPORT_MAX_PX longest side, pixelRatio pinned to
  // 1 — see the constant): a bird's-eye of the WHOLE board (no region), and a
  // higher-fidelity crop of a REQUESTED region (an agent leaning in on a piece).
  // Passing ALL shape ids in both modes lets tldraw clip to `bounds` while still
  // rendering shapes that straddle the region edge.
  const exportPng = useCallback(async (region?: ExportRegion): Promise<Blob | null> => {
    const editor = editorRef.current
    if (!editor) return null
    const ids = editor.getCurrentPageShapes().map((s) => s.id)
    if (ids.length === 0) return null // toImage needs at least one shape

    const bounds = region
      ? new Box(region.x, region.y, region.w, region.h)
      : editor.getCurrentPageBounds()
    if (!bounds) return null // no content bounds ⇒ nothing to render

    // Downscale so longest_side × scale ≤ EXPORT_MAX_PX. A small region stays at
    // scale 1 (full detail); only an oversized area shrinks. pixelRatio:1 undoes
    // the bitmap default of 2 (which would quadruple the raster and drive the OOM).
    const longest = Math.max(bounds.width, bounds.height)
    const scale = longest > EXPORT_MAX_PX ? EXPORT_MAX_PX / longest : 1

    const { blob } = await editor.toImage(ids, {
      format: 'png',
      background: true,
      bounds,
      scale,
      pixelRatio: 1,
      // A region is an exact crop (0). The whole-board box comes from
      // getCurrentPageBounds() (already tight), so a little padding keeps edge
      // strokes/arrowheads from clipping without meaningfully growing the raster.
      padding: region ? 0 : 8,
    })
    return blob
  }, [])

  // Export + deliver a PNG to the bridge, correlated by `id` (SPEC §4 /image-upload).
  // The render is time-bounded: a degraded headless Chromium can hang inside
  // toImage without throwing, which would otherwise leave the bridge's /image
  // waiter to time out with NO health recorded (the null-across-the-board stall).
  // On timeout we emit ok:false + an error so the bridge records lastExportError.
  const exportAndUpload = useCallback(
    async (id: string, region?: ExportRegion) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const blob = await Promise.race([
          exportPng(region),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('toImage timed out')), EXPORT_TIMEOUT_MS)
          }),
        ])
        if (blob) {
          await uploadImage(id, blob)
          send({ type: 'image', id, ok: true })
        } else {
          // No blob = empty board / no content bounds: signal ok:false with NO
          // error so the bridge treats it as "nothing to render", not a stall.
          send({ type: 'image', id, ok: false })
        }
      } catch (err) {
        send({ type: 'image', id, ok: false, error: String(err) })
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    [exportPng, send],
  )

  // ── inbound WS frame handling (bridge → app) ────────────────────────────────
  const handleFrame = useCallback(
    async (frame: { type: string; [k: string]: unknown }) => {
      const editor = editorRef.current
      switch (frame.type) {
        // Agent-surface write path (SPEC §5): run the blob against the live editor.
        case 'exec': {
          const id = String(frame.id ?? '')
          const code = String(frame.code ?? '')
          if (!editor) {
            send({ type: 'exec-result', id, ok: false, error: 'editor not ready' })
            return
          }
          // [v5, SPEC §8.6] Establish the author context for the shapes this blob
          // creates/edits BEFORE running it, and clear it in `finally` so a shape
          // touched between blobs is never mis-attributed. The stamping side-effect
          // (onMount) reads `currentExecAuthor` synchronously as each shape is made.
          currentExecAuthor = coerceAuthor(frame.author)
          try {
            const fn = AsyncFunction('editor', 'createShapeId', 'createBindingId', 'toRichText', code)
            const result = await fn(editor, createShapeId, createBindingId, toRichText)
            let safeResult: unknown = undefined
            try {
              safeResult = JSON.parse(JSON.stringify(result ?? null))
            } catch {
              safeResult = String(result)
            }
            send({ type: 'exec-result', id, ok: true, result: safeResult })
          } catch (err) {
            send({ type: 'exec-result', id, ok: false, error: String(err) })
          } finally {
            currentExecAuthor = null
          }
          // [render-cap] No spontaneous post-exec export here. The bridge's runExec
          // issues its OWN `export-image` request after the exec-result settles
          // (server/index.ts requestImage), so a second full-board render fired from
          // here was pure duplicated OOM pressure — and its `id` was the exec-waiter
          // id, never an image-waiter, so its failures were invisible to health. The
          // bridge-initiated export (below, matched to a real /image waiter) is the
          // single source of the verify-after-write frame.
          break
        }
        case 'export-image': {
          await exportAndUpload(String(frame.id ?? ''), parseRegion(frame.bounds))
          break
        }
        // Agent voice (SPEC §10): render in the operator's log, deduped by id. The
        // frame may carry the stored `id`/`ts`/`name` (so a later GET reconnect
        // reconciles instead of doubling); absent those, we synthesize a local id.
        case 'agent-message': {
          const id = typeof frame.id === 'string' && frame.id ? frame.id : newId()
          const ts = typeof frame.ts === 'number' ? frame.ts : Date.now()
          const name = typeof frame.name === 'string' && frame.name ? frame.name : 'Agent'
          ingest({ id, kind: 'agent', name, text: String(frame.text ?? ''), ts, mine: false })
          break
        }
        // Human Send broadcast by the server (SPEC §8.2): a stored Message so a
        // second browser and a reloaded panel see it; dedupes the operator's own
        // optimistic echo against the stored copy by `id`.
        case 'message': {
          const m = frame.message as Message | undefined
          if (!m || typeof m.id !== 'string') break
          ingest(toLine(m, m.author.kind === 'human' && myIds.current.has(m.id)))
          break
        }
        // [v5.1, SPEC §8.2] A Send's lifecycle changed (queued → working → done, or stalled).
        // [v6, SEAM §4] The frame now carries `recipient` (the aggregate for a broadcast); we
        // pass it through so a line can backfill its addressee, but the badge stays per-message.
        case 'message-state': {
          const id = typeof frame.id === 'string' ? frame.id : ''
          const state = frame.state as SendState | undefined
          if (!id || (state !== 'queued' && state !== 'working' && state !== 'stalled' && state !== 'done')) break
          applyMessageState(id, state, coerceRecipient(frame.recipient))
          break
        }
        // [v5, SPEC §8.6/decision #29] A lead parked or left; drives the LEAD-default banner.
        case 'parked': {
          if (typeof frame.agentParked === 'boolean') setAgentParked(frame.agentParked)
          break
        }
        // [v9.3, SPEC §7] The lead's liveness changed. Analogous to `parked`, but this is the
        // "session ended" signal: it stays true through the wake→re-arm gap and only goes false
        // on confirmed death. Wired the SAME way as `parked`.
        case 'lead-alive': {
          if (typeof frame.leadAlive === 'boolean') setLeadAlive(frame.leadAlive)
          break
        }
        // [v6, SPEC §7, SEAM §4/§10] The per-agent roster changed; drives the recipient
        // selector's worker list and the status strip. The bridge dedupes by value, so we
        // just replace the roster wholesale.
        case 'agent-status': {
          setAgents(coerceAgents(frame.agents))
          rosterLoadedRef.current = true
          break
        }
        // [v9.6, fix 4] The sync server is tearing this room down; fires once, no reconnect coming.
        // Definitive (unlike the debounced disconnect read), so it raises the banner immediately.
        case 'server-closing': {
          setServerClosing(true)
          break
        }
        // Per-session agent cursor (SPEC §7). See presence.ts for the verified
        // propagation limit: this renders on the render-canvas; human-visible
        // cursors are injected server-side by the bridge.
        case 'presence': {
          presenceRef.current?.apply(frame as unknown as PresenceFrame)
          break
        }
        // Perception read path (SPEC §6): the bridge's GET /shapes asks over WS.
        case 'get-shapes': {
          const id = String(frame.id ?? '')
          if (!editor) {
            send({ type: 'shapes-result', id, ok: false, error: 'editor not ready' })
            break
          }
          const shapes = editor.getCurrentPageShapes()
          const page = editor.getCurrentPage()
          const camera = editor.getCamera()
          const selection = editor.getSelectedShapeIds()
          let safeShapes: unknown
          try {
            safeShapes = JSON.parse(JSON.stringify(shapes))
          } catch {
            safeShapes = []
          }
          send({
            type: 'shapes-result',
            id,
            ok: true,
            shapes: safeShapes,
            page: { id: page.id, name: page.name },
            camera: { x: camera.x, y: camera.y, z: camera.z },
            selection,
          })
          break
        }
        // [v9.5, SPEC §5] Store-health probe for the server's honest-contract detection and
        // recovery (slice B/C). possiblyCorrupted is the load-bearing signal and is ALWAYS
        // reachable from the store, even when the sync client is not, so it is read directly.
        // window.tlsync is the raw @tldraw/sync client IF something has exposed it on window:
        // @tldraw/sync's useSync does not expose it publicly (verified against 5.4.2), so it is
        // normally absent here. When it is absent we fall back to the reachable useSync status
        // wrapper for connectivity and report the client-only fields (speculativeAdded,
        // lastServerClock) as empty. The server treats documentClock advance as the primary
        // "reached room" signal and possiblyCorrupted as the corruption signal, so those two
        // client-only fields are supplementary.
        case 'sync-health': {
          const id = String(frame.id ?? '')
          const possiblyCorrupted =
            (editor?.store as unknown as { isPossiblyCorrupted?: () => boolean } | undefined)
              ?.isPossiblyCorrupted?.() ?? false
          const tlsync = (
            window as unknown as {
              tlsync?: {
                isConnectedToRoom?: boolean
                speculativeChanges?: { added?: Record<string, unknown> }
                lastServerClock?: number
              }
            }
          ).tlsync
          let connectedToRoom: boolean
          let speculativeAdded: number
          let lastServerClock: number | null
          if (tlsync) {
            connectedToRoom = tlsync.isConnectedToRoom === true
            speculativeAdded = Object.keys(tlsync.speculativeChanges?.added ?? {}).length
            lastServerClock = typeof tlsync.lastServerClock === 'number' ? tlsync.lastServerClock : null
          } else {
            const status = syncStatusRef.current
            connectedToRoom = status.status === 'synced-remote' && status.connectionStatus === 'online'
            speculativeAdded = 0
            lastServerClock = null
          }
          send({
            type: 'sync-health-result',
            id,
            possiblyCorrupted,
            connectedToRoom,
            speculativeAdded,
            lastServerClock,
          })
          break
        }
      }
    },
    [ingest, applyMessageState, exportAndUpload, send],
  )

  // [v5, SPEC §8.6] Seed / refresh `agentParked` from /canvas-status (human only).
  // Called on mount and on every (re)connect; the live `parked` frame keeps it
  // current between refreshes. A fetch failure leaves the flag untouched (unknown).
  const refreshStatus = useCallback(async () => {
    if (ROLE !== 'human') return
    try {
      const status = await fetchCanvasStatus()
      setAgentParked(status.agentParked)
      // [v9.3, SPEC §7] Seed the lead-liveness signal. Read defensively (the bridge SEAM adds
      // `leadAlive` to CanvasStatus; until that type lands we read it off the value): a boolean
      // seeds true/false, anything else (a pre-v9.3 bridge that omits it) stays `null` = unknown,
      // so an unresolved liveness never accuses — exactly like the `agentParked` null discipline.
      const la = (status as { leadAlive?: boolean }).leadAlive
      setLeadAlive(typeof la === 'boolean' ? la : null)
      // [v6, SEAM §7/§10] Seed the roster too; `?? []` tolerates a pre-v6 bridge that omits it.
      setAgents(coerceAgents(status.agents ?? []))
      rosterLoadedRef.current = true
      // [v9.1, #53] Reflect the room-wide teardown-requested flag as the "closing…" state; a
      // pre-v9.1 bridge omits it (→ false). Once true it stays true (teardown is terminal).
      if (status.teardownRequested === true) setTeardownRequested(true)
    } catch {
      /* bridge may be briefly unreachable; the live frames still update it */
    }
  }, [])

  // ── WS lifecycle: connect once the editor is mounted ────────────────────────
  useEffect(() => {
    if (!editorReady) return
    let closed = false
    let reconnect: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      const ws = new WebSocket(wsUrl(ROLE, ROOM))
      wsRef.current = ws
      ws.onopen = () => {
        setWsConnected(true)
        // Re-seed the parked flag on every (re)connect so a change missed while the
        // socket was down is corrected, not just the live frames from here on.
        void refreshStatus()
        // On (re)connect, catch up on anything the panel missed while the socket
        // was down (SPEC §8.2), then stay live over the WS. The first full load
        // is done by its own effect; only reconnects fetch incrementally here.
        if (ROLE === 'human' && hydratedRef.current) {
          void (async () => {
            try {
              const msgs = await fetchMessages(ROOM, lastSeenTs.current)
              for (const m of msgs) {
                ingest(toLine(m, m.author.kind === 'human' && myIds.current.has(m.id)))
              }
            } catch {
              /* bridge may be briefly unreachable; the next open retries */
            }
          })()
        }
      }
      ws.onclose = () => {
        setWsConnected(false)
        if (!closed) reconnect = setTimeout(connect, 1000)
      }
      ws.onerror = () => ws.close()
      ws.onmessage = (ev) => {
        let frame: { type: string; [k: string]: unknown }
        try {
          frame = JSON.parse(ev.data as string)
        } catch {
          return
        }
        void handleFrame(frame)
      }
    }
    connect()

    return () => {
      closed = true
      if (reconnect) clearTimeout(reconnect)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [editorReady, handleFrame, ingest])

  // ── load the board list on start (human surface only) ───────────────────────
  const refreshBoards = useCallback(async () => {
    try {
      setBoards(await fetchBoards())
    } catch {
      /* bridge may not be up in dev; ignore */
    }
  }, [])
  useEffect(() => {
    if (ROLE === 'human') {
      void refreshBoards()
      void refreshStatus()
    }
  }, [refreshBoards, refreshStatus])

  // ── panel read model: full history on mount / room load (human only) ─────────
  // GET /messages (no `since`) seeds the log from server truth; reconnects then
  // fetch incrementally in the WS onopen. `hydratedRef` opens that path only
  // after this first load has resolved (SPEC §8.2).
  useEffect(() => {
    if (ROLE !== 'human') return
    let cancelled = false
    void (async () => {
      try {
        const msgs = await fetchMessages(ROOM)
        if (!cancelled) seedFromServer(msgs)
      } catch {
        /* bridge may not be up in dev; the log seeds empty */
      } finally {
        if (!cancelled) hydratedRef.current = true
      }
    })()
    return () => {
      cancelled = true
    }
  }, [seedFromServer])

  // keep the log scrolled to the newest line
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  // ── editor mount: wire the presence manager + a light store-change diff ──────
  // Persistence is the sync server's job now (SPEC §8): no snapshot autosave here.
  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    presenceRef.current = new MultiAgentPresence(editor)

    // Debounced light store-change diff (shape ids only) up the /events WS, so
    // the bridge can nudge the lead that the board moved between turns (SPEC §6).
    const scheduleDiff = () => {
      if (diffTimer.current) clearTimeout(diffTimer.current)
      diffTimer.current = setTimeout(() => {
        const d = pendingDiff.current
        if (d.added.size + d.updated.size + d.removed.size === 0) return
        send({
          type: 'store-change',
          diff: {
            added: [...d.added],
            updated: [...d.updated],
            removed: [...d.removed],
          },
        })
        pendingDiff.current = { added: new Set(), updated: new Set(), removed: new Set() }
      }, 1000)
    }

    // Only user-sourced document changes: excludes our own presence writes
    // (mergeRemoteChanges → source 'remote') and remote sync updates.
    const unlisten = editor.store.listen(
      (entry) => {
        const d = pendingDiff.current
        for (const rec of Object.values(entry.changes.added)) {
          if (rec.typeName === 'shape') d.added.add(rec.id)
        }
        for (const [, to] of Object.values(entry.changes.updated)) {
          if (to.typeName === 'shape') d.updated.add(to.id)
        }
        for (const rec of Object.values(entry.changes.removed)) {
          if (rec.typeName === 'shape') d.removed.add(rec.id)
        }
        scheduleDiff()
      },
      { source: 'user', scope: 'document' },
    )

    // ── Per-object authorship stamping (SPEC §8.6, decision #30) ────────────────
    // Two `editor.sideEffects` handlers stamp `meta.createdBy` / `meta.lastEditedBy`.
    // Both guard `source === 'user'`: the handlers DO fire on remote sync diffs
    // (StoreBeforeCreate/ChangeHandler `source` is 'remote' | 'user', and
    // @tldraw/sync applies peer edits via `store.mergeRemoteChanges`, which stamps
    // 'remote' — verified in @tldraw/store 5.4.2 index.d.ts:379/1783), so the guard
    // is what makes stamping LOCAL-ONLY (invariant: never restamp a synced shape).
    // Using the BEFORE handlers, which return the record to commit, means the meta
    // is set in the SAME write — no `editor.updateShape` second write, so no
    // re-entrancy and no recursion (invariant #3).
    const unstampCreate = editor.sideEffects.registerBeforeCreateHandler(
      'shape',
      (shape, source) => {
        if (source !== 'user') return shape
        const author = resolveAuthor()
        if (!author) return shape
        const meta = { ...shape.meta }
        // createdBy is immutable: only ever set when absent, never overwritten.
        if (!meta.createdBy) meta.createdBy = authorStamp(author)
        meta.lastEditedBy = authorStamp(author)
        return { ...shape, meta }
      },
    )
    const unstampChange = editor.sideEffects.registerBeforeChangeHandler(
      'shape',
      (_prev, next, source) => {
        if (source !== 'user') return next
        const author = resolveAuthor()
        if (!author) return next
        // Rewrite lastEditedBy on each local edit; never touch createdBy (immutable,
        // and no backfill — a shape with no createdBy keeps none: SPEC §8.6).
        return { ...next, meta: { ...next.meta, lastEditedBy: authorStamp(author) } }
      },
    )

    // [v9.5, SPEC §5] Agent render-canvas only: install the validate-first exec write
    // guard so a schema-invalid /exec record is rejected (ok:false with the validation
    // message) before it can flip the store's sticky corruption flag. The human surface
    // never runs /exec, so it is left unguarded.
    const uninstallGuard = ROLE === 'agent' ? installExecShapeGuard(editor) : null

    const dispose = () => {
      unlisten()
      unstampCreate()
      unstampChange()
      uninstallGuard?.()
    }
    ;(editor as unknown as { _wbUnlisten?: () => void })._wbUnlisten = dispose

    setEditorReady(true)
  }, [send])

  // teardown
  useEffect(() => {
    return () => {
      presenceRef.current?.dispose()
      const editor = editorRef.current as unknown as { _wbUnlisten?: () => void } | null
      editor?._wbUnlisten?.()
      if (diffTimer.current) clearTimeout(diffTimer.current)
    }
  }, [])

  // ── panel actions (human surface) ───────────────────────────────────────────
  const onSend = useCallback(async () => {
    const editor = editorRef.current
    const trimmed = text.trim()
    if (!trimmed || !editor) return
    const selection = editor.getSelectedShapeIds() as TLShapeId[]
    // One fresh UUID is BOTH the optimistic echo's id AND the message
    // idempotencyKey (SPEC §4/§8.2): the stored copy arrives with the same id, so
    // the echo reconciles instead of duplicating. Record it in `myIds` so that
    // stored copy is recognized as the operator's own and keeps its "You:" label.
    const id = newId()
    myIds.current.add(id)
    // [v6, SEAM §2/§3] Resolve the chosen recipient once and stamp it on both the optimistic
    // echo (so the line shows its addressee immediately) and the POST (so the bridge routes it).
    const recipient = recipientFor(recipientId, agents)
    ingest({ id, kind: 'human', name: 'You', text: trimmed, ts: Date.now(), mine: true, recipient })
    setText('')
    try {
      await postMessage(trimmed, selection as unknown as string[], id, recipient)
    } catch (err) {
      console.error('send failed', err)
    }
  }, [text, ingest, recipientId, agents])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void onSend()
      }
    },
    [onSend],
  )

  // A board is a room: opening one re-joins its sync room by navigating to
  // ?room=<slug>. The bridge also switches its active board server-side so
  // persistence + the render-canvas follow.
  const gotoRoom = useCallback((room: string) => {
    const url = new URL(location.href)
    url.searchParams.set('room', room)
    url.searchParams.set('role', 'human')
    location.assign(url.toString())
  }, [])

  // [v8 §8.3] Attach to a board hosted by ANOTHER live process: navigate the browser to that
  // process's port (same host, preserving author/authorKey), NOT this port. bridge.ts derives its
  // API/WS base from location, so a cross-port navigation repoints every subsequent call coherently.
  const gotoBoardAt = useCallback((port: number, room: string) => {
    const url = new URL(location.href)
    url.protocol = 'http:'
    url.host = `${location.hostname}:${port}`
    url.searchParams.set('room', room)
    url.searchParams.set('role', 'human')
    location.assign(url.toString())
  }, [])

  // Join the room the bridge names. A board it refused (one it cannot load) is never joined.
  const onOpenBoard = useCallback(
    async (entry: BoardEntry) => {
      try {
        const r = await openBoard(entry.path)
        // The board was already live on another process — attach there instead of same-port.
        if (r.attach && r.port) { gotoBoardAt(r.port, r.room); return }
        gotoRoom(r.room)
      } catch (err) {
        console.error('open board failed', err)
        window.alert(`Could not open ${entry.name}: ${(err as Error).message}`)
      }
    },
    [gotoRoom, gotoBoardAt],
  )

  const onNewBoard = useCallback(async () => {
    const name = window.prompt('New board name?')
    if (!name) return
    try {
      const r = await newBoard(name)
      if (r.attach && r.port) { gotoBoardAt(r.port, r.room); return }
      gotoRoom(r.room)
    } catch (err) {
      console.error('new board failed', err)
      window.alert(`Could not create ${name}: ${(err as Error).message}`)
    }
  }, [gotoRoom, gotoBoardAt])

  // [v6, SPEC §7, decisions #29/#32/#38] The loud "nobody's home" signal, now per recipient.
  // Is the recipient a given waiting Send is addressed to NOT listening?
  //   lead (default) — [v9.3] confirmed-dead only: leadAlive === false (an explicit false, never
  //     the unknown null, so an unresolved liveness never accuses). NOT transient agentParked ===
  //     false, which drops on every normal turn as poll.sh tears down to wake the agent; the
  //     server holds leadAlive true across that wake→re-arm gap via its grace window.
  //   worker — honest per the agents strip: `absent` (dead / never-spawned) or `stalled` (held
  //     a lease then went silent). A present worker (idle / queued / working) is listening.
  //   broadcast — not listening if any targeted worker is absent/stalled, or there is no worker
  //     to hear it at all.
  // A `working` Send is already excluded upstream by `needsLead`, so an active draw never trips it.
  const workers = agents.filter((a) => a.role === 'worker')
  const recipientNotListening = (line: LogLine): boolean => {
    const r = line.recipient
    if (!r || r.kind === 'lead') return leadAlive === false
    if (r.kind === 'broadcast') {
      return workers.length === 0 || workers.some((a) => a.lifecycle === 'absent' || a.lifecycle === 'stalled')
    }
    const a = agents.find((x) => x.role === 'worker' && x.id === r.id)
    if (!a) return false // an unknown worker id → don't accuse
    return a.lifecycle === 'absent' || a.lifecycle === 'stalled'
  }
  const strandedSends = log.filter(needsLead).filter(recipientNotListening)
  const noAgent = strandedSends.length > 0
  const anyStalled = strandedSends.some((l) => l.state === 'stalled')

  // [redesign] The collaborators shown as a presence row and used as tap-to-address targets:
  // the Lead (always, synthesized before the roster arrives so there is always a target) plus
  // every worker. Only these real ids — plus EVERYONE_ID once a worker exists — are tappable,
  // so the panel can never select an unknown recipient id (the 400-safe roster contract).
  //
  // [v9.3, SPEC §7, decision #47] The lead's listening state is driven by the server-computed
  // `leadAlive` signal (kept live by the `lead-alive` WS frame), NOT by transient `agentParked`
  // (which drops on every normal turn as poll.sh tears down to wake the agent) and NOT by a
  // possibly-stale roster entry. `leadAlive` stays TRUE through the wake→re-arm gap (bridged by
  // the server's grace window) and goes false only on CONFIRMED death, so a lead merely between
  // turns — or mid-conversation with the operator — still reads present/listening. The
  // reconciliation, three-valued exactly like the old agentParked force:
  //   leadAlive === true  → listening: a resting 'idle'/'absent' lifecycle becomes 'idle',
  //                         while genuine activity ('working'/'queued') is preserved. (A lead
  //                         never carries 'stalled' post-v9.3 — its liveness is not a lease.)
  //   leadAlive === false → CONFIRMED dead (§7): force 'absent' regardless of a stale roster
  //                         lifecycle, so the avatar dims honestly.
  //   leadAlive === null  → unknown: fall back to whatever the roster carries, never accuse.
  // `agentParked` still sets the `parked` boolean (the little parked dot) when known, but no
  // longer drives the lifecycle force.
  const leadBase: AgentStatus =
    agents.find((a) => a.role === 'lead') ?? {
      id: LEAD_ID,
      name: 'Lead',
      role: 'lead',
      parked: false,
      lifecycle: 'idle',
      color: '', // agentColor falls the lead back to the product accent
    }
  const leadEntry: AgentStatus = {
    ...leadBase,
    // The parked dot still reflects agentParked (transient) when known; unknown keeps the roster's.
    parked: agentParked === null ? leadBase.parked : agentParked,
    lifecycle:
      leadAlive === false
        ? 'absent'
        : leadAlive === true
          ? leadBase.lifecycle === 'absent'
            ? 'idle'
            : leadBase.lifecycle
          : leadBase.lifecycle,
  }
  const roster: AgentStatus[] = [leadEntry, ...workers]

  // [redesign] The current board's display name for the switcher trigger: the boards list entry
  // whose room matches the joined ROOM, else the ROOM slug itself.
  const currentBoard = boards.find((b) => b.room === ROOM)
  const currentBoardName = currentBoard?.name ?? ROOM
  // What to type to reopen this board: its name for a board in the boards folder, else its path.
  const resumeTarget = currentBoard ? (currentBoard.source === 'home' ? currentBoard.name : currentBoard.path) : ROOM

  // [v9.1, #53] The panel's "closing…" state: this browser's optimistic latch OR the room-wide
  // flag any browser reads from /canvas-status. It drives the calm closing notice and the
  // control's own label.
  const isClosing = closing || teardownRequested

  // [redesign] Who the compose bar is addressed to, for the "To" indicator. Everyone is a
  // pseudo-target (accent-colored); otherwise the matching roster entry, defaulting to the Lead.
  const addressed =
    recipientId === EVERYONE_ID
      ? { name: 'Everyone', color: 'var(--wb-accent)' }
      : (() => {
          const a = roster.find((x) => x.id === recipientId) ?? leadEntry
          return { name: a.name, color: agentColor(a) }
        })()

  // [reskin] The pure identity hue for a chat line's leading dot — the operator's own lines in the
  // "you" color, an agent's line in its identity color (matched by name against the live roster),
  // else the neutral accent. Unlike the old design this hue no longer tints the NAME text (which
  // now reads in the neutral text color for a calm, un-toy hierarchy); it only fills the small
  // 6px dot before the name (Linear/Slack pattern), so no AA text blend is needed here.
  const pureColorForLine = (line: LogLine): string => {
    if (line.kind === 'human') return 'var(--wb-you)'
    const a = agents.find((x) => x.name === line.name)
    return a ? agentColor(a) : 'var(--wb-accent)'
  }

  // ── render ──────────────────────────────────────────────────────────────────
  // Agent surface: just the canvas (the operator panel is hidden — it is
  // offscreen in Playwright and only screenshots + the Editor are needed).
  if (ROLE === 'agent') {
    return (
      <div className="wb-root wb-agent">
        <div className="wb-canvas">
          <Tldraw store={store} onMount={onMount} />
        </div>
      </div>
    )
  }

  // Human surface: full panel + collapsible zen mode.
  return (
    <div className={panelOpen ? 'wb-root' : 'wb-root wb-collapsed'}>
      <button
        type="button"
        className="wb-toggle"
        onClick={togglePanel}
        title={`${panelOpen ? 'Collapse' : 'Open'} panel  (⌘/Ctrl + \\)`}
        aria-label={panelOpen ? 'Collapse panel' : 'Open panel'}
      >
        <span className="wb-toggle-grip">{panelOpen ? '›' : '‹'}</span>
        {!panelOpen && unread && <span className="wb-unread" />}
      </button>

      <div className="wb-canvas">
        <Tldraw store={store} onMount={onMount} />
        {/* [v9.6, fix 4] Silent-data-loss guard. A canvas overlay (not a panel notice) so it
            survives panel-collapse and is unmissable. `serverClosing` is definitive and takes
            priority; `showDisconnected` is the debounced sync-store read. role="alert" — urgent. */}
        {(serverClosing || showDisconnected) && (
          <div className="wb-disconnect-banner" role="alert">
            <span className="wb-disconnect-dot" aria-hidden="true" />
            <span className="wb-disconnect-text">
              {serverClosing
                ? 'This board is closing. Your changes are no longer being saved — export now if you have unsaved edits.'
                : 'Disconnected from the board. Your changes are not being saved — export the board now, and don’t rely on further edits syncing.'}
            </span>
          </div>
        )}
      </div>

      <aside className="wb-panel" aria-label="Collaboration panel">
        <div className="wb-panel-inner">
          {/* Board switcher: a slim trigger that opens a popover (Miro/tldraw pattern),
              replacing the always-open scrolling board list and its header/row crunch. */}
          <div className="wb-topbar" ref={boardMenuRef}>
            <button
              type="button"
              className="wb-board-trigger"
              aria-haspopup="menu"
              aria-expanded={boardMenuOpen}
              onClick={() => setBoardMenuOpen((o) => !o)}
              title="Switch board"
            >
              <span className="wb-board-name">{currentBoardName}</span>
              <span className="wb-caret" aria-hidden="true">▾</span>
            </button>
            <span
              className={`wb-conn ${wsConnected ? 'on' : 'off'}`}
              role="status"
              title={wsConnected ? 'Connected' : 'Reconnecting…'}
              aria-label={wsConnected ? 'Connected' : 'Reconnecting'}
            />
            {boardMenuOpen && (
              // A plain popover, not an ARIA menu widget: the trigger carries aria-haspopup/
              // aria-expanded and Escape/outside-click dismiss it, but we deliberately do NOT
              // claim role="menu" (which would require a roving-focus keyboard model).
              <div className="wb-board-popover">
                <div className="wb-board-popover-head">
                  <span>Boards</span>
                  <button
                    type="button"
                    className="wb-new"
                    onClick={() => {
                      setBoardMenuOpen(false)
                      void onNewBoard()
                    }}
                  >
                    + New
                  </button>
                </div>
                <ul className="wb-board-menu">
                  {boards.length === 0 && <li className="wb-menu-empty">No boards yet</li>}
                  {boards.map((b) => {
                    const active = b.room === ROOM
                    return (
                      <li key={b.path || b.name}>
                        <button
                          type="button"
                          className={active ? 'wb-board-item is-active' : 'wb-board-item'}
                          title={b.path}
                          onClick={() => {
                            setBoardMenuOpen(false)
                            void onOpenBoard(b)
                          }}
                        >
                          <span className="wb-board-item-name">{b.name}</span>
                          {/* Only the current board is marked (a check). The board's `source`
                              ('home' | 'repo') is internal provenance, not something the operator
                              chooses a board by, so it is not surfaced as a raw row tag. */}
                          {active && (
                            <span className="wb-board-check" aria-label="current board">✓</span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
                {/* [v9.1, #53] The operator's ONLY deliberate teardown signal, kept unobtrusive in
                    the switcher footer rather than competing with Send. Confirm-gated in-app (never
                    a browser confirm): "Close session" expands to Confirm/Cancel, and only Confirm
                    posts /request-teardown. The lead then performs the graceful /done. */}
                <div className="wb-popover-footer">
                  {isClosing ? (
                    <span className="wb-close-progress" role="status">
                      <span className="wb-close-dot" aria-hidden="true" />
                      Closing session…
                    </span>
                  ) : closeArm ? (
                    <div className="wb-close-confirm" role="group" aria-label="Confirm closing the session">
                      <span className="wb-close-q">Close session?</span>
                      <div className="wb-close-choices">
                        <button
                          type="button"
                          className="wb-close-affirm"
                          onClick={() => void onConfirmClose()}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="wb-close-cancel"
                          onClick={() => setCloseArm(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="wb-close-session"
                      onClick={() => setCloseArm(true)}
                      title="Ask the collaborator to wrap up and disconnect"
                    >
                      Close session
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Collaborators: a slim presence row of identity-colored avatars — the Lead and each
              worker — that doubles as the targeting surface. Tap an avatar to address it (default
              is the Lead); Everyone appears once a worker exists. Only real roster ids are
              tappable, so the panel can never select an unknown recipient (the 400-safe contract). */}
          <div className="wb-presence" role="group" aria-label="Collaborators — tap one to address it">
            {roster.map((a) => {
              const selected = recipientId === a.id
              const state = avatarState(a)
              const color = agentColor(a)
              return (
                <button
                  type="button"
                  key={a.id}
                  className={`wb-avatar${selected ? ' is-selected' : ''}`}
                  style={
                    { '--wb-id-color': color, '--wb-on-id': discLabelColor(color) } as CSSProperties
                  }
                  onClick={() => onRecipientChange(a.id)}
                  aria-pressed={selected}
                  title={`${a.name} — ${a.lifecycle}${a.parked ? ' · listening' : ''}${selected ? ' · addressing' : ''}`}
                >
                  <span className="wb-av-figure">
                    <span className="wb-av-disc">{avatarLabel(a.name)}</span>
                    <span className={`wb-av-dot wb-av-dot-${state}`} aria-hidden="true" />
                  </span>
                  <span className="wb-av-name">{a.name}</span>
                </button>
              )
            })}
            {workers.length > 0 && (
              <button
                type="button"
                className={`wb-everyone${recipientId === EVERYONE_ID ? ' is-selected' : ''}`}
                onClick={() => onRecipientChange(EVERYONE_ID)}
                aria-pressed={recipientId === EVERYONE_ID}
                title="Address everyone on the board"
              >
                Everyone
              </button>
            )}
          </div>

          {/* [v9.1, #53] Calm, persistent "closing…" state — visible whether or not the switcher
              popover is open, since teardown is a room-wide terminal state (any browser reflects it
              from /canvas-status). Not an alarm: the session stays live until the lead's /done. */}
          {isClosing && (
            <div className="wb-closing" role="status">
              <span className="wb-closing-dot" aria-hidden="true" />
              <span className="wb-closing-text">
                Closing the session. The collaborator will wrap up and disconnect.
              </span>
            </div>
          )}

          {/* The room: chat in each collaborator's identity color. */}
          <div className="wb-log" ref={logRef}>
            {log.length === 0 && (
              <div className="wb-log-empty">
                <p className="wb-log-empty-title">You're on the board</p>
                <p className="wb-log-empty-sub">
                  Say hello, or ask a collaborator to sketch something. Select shapes first to
                  point at them.
                </p>
              </div>
            )}
            {log.map((line) => {
              const label = line.mine ? 'You' : line.name
              // [v6, SPEC §4] Show the addressee alongside the author for a worker/broadcast Send
              // ("You → Claude-2"); a plain lead Send stays clean ("You").
              const addr = addresseeLabel(line)
              const life = lifecycleLabel(line)
              return (
                <div
                  className="wb-log-line"
                  key={line.id}
                  style={{ '--wb-line-color': pureColorForLine(line) } as CSSProperties}
                >
                  <span className="wb-who">
                    <span className="wb-who-dot" aria-hidden="true" />
                    <span className="wb-who-name">{label}</span>
                    {addr && <span className="wb-to"> → {addr}</span>}
                    {life && (
                      <span className={`wb-life wb-life-${life.cls}`} title={`Send ${life.text}`}>
                        {life.text}
                      </span>
                    )}
                  </span>
                  <span className="wb-msg">{line.text}</span>
                </div>
              )
            })}
          </div>

          {/* A calm inline notice — not an alarm — when a Send is waiting for someone to join. */}
          {noAgent && (
            <div className={anyStalled ? 'wb-notice wb-notice-stalled' : 'wb-notice'} role="status">
              <span className="wb-notice-dot" aria-hidden="true" />
              <span className="wb-notice-text">
                {anyStalled
                  ? 'A collaborator stepped away mid-task. Your message is re-queued and will be picked up when they are back.'
                  : 'No one is on the board yet. Your message is queued and will be delivered when a collaborator joins.'}{' '}
                Run <code>/whiteboard open {resumeTarget}</code> to resume.
              </span>
            </div>
          )}

          {/* Compose: the "To" chip shows who you are addressing (set by tapping an avatar). The
              recipient still drives recipientId / onRecipientChange and is sent via onSend. */}
          <div className="wb-compose">
            <div className="wb-compose-to">
              <span className="wb-to-caption">To</span>
              <span
                className="wb-to-chip"
                style={{ '--wb-id-color': addressed.color } as CSSProperties}
              >
                <span className="wb-to-swatch" aria-hidden="true" />
                {addressed.name}
              </span>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={`Message ${addressed.name}…`}
              rows={3}
            />
            <div className="wb-compose-actions">
              <span className="wb-send-hint" aria-hidden="true">
                <kbd>⌘</kbd><kbd>↵</kbd> to send
              </span>
              <button
                type="button"
                className="wb-send"
                onClick={() => void onSend()}
                disabled={!text.trim()}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}

export default App
