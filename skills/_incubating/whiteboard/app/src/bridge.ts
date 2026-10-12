// ─────────────────────────────────────────────────────────────────────────────
// BRIDGE CONTRACT (app ↔ Node bridge + sync server) — the seam the bridge
// builder must match. See SPEC.md §3/§4/§5/§6/§7.
//
// One Node process serves three things on the SAME origin (http://127.0.0.1:5179):
//   1. app/dist static  at /
//   2. the sync server  at /sync/<room>   (WS; @tldraw/sync-core TLSocketRoom,
//      one room per board — this is where the board itself lives + persists)
//   3. the bridge WS     at /events        (WS; control channel below)
//
// ── ROLE + ROOM (v3) ─────────────────────────────────────────────────────────
// The app reads its identity from the URL query string:
//   ?role=human|agent   (default human)   which surface this instance is
//   ?room=<slug>        (default board)   which sync room to join
// The bridge launches the headless render-canvas (Playwright) with
//   ?role=agent&room=<slug>  and opens the operator's browser with
//   ?role=human&room=<slug>.
//
// ── SYNC (v3) ────────────────────────────────────────────────────────────────
// The board is a tldraw SYNC room. The app joins it with @tldraw/sync `useSync`
// against `syncUrl(room)` (= ws(s)://<host>/sync/<room>). The sync server owns
// the board document AND its persistence (writes the room to <name>.tldr on an
// interval / onDataChange). The app NO LONGER posts snapshots — /snapshot is
// gone. Switching boards = joining a different room = navigating to ?room=<slug>.
//
// ── PRESENCE — VERIFIED, READ THIS (v3, SPEC §7) ─────────────────────────────
// Verified against installed @tldraw/sync-core 5.4.2 types: a sync client
// broadcasts EXACTLY ONE presence record (TLSyncClient `presence: Signal`), and
// pushes ONLY document-scoped diffs. instance_presence records written into a
// client's synced store are NOT replicated to peers. Therefore N agent cursors
// visible in the HUMAN's browser MUST be injected SERVER-SIDE by the bridge into
// the TLSocketRoom (SPEC §3/§4 "presence inject"), one presence record per
// registered sessionId. The app-side MultiAgentPresence (presence.ts, driven by
// the `presence` frame below) is the render-canvas-LOCAL renderer + a fallback
// if the bridge chooses to route presence through the render-canvas instead.
//
// ── SESSIONS (v3, SPEC §4) ───────────────────────────────────────────────────
// The bridge owns per-session identity: POST /session/register {name,color?} →
// {sessionId}. `exec`, `agent-message`, and `presence` frames carry that
// sessionId so the bridge attributes cursor motion/state to the right agent.
//
// ── ADDRESSABLE WORKERS (v6, SPEC §4/§7/§8.2, decisions #36/#38) ──────────────
// v5.1 had ONE lead as the sole consumer of Sends; v6 keeps the lead as the
// default recipient and adds N addressable worker subagents. A human Send now
// carries a `recipient` (see the `Recipient` type below): the lead (default —
// absent recipient == the lead, so the v5 shape is unchanged), a named worker
// (routed by its stable recipient id), or `everyone` (broadcast). The panel
// learns the live worker roster from the `agents` array on GET /canvas-status
// (seed) kept current by the `agent-status` WS frame, and renders a per-agent
// status strip from it (SPEC §7). The recipient id is a STABLE string (a
// worker's clientKey), NOT a sessionId — a revived worker re-registers with the
// same clientKey, so routing survives its death (SEAM §1/§2).
//
// HTTP endpoints the app CALLS on the bridge:
//   POST /message   body {text, selection:string[], idempotencyKey, recipient?}  operator Send (human)
//                   [v6] `recipient` is {kind,id?,name?}; absent == the lead (v5 default).
//   GET  /boards         → [{name, path, source, room}]          board discovery
//   POST /board/open       body {path}  → {attach, port?, room}  switch active board
//   POST /board/new        body {name}  → {attach, port?, room}  create empty board
//        `room` is the server's id for the board (derived from its file path); the app always
//        joins the room the server names. A board the server cannot load is a 4xx with {error}.
//   POST /image-upload?id=<id>   raw body, Content-Type image/png   PNG export delivery
//        (bridge writes the bytes to <boards folder>/<room>.png and owns the
//         path; `id` correlates the upload with the exec/export that triggered it.)
//   POST /request-teardown  body {room}  → {ok:true}                 operator teardown (human)
//        [v9.1, SPEC §8.2/§8.4, decision #53] The confirm-gated close-session control's
//        signal. NOT a chat Message: it never enters the attributed log or a recipient queue.
//        The bridge sets a per-room teardown-requested flag (surfaced on GET /canvas-status
//        below and raised to the lead's supervise=1 poll as a teardown directive); the LEAD
//        performs the actual graceful POST /done. This is the operator's ONLY deliberate
//        teardown signal — the lead never hangs up at its own discretion (SPEC §7/§9).
//
// WS /events frames (the render-canvas connects as role=agent, the operator as
// role=human; the app tags its socket with ?role & ?room):
//   up   (app→bridge): {type:'store-change', diff:{added,updated,removed}} (shape ids only)
//                      {type:'exec-result', id, ok, result?, error?}      (agent)
//                      {type:'image', id, ok, error?}                     (agent, upload notice)
//   down (bridge→app): {type:'exec', id, code, sessionId?,
//                             author?:{kind:'agent',sessionId,name,color}}  (→ agent)
//                          [v5] `author` is the per-/exec author context stamped
//                          onto every shape the blob creates/edits (SPEC §8.6).
//                      {type:'export-image', id}                         (→ agent)
//                      {type:'get-shapes', id}                           (→ agent)
//                      {type:'agent-message', text, sessionId?}          (→ human log)
//                      {type:'message-state', id, state, recipient?, deliveredAt?, completedAt?}  (→ human)
//                          [v5] a Send's lifecycle change; panel matches by `id`.
//                          [v6] `recipient` echoes which recipient this state is for
//                          (a broadcast reports the aggregate over all its workers).
//                      {type:'parked', agentParked:boolean}              (→ human)
//                          [v5] a lead parked/left; drives the LEAD avatar's parked dot.
//                      {type:'lead-alive', leadAlive:boolean}            (→ human)
//                          [v9.3] the lead's honest liveness (armed listener or receipt holder
//                          within the grace window); drives the LEAD-default no-agent banner and
//                          the avatar dim, staying true through the wake→re-arm gap.
//                      {type:'agent-status', agents:AgentStatus[]}       (→ human)
//                          [v6] the per-agent roster + lifecycle/parked; drives the
//                          recipient selector's worker list and the status strip (SPEC §7).
//                      {type:'server-closing', room}                     (→ human)
//                          [v9.6] the sync server is tearing this room down; fires once, no
//                          reconnection expected. Drives the human disconnect banner (definitive,
//                          not debounced) — edits from here on sync nowhere.
//                      {type:'presence', sessionId, name?, color?,
//                             state:'idle'|'thinking'|'drawing', cursor?:{x,y}}  (→ agent)
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'human' | 'agent'

// Role + room come from the URL; the bridge sets them when it launches each surface.
export function readRole(): Role {
  if (typeof location === 'undefined') return 'human'
  return new URLSearchParams(location.search).get('role') === 'agent' ? 'agent' : 'human'
}

export function readRoom(): string {
  if (typeof location === 'undefined') return 'board'
  return new URLSearchParams(location.search).get('room') || 'board'
}

// [decision #54] The bound CC session's semantic name, passed in the URL by the
// skill when it opens the operator's browser (`&session=<urlencoded>`). Powers the
// per-tab title. Absent (the skill could not resolve a name) → '' so the tab keeps
// the plain "Whiteboard".
export function readSession(): string {
  if (typeof location === 'undefined') return ''
  return new URLSearchParams(location.search).get('session') || ''
}

// [v5, SPEC §4/§8.6] The human surface's author identity, passed in the URL by the
// skill when it opens the operator's browser (`&author=<name>&authorKey=<stable>`).
// `name` defaults to "Operator" so an un-parameterized load still stamps a coherent
// author. `authorKey` is a stable per-person id that becomes the stamp's `sessionId`.
export function readAuthor(): { name: string; authorKey?: string } {
  if (typeof location === 'undefined') return { name: 'Operator' }
  const p = new URLSearchParams(location.search)
  const name = p.get('author') || 'Operator'
  const authorKey = p.get('authorKey') || undefined
  return { name, authorKey }
}

// Base-URL derivation (SPEC §3 / §8.3 build constraint). The bridge serves this
// app SAME-ORIGIN on an OS-assigned ephemeral port, so the HTTP base is
// `window.location.origin` and the WS base is the ws(s):// equivalent of
// `window.location.host` — NEVER a hardcoded port. The single exception is the
// Vite dev server (`import.meta.env.DEV`), where the app runs on its own port and
// the bridge is reached at a fixed localhost dev port.
const DEV_BRIDGE_HOST = '127.0.0.1:5179'

function isDev(): boolean {
  return typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)
}

// HTTP origin of the bridge (no trailing slash). Served case: window.location.origin.
function httpOrigin(): string {
  if (isDev()) return `http://${DEV_BRIDGE_HOST}`
  if (typeof location !== 'undefined' && location.origin) return location.origin
  return `http://${DEV_BRIDGE_HOST}`
}

// WS origin of the bridge (ws://host or wss://host), protocol matched to the page.
function wsOrigin(): string {
  if (isDev()) return `ws://${DEV_BRIDGE_HOST}`
  if (typeof location !== 'undefined' && location.host) {
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
  }
  return `ws://${DEV_BRIDGE_HOST}`
}

// The bridge control-channel WS. Tag the socket with role + room so the bridge
// routes exec/presence to the render-canvas and agent-message to the operator.
export function wsUrl(role: Role, room: string): string {
  const q = `role=${encodeURIComponent(role)}&room=${encodeURIComponent(room)}`
  return `${wsOrigin()}/events?${q}`
}

// The tldraw sync-room WS (owned by the sync server, one room per board).
export function syncUrl(room: string): string {
  return `${wsOrigin()}/sync/${encodeURIComponent(room)}`
}

export function apiUrl(path: string): string {
  return `${httpOrigin()}${path}`
}

export type BoardEntry = { name: string; path: string; source: string; room: string }

export async function fetchBoards(): Promise<BoardEntry[]> {
  const res = await fetch(apiUrl('/boards'))
  if (!res.ok) throw new Error(`GET /boards ${res.status}`)
  return (await res.json()) as BoardEntry[]
}

// The persisted, attributed chat message (SPEC §8.2). `id` == the message
// idempotencyKey (one stable UUID); ts is server receipt time (epoch ms).
export type MessageAuthor = {
  kind: 'human' | 'agent'
  name: string
  sessionId?: string
  color?: string
}

// [v5, SPEC §4/§8.6] A contributor identity — used both for a message's author and,
// with an `at` timestamp, as a shape's per-object authorship stamp (`AuthorStamp`).
// Kept structurally identical to `MessageAuthor` for codebase consistency (§8.6).
export type AuthorIdentity = {
  kind: 'human' | 'agent'
  name: string
  sessionId?: string
  color?: string
}

// [v5, SPEC §8.6] What lands in `shape.meta.createdBy` / `shape.meta.lastEditedBy`:
// the author identity plus when it was stamped. `createdBy` is immutable (stamped
// once); `lastEditedBy` is rewritten on each local edit.
export type AuthorStamp = AuthorIdentity & { at: number }

// [v5.1, SPEC §8.2] A human Send's lifecycle state, computed server-side (single source of
// truth). queued: awaiting a lead. working: leased to a live lead that is drawing it.
// stalled: was delivered but the lead went silent — the lease expired and it is re-queued
// for redelivery. done: completed. The panel renders this directly (never re-derives it).
export type SendState = 'queued' | 'working' | 'stalled' | 'done'

// [v6, SEAM §1/§2, SPEC §4/§8.2] The routing target of a human Send. `id` is the
// STABLE recipient id — the lead's reserved `'lead'`, or a worker's `clientKey` —
// NOT a sessionId (a revived worker re-registers with the same clientKey, so
// routing must key on identity, not the session, which changes on revival). We
// deliberately store `id` where SPEC §8.2 sketches `sessionId`; this is the
// "recipient id" §4/§8.5 name throughout. `name` is display only.
//   lead      → { kind:'lead', id:'lead' } (or absent — absent == the lead)
//   worker    → { kind:'worker', id:<clientKey>, name?:'Claude-2' }
//   everyone  → { kind:'broadcast' } (id/name omitted — a broadcast is not a session)
export type Recipient = {
  kind: 'lead' | 'worker' | 'broadcast'
  id?: string
  name?: string
}

export type Message = {
  id: string
  room: string
  ts: number
  author: MessageAuthor
  text: string
  selection?: string[]
  // [v6, SPEC §8.2] Routing target (human Sends only). Absent == the lead (the v5
  // default), so a plain Send is byte-identical to v5. Does not change how the
  // message is stored, attributed, or shown — only who drains it.
  recipient?: Recipient
  // [v5, SPEC §8.2] Send lifecycle (human Sends only): deliveredAt set when a lead takes the
  // instruction via /next-instruction; completedAt when it reports the turn done via
  // /instruction-complete. [v5.1] `state` is the authoritative label derived from these plus
  // the live lease — GET /messages and every `message-state` frame carry it. [v6] For a
  // broadcast these are the aggregate (done only once every worker completes).
  deliveredAt?: number
  completedAt?: number
  state?: SendState
}

// [v6, SEAM §7, SPEC §7] One agent's live status, computed server-side. The panel
// renders `lifecycle` and `parked` verbatim (never re-derives them). The roster is
// the lead (always) ∪ every registered worker session ∪ every worker recipient id
// that has a pending Send but no live session (an `absent` worker — what revival
// acts on). `id` is the recipient id ('lead' or a worker clientKey).
export type AgentStatus = {
  id: string
  name: string
  color: string // identity hex ('#7C4DFF'): live presence color, else a deterministic fallback
  role: 'lead' | 'worker'
  parked: boolean // a live long-poll waiter exists for this id right now
  lifecycle: 'idle' | 'queued' | 'working' | 'stalled' | 'absent'
}

// [v5, SPEC §8.6/§11, decision #29] The bridge's liveness snapshot. `agentParked` is
// true iff a live long-poll waiter (a parked LEAD) exists; false is the loud
// "nobody's listening" signal for the default (lead) recipient. [v6] `agents` is the
// per-agent roster (SEAM §7) — the recipient selector's worker list and the status
// strip seed from it, then stay live over the `agent-status` frame.
export type CanvasStatus = {
  agentParked: boolean
  // [v9.3, SPEC §9, decision #55] The honest lead-liveness signal: true when an armed lead listener
  // exists OR the receipt holder was seen within the grace window; false only on confirmed death.
  // The panel keys the "no one on the board" banner and the lead avatar dim on THIS, not the
  // transient `agentParked`, so a normal turn's wake→re-arm gap never reads as "session ended".
  // Optional so a pre-v9.3 bridge that omits it reads as unknown (never accuse) rather than throwing.
  leadAlive?: boolean
  agents: AgentStatus[]
  // [v9.1, SPEC §8.2/§8.4, decision #53] Whether the operator has requested teardown for this
  // room (via POST /request-teardown). The panel reflects it as a calm "closing…" state until
  // the lead performs its graceful /done. Optional so a pre-v9.1 bridge that omits it reads as
  // not-closing rather than throwing.
  teardownRequested?: boolean
  // [v8 §8.3] The board this process hosts. Used by the runtime one-server guard's probe; the
  // panel does not read it, but the type mirrors the seam so the field is not silently dropped.
  activeRoom?: string
}

// Seed `agentParked` on panel load / reconnect (SPEC §8.6). A failure leaves the
// flag unknown; the panel treats unknown as "don't accuse", falling back to the live
// `parked` WS frame once it arrives.
export async function fetchCanvasStatus(): Promise<CanvasStatus> {
  const res = await fetch(apiUrl('/canvas-status'))
  if (!res.ok) throw new Error(`GET /canvas-status ${res.status}`)
  return (await res.json()) as CanvasStatus
}

// The panel's read model source (SPEC §8.2). `since` omitted returns the full
// history for the room; on reconnect the panel passes its last-seen ts.
export async function fetchMessages(room: string, since?: number): Promise<Message[]> {
  const q = new URLSearchParams({ room })
  if (since !== undefined) q.set('since', String(since))
  const res = await fetch(apiUrl(`/messages?${q.toString()}`))
  if (!res.ok) throw new Error(`GET /messages ${res.status}`)
  const body = (await res.json()) as { messages?: Message[] }
  return body.messages ?? []
}

// Operator Send (SPEC §4/§8.2). `idempotencyKey` doubles as the message `id` so
// the server stores it under that id and the panel dedupes its optimistic echo
// against the stored copy. [v6] `recipient` routes the Send (SEAM §3); it is
// OMITTED from the body when absent so a lead-addressed Send is byte-identical to
// the v5 shape (absent == the lead — keeps the zero-worker case unchanged).
export async function postMessage(
  text: string,
  selection: string[],
  idempotencyKey: string,
  recipient?: Recipient,
): Promise<void> {
  const body: Record<string, unknown> = { text, selection, idempotencyKey }
  if (recipient) body.recipient = recipient
  await fetch(apiUrl('/message'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// [v9.1, SPEC §8.2/§8.4, decision #53] Post the operator's confirm-gated teardown request. A
// distinct control signal, not a `POST /message`, so it never enters the attributed chat log or
// a recipient queue: the bridge raises a per-room teardown directive on the lead's supervise poll
// and the LEAD performs the graceful `POST /done`. Throws on a non-200 so the panel can revert its
// optimistic "closing…" state rather than get stuck. Success is `{ ok: true }`.
export async function requestTeardown(room: string): Promise<void> {
  const res = await fetch(apiUrl('/request-teardown'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room }),
  })
  if (!res.ok) throw new Error(`POST /request-teardown ${res.status}`)
}

// [v8 §8.3] The bridge's answer to "open this board". `attach:true` means the board is already
// hosted by ANOTHER live process (at `port`) — the caller must navigate the browser to that port
// rather than trust this process to have switched (it deliberately did NOT steal the lock).
// `attach:false` means this process switched to the board in-process (the common single-server case).
export type OpenBoardResult = { attach: boolean; port?: number; room: string }

async function postBoard(endpoint: string, body: Record<string, string>): Promise<OpenBoardResult> {
  const res = await fetch(apiUrl(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const why = ((await res.json().catch(() => ({}))) as { error?: string }).error
    throw new Error(why ?? `POST ${endpoint} ${res.status}`)
  }
  const b = (await res.json()) as { attach?: boolean; port?: number; room: string }
  return { attach: !!b.attach, port: b.port, room: b.room }
}

export function openBoard(path: string): Promise<OpenBoardResult> {
  return postBoard('/board/open', { path })
}

export function newBoard(name: string): Promise<OpenBoardResult> {
  return postBoard('/board/new', { name })
}

export async function uploadImage(id: string, blob: Blob): Promise<void> {
  await fetch(apiUrl(`/image-upload?id=${encodeURIComponent(id)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: blob,
  })
}
