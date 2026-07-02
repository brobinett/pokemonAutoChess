import type { ReplayWriterMeta } from "./opfs-replay-writer"
import type { ReplayFrame } from "./replay-room"

// The render-thread side of the no-loss recorder, factored out of the browser glue (recorder.ts) so the
// frame-durability state machine can be unit-tested in Node (replay/verify-flush-core.mjs). It holds NO
// browser API: the live capture buffers, the worker postMessage, and the meta/frame builders are all
// injected via FlushDeps.
//
// The guarantee (code-review finding #1): a captured frame is removed from the in-memory buffer ONLY after
// the recording worker confirms (acks) it's durably appended to OPFS. Mechanism:
//   • stop-and-wait — at most ONE unacked batch per room is in flight (flushes serialize on flushChain).
//   • on ACK  → splice the batch's frames off the FRONT of the live buffers (frames captured during the
//               flush were pushed to the back and survive) + roll the tally forward.
//   • on NACK → keep the batch in flight (SAME batchId) and resend it on the next flush; nothing is spliced
//               because nothing was persisted. The worker writes batches atomically and dedups by batchId,
//               so a resend never half-duplicates on disk.
// Because a nacked batch is retained for resend, frames buffer in memory while writes keep failing (e.g.
// OPFS quota) rather than being dropped — the deliberate trade for the no-loss guarantee.

/** A captured frame as buffered on the render thread. The core treats it opaquely apart from `seq` (used to
 *  merge state + message frames into one ordered batch) and the fields toFrame() reads. */
export interface CapturedFrame {
  t: number
  seq: number
  kind: "handshake" | "state" | "patch" | "message"
  offset?: number
  bytes?: Uint8Array
  type?: string | number
  payload?: unknown
}

/** The live capture arrays for a room — the SAME instances the taps push into, so the core can splice acked
 *  frames out of them in place. Either may be absent if the room has no frames of that kind yet. */
export interface FlushBuffers {
  state?: CapturedFrame[]
  msg?: CapturedFrame[]
}

export interface FlushDeps {
  /** Resolve a room's live capture buffers. */
  buffers(roomId: string): FlushBuffers
  /** Build the writer meta for a flush (viewerUid, game build, …), stamped with the recording's start time. */
  meta(roomId: string, recordedAt: string): ReplayWriterMeta
  /** Post a frames batch to the recording worker. MUST NOT transfer the frame buffers — they have to survive
   *  in memory for a possible resend on nack. */
  postFrames(msg: {
    type: "frames"
    roomId: string
    meta: ReplayWriterMeta
    frames: ReplayFrame[]
    batchId: number
  }): void
  /** Map a captured frame to its on-disk ReplayFrame shape. */
  toFrame(frame: CapturedFrame): ReplayFrame
  /** ISO timestamp for a recording's recordedAt (injectable so tests are deterministic). */
  now(): string
}

interface PendingBatch {
  batchId: number
  roomId: string
  sLen: number
  mLen: number
  sBuf?: CapturedFrame[]
  mBuf?: CapturedFrame[]
  frames: ReplayFrame[] // retained verbatim for a resend on nack
  frameCount: number
  firstT: number
  lastT: number
  meta: ReplayWriterMeta
  settle?: (ok: boolean) => void
}

interface Tally {
  frames: number
  firstT: number
  lastT: number
  recordedAt: string
}

export function createFlushController(deps: FlushDeps) {
  // At most one unacked batch per room (stop-and-wait). Enforced by flushChain serialization; the map is
  // keyed by roomId so a resend can find the retained batch.
  const inFlight = new Map<string, PendingBatch>()
  // Per-room running summary for the after-game indicator (the OPFS file is the source of truth for the
  // actual download; this only counts DURABLY-acked frames so it never over-reports).
  const tally = new Map<string, Tally>()
  let batchSeq = 0
  let flushChain: Promise<void> = Promise.resolve()

  function ensureTally(roomId: string): Tally {
    let t = tally.get(roomId)
    if (!t) {
      t = { frames: 0, firstT: 0, lastT: 0, recordedAt: deps.now() }
      tally.set(roomId, t)
    }
    return t
  }

  async function flushImpl(roomId: string): Promise<void> {
    // A batch already in flight (a prior nack / worker error left it unacked) → resend IT verbatim, same
    // batchId, so the worker can dedup. Building a fresh batch here would reorder/duplicate frames.
    let b = inFlight.get(roomId)
    if (!b) {
      const { state, msg } = deps.buffers(roomId)
      const sLen = state?.length ?? 0
      const mLen = msg?.length ?? 0
      if (sLen + mLen === 0) return
      const merged = [
        ...(state ?? []).slice(0, sLen),
        ...(msg ?? []).slice(0, mLen)
      ].sort((x, y) => x.seq - y.seq)
      const frames = merged.map(deps.toFrame)
      const t = ensureTally(roomId)
      b = {
        batchId: ++batchSeq,
        roomId,
        sLen,
        mLen,
        sBuf: state,
        mBuf: msg,
        frames,
        frameCount: frames.length,
        firstT: frames.length ? frames[0].t : 0,
        lastT: frames.length ? frames[frames.length - 1].t : 0,
        meta: deps.meta(roomId, t.recordedAt)
      }
      inFlight.set(roomId, b)
    }
    const settled = new Promise<boolean>((res) => {
      b!.settle = res
    })
    deps.postFrames({ type: "frames", roomId, meta: b.meta, frames: b.frames, batchId: b.batchId })
    await settled
  }

  /** Send (or resend) one batch for `roomId` and resolve once the worker has acked or nacked it. Flushes are
   *  serialized through flushChain so only one batch is ever in flight. Never throws. */
  function flush(roomId: string): Promise<void> {
    flushChain = flushChain
      .then(() => flushImpl(roomId))
      .catch((e) => console.error("[recorder] flush failed", e))
    return flushChain
  }

  /** Worker confirmed a batch is on disk: splice its frames out of the live buffers + roll the tally. */
  function onAck(roomId: string, batchId: number): void {
    const b = inFlight.get(roomId)
    if (!b || b.batchId !== batchId) return // stale/duplicate ack
    inFlight.delete(roomId)
    // The batch took the first sLen/mLen of each buffer; frames captured during the flush were pushed to the
    // back, so splicing from the front removes exactly this batch's frames and keeps the new ones.
    b.sBuf?.splice(0, b.sLen)
    b.mBuf?.splice(0, b.mLen)
    const t = ensureTally(roomId)
    if (t.frames === 0 && b.frameCount) t.firstT = b.firstT
    t.frames += b.frameCount
    if (b.frameCount) t.lastT = b.lastT
    b.settle?.(true)
  }

  /** Worker rejected a batch (write failed; nothing persisted): keep it in flight for resend, splice nothing. */
  function onNack(roomId: string, batchId: number, error?: string): void {
    const b = inFlight.get(roomId)
    if (!b || b.batchId !== batchId) return
    console.error("[recorder] worker rejected a frame batch; will retry", error)
    const settle = b.settle
    b.settle = undefined
    settle?.(false) // unblock the awaiting flush; b stays in inFlight so the next flush resends it
  }

  /** The worker died/errored: unblock any awaiting flush so flushChain can't hang. The batch stays in flight
   *  (retained for resend if the worker recovers); its frames remain buffered, so nothing is lost. */
  function onWorkerError(): void {
    for (const b of inFlight.values()) {
      const settle = b.settle
      b.settle = undefined
      settle?.(false)
    }
  }

  /** Flush repeatedly until everything captured for `roomId` is durably acked (used before a download).
   *  Bounded: if the worker keeps nacking (e.g. persistent quota) give up after a few tries and let the
   *  download serve whatever IS on disk. */
  async function drain(roomId: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await flush(roomId)
      const { state, msg } = deps.buffers(roomId)
      const remaining = (state?.length ?? 0) + (msg?.length ?? 0)
      if (!inFlight.has(roomId) && remaining === 0) return
    }
    console.warn("[recorder] drain gave up with frames still unacked; download serves what reached disk")
  }

  /** Recording summary (durably-acked frame count + span) for the after-game indicator. */
  function captureInfo(roomId: string): { frames: number; ms: number } {
    const t = tally.get(roomId)
    return t ? { frames: t.frames, ms: Math.max(0, t.lastT - t.firstT) } : { frames: 0, ms: 0 }
  }

  /** The recording's start timestamp (for the download filename); undefined if nothing flushed yet. */
  function recordedAt(roomId: string): string | undefined {
    return tally.get(roomId)?.recordedAt
  }

  /** Drop a finished room's in-flight/tally state (called when returning to the lobby). Settles any batch
   *  still awaiting an ack FIRST (mirror onWorkerError): a parked flushImpl is `await settled`, so dropping
   *  the batch without settling leaves that promise pending forever → flushChain wedges and every later
   *  flush/drain (this room and the next game's) silently never runs. */
  function forget(roomId: string): void {
    const b = inFlight.get(roomId)
    if (b) {
      const settle = b.settle
      b.settle = undefined
      settle?.(false)
    }
    inFlight.delete(roomId)
    tally.delete(roomId)
  }

  return { flush, onAck, onNack, onWorkerError, drain, captureInfo, recordedAt, forget }
}
