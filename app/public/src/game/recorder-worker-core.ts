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
  /** Keep the `keep` most-recent recordings plus `protect` (the in-progress one), deleting the rest. */
  prune?(keep: number, protect: string): Promise<void>
  /** Post a message back to the main thread (with optional transferables). */
  post(message: unknown, transfer?: Transferable[]): void
}

export type RecorderInMessage =
  | { type: "frames"; roomId: string; meta: ReplayWriterMeta; frames: ReplayFrame[] }
  | { type: "flush" }
  | { type: "download"; roomId: string; id: number }
  | { type: "close" }

const KEEP_RECENT = 2

export function createRecorderWorker(deps: WorkerDeps) {
  let current: {
    roomId: string
    handle: ReplayReadWriteHandle
    writer: ReplayFileWriter
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
    current = { roomId, handle, writer: new ReplayFileWriter(handle, { meta }) }
    if (deps.prune) await deps.prune(KEEP_RECENT, roomId)
  }

  /** Process one inbound message. Caller MUST serialize calls (await each before the next) so the async
   *  open can't race a second message into a duplicate handle on the same exclusive file. */
  async function handleMessage(msg: RecorderInMessage): Promise<void> {
    switch (msg.type) {
      case "frames":
        await ensureOpen(msg.roomId, msg.meta)
        current?.writer.appendFrames(msg.frames)
        break
      case "flush":
        current?.writer.flush()
        break
      case "download": {
        if (!current || current.roomId !== msg.roomId) {
          deps.post({ type: "downloaded", id: msg.id, error: "no recording for room" })
          return
        }
        current.writer.flush()
        const size = current.writer.size
        const buf = new Uint8Array(size)
        current.handle.read(buf, { at: 0 })
        deps.post({ type: "downloaded", id: msg.id, buf: buf.buffer, bytes: size }, [buf.buffer])
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
