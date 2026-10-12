// `ClientWebSocketAdapter` is a real runtime export of @tldraw/sync-core (its docblock
// shows `new ClientWebSocketAdapter('ws://…/sync')`) but is marked "Excluded from this
// release type", so the published typings omit it. We use it to run headless
// presence-only sync clients (see ./presence). Import it through this one wrapper — a
// `declare module` augmentation would shadow the package's real exports — and give it a
// precise type as a TLPersistentClientSocket.
import type { TLPersistentClientSocket } from '@tldraw/sync-core';
// @ts-expect-error runtime export intentionally absent from the published .d.ts
import { ClientWebSocketAdapter as RuntimeClientWebSocketAdapter } from '@tldraw/sync-core';

export type ClientWebSocketAdapter = TLPersistentClientSocket & { restart(): void; close(): void };

type ClientWebSocketAdapterCtor = new (getUri: () => string | Promise<string>) => ClientWebSocketAdapter;

export const ClientWebSocketAdapter: ClientWebSocketAdapterCtor =
  RuntimeClientWebSocketAdapter as ClientWebSocketAdapterCtor;
