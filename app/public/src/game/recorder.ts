import { Room, SchemaSerializer } from "@colyseus/sdk"
import { rooms } from "../network"
import store from "../stores"
import {
  appendFrames,
  loadFrames,
  pruneToRecent,
  storedInfo,
  type StoredFrame
} from "./recorder-store"
import type { ReplayManifest } from "./replay-room"

// In-client match recorder. Taps the live client's own inbound Colyseus stream — the exact same seam
// the headless harness recorder uses (replay/record-match.mjs) — and lets the player download the
// captured match as a .colreplay the /replay viewer can play back.
//
// The taps are installed on the SDK prototypes at app startup (installRecorder, called from
// index.tsx) so the GAME room's join handshake is captured too. Frames are buffered per room /
// serializer in WeakMaps, so non-game rooms (lobby/prep) are garbage-collected when left, and only
// the room currently referenced by rooms.game is retained.
//
// Privacy is automatic: the client only ever received its own @view-scoped state, so a recording
// can't contain another player's hidden information (shop, etc.).

interface CapturedFrame {
  t: number
  seq: number
  kind: "handshake" | "state" | "patch" | "message"
  offset?: number
  bytes?: Uint8Array
  type?: string | number
  payload?: unknown
}

const stateCaptures = new WeakMap<object, CapturedFrame[]>() // serializer instance -> frames
const msgCaptures = new WeakMap<object, CapturedFrame[]>() // room instance -> message frames
let seq = 0
let installed = false

// Strong ref to the most recent game room so its captured frames survive after rooms.game is cleared
// (e.g. on the after-game screen for the download). Tracked automatically from the taps below — no
// visible in-game UI needed.
let lastGameRoom: Room | null = null
export function getActiveGameRoom(): Room | null {
  return rooms.game ?? lastGameRoom
}

// Release the retained finished-game room (and, transitively, its in-memory capture buffers held via the
// serializer WeakMap key). Called when the player returns to the lobby — past the after-game screen where
// the download is offered, so the durable IndexedDB copy is what remains. Without this the last game's
// frames linger in memory until a new game overwrites the ref (or forever while idling in lobby).
export function resetActiveGameRoom() {
  lastGameRoom = null
}

// The game build a recording was made in. TODO: source from a build-time constant once available.
const GAME_BUILD = {
  version: "6.10.1",
  commit: "deployed",
  serializerId: "schema"
}

// --- durable flush (IndexedDB) -------------------------------------------------------------------
// Frames live in memory only until flushed; a crash/reload wipes them, so the download after a
// reconnect used to lose everything before the crash. We flush to IndexedDB ~1s at a time, keyed by
// roomId — reconnect rejoins the same roomId, so the recording survives a crash. See recorder-store.ts.
const FLUSH_MS = 1000
// Keep only the current + previous recording. A past game isn't downloadable from the UI (only the
// just-finished game's after-screen offers a download), so retaining more just wastes storage. At
// ~2 KB/s a 35-min game is ~4-8 MB, so this bounds IndexedDB to ~tens of MB regardless of play volume.
const KEEP_RECENT = 2
let lastPrunedForRoom: string | null = null // re-prune when a NEW game starts (drops un-downloaded ones)

const toStored =
  (room: string) =>
  (f: CapturedFrame): StoredFrame => ({
    room,
    t: f.t,
    seq: f.seq,
    kind: f.kind,
    offset: f.offset,
    bytes: f.bytes,
    type: f.type,
    payload: f.payload
  })

// Flushes MUST be serialized: the 1s interval and the on-download flush (buildReplay) can otherwise
// overlap, and a second flush would read the SAME un-spliced prefix — writing duplicate state/patch
// frames (which the ReplayRoom would re-apply to the decoder → desync) and over-trimming the buffer.
// We chain every flush through a single promise so they run strictly one at a time.
let flushChain: Promise<void> = Promise.resolve()

/** Persist the active game's newly-captured frames to durable storage. Serialized (see flushChain);
 * returns once this flush AND any already-queued ones have completed, so the download can await it. */
export function flushRoom(room: Room | null): Promise<void> {
  flushChain = flushChain
    .then(() => flushRoomImpl(room))
    .catch((e) => console.error("[recorder] flush failed", e))
  return flushChain
}

/** Persist the un-flushed prefix of `room`'s in-memory buffers, then trim what was persisted (memory
 * stays bounded for long games). Skips the replay room — watching a replay re-runs the serializer taps
 * and we don't record replays. On append failure nothing is trimmed → retried on the next flush. Never
 * call directly; go through flushRoom so flushes stay serialized. */
async function flushRoomImpl(room: Room | null): Promise<void> {
  if (!room || room.roomId === "replay") return
  const ser = (room as unknown as { serializer: object }).serializer
  const sAll = stateCaptures.get(ser)
  const mAll = msgCaptures.get(room)
  const sLen = sAll?.length ?? 0
  const mLen = mAll?.length ?? 0
  if (sLen + mLen === 0) return
  const batch = [...(sAll ?? []).slice(0, sLen), ...(mAll ?? []).slice(0, mLen)]
    .sort((a, b) => a.seq - b.seq)
    .map(toStored(room.roomId))
  await appendFrames(room.roomId, batch, {
    viewerUid: store.getState().network.uid,
    version: GAME_BUILD.version
  })
  sAll?.splice(0, sLen) // frames captured during the async append remain for the next flush
  mAll?.splice(0, mLen)
  // When a NEW game starts (roomId changed since the last flush), drop all but the recent recordings so
  // un-downloaded past games don't pile up; protect the active room so it's never pruned mid-record.
  if (room.roomId !== lastPrunedForRoom) {
    lastPrunedForRoom = room.roomId
    void pruneToRecent(KEEP_RECENT, room.roomId).catch(() => {})
  }
}

const push = (
  map: WeakMap<object, CapturedFrame[]>,
  key: object,
  frame: CapturedFrame
) => {
  let arr = map.get(key)
  if (!arr) map.set(key, (arr = []))
  arr.push(frame)
}

const serializePayload = (m: unknown): unknown =>
  m instanceof Uint8Array ? { __bytes__: bytesToB64(m) } : m

function bytesToB64(u8: Uint8Array): string {
  let s = ""
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}

// Only the game room is ever downloaded, so don't buffer frames for the lobby/preparation/after rooms —
// their continuous state patches + chat messages would otherwise pile up in memory while a player idles.
// We EXCLUDE the known non-game rooms rather than INCLUDE only rooms.game: the game room's handshake +
// initial state arrive during client.joinById, BEFORE joinGame sets rooms.game, so an inclusion test
// (this === rooms.game) would drop them. The game room object/serializer is never one of lobby/prep/after
// (distinct instances, even mid-join), so excluding those can NEVER drop a game frame.
const isExcludedRoom = (room: object): boolean =>
  room === rooms.lobby || room === rooms.preparation || room === rooms.after
const serializerOf = (room: object | undefined) =>
  (room as unknown as { serializer?: object } | undefined)?.serializer
const isExcludedSerializer = (ser: object): boolean =>
  ser === serializerOf(rooms.lobby) ||
  ser === serializerOf(rooms.preparation) ||
  ser === serializerOf(rooms.after)

/** Install the inbound-stream taps. Idempotent; call once at app startup, before any game join. */
export function installRecorder() {
  if (installed) return
  installed = true

  const S = SchemaSerializer.prototype as unknown as {
    handshake: (b: Uint8Array, it?: { offset: number }) => unknown
    setState: (b: Uint8Array, it?: { offset: number }) => unknown
    patch: (b: Uint8Array, it?: { offset: number }) => unknown
  }
  const tap = (
    orig: (b: Uint8Array, it?: { offset: number }) => unknown,
    kind: CapturedFrame["kind"],
    defaultOffset: number
  ) =>
    function (this: object, bytes: Uint8Array, it?: { offset: number }) {
      // Capture is best-effort and must NEVER break the live client's decode: wrap it so any failure
      // (e.g. OOM under capture pressure) falls through to orig. The recorder sits in the live decode
      // hot path — this is the structural guard against the "additive code reaches into live" risk.
      try {
        if (!isExcludedSerializer(this))
          push(stateCaptures, this, {
            t: Date.now(),
            seq: seq++,
            kind,
            offset: it?.offset ?? defaultOffset,
            bytes: bytes.slice() // copy: the SDK reuses the underlying buffer for later messages
          })
      } catch (e) {
        console.error("[recorder] capture failed (live decode unaffected)", e)
      }
      return orig.call(this, bytes, it)
    }
  S.handshake = tap(S.handshake, "handshake", 0)
  S.setState = tap(S.setState, "state", 1)
  S.patch = tap(S.patch, "patch", 1)

  const R = Room.prototype as unknown as {
    dispatchMessage: (t: string | number, m: unknown) => unknown
  }
  const origDispatch = R.dispatchMessage
  R.dispatchMessage = function (
    this: object,
    type: string | number,
    message: unknown
  ) {
    try {
      if (rooms.game) lastGameRoom = rooms.game // retain the game room for the after-game download
      if (!isExcludedRoom(this))
        push(msgCaptures, this, {
          t: Date.now(),
          seq: seq++,
          kind: "message",
          type,
          payload: serializePayload(message)
        })
    } catch (e) {
      console.error(
        "[recorder] message capture failed (live dispatch unaffected)",
        e
      )
    }
    return origDispatch.call(this, type, message)
  }

  // Periodically flush the active game's frames to durable storage so a crash can't lose them, and drop
  // stale recordings on startup so IndexedDB doesn't grow without bound.
  setInterval(() => void flushRoom(getActiveGameRoom()), FLUSH_MS)
  void pruneToRecent(KEEP_RECENT).catch(() => {})
}

/** Durable recording summary (frame count + span) for the after-game indicator. Reads the persisted
 * meta, so it reflects the WHOLE recording including anything captured before a crash + reconnect —
 * unlike the in-memory buffers, which only hold the current page's frames (and get trimmed on flush). */
export async function getStoredCaptureInfo(
  room: Room | undefined
): Promise<{ frames: number; ms: number }> {
  if (!room || room.roomId === "replay") return { frames: 0, ms: 0 }
  const { frames, ms } = await storedInfo(room.roomId)
  return { frames, ms }
}

/** Assemble a .colreplay manifest from the DURABLE capture for `room`. Flushes any in-memory tail
 * first, then reads every persisted frame (in arrival order) — so a recording that spanned a crash +
 * reconnect comes out whole. */
export async function buildReplay(
  room: Room,
  viewerUid: string
): Promise<ReplayManifest> {
  await flushRoom(room) // persist the last in-memory frames before reading
  const all = await loadFrames(room.roomId)
  const t0 = all.length ? all[0].t : 0
  const frames = all.map((f) =>
    f.kind === "message"
      ? {
          t: f.t - t0,
          kind: "message" as const,
          type: f.type,
          payload: f.payload
        }
      : {
          t: f.t - t0,
          kind: f.kind,
          offset: f.offset,
          b64: bytesToB64(f.bytes!)
        }
  )
  return {
    format: "colreplay-v0",
    schemaVersion: 0,
    game: { ...GAME_BUILD },
    room: "game",
    viewerUid,
    recordedAt: new Date().toISOString(),
    frames
  }
}

/** Build the replay and trigger a browser download. */
export async function downloadReplay(room: Room, viewerUid: string) {
  const manifest = await buildReplay(room, viewerUid)
  const blob = new Blob([JSON.stringify(manifest)], {
    type: "application/json"
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `replay-${manifest.recordedAt.replace(/[:.]/g, "-")}.colreplay.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
