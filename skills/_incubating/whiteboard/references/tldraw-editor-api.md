# tldraw editor API — verified core + pointers

> Section references (SPEC §n, decision #n) point at the design spec, `docs/whiteboard/SPEC.md` in
> https://github.com/spencermarx/skills. You never need it to run the board.

**These signatures are for `tldraw@5.4.2`.** If `app/package.json` pins a
different version, re-verify against `app/node_modules` before trusting anything
here — tldraw's write API has changed shape across majors (arrow bindings, in
particular, are no longer arrow props). This file is a **pointer, not a
transcription**: it carries only the handful of calls the read-act loop uses,
each checked against the installed types; for anything else, read the installed
`.d.ts` or the docs (bottom of file) rather than guessing.

Every call below runs inside a `POST /exec` blob, against the browser's live
`editor`. Helper functions (`createShapeId`, `createBindingId`, `toRichText`)
are exported from the `tldraw` package; the app is responsible for exposing them
in the `/exec` scope alongside `editor`. If one is not defined in a blob, read
how the app builds the exec sandbox rather than assuming — do not silently
substitute a hand-rolled id string.

## Verified core (tldraw@5.4.2)

Each entry names the source that verified it (installed type path, or DOCS.md
shipped inside the package). Paths are relative to the skill root.

### Ids

- `createShapeId(id?: string): TLShapeId` — `app/node_modules/@tldraw/tlschema/dist-cjs/index.d.ts:1052`
- `createBindingId(id?: string): TLBindingId` — same file, `:689`

Call with no argument for a fresh id; pass a string only when you need a stable,
predictable id within one blob.

### Create / update / delete shapes

- `editor.createShapes<T>(shapes: TLCreateShapePartial<T>[]): this` — `@tldraw/editor/dist-cjs/index.d.ts:3826` (single-shape `createShape` at `:3812`)
- `editor.updateShapes<T>(partials: (TLShapePartial<T> | null | undefined)[]): this` — `:3925`
- `editor.deleteShapes(ids: TLShapeId[]): this` (also accepts `TLShape[]`) — `:3940`

A shape partial is `{ id, type, x, y, props }`. Prefer `updateShapes` (a partial
merged onto an existing id) over deleting and recreating, so bindings and
selection survive a nudge.

### Geo shapes (rectangle, ellipse, … with text)

A box is `type: 'geo'` with `props.geo` set to a **valid geo value**. The
complete enum in 5.4.2 (`@tldraw/tlschema/dist-cjs/index.d.ts:1969`,
`GeoShapeGeoStyle`) is:

```
arrow-down, arrow-left, arrow-right, arrow-up, check-box, cloud, diamond,
ellipse, heart, hexagon, octagon, oval, pentagon, rectangle, rhombus,
rhombus-2, star, trapezoid, triangle, x-box
```

**There is NO `cylinder` (database / data-store) geo in 5.4.2.** Do not write
`geo: 'cylinder'` — it will fail validation. For a "data store" / "Store" shape,
either use the nearest built-in (`oval` reads as a store to most people) and
label it, or read the docs on custom shapes if a true cylinder is required. This
is exactly the kind of value that is wrong when written from memory; the enum
above is copied from the installed schema.

**Every shape field lives under `props`, never on the shape record.** The geo
dimensions `w` and `h` in particular belong in `props`, alongside `geo` and
`richText`, not at the top level next to `id`/`type`/`x`/`y`. A top-level `w` (or
`h`) throws `At shape(type=geo).w: Unexpected property` from the schema validator
inside `store.put`, and pre-v9.5 that throw **severed sync silently**: the failing
put flipped the store's sticky corruption flag, the sync client then suppressed
every outbound push while the socket stayed connected, and later well-formed
execs returned `ok:true` yet never reached the room. As of v9.5 a validate-first
guard rejects the bad record before it reaches the crashing put, and the honest
`/exec` contract plus server-owned recovery make a severed board impossible to
miss. See the **sync-integrity invariant** in the design spec §5: an `/exec` that
returns `ok` has reached the room, and a corrupted store is auto-recovered and
announced, never silently dropped.

Geo text goes in `props.richText` via `toRichText`:

- `toRichText(text: string): TLRichText` — `@tldraw/tlschema/dist-cjs/index.d.ts:7005`

```js
const a = createShapeId()
editor.createShapes([{
  id: a, type: 'geo', x: 100, y: 100,
  props: { geo: 'rectangle', w: 160, h: 90, richText: toRichText('Ingest') },
}])
```

### Legible geo text (sizing landmine)

A `geo` box does **not** grow to fit its text, and its text is **centered
vertically**. So when the box is too short for its content, the text overflows and
**clips at both the top and the bottom** — the title and the last line disappear
first. Long single words (`TLSocketRoom`, `authoritative`) **wrap mid-word** when
the box is too narrow. Both are deterministic, and both silently produce an
unreadable board. Rules:

- **Size height to the content:** `h ≳ lines × 40 + 48` (line count includes
  wrapped lines and any blank spacer lines), then err larger.
- **Widen for long tokens,** or put a long word on its own line; do not let a box
  be narrower than its longest unbreakable word needs.
- **Keep labels short.** Prefer a few words over prose; for a genuinely long block
  use a `text` shape (which sizes to its content), not a `geo`.
- **Arrow labels short too** (`richText`), especially where the arrow crosses a
  tight gap — a long label shatters across lines onto the shapes behind it.

This is a **legibility gate**, not polish: after drawing, verify against
[`legibility-checklist.md`](legibility-checklist.md) and keep correcting (bounded)
until it passes. Do not classify clipped text or mid-word breaks as "polish."

### Reading the board

- `editor.getCurrentPageShapes(): TLShape[]` — `@tldraw/editor/dist-cjs/index.d.ts:3239`
- `editor.getSelectedShapeIds(): TLShapeId[]` — `:1840`

Prefer `GET /shapes` (bridge, §4) for the JSON you write against; use these
inside a blob when you need live state mid-exec.

### Selecting and framing (point back)

- `editor.select(...shapes: TLShapeId[] | TLShape[]): this` — `:1883`
- `editor.zoomToBounds(bounds: BoxLike, opts?): this` — `:2439` (`BoxLike` is `{ x, y, w, h }`)

After drawing, `editor.select(...)` the shapes you touched — this is the
"point back" the loop owes the operator.

### Bound arrows (the part that changed) — `createBinding`

In 5.4.2 an arrow does **not** carry its targets in its own props. You create an
**arrow shape**, then **two separate `binding` records** (one per terminal)
linking that arrow to each target shape.

- `editor.createBinding<B>(partial: TLBindingCreate<B>): this` — `@tldraw/editor/dist-cjs/index.d.ts:3467` (batch `createBindings` at `:3462`)

Arrow-binding props (`TLArrowBindingProps`,
`@tldraw/tlschema/dist-cjs/index.d.ts:3395`): `terminal: 'start' | 'end'`,
`normalizedAnchor: {x, y}`, `isExact: boolean`, `isPrecise: boolean`,
`snap: 'none' | 'edge' | ...`. The binding record's `fromId` is the **arrow**,
`toId` is the **target shape** (`TLArrowBinding` example, same file `:3357`; the
`createBinding` shape is confirmed by the package's own DOCS.md `:5516`).

### `/exec` example — two boxes and a BOUND arrow, the 5.4.2 way

```js
const from = createShapeId()
const to = createShapeId()
const arrow = createShapeId()

editor.createShapes([
  { id: from, type: 'geo', x: 100, y: 100,
    props: { geo: 'rectangle', w: 160, h: 90, richText: toRichText('Source') } },
  { id: to, type: 'geo', x: 420, y: 100,
    props: { geo: 'rectangle', w: 160, h: 90, richText: toRichText('Sink') } },
  { id: arrow, type: 'arrow' }, // default props; bindings position the ends
])

// Bind the arrow's start to `from` and its end to `to`.
editor.createBinding({
  type: 'arrow', fromId: arrow, toId: from,
  props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 },
           isExact: false, isPrecise: false, snap: 'none' },
})
editor.createBinding({
  type: 'arrow', fromId: arrow, toId: to,
  props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 },
           isExact: false, isPrecise: false, snap: 'none' },
})

editor.select(from, to, arrow)
```

Because the arrow is *bound* (not fixed to coordinates captured from a stale
read), it follows either box when the operator drags it — the placement
robustness §5 asks for.

### Exporting a PNG (perception loop)

The bridge's `/image` and the `/exec` response image are produced by the app,
not by a blob you write. The underlying calls, if you need them:

- `editor.toImage(shapes, opts?): Promise<{ blob: Blob; width: number; height: number }>` — `@tldraw/editor/dist-cjs/index.d.ts:4223`
- `editor.toImageDataUrl(shapes, opts?): Promise<{ url: string; width: number; height: number }>` — `:4237`

`opts` is `TLImageExportOptions` (`:8886`). Pass `editor.getCurrentPageShapes()`
(or a shape-id list) as the first argument to export the whole board.

### Authorship stamping — `editor.sideEffects` [v5]

v5 stamps `meta.createdBy` / `meta.lastEditedBy` on each shape from an
`editor.sideEffects` handler, never from the `/exec` blob (SPEC §5, §8.6). The
symbols below were checked against the installed `@tldraw/*@5.4.2` types (paths
relative to the skill root); the exact handler-argument shapes are in those files,
so read them there rather than reconstructing a signature from memory.

- **The side-effect surface:** `editor.sideEffects: StoreSideEffects<TLRecord>` —
  `app/node_modules/@tldraw/editor/dist-cjs/index.d.ts:1324`.
- **Create / change handlers** (register on the `'shape'` type):
  `registerAfterCreateHandler(typeName, handler)` —
  `app/node_modules/@tldraw/store/dist-cjs/index.d.ts:2666`; and
  `registerAfterChangeHandler(typeName, handler)` — same file, `:2719`. Their
  handler types (`StoreAfterCreateHandler` `:1880`, `StoreAfterChangeHandler`
  `:1858`) both hand the callback a trailing **`source: 'remote' | 'user'`**
  argument (`ChangeSource`, `:379`).
- **The `source:'user'` filter is the whole landmine.** `'user'` is a **local**
  change; `'remote'` is a shape arriving over sync from another peer. Stamping must
  fire on **local changes only** — gate every handler on `source === 'user'`, or a
  peer would re-stamp shapes it merely received and clobber their true author. The
  store-listener surface takes the same filter: `store.listen(fn, { source: 'user',
  scope: 'document' })` (`StoreListenerFilters.source: 'all' | ChangeSource`,
  `:2036`; `store.listen` `:1779`).
- **`createdBy` is stamped once and immutable** — the create handler sets it and
  nothing overwrites it; only `lastEditedBy` is rewritten, by the change handler
  (SPEC §8.6). Read the app's author-stamping wiring (the `app/` slice, SPEC §9
  layout) for how the current author context is threaded into these handlers before
  citing anything beyond the signatures above.

## Sync + presence (v3 multi-peer) — pointers only

v3 makes the board a **sync room** with the operator's browser, the headless
render-canvas, and each agent as peers (SPEC §3, §4, §7). The core above is the
**write API** and is unchanged. The sync and presence APIs below are **not
transcribed here** — they changed across versions and the multi-peer /
server-injected-cursor path is the fragile part, so **verify against the
installed types, do not guess**. The symbol names below were checked against the
installed `@tldraw/*@5.4.2` `.d.ts` (paths relative to the skill root); the
**call shapes** behind them are for the implementation to read there, not to
reconstruct from these lines.

- **Sync client (the app joins a room):** `useSync` — `app/node_modules/@tldraw/sync/dist-cjs/index.d.ts` (`useSync(opts)` → a remote store; worked examples in the file header). This is what `role=human` and `role=agent` use instead of a local store.
- **What each peer broadcasts as its cursor:** `useSync`'s **`getUserPresence?(store, user): null | TLPresenceStateInfo`** option (verified `@tldraw/sync/dist-cjs/index.d.ts:193`, `:323`) customizes the presence a peer contributes; `TLPresenceStateInfo` is re-exported from `tldraw`, and `getDefaultUserPresence` (`@tldraw/tlschema`) is the default it layers on. Leave `presenceMode` at `atom('full')` — see below.
- **Sync server (authoritative room, persistence):** `TLSocketRoom` — `server/node_modules/@tldraw/sync-core/dist-cjs/index.d.ts` (the `TLSocketRoom` class; check its constructor options and the on-change / snapshot hooks the server uses to persist the `.tldr`).
- **Server-injected per-agent cursors (the fragile part, SPEC §7):** one `TLSocketRoom` client broadcasts **exactly one** presence record and replicates only **document-scoped** diffs, so writing N `instance_presence` records into a store does **not** propagate to human peers. The supported path is **N presence-only sync clients**, one per session: `TLSyncClient` (`@tldraw/sync-core`'s `dist-cjs/index.d.ts` under the server's `node_modules`) takes `presence: Signal<null | R>` and `presenceMode?: Signal<TLPresenceMode>` (verified `:1514`–`:1515`); `presenceMode` **must** be `atom('full')` or post-connect presence updates silently drop. The working implementation is `server/presence.ts` (`PresenceManager`) — read it before touching cursor injection.
- **Presence records (a named, colored agent cursor):** `TLInstancePresence` / `InstancePresenceRecordType` — `app/node_modules/@tldraw/tlschema/dist-cjs/index.d.ts` (the `instance_presence` record: `userName`, cursor position, etc.).
- **Docs:** `https://tldraw.dev/docs/sync` (WebFetch) for the sync model and self-hosting; cross-check anything version-sensitive against the installed types, since the site tracks latest.

## Explore as needed — the authoritative sources

For anything outside the verified core above, **read one of these, do not guess**:

1. **Installed types (ground truth for this pinned version).**
   - `app/node_modules/@tldraw/editor/dist-cjs/index.d.ts` — the `Editor` class (every method the loop calls).
   - `app/node_modules/@tldraw/tlschema/dist-cjs/index.d.ts` — shape/binding record shapes, prop enums, `toRichText`, id helpers.
   - `app/node_modules/tldraw/DOCS.md` — the package's own prose docs, with worked examples (this is where the `createBinding` example above came from).
   - Grep a symbol: `grep -n "createBinding\|toImage\|GeoShapeGeoStyle" app/node_modules/@tldraw/*/dist-cjs/index.d.ts`
2. **tldraw.dev docs.**
   - Reference: `https://tldraw.dev/reference`
   - LLM-oriented dumps: `https://tldraw.dev/llms.txt` and `https://tldraw.dev/llms-full.txt` — WebFetch these for a fuller API surface than fits here. Cross-check anything version-sensitive against the installed types, since the site tracks latest.

If a call cannot be verified against the installed types or the docs, say so in
the `/agent-message` rather than shipping a guessed blob.
