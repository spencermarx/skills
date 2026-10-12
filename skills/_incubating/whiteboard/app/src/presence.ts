// Multi-agent presence cursors keyed by sessionId (SPEC §7, v3).
//
// tldraw renders peer cursors from `instance_presence` records whose userId
// differs from the local user's. This manager keeps N such records — one per
// agent sessionId — and writes them into the store through `mergeRemoteChanges`
// (so they read as remote changes, not user edits). `getVisibleCollaborators`
// filters by lastActivityTimestamp, so a heartbeat keeps live cursors fresh and
// an idle state removes the record.
//
// VERIFIED PROPAGATION LIMIT (checked against installed @tldraw/sync-core 5.4.2
// types — TLSyncClient takes `presence: Signal<null | R>`, one record per
// client, and pushes ONLY document-scoped diffs). Presence-scoped records put
// into a client's synced store are NOT pushed to peers. So records written here
// render on THIS canvas only. For agent cursors to appear in a human peer's
// browser, the bridge must inject them SERVER-SIDE into the TLSocketRoom (SPEC
// §3/§4/§7); this manager is the render-canvas-local renderer and the fallback
// if the bridge instead routes presence frames through this app.
//
// Verified against tldraw 5.4.2 installed types:
//   InstancePresenceRecordType.create({ id, userId, userName, currentPageId, ... })
//   InstancePresenceRecordType.createId('<key>') → 'instance_presence:<key>'
//   editor.store.mergeRemoteChanges(() => editor.store.put([record]) / .remove([id]))

import { InstancePresenceRecordType } from 'tldraw'
import type { Editor, TLInstancePresence, TLInstancePresenceID } from 'tldraw'

export type PresenceState = 'idle' | 'thinking' | 'drawing'

// A `presence` WS frame from the bridge, tagged with the agent session it drives.
export type PresenceFrame = {
  sessionId: string
  name?: string
  color?: string
  state: PresenceState
  cursor?: { x: number; y: number }
}

// Fallback colors assigned in first-seen order when a frame omits `color`.
const PALETTE = ['#7C4DFF', '#00BFA5', '#FF6D00', '#2962FF', '#D500F9', '#00C853']

type Agent = {
  id: TLInstancePresenceID
  userId: string
  name: string
  color: string
  state: PresenceState
  cursor: { x: number; y: number }
}

export class MultiAgentPresence {
  private editor: Editor
  private agents = new Map<string, Agent>()
  private heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(editor: Editor) {
    this.editor = editor
  }

  // Drive one agent's cursor from a bridge `presence` frame. First sighting of a
  // sessionId creates its record (name + color); later frames update state/cursor.
  //   idle     → remove the record (hide the cursor)
  //   thinking → visible, parked at its last point (or the given cursor)
  //   drawing  → visible, moved to the given point (typically newest shape bounds)
  apply(frame: PresenceFrame) {
    const { sessionId } = frame
    if (!sessionId) return

    let agent = this.agents.get(sessionId)
    if (!agent) {
      agent = {
        id: InstancePresenceRecordType.createId(sessionId),
        userId: `claude-${sessionId}`,
        name: frame.name || 'Agent',
        color: frame.color || PALETTE[this.agents.size % PALETTE.length],
        state: 'idle',
        cursor: { x: 0, y: 0 },
      }
      this.agents.set(sessionId, agent)
    }
    // A later frame may still refine the label/color set at registration.
    if (frame.name) agent.name = frame.name
    if (frame.color) agent.color = frame.color
    agent.state = frame.state
    if (frame.cursor) agent.cursor = frame.cursor

    if (frame.state === 'idle') {
      this.remove(sessionId)
      return
    }
    this.put(agent)
    this.ensureHeartbeat()
  }

  private put(agent: Agent) {
    const editor = this.editor
    const record = InstancePresenceRecordType.create({
      id: agent.id,
      userId: agent.userId as TLInstancePresence['userId'],
      userName: agent.state === 'thinking' ? `${agent.name} (thinking…)` : agent.name,
      currentPageId: editor.getCurrentPageId(),
      color: agent.color,
      cursor: { x: agent.cursor.x, y: agent.cursor.y, type: 'default', rotation: 0 },
      lastActivityTimestamp: Date.now(),
    }) as TLInstancePresence

    editor.store.mergeRemoteChanges(() => {
      editor.store.put([record])
    })
  }

  private remove(sessionId: string) {
    const agent = this.agents.get(sessionId)
    if (!agent) return
    this.agents.delete(sessionId)
    this.editor.store.mergeRemoteChanges(() => {
      this.editor.store.remove([agent.id])
    })
    if (this.agents.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  // Keep every live record "active" so getVisibleCollaborators does not age it out.
  private ensureHeartbeat() {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      for (const agent of this.agents.values()) {
        if (agent.state !== 'idle') this.put(agent)
      }
    }, 3000)
  }

  dispose() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    const ids = [...this.agents.values()].map((a) => a.id)
    this.agents.clear()
    if (ids.length === 0) return
    this.editor.store.mergeRemoteChanges(() => {
      this.editor.store.remove(ids)
    })
  }
}
