import { Room, SchemaSerializer } from "@colyseus/sdk"
import { rooms } from "../network"
import store from "../stores"
import type { ReplayWriterMeta } from "./opfs-replay-writer"
import type { ReplayFrame } from "./replay-room"

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
  // Past the after-game download → tell the worker to flush + release the OPFS handle. The file stays on
  // disk (re-openable on a future reconnect to the same roomId); only the exclusive sync handle is freed.
  worker?.postMessage({ type: "close" })
}

// The game build a recording was made in. TODO: source from a build-time constant once available.
const GAME_BUILD = {
  version: "6.10.1",
  commit: "deployed",
  serializerId: "schema"
}

// --- durable flush (WebWorker + OPFS) ------------------------------------------------------------
// Capture stays on the render thread (the taps must sit on the SDK prototypes), but file I/O does NOT:
// every ~1s we postMessage the newly-captured frames to a dedicated worker (recorder.worker.ts) that
// streams them into an OPFS `${roomId}.colreplay` via a ReplayFileWriter. OPFS is persistent, so it also
// gives crash-durability — a reconnect (same roomId, even after a reload) reopens the same file and
// appends. The render thread never base64s, JSON.stringifies, or touches IndexedDB; the per-frame
// bytes.slice() copies are TRANSFERRED to the worker (zero-copy), not re-cloned.
const FLUSH_MS = 1000

// --- the recording worker ---
let worker: Worker | null = null
let downloadSeq = 0
const pendingDownloads = new Map<number, (r: { buf?: ArrayBuffer; error?: string }) => void>()
function getWorker(): Worker {
  if (!worker) {
    // recorder.worker.ts is built as its own esbuild entry to app/public/dist/client/recorder.worker.js
    // (served at /recorder.worker.js). A stable URL — not `new URL(..., import.meta.url)`, which esbuild
    // leaves empty under the es2016 target. A classic (non-module) worker, so no ESM at runtime.
    worker = new Worker("/recorder.worker.js")
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data
      if (m?.type === "downloaded") {
        const cb = pendingDownloads.get(m.id)
        if (cb) {
          pendingDownloads.delete(m.id)
          cb(m)
        }
      }
    }
    worker.onerror = (e) => console.error("[recorder] worker error", e.message)
  }
  return worker
}

// Per-room running summary for the after-game indicator (the OPFS file is the source of truth for the
// DOWNLOAD; this is only the count/span shown on the button). recordedAt is stamped once, at first flush.
const tally = new Map<
  string,
  { frames: number; firstT: number; lastT: number; recordedAt: string }
>()
function ensureTally(roomId: string) {
  let t = tally.get(roomId)
  if (!t) {
    t = { frames: 0, firstT: 0, lastT: 0, recordedAt: new Date().toISOString() }
    tally.set(roomId, t)
  }
  return t
}

const toReplayFrame = (f: CapturedFrame): ReplayFrame =>
  f.kind === "message"
    ? { t: f.t, kind: "message", type: f.type, payload: f.payload }
    : { t: f.t, kind: f.kind, offset: f.offset, bytes: f.bytes }

// Flushes MUST be serialized so per-frame order (and the worker's prevT threading) is preserved and the
// same un-spliced prefix is never sent twice. We chain every flush through a single promise.
let flushChain: Promise<void> = Promise.resolve()

/** Send the active game's newly-captured frames to the recording worker. Serialized (see flushChain);
 * returns once this flush AND any already-queued ones have completed, so the download can await it. */
export function flushRoom(room: Room | null): Promise<void> {
  flushChain = flushChain
    .then(() => flushRoomImpl(room))
    .catch((e) => console.error("[recorder] flush failed", e))
  return flushChain
}

/** Drain the un-flushed prefix of `room`'s in-memory buffers to the worker (which appends them to OPFS),
 * then trim what was sent. Skips the replay room — watching a replay re-runs the taps and we don't record
 * replays. Never call directly; go through flushRoom so flushes stay serialized. */
async function flushRoomImpl(room: Room | null): Promise<void> {
  if (!room || room.roomId === "replay") return
  const ser = (room as unknown as { serializer: object }).serializer
  const sAll = stateCaptures.get(ser)
  const mAll = msgCaptures.get(room)
  const sLen = sAll?.length ?? 0
  const mLen = mAll?.length ?? 0
  if (sLen + mLen === 0) return
  const batch = [
    ...(sAll ?? []).slice(0, sLen),
    ...(mAll ?? []).slice(0, mLen)
  ].sort((a, b) => a.seq - b.seq)
  const frames = batch.map(toReplayFrame)

  const t = ensureTally(room.roomId)
  if (t.frames === 0 && frames.length) t.firstT = frames[0].t
  const meta: ReplayWriterMeta = {
    game: { ...GAME_BUILD },
    room: "game",
    viewerUid: store.getState().network.uid,
    recordedAt: t.recordedAt
  }

  // Transfer each state frame's ArrayBuffer (zero-copy). These are private bytes.slice() copies, so the
  // live decode is unaffected, and they're spliced out below — the neutered buffers are discarded.
  const transfer: Transferable[] = []
  for (const f of frames) if (f.bytes) transfer.push(f.bytes.buffer)
  getWorker().postMessage(
    { type: "frames", roomId: room.roomId, meta, frames },
    transfer
  )

  t.frames += frames.length
  if (frames.length) t.lastT = frames[frames.length - 1].t

  sAll?.splice(0, sLen) // frames captured during the postMessage remain for the next flush
  mAll?.splice(0, mLen)
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

  // Ask the browser to persist OPFS storage so a recording isn't evicted under storage pressure mid-game
  // (best effort; resolves false without throwing if not granted).
  void navigator.storage?.persist?.().catch(() => {})

  // Periodically flush the active game's frames to the recording worker so a crash can't lose them. The
  // worker prunes old OPFS recordings itself when it opens a new game's file.
  setInterval(() => void flushRoom(getActiveGameRoom()), FLUSH_MS)
}

/** Recording summary (frame count + span) for the after-game indicator. From the in-memory tally — the
 * OPFS file is the source of truth for the actual download. (After a crash + reload the tally only counts
 * post-reconnect frames, so the indicator may undercount; the DOWNLOAD still reads the whole OPFS file.) */
export async function getStoredCaptureInfo(
  room: Room | undefined
): Promise<{ frames: number; ms: number }> {
  if (!room || room.roomId === "replay") return { frames: 0, ms: 0 }
  const t = tally.get(room.roomId)
  return t ? { frames: t.frames, ms: Math.max(0, t.lastT - t.firstT) } : { frames: 0, ms: 0 }
}

/** Flush the in-memory tail, then ask the worker to flush + return the assembled OPFS file, and trigger a
 * browser download of the v1 binary `.colreplay`. The worker streamed the whole match (incl. anything
 * captured before a crash + reconnect, since OPFS persists), so the file comes out whole with no
 * main-thread encode. `_viewerUid` is unused (the worker already stamped viewerUid into the file). */
export async function downloadReplay(
  room: Room,
  _viewerUid: string
): Promise<void> {
  if (!room || room.roomId === "replay") return
  await flushRoom(room) // persist the last in-memory frames before reading
  const id = ++downloadSeq
  const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
    pendingDownloads.set(id, (r) =>
      r.error || !r.buf
        ? reject(new Error(r.error ?? "download failed"))
        : resolve(r.buf)
    )
    getWorker().postMessage({ type: "download", roomId: room.roomId, id })
  })
  const blob = new Blob([buf], { type: "application/octet-stream" })
  const recordedAt =
    tally.get(room.roomId)?.recordedAt ?? new Date().toISOString()
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `replay-${recordedAt.replace(/[:.]/g, "-")}.colreplay`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
