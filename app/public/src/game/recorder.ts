import { Room, SchemaSerializer } from "@colyseus/sdk"
import { rooms } from "../network"
import { preference, subscribeToPreference } from "../preferences"
import store from "../stores"
import { type CapturedFrame, createFlushController } from "./recorder-flush-core"
import type { ReplayWriterMeta } from "./opfs-replay-writer"
import type { ReplayFileInfo } from "./recorder-worker-core"
import { loadReplay } from "./replay-format"
import type { ReplayFrame, ReplayManifest } from "./replay-room"

export type { ReplayFileInfo } from "./recorder-worker-core"

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

const stateCaptures = new WeakMap<object, CapturedFrame[]>() // serializer instance -> frames
const msgCaptures = new WeakMap<object, CapturedFrame[]>() // room instance -> message frames
let seq = 0
let installed = false

// Recording is opt-out: on by default, toggled off in the options panel (the `recordReplays` pref).
// The SDK-prototype taps stay installed either way (they only ever wrap the live decode, best-effort),
// but this flag gates whether a captured frame is actually buffered AND whether the periodic flush
// runs — so toggling takes effect immediately, no reload. With it off from app start nothing is ever
// captured, no OPFS file is opened, and the recording worker is never spawned. Kept in sync with the
// preference in installRecorder(); seeded here so it's correct even before install. Turning it off
// mid-game stops capture going forward (an already-running game keeps what it flushed); turning it on
// mid-game can't recover the missed join handshake, so that game won't produce a playable replay.
let recordingEnabled = preference("recordReplays")

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
  const roomId = lastGameRoom?.roomId ?? rooms.game?.roomId
  lastGameRoom = null
  if (roomId) controller.forget(roomId) // drop the finished game's in-flight/tally state
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
let opSeq = 0
// id -> resolver for a request/reply worker op (download / list / delete). Every such reply carries a
// numeric `id`; the resolver reads the fields its op cares about (buf / files / error).
const pendingOps = new Map<number, (r: { buf?: ArrayBuffer; files?: ReplayFileInfo[]; error?: string }) => void>()
function getWorker(): Worker {
  if (!worker) {
    // recorder.worker.ts is built as its own esbuild entry to app/public/dist/client/recorder.worker.js
    // (served at /recorder.worker.js). A stable URL — not `new URL(..., import.meta.url)`, which esbuild
    // leaves empty under the es2016 target. A classic (non-module) worker, so no ESM at runtime.
    worker = new Worker("/recorder.worker.js")
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data
      if (m?.type === "downloaded" || m?.type === "listed" || m?.type === "deleted") {
        const cb = pendingOps.get(m.id)
        if (cb) {
          pendingOps.delete(m.id)
          cb(m)
        }
      } else if (m?.type === "ack") {
        controller.onAck(m.roomId, m.batchId) // batch durably on OPFS → free its frames
      } else if (m?.type === "nack") {
        controller.onNack(m.roomId, m.batchId, m.error) // write failed → keep + resend
      }
    }
    worker.onerror = (e) => {
      console.error("[recorder] worker error", e.message)
      // Fail any in-flight op so its UI surfaces an error instead of hanging forever (e.g. the worker
      // script 404s in a deploy, or it throws fatally).
      for (const cb of pendingOps.values()) cb({ error: `recording worker error: ${e.message}` })
      pendingOps.clear()
      controller.onWorkerError() // unblock any awaiting flush so the flush chain can't hang
    }
    // Seed the retention cap the moment the worker exists (whoever spawned it — gameplay flush OR the
    // library's list), BEFORE any frames, so the first new-game prune keeps the configured count. Sending
    // it here (not at install) preserves the "recording off → worker never spawned" property.
    worker.postMessage({ type: "config", keep: preference("keepReplays") })
  }
  return worker
}

/** Trigger a browser download of v1 `.colreplay` bytes (a stable filename derived from recordedAt). */
function triggerBrowserDownload(buf: ArrayBuffer, recordedAt: string): void {
  const blob = new Blob([buf], { type: "application/octet-stream" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `replay-${recordedAt.replace(/[:.]/g, "-")}.colreplay`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Ask the worker for the whole on-disk `${roomId}.colreplay` (the active file via its sync handle, a
 *  sealed one via a read-only getFile). Shared by Download and Watch. */
function fetchReplayBytes(roomId: string): Promise<ArrayBuffer> {
  const id = ++opSeq
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pendingOps.set(id, (r) =>
      r.error || !r.buf ? reject(new Error(r.error ?? "read failed")) : resolve(r.buf)
    )
    getWorker().postMessage({ type: "download", roomId, id })
  })
}

const toReplayFrame = (f: CapturedFrame): ReplayFrame =>
  f.kind === "message"
    ? { t: f.t, kind: "message", type: f.type, payload: f.payload }
    : { t: f.t, kind: f.kind, offset: f.offset, bytes: f.bytes }

// The no-loss flush state machine (ack-before-splice; see recorder-flush-core.ts). We inject the live
// capture buffers, the worker postMessage, and the meta/frame builders; the controller owns the in-flight
// bookkeeping and the tally. The worker's ack/nack messages are routed to it from worker.onmessage above.
const controller = createFlushController({
  buffers(roomId) {
    // Only the active game room is ever flushed, so resolve via the retained game-room ref. The taps key
    // buffers by serializer/room object identity, so on ack the controller splices the exact arrays here.
    const room = getActiveGameRoom()
    if (!room || room.roomId !== roomId) return {}
    const ser = (room as unknown as { serializer?: object }).serializer
    return {
      state: ser ? stateCaptures.get(ser) : undefined,
      msg: msgCaptures.get(room)
    }
  },
  meta(_roomId, recordedAt): ReplayWriterMeta {
    return {
      game: { ...GAME_BUILD },
      room: "game",
      viewerUid: store.getState().network.uid,
      recordedAt
    }
  },
  postFrames(msg) {
    // NO transfer: the frame buffers must stay valid in memory in case a write fails and the batch is
    // resent (the cost of the no-loss guarantee — postMessage structured-clones the bytes instead).
    getWorker().postMessage(msg)
  },
  toFrame: toReplayFrame,
  now: () => new Date().toISOString()
})

/** Send the active game's newly-captured frames to the recording worker. Resolves once the batch is acked
 * (durably on OPFS) or nacked; serialized inside the controller. A no-op for non-game / replay rooms. */
export function flushRoom(room: Room | null): Promise<void> {
  if (!room || room.roomId === "replay") return Promise.resolve()
  return controller.flush(room.roomId)
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

// A ROOM_DATA_BYTES payload is a Uint8Array the SDK may reuse, so COPY it (slice) and pass the bytes
// straight through — the worker's encoder stores them as ENC_BYTES. (The old path base64'd here and
// un-base64'd in the worker, a round-trip that only undid itself and violated "the render thread never
// base64s".) Other payloads pass as-is; postMessage structured-clones them to the worker.
const serializePayload = (m: unknown): unknown =>
  m instanceof Uint8Array ? m.slice() : m

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
        if (recordingEnabled && !isExcludedSerializer(this))
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
      if (recordingEnabled && rooms.game) lastGameRoom = rooms.game // retain the game room for the after-game download
      if (recordingEnabled && !isExcludedRoom(this))
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

  // Keep the capture gate in sync with the options-panel toggle (runInitially seeds it from the stored
  // pref right now, before any game join).
  subscribeToPreference("recordReplays", (v) => { recordingEnabled = v }, true)

  // Keep the worker's retention cap in sync with the keepReplays pref. Only push when the worker already
  // exists — don't spawn it just for a settings change (getWorker seeds the current value on spawn).
  subscribeToPreference("keepReplays", (v) => { worker?.postMessage({ type: "config", keep: v }) }, false)

  // Ask the browser to persist OPFS storage so a recording isn't evicted under storage pressure mid-game
  // (best effort; resolves false without throwing if not granted).
  void navigator.storage?.persist?.().catch(() => {})

  // Periodically flush the active game's frames to the recording worker so a crash can't lose them. The
  // worker prunes old OPFS recordings itself when it opens a new game's file. Skipped while recording is
  // off so a disabled recorder never spawns the worker or touches OPFS.
  setInterval(() => {
    if (recordingEnabled) void flushRoom(getActiveGameRoom())
  }, FLUSH_MS)
}

/** Recording summary (durably-acked frame count + span) for the after-game indicator. From the controller's
 * tally — the OPFS file is the source of truth for the actual download. (After a crash + reload the tally
 * only counts post-reconnect frames, so the indicator may undercount; the DOWNLOAD still reads the whole
 * OPFS file.) */
export async function getStoredCaptureInfo(
  room: Room | undefined
): Promise<{ frames: number; ms: number }> {
  if (!room || room.roomId === "replay") return { frames: 0, ms: 0 }
  return controller.captureInfo(room.roomId)
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
  await controller.drain(room.roomId) // persist + ack every captured frame before reading the file
  const buf = await fetchReplayBytes(room.roomId)
  const recordedAt = controller.recordedAt(room.roomId) ?? new Date().toISOString()
  triggerBrowserDownload(buf, recordedAt)
}

// --- the /replay library (list / watch / download / delete stored recordings) ----------------------

/** List the recordings stored in OPFS, newest first, for the /replay library. Resolves [] if the worker
 *  can't enumerate them (e.g. OPFS unavailable) — the library then just offers the external-file picker. */
export function listReplays(): Promise<ReplayFileInfo[]> {
  const id = ++opSeq
  return new Promise<ReplayFileInfo[]>((resolve) => {
    pendingOps.set(id, (r) => {
      if (r.error) console.warn("[recorder] listReplays:", r.error)
      resolve(r.files ?? [])
    })
    getWorker().postMessage({ type: "list", id })
  })
}

/** Load a stored recording straight from OPFS into a manifest the viewer plays — the "Watch" path, no
 *  manual file pick. */
export async function loadStoredReplay(roomId: string): Promise<ReplayManifest> {
  return loadReplay(await fetchReplayBytes(roomId))
}

/** Save a stored recording to the user's Downloads as a portable `.colreplay`. */
export async function downloadStoredReplay(
  roomId: string,
  recordedAt: string | null
): Promise<void> {
  triggerBrowserDownload(
    await fetchReplayBytes(roomId),
    recordedAt ?? new Date().toISOString()
  )
}

/** Delete a stored recording from OPFS. Rejects if it's the active recording or the remove fails. */
export function deleteStoredReplay(roomId: string): Promise<void> {
  const id = ++opSeq
  return new Promise<void>((resolve, reject) => {
    pendingOps.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve()))
    getWorker().postMessage({ type: "delete", roomId, id })
  })
}
