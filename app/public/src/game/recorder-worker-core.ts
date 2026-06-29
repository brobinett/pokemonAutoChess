import {
  ReplayFileWriter,
  type ReplayFileHandle,
  type ReplayWriterMeta
} from "./opfs-replay-writer"
import { readReplayHeader } from "./replay-format"
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

/** One raw stored-recording entry the shell hands the core for `list`: the filename stem, a generous
 *  header-prefix read (the core parses it with readReplayHeader — no need to read whole multi-MB files),
 *  and cheap file stats. */
export interface RawReplayEntry {
  roomId: string
  header: Uint8Array
  bytes: number
  mtime: number
}

/** A stored recording, summarised for the library list. recordedAt/game/viewerUid come from the file
 *  header when it parses; null when it doesn't (a foreign/corrupt file — still listable by mtime + size). */
export interface ReplayFileInfo {
  roomId: string
  recordedAt: string | null
  mtime: number
  bytes: number
  game: { version: string; assetsVersion: string } | null
  viewerUid: string | null
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
  /** Enumerate stored recordings (filename stem + header-prefix read + size + mtime), any order — the core
   *  sorts. Optional (older shells / tests may omit it). */
  list?(): Promise<RawReplayEntry[]>
  /** Delete the stored `${roomId}.colreplay`. Optional. */
  remove?(roomId: string): Promise<void>
  /** Post a message back to the main thread (with optional transferables). */
  post(message: unknown, transfer?: Transferable[]): void
}

export type RecorderInMessage =
  | { type: "frames"; roomId: string; meta: ReplayWriterMeta; frames: ReplayFrame[]; batchId?: number }
  | { type: "flush" }
  | { type: "download"; roomId: string; id: number }
  | { type: "list"; id: number }
  | { type: "delete"; roomId: string; id: number }
  | { type: "config"; keep: number }
  | { type: "close" }

// How many SEALED recordings survive a new-game prune (plus the in-progress one, always protected). The
// default; the main thread overrides it from the `keepReplays` preference via a "config" message.
const DEFAULT_KEEP_RECENT = 2

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e)
const isQuotaError = (e: unknown): boolean =>
  e instanceof Error && (e.name === "QuotaExceededError" || /quota/i.test(e.message))

/** Parse a raw entry's header into the list summary; foreign/corrupt headers degrade to nulls (still
 *  listed, orderable by mtime, deletable). */
function summariseEntry(e: RawReplayEntry): ReplayFileInfo {
  const meta = readReplayHeader(e.header)
  return {
    roomId: e.roomId,
    recordedAt: meta?.recordedAt ?? null,
    mtime: e.mtime,
    bytes: e.bytes,
    game: meta
      ? { version: meta.game.version, assetsVersion: meta.game.assetsVersion }
      : null,
    viewerUid: meta?.viewerUid ?? null
  }
}

/** Newest-first sort key: the header's recordedAt when parseable, else the file mtime. */
const sortKey = (f: ReplayFileInfo): number =>
  (f.recordedAt ? Date.parse(f.recordedAt) : Number.NaN) || f.mtime

export function createRecorderWorker(deps: WorkerDeps) {
  // How many sealed recordings to keep on a new-game prune; overridden by a "config" message.
  let keepRecent = DEFAULT_KEEP_RECENT
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
    if (deps.prune) await deps.prune(keepRecent, roomId)
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
        } catch (e) {
          // Atomic rollback → nothing written → nack so the main thread resends the same batch. On a quota
          // error, first reclaim space by hard-pruning sealed recordings (keep 0; the active file is
          // protected) so the resend can succeed instead of buffering frames in RAM unbounded.
          if (deps.prune && isQuotaError(e)) {
            try {
              await deps.prune(0, msg.roomId)
            } catch {
              // best effort — if it can't reclaim, the resend nacks again and the frames stay buffered
            }
          }
          deps.post({ type: "nack", roomId: msg.roomId, batchId, error: errMsg(e) })
          break
        }
        // Appended (durably on disk). Advance lastBatchId BEFORE flushing so a flush throw can't cause a
        // resend to re-append this batch (a duplicate). fsync so the ack means "durable", not just "written";
        // a flush failure is logged but does NOT nack — the bytes are already appended (OPFS persists written
        // bytes across a reload anyway), so a later flush/close retries the fsync.
        cur.lastBatchId = batchId
        try {
          cur.writer.flush()
        } catch (e) {
          console.error("[recorder.worker] flush after append failed", e)
        }
        deps.post({ type: "ack", roomId: msg.roomId, batchId })
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
      case "config":
        // Clamp to >= 1: a 0 would prune away the game that just finished. The active recording is always
        // protected separately, so `keep` only governs how many SEALED files survive a new-game prune.
        keepRecent = Math.max(1, Math.floor(msg.keep))
        break
      case "list": {
        // Enumerate stored recordings for the library. Always replies (even on enumeration failure / no
        // OPFS) so the main-thread promise can't hang; an empty list is a valid answer.
        try {
          const raw = deps.list ? await deps.list() : []
          const files = raw.map(summariseEntry).sort((a, b) => sortKey(b) - sortKey(a))
          deps.post({ type: "listed", id: msg.id, files })
        } catch (e) {
          deps.post({ type: "listed", id: msg.id, files: [], error: errMsg(e) })
        }
        break
      }
      case "delete": {
        // Never delete the file we're actively writing — that would orphan the open sync handle and lose the
        // in-progress recording. (The library only lists/deletes sealed files, but guard defensively.)
        if (current?.roomId === msg.roomId) {
          deps.post({ type: "deleted", id: msg.id, error: "cannot delete the active recording" })
          break
        }
        try {
          if (deps.remove) await deps.remove(msg.roomId)
          deps.post({ type: "deleted", id: msg.id, roomId: msg.roomId })
        } catch (e) {
          deps.post({ type: "deleted", id: msg.id, error: errMsg(e) })
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
