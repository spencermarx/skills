// Server-side per-agent presence injection (SPEC §7).
//
// WHY this is not simpler: a tldraw sync peer (TLSyncClient) broadcasts EXACTLY ONE
// presence record — its own — and the authoritative `TLSocketRoom` keeps presence in a
// SEPARATE per-session `presenceStore` (keyed by each socket's `presenceId`) that
// `room.updateStore(...)` cannot reach (updateStore asserts document scope; presence is
// scope 'presence'). So neither the render-canvas nor a server store-write can make N
// named agent cursors visible to the operator's browser. The supported path is N
// presence-only sync CLIENTS: one headless TLSyncClient per registered session, each
// pushing its single `instance_presence` record. Verified end-to-end against installed
// 5.4.2 — a second peer sees each pushed cursor (name, color, position).
//
// Requires ./headless-shim to have run first (browser globals the client stack reads).

import { randomUUID } from 'node:crypto';
import { TLSyncClient, type TLPresenceMode } from '@tldraw/sync-core';
import { ClientWebSocketAdapter } from './client-adapter.js';
import { Store } from '@tldraw/store';
import { atom, type Atom } from '@tldraw/state';
import {
  createTLSchema,
  InstancePresenceRecordType,
  type TLInstancePresence,
  type TLPageId,
  type TLRecord,
  type TLStoreProps,
  type TLUserId,
} from '@tldraw/tlschema';

export type PresenceState = 'idle' | 'thinking' | 'drawing';

// The default single page in a fresh tldraw document.
const DEFAULT_PAGE_ID = 'page:page' as TLPageId;

type PresenceStore = Store<TLRecord, TLStoreProps>;

// A presence-only store never mounts an editor, uploads an asset, or resolves a user,
// so these props are never invoked; one honest cast beats stubbing four subsystems.
const PRESENCE_STORE_PROPS = {} as TLStoreProps;

// TLSyncClient only pushes presence CHANGES (post-connect updates like idle→drawing) when
// presenceMode resolves to 'full'; with no signal it reads `undefined` and silently skips
// every update after the initial connect snapshot. Verified against 5.4.2.
const PRESENCE_MODE_FULL = atom<TLPresenceMode>('presence-mode', 'full');

// [v8, SPEC §7 / decision #47] Whether to inject a per-agent cursor into the operator's view.
// OFF: decision #47 dropped agent cursors from the UI (the drawer's collaborators row now carries
// who is present and their state), so the canvas cursor is redundant — and, being static, it read as
// a stray "glowing cursor" rather than live activity. Human peers broadcast their own cursors through
// their own browsers and are unaffected by this; only the server-injected agent cursors are gated.
// Flip to true to restore per-agent canvas cursors (the PresenceClient machinery below is intact).
const SHOW_AGENT_CURSORS = false;

function labelFor(name: string, state: PresenceState): string {
  return state === 'idle' ? name : `${name} (${state})`;
}

// One agent cursor: a headless sync client pushing a single instance_presence record.
class PresenceClient {
  private readonly store: PresenceStore;
  private readonly socket: ClientWebSocketAdapter;
  private readonly client: TLSyncClient<TLRecord, PresenceStore>;
  private readonly signal: Atom<TLRecord | null>;
  private readonly recordId = InstancePresenceRecordType.createId(randomUUID());
  private state: PresenceState = 'idle';
  private cursor: { x: number; y: number };

  constructor(
    private readonly sessionId: string,
    private name: string,
    private color: string,
    cursor: { x: number; y: number },
    getRoomUri: () => string,
  ) {
    this.cursor = cursor;
    this.store = new Store<TLRecord, TLStoreProps>({ schema: createTLSchema(), props: PRESENCE_STORE_PROPS });
    this.signal = atom<TLRecord | null>(`presence:${sessionId}`, this.record());
    this.socket = new ClientWebSocketAdapter(getRoomUri);
    this.client = new TLSyncClient<TLRecord, PresenceStore>({
      store: this.store,
      socket: this.socket,
      presence: this.signal,
      presenceMode: PRESENCE_MODE_FULL,
      onLoad: () => {},
      onSyncError: (reason: string) => console.warn(`[presence] '${this.name}' sync error: ${reason}`),
    });
  }

  private record(): TLInstancePresence {
    return InstancePresenceRecordType.create({
      id: this.recordId,
      userId: `user:${this.sessionId}` as TLUserId,
      userName: labelFor(this.name, this.state),
      currentPageId: DEFAULT_PAGE_ID,
      color: this.color,
      cursor: { x: this.cursor.x, y: this.cursor.y, type: 'default', rotation: 0 },
      lastActivityTimestamp: Date.now(),
    });
  }

  private flush(): void {
    this.signal.set(this.record());
  }

  setState(state: PresenceState): void {
    this.state = state;
    this.flush();
  }

  update(fields: { name?: string; color?: string; cursor?: { x: number; y: number } }): void {
    if (fields.name) this.name = fields.name;
    if (fields.color) this.color = fields.color;
    if (fields.cursor) this.cursor = fields.cursor;
    this.flush();
  }

  close(): void {
    // Closing the client ends the session; the room deletes its presenceId and every
    // peer sees the cursor disappear (verified in TLSyncRoom onSessionRemoved path).
    try {
      this.client.close();
    } catch {
      /* already closed */
    }
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
    try {
      this.store.dispose();
    } catch {
      /* already disposed */
    }
  }
}

type SessionRecord = {
  name: string;
  color: string;
  state: PresenceState;
  cursor: { x: number; y: number };
  // null when SHOW_AGENT_CURSORS is off: the session is still tracked (name/color/state for the
  // roster + message attribution), but no cursor is injected into the room.
  presence: PresenceClient | null;
};

// Manages one PresenceClient per registered session, all pointed at the active room.
// On a room switch it rebuilds every client against the new room URI.
export class PresenceManager {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private roomUri: (roomId: string) => string, private activeRoomId: string) {}

  private uriForActive = (): string => this.roomUri(this.activeRoomId);

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // Attribution lookup for the message store (§8.2): the session's display name and color.
  info(sessionId: string): { name: string; color: string } | undefined {
    const rec = this.sessions.get(sessionId);
    return rec ? { name: rec.name, color: rec.color } : undefined;
  }

  // Register (or, on a repeated clientKey, rebind) a session's cursor. Returns the record.
  register(sessionId: string, name: string, color: string): SessionRecord {
    const index = this.sessions.size;
    const cursor = { x: 120 + index * 48, y: 120 + index * 32 };
    const presence = SHOW_AGENT_CURSORS
      ? new PresenceClient(sessionId, name, color, cursor, this.uriForActive)
      : null;
    const rec: SessionRecord = { name, color, state: 'idle', cursor, presence };
    this.sessions.set(sessionId, rec);
    return rec;
  }

  setState(sessionId: string, state: PresenceState): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    rec.state = state;
    rec.presence?.setState(state);
  }

  update(sessionId: string, fields: { name?: string; color?: string; cursor?: { x: number; y: number } }): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    if (fields.name) rec.name = fields.name;
    if (fields.color) rec.color = fields.color;
    if (fields.cursor) rec.cursor = fields.cursor;
    rec.presence?.update(fields);
  }

  // Idempotent: removing an already-removed session is a no-op.
  unregister(sessionId: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (!rec) return false;
    rec.presence?.close();
    this.sessions.delete(sessionId);
    return true;
  }

  // Rebuild every cursor against a new room (clients are single-room). A no-cursor session (presence
  // null) just re-points its record; only a live PresenceClient is torn down and rebuilt.
  switchRoom(roomId: string): void {
    this.activeRoomId = roomId;
    for (const [sessionId, rec] of this.sessions) {
      if (!rec.presence) continue;
      rec.presence.close();
      rec.presence = new PresenceClient(sessionId, rec.name, rec.color, rec.cursor, this.uriForActive);
      if (rec.state !== 'idle') rec.presence.setState(rec.state);
    }
  }

  closeAll(): void {
    for (const rec of this.sessions.values()) rec.presence?.close();
    this.sessions.clear();
  }
}
