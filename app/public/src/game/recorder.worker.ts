/// <reference lib="webworker" />
import {
  createRecorderWorker,
  type RawReplayEntry,
  type ReplayReadWriteHandle
} from "./recorder-worker-core"

// Dedicated worker that owns the recording's file I/O — keeps capture/encode off the render thread and
// streams the v1 `.colreplay` straight to an OPFS file (low RAM, crash-durable). The main-thread taps
// (recorder.ts) postMessage frame batches here; this worker appends them via a ReplayFileWriter. OPFS +
// createSyncAccessHandle need no permission prompt and are worker-only, which is exactly why the recorder
// uses them. All logic lives in recorder-worker-core (Node-tested); this file is the browser glue.

declare const self: DedicatedWorkerGlobalScope

let dirPromise: Promise<FileSystemDirectoryHandle> | null = null
function replaysDir(): Promise<FileSystemDirectoryHandle> {
  if (!dirPromise) {
    dirPromise = navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle("replays", { create: true }))
  }
  return dirPromise
}

const core = createRecorderWorker({
  async openHandle(roomId): Promise<ReplayReadWriteHandle> {
    const dir = await replaysDir()
    const fh = await dir.getFileHandle(`${roomId}.colreplay`, { create: true })
    // Sync access handle: dedicated-worker only; write/read/getSize/flush/close are synchronous and fast.
    const h = await (fh as unknown as { createSyncAccessHandle(): Promise<ReplayReadWriteHandle> }).createSyncAccessHandle()
    return h as ReplayReadWriteHandle
  },
  async readFile(roomId): Promise<Uint8Array | null> {
    // Read-only whole-file read for a download of a NON-active file (e.g. after a reload, before the first
    // post-reconnect flush reopened it). getFile() doesn't need the exclusive sync handle, so it works on a
    // file we aren't currently writing. Returns null if the recording isn't on disk.
    const dir = await replaysDir()
    let fh: FileSystemFileHandle
    try {
      fh = await dir.getFileHandle(`${roomId}.colreplay`, { create: false })
    } catch {
      return null
    }
    const file = await fh.getFile()
    return new Uint8Array(await file.arrayBuffer())
  },
  async list(): Promise<RawReplayEntry[]> {
    // Enumerate every stored recording for the library. Read only a generous header PREFIX + a small TAIL of
    // each file (never the whole multi-MB recording): the metadata JSON is a few hundred bytes at the front,
    // the match-summary trailer a few hundred at the end; the core parses both.
    const HEADER_PREFIX = 16384
    const TAIL_BYTES = 4096
    const dir = await replaysDir()
    const out: RawReplayEntry[] = []
    const iter = dir as unknown as {
      entries(): AsyncIterable<[string, FileSystemHandle]>
    }
    for await (const [name, handle] of iter.entries()) {
      if (!name.endsWith(".colreplay") || handle.kind !== "file") continue
      try {
        const file = await (handle as FileSystemFileHandle).getFile()
        const header = new Uint8Array(
          await file.slice(0, HEADER_PREFIX).arrayBuffer()
        )
        const tail = new Uint8Array(
          await file.slice(Math.max(0, file.size - TAIL_BYTES)).arrayBuffer()
        )
        out.push({
          roomId: name.slice(0, -".colreplay".length),
          header,
          tail,
          bytes: file.size,
          mtime: file.lastModified
        })
      } catch {
        // a file held open by the active sync handle may be unreadable here — skip it (lists next time)
      }
    }
    return out
  },
  async remove(roomId): Promise<void> {
    const dir = await replaysDir()
    await dir.removeEntry(`${roomId}.colreplay`)
  },
  async prune(keep, protect) {
    const dir = await replaysDir()
    const entries: { name: string; mtime: number }[] = []
    const iter = dir as unknown as {
      entries(): AsyncIterable<[string, FileSystemHandle]>
    }
    for await (const [name, handle] of iter.entries()) {
      if (!name.endsWith(".colreplay") || handle.kind !== "file") continue
      try {
        const file = await (handle as FileSystemFileHandle).getFile()
        entries.push({ name, mtime: file.lastModified })
      } catch {
        // a file held open by the active sync handle may be unreadable here — skip (it's the protected one)
      }
    }
    const keepNames = new Set(
      entries
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, keep)
        .map((e) => e.name)
    )
    keepNames.add(`${protect}.colreplay`)
    for (const e of entries) {
      if (!keepNames.has(e.name)) {
        try {
          await dir.removeEntry(e.name)
        } catch {
          // best effort
        }
      }
    }
  },
  post: (message, transfer) => self.postMessage(message, transfer ?? [])
})

// Serialize ALL message handling: the async open must fully complete before the next message is processed,
// or two "frames" messages could both try to create the same exclusive sync handle on one file.
let chain: Promise<void> = Promise.resolve()
self.onmessage = (e: MessageEvent) => {
  chain = chain
    .then(() => core.handleMessage(e.data))
    .catch((err) => console.error("[recorder.worker]", err))
}

self.postMessage({ type: "ready" })
