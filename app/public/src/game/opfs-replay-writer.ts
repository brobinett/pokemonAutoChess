import { encodeFrameV1, encodeHeaderV1, encodeReplayTrailer, trailerByteLength, type ReplaySummary } from "./replay-format"
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
  /** Read up to `buffer.length` bytes at `opts.at` (default 0); returns bytes read. Optional: the real OPFS
   *  FileSystemSyncAccessHandle has it (the worker's ReplayReadWriteHandle exposes it); older fakes may not.
   *  Used only on resume, to detect + strip an EOF trailer before appending. */
  read?(buffer: Uint8Array, opts?: { at?: number }): number
}

// Bounded tail read on resume: large enough to hold any real match-summary trailer (a full POV team + name is
// well under 1 KB), so parseTrailerFooter can find the footer without reading a whole multi-MB file.
const RESUME_TAIL_SCAN = 64 * 1024

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
      // Reconnect reopened the same roomId file — append past what's already there. But if the file was
      // SEALED with an EOF match-summary trailer (written on the prior lobby-return close), strip it FIRST:
      // appending frames after the trailer yields [header][frames][TRAILER][more frames], and the decoder
      // bounds the frame region by the trailer footer at EOF — so once more frames follow, the tail is no
      // longer "CLTR", the trailer is missed, and the frame loop runs into the summary JSON ("unknown frame
      // kind") and loses the whole post-reconnect half of the match.
      this.offset = this.stripResumeTrailer(size)
      this.resumed = true
    }
  }

  /** On resume, detect a match-summary trailer at EOF and truncate it off, returning the offset to append at
   *  (the file size, minus the trailer if one was stripped). Best-effort: needs both handle.read (to detect)
   *  and handle.truncate (to strip); the real OPFS sync handle has both. Without either, or on an IO error,
   *  it leaves the file unchanged — the common reload path (fresh file, no trailer) is unaffected. */
  private stripResumeTrailer(size: number): number {
    if (!this.handle.read || !this.handle.truncate) return size
    const tailLen = Math.min(size, RESUME_TAIL_SCAN)
    const tail = new Uint8Array(tailLen)
    let got: number
    try {
      got = this.handle.read(tail, { at: size - tailLen })
    } catch (e) {
      console.error("[colreplay] resume tail read failed; appending without trailer strip", e)
      return size
    }
    const trailerLen = trailerByteLength(tail.subarray(0, got))
    if (trailerLen == null) return size
    const newSize = size - trailerLen
    try {
      this.handle.truncate(newSize)
    } catch (e) {
      console.error("[colreplay] resume trailer truncate failed; appending without trailer strip", e)
      return size
    }
    return newSize
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

  /** Append the match-summary trailer (POV final team + placement) as the file's EOF footer — called once at
   *  close, after the last frame. Best-effort: a failure here must never lose the recording, so it's guarded
   *  and only advances the offset on a full write (a short/failed write is rolled back so the file ends at the
   *  last good frame, i.e. simply trailer-less). */
  writeTrailer(summary: ReplaySummary): void {
    const bytes = encodeReplayTrailer(summary)
    const at = this.offset
    try {
      const written = this.handle.write(bytes, { at })
      if (written !== bytes.length) {
        this.handle.truncate?.(at) // partial footer would corrupt the tail read — drop it
        return
      }
      this.offset += bytes.length
    } catch (e) {
      console.error("[colreplay] trailer write failed (recording kept, no summary)", e)
      try {
        this.handle.truncate?.(at)
      } catch {
        /* best effort */
      }
    }
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
