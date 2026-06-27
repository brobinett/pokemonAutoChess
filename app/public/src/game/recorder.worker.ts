/// <reference lib="webworker" />
import {
  createRecorderWorker,
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
