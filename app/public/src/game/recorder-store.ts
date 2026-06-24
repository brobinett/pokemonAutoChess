// Durable frame storage for the in-client recorder (IndexedDB). The recorder buffers frames in memory,
// but a crash + page reload wipes that — so the download after a reconnect used to start from the
// reconnect, losing everything before the crash. Here we persist captured frames to IndexedDB keyed by
// the game's roomId, flushed ~1s at a time. Colyseus reconnect rejoins the SAME roomId, so
// post-reconnect frames append to the same recording and the download includes the whole match. Best
// effort: a hard crash loses at most the last unflushed second.
//
// One DB "pac-replay" with two stores: `frames` (autoIncrement key = arrival order, indexed by room) and
// `meta` (one row per room: firstT/lastT/count for a cheap indicator + keep-recent pruning). Storage is
// bounded to the most-recent recordings (pruneToRecent) since a past game isn't downloadable from the UI.

const DB_NAME = "pac-replay"
const DB_VERSION = 1
const FRAMES = "frames"
const META = "meta"

export interface StoredFrame {
  room: string
  t: number
  seq: number
  kind: "handshake" | "state" | "patch" | "message"
  offset?: number
  bytes?: Uint8Array
  type?: string | number
  payload?: unknown
}

interface MetaRow {
  room: string
  firstT: number
  lastT: number
  count: number
  viewerUid: string
  version: string
}

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(FRAMES)) {
        db.createObjectStore(FRAMES, { autoIncrement: true }).createIndex(
          "room",
          "room"
        )
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "room" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

const reqP = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
    tx.onabort = () => rej(tx.error)
  })

/** Append a batch of frames for `room` and bump its meta row. Frames keep arrival (seq) order; the
 * autoIncrement key preserves it within and across batches, so reads come back chronological. */
export async function appendFrames(
  room: string,
  frames: StoredFrame[],
  info: { viewerUid: string; version: string }
): Promise<void> {
  if (!frames.length) return
  const db = await openDb()
  const tx = db.transaction([FRAMES, META], "readwrite")
  const fs = tx.objectStore(FRAMES)
  for (const f of frames) fs.add(f)
  // Read-modify-write the meta row inside the same tx (no await between ops → tx stays active).
  const ms = tx.objectStore(META)
  const getReq = ms.get(room)
  getReq.onsuccess = () => {
    const cur = getReq.result as MetaRow | undefined
    ms.put({
      room,
      firstT: cur?.firstT ?? frames[0].t,
      lastT: frames[frames.length - 1].t,
      count: (cur?.count ?? 0) + frames.length,
      viewerUid: info.viewerUid,
      version: info.version
    } satisfies MetaRow)
  }
  await txDone(tx)
}

/** All frames for `room`, in arrival order (autoIncrement key order). */
export async function loadFrames(room: string): Promise<StoredFrame[]> {
  const db = await openDb()
  const tx = db.transaction(FRAMES, "readonly")
  return reqP(tx.objectStore(FRAMES).index("room").getAll(room))
}

/** Cheap recording summary from the meta row (frame count + span ms), for the download indicator. */
export async function storedInfo(
  room: string
): Promise<{ frames: number; ms: number; viewerUid?: string }> {
  const db = await openDb()
  const tx = db.transaction(META, "readonly")
  const m = (await reqP(tx.objectStore(META).get(room))) as MetaRow | undefined
  return m
    ? { frames: m.count, ms: m.lastT - m.firstT, viewerUid: m.viewerUid }
    : { frames: 0, ms: 0 }
}

/** Keep only the `keep` most-recently-active recordings (plus `protect`, the in-progress game so it's
 * never dropped mid-record), deleting the rest. Bounds IndexedDB to a couple of games regardless of how
 * many are played without downloading — a past game isn't reachable from the UI anyway (only the
 * just-finished game's after-screen offers a download), so there's no reason to retain it. */
export async function pruneToRecent(
  keep: number,
  protect?: string
): Promise<void> {
  const db = await openDb()
  const metas = (await reqP(
    db.transaction(META, "readonly").objectStore(META).getAll()
  )) as MetaRow[]
  const keepSet = new Set(
    metas
      .sort((a, b) => b.lastT - a.lastT)
      .slice(0, keep)
      .map((m) => m.room)
  )
  if (protect) keepSet.add(protect)
  const drop = metas.map((m) => m.room).filter((r) => !keepSet.has(r))
  if (!drop.length) return
  const tx = db.transaction([FRAMES, META], "readwrite")
  const idx = tx.objectStore(FRAMES).index("room")
  for (const room of drop) {
    const cur = idx.openCursor(IDBKeyRange.only(room))
    cur.onsuccess = () => {
      const c = cur.result
      if (c) {
        c.delete()
        c.continue()
      }
    }
    tx.objectStore(META).delete(room)
  }
  await txDone(tx)
}
