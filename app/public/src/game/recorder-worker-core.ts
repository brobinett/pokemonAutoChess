import {
  ReplayFileWriter,
  type ReplayFileHandle,
  type ReplayWriterMeta
} from "./opfs-replay-writer"
import type { ReplayFrame } from "./replay-room"

// The pure logic of the recorder worker, factored out of the browser shell (recorder.worker.ts) so it can
// be unit-tested in Node with a fake handle + a capturing postMessage (replay/verify-recorder-worker.mjs).
// The worker owns ONE open recording at a time (the active game's `${roomId}.colreplay`), streaming frames
// to it through a ReplayFileWriter; on a new roomId it closes the old file and opens the new one. All of
// the browser API (OPFS directory, createSyncAccessHandle, prune by mtime, self.postMessage) is injected
// via WorkerDeps, so this module references no browser globals.

/** A sync handle that can also be read back for download (OPFS FileSystemSyncAccessHandle has read()). */
export interface ReplayReadWriteHandle extends ReplayFileHandle {
  read(buffer: Uint8Array, opts?: { at?: number }): number
}

export interface WorkerDeps {
  /** Open (creating if needed) the OPFS file for `roomId` and return its sync handle. A reconnect after a
   *  reload reopens the SAME file → non-empty → ReplayFileWriter appends. */
  openHandle(roomId: string): Promise<ReplayReadWriteHandle>
  /** Read the whole on-disk `${roomId}.colreplay` (read-only, no exclusive handle) for a download of a file
   *  that isn't the active one — e.g. after a reload, before the first post-reconnect flush reopened it.
   *  Returns null if the file doesn't exist. Optional (older shells / tests may omit it). */
  readFile?(roomId: string): Promise<Uint8Array | null>
  /** Keep the `keep` most-recent recordings plus `protect` (the in-progress one), deleting the rest. */
  prune?(keep: number, protect: string): Promise<void>
  /** Post a message back to the main thread (with optional transferables). */
  post(message: unknown, transfer?: Transferable[]): void
}

export type RecorderInMessage =
  | { type: "frames"; roomId: string; meta: ReplayWriterMeta; frames: ReplayFrame[]; batchId?: number }
  | { type: "flush" }
  | { type: "download"; roomId: string; id: number }
  | { type: "close" }

const KEEP_RECENT = 2

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e)

export function createRecorderWorker(deps: WorkerDeps) {
  let current: {
    roomId: string
    handle: ReplayReadWriteHandle
    writer: ReplayFileWriter
    // Highest batchId durably appended to THIS file. A "frames" message with batchId <= this is a resend
    // of an already-written batch (the main thread retried after a missed ack / worker error) — we skip the
    // write but still ack, so retries are idempotent. Reset per file (a new roomId or a fresh page session).
    lastBatchId: number
  } | null = null

  async function ensureOpen(roomId: string, meta: ReplayWriterMeta) {
    if (current?.roomId === roomId) return
    if (current) {
      try {
        current.writer.close()
      } catch (e) {
        console.error("[recorder.worker] closing previous file", e)
      }
      current = null
    }
    const handle = await deps.openHandle(roomId)
    let writer: ReplayFileWriter
    try {
      // The constructor writes the header synchronously; if that first write throws (IO/quota), close the
      // just-opened exclusive sync handle so we don't leak the lock on `${roomId}.colreplay` (the next
      // ensureOpen's createSyncAccessHandle would otherwise throw NoModificationAllowedError forever).
      writer = new ReplayFileWriter(handle, { meta })
    } catch (e) {
      try {
        handle.close()
      } catch {
        // ignore
      }
      throw e
    }
    current = { roomId, handle, writer, lastBatchId: 0 }
    if (deps.prune) await deps.prune(KEEP_RECENT, roomId)
  }

  /** Process one inbound message. Caller MUST serialize calls (await each before the next) so the async
   *  open can't race a second message into a duplicate handle on the same exclusive file. */
  async function handleMessage(msg: RecorderInMessage): Promise<void> {
    switch (msg.type) {
      case "frames": {
        const batchId = msg.batchId ?? 0
        // Open (or reopen) the file. If that fails the batch isn't persisted → nack so the main thread keeps
        // the frames buffered and resends them (no loss).
        try {
          await ensureOpen(msg.roomId, msg.meta)
        } catch (e) {
          deps.post({ type: "nack", roomId: msg.roomId, batchId, error: errMsg(e) })
          break
        }
        const cur = current
        if (!cur) {
          deps.post({ type: "nack", roomId: msg.roomId, batchId, error: "no active file after open" })
          break
        }
        if (batchId !== 0 && batchId <= cur.lastBatchId) {
          // Already on disk (a resend after a missed ack) — skip the write, but ack so the main thread frees
          // the frames. appendFrames is atomic, so a prior attempt either fully wrote this or wrote nothing;
          // since lastBatchId advanced, it fully wrote → safe to skip.
          deps.post({ type: "ack", roomId: msg.roomId, batchId })
          break
        }
        try {
          cur.writer.appendFrames(msg.frames) // atomic: fully appended, or rolled back + throws
          cur.lastBatchId = batchId
          deps.post({ type: "ack", roomId: msg.roomId, batchId })
        } catch (e) {
          // Nothing was written (atomic rollback) → nack; the main thread resends the same batch later.
          deps.post({ type: "nack", roomId: msg.roomId, batchId, error: errMsg(e) })
        }
        break
      }
      case "flush":
        current?.writer.flush()
        break
      case "download": {
        // ALWAYS reply (even on a flush/read failure) so the main-thread download promise can't hang forever.
        if (current && current.roomId === msg.roomId) {
          try {
            current.writer.flush()
            const size = current.writer.size
            const buf = new Uint8Array(size)
            current.handle.read(buf, { at: 0 })
            deps.post({ type: "downloaded", id: msg.id, buf: buf.buffer, bytes: size }, [buf.buffer])
          } catch (e) {
            deps.post({ type: "downloaded", id: msg.id, error: errMsg(e) })
          }
          break
        }
        // Not the active file — e.g. after a reload the user hit Download before the first post-reconnect
        // flush reopened it. The whole `.colreplay` is still on disk; read it directly (read-only).
        try {
          const bytes = deps.readFile ? await deps.readFile(msg.roomId) : null
          if (!bytes || bytes.length === 0) {
            deps.post({ type: "downloaded", id: msg.id, error: "no recording for room" })
          } else {
            // Hand off a standalone ArrayBuffer (transferable) so the read bytes aren't copied again.
            const ab =
              bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                ? bytes.buffer
                : bytes.slice().buffer
            deps.post({ type: "downloaded", id: msg.id, buf: ab, bytes: bytes.length }, [ab])
          }
        } catch (e) {
          deps.post({ type: "downloaded", id: msg.id, error: errMsg(e) })
        }
        break
      }
      case "close":
        if (current) {
          try {
            current.writer.close()
          } catch (e) {
            console.error("[recorder.worker] close", e)
          }
          current = null
        }
        break
    }
  }

  return {
    handleMessage,
    /** test/inspection only */
    get activeRoom() {
      return current?.roomId ?? null
    }
  }
}
