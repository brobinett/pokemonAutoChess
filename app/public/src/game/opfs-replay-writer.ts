import { encodeFrameV1, encodeHeaderV1 } from "./replay-format"
import type { ReplayFrame, ReplayManifest } from "./replay-room"

// Streams a v1 binary `.colreplay` to a file as frames arrive — the write side of the OPFS worker
// recorder (replay/V1-RECORDER-DESIGN.md Step 5). It holds NO browser API directly: it writes through a
// minimal synchronous `ReplayFileHandle` so the same logic runs against an OPFS FileSystemSyncAccessHandle
// in the worker AND against a Node fake in tests (replay/verify-opfs-writer.mjs).
//
// Lifecycle: at game-join open a handle and `new ReplayFileWriter(handle, { meta })` — an empty file gets
// the header; a non-empty one (a reconnect AFTER a page reload re-opened the same `${roomId}` file) is
// appended to with NO new header. appendFrame() encodes one frame record at the running offset; flush()
// fsyncs (the worker calls it after each acked batch and on close); close() flushes + releases the handle so
// the main thread can read the file for download. Memory stays tiny — only the running offset + prevT live
// here, never the whole match.

/** The subset of FileSystemSyncAccessHandle this writer needs (so tests can fake it). */
export interface ReplayFileHandle {
  /** Write `buffer` at byte offset `opts.at` (default current cursor); returns bytes written. */
  write(buffer: Uint8Array, opts?: { at?: number }): number
  /** Current file size in bytes. */
  getSize(): number
  /** Persist pending writes to disk. */
  flush(): void
  /** Release the (exclusive) handle. */
  close(): void
  /** Shrink the file back to `newSize` bytes — used to roll back a failed batch write so the file is never
   *  left with a half-written record. Optional: FileSystemSyncAccessHandle has it; older fakes may not. */
  truncate?(newSize: number): void
}

export type ReplayWriterMeta = Pick<ReplayManifest, "game" | "room" | "viewerUid" | "recordedAt">

export class ReplayFileWriter {
  private offset: number
  // prevT threads tDelta across appendFrame calls. Null at (re)open → the next frame is tDelta 0: a fresh
  // file's first frame opens the timeline at 0; a reopened file's first frame continues from the file's
  // accumulated time (the disconnect gap collapses — dead time anyway). See encodeFrameV1.
  private prevT: number | null = null
  private framesWritten = 0
  private readonly resumed: boolean

  constructor(
    private readonly handle: ReplayFileHandle,
    opts: { meta: ReplayWriterMeta }
  ) {
    const size = handle.getSize()
    if (size === 0) {
      const header = encodeHeaderV1(opts.meta)
      handle.write(header, { at: 0 })
      this.offset = header.length
      this.resumed = false
    } else {
      // Reconnect after a reload reopened the same roomId file — append past what's already there.
      this.offset = size
      this.resumed = true
    }
  }

  /** Encode one frame and append it at the running offset. */
  appendFrame(frame: ReplayFrame): void {
    const { bytes, t } = encodeFrameV1(frame, this.prevT)
    this.handle.write(bytes, { at: this.offset })
    this.offset += bytes.length
    this.prevT = t
    this.framesWritten++
  }

  /** Append a batch of frames as a SINGLE atomic write. Encode the whole batch into one buffer (threading
   *  tDelta), write it once at the running offset, then advance. If the write throws (OPFS quota/IO) or
   *  comes up short, roll the file back to its pre-batch size and rethrow — so the batch is either fully on
   *  disk or not at all. The recorder relies on this for its no-loss guarantee: a caller that gets the
   *  rejection can safely resend the SAME batch without risking a half-written duplicate on disk. */
  appendFrames(frames: ReplayFrame[]): void {
    if (frames.length === 0) return
    const startOffset = this.offset
    const startPrevT = this.prevT
    // Encode every frame first (threading prevT) and concatenate, so the actual disk write is one call.
    // This is byte-identical to writing each frame separately (verify-stream-encode proves incremental ==
    // one-shot), but the OS write is now all-or-nothing.
    let prevT = this.prevT
    let total = 0
    const parts: Uint8Array[] = []
    for (const f of frames) {
      const { bytes, t } = encodeFrameV1(f, prevT)
      parts.push(bytes)
      total += bytes.length
      prevT = t
    }
    const buf = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
      buf.set(p, at)
      at += p.length
    }

    let written: number
    try {
      written = this.handle.write(buf, { at: startOffset })
    } catch (e) {
      this.rollback(startOffset, startPrevT)
      throw e
    }
    if (written !== buf.length) {
      this.rollback(startOffset, startPrevT)
      throw new Error(`ReplayFileWriter: short write ${written}/${buf.length} B`)
    }
    this.offset = startOffset + buf.length
    this.prevT = prevT
    this.framesWritten += frames.length
  }

  /** Undo a failed batch: truncate the file back to its pre-batch size (best effort) and restore the
   *  running offset + prevT so the next write resumes cleanly. */
  private rollback(offset: number, prevT: number | null): void {
    try {
      this.handle.truncate?.(offset)
    } catch (e) {
      console.error("[colreplay] rollback truncate failed", e)
    }
    this.offset = offset
    this.prevT = prevT
  }

  flush(): void {
    this.handle.flush()
  }

  /** Flush, then release the handle (so the file can be read for download). flush() is in a try/finally so a
   *  flush throw (a final quota/IO error, exactly when close runs under pressure) still releases the exclusive
   *  sync handle — otherwise the lock on `${roomId}.colreplay` leaks for the page session and a later
   *  Watch/Download/Delete of it throws NoModificationAllowedError. */
  close(): void {
    try {
      this.handle.flush()
    } finally {
      this.handle.close()
    }
  }

  /** Current file size (bytes written so far). */
  get size(): number {
    return this.offset
  }

  /** Frames appended by THIS writer (excludes any present from a prior session when resumed). */
  get count(): number {
    return this.framesWritten
  }

  /** True if this writer opened onto a non-empty file (resumed a reconnect). */
  get isResumed(): boolean {
    return this.resumed
  }
}
