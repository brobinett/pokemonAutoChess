import { Room, SchemaSerializer } from "@colyseus/sdk"
import { rooms } from "../network"
import type { ReplayManifest } from "./replay-room"

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

interface CapturedFrame {
  t: number
  seq: number
  kind: "handshake" | "state" | "patch" | "message"
  offset?: number
  bytes?: Uint8Array
  type?: string | number
  payload?: unknown
}

const stateCaptures = new WeakMap<object, CapturedFrame[]>() // serializer instance -> frames
const msgCaptures = new WeakMap<object, CapturedFrame[]>() // room instance -> message frames
let seq = 0
let installed = false

// Strong ref to the most recent game room so its captured frames survive after rooms.game is cleared
// (e.g. on the after-game screen for the download). Tracked automatically from the taps below — no
// visible in-game UI needed.
let lastGameRoom: Room | null = null
export function getActiveGameRoom(): Room | null {
  return rooms.game ?? lastGameRoom
}

const push = (map: WeakMap<object, CapturedFrame[]>, key: object, frame: CapturedFrame) => {
  let arr = map.get(key)
  if (!arr) map.set(key, (arr = []))
  arr.push(frame)
}

const serializePayload = (m: unknown): unknown =>
  m instanceof Uint8Array ? { __bytes__: bytesToB64(m) } : m

function bytesToB64(u8: Uint8Array): string {
  let s = ""
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}

/** Install the inbound-stream taps. Idempotent; call once at app startup, before any game join. */
export function installRecorder() {
  if (installed) return
  installed = true

  const S = SchemaSerializer.prototype as unknown as {
    handshake: (b: Uint8Array, it?: { offset: number }) => unknown
    setState: (b: Uint8Array, it?: { offset: number }) => unknown
    patch: (b: Uint8Array, it?: { offset: number }) => unknown
  }
  const tap = (orig: (b: Uint8Array, it?: { offset: number }) => unknown, kind: CapturedFrame["kind"], defaultOffset: number) =>
    function (this: object, bytes: Uint8Array, it?: { offset: number }) {
      push(stateCaptures, this, {
        t: Date.now(),
        seq: seq++,
        kind,
        offset: it?.offset ?? defaultOffset,
        bytes: bytes.slice() // copy: the SDK reuses the underlying buffer for later messages
      })
      return orig.call(this, bytes, it)
    }
  S.handshake = tap(S.handshake, "handshake", 0)
  S.setState = tap(S.setState, "state", 1)
  S.patch = tap(S.patch, "patch", 1)

  const R = Room.prototype as unknown as { dispatchMessage: (t: string | number, m: unknown) => unknown }
  const origDispatch = R.dispatchMessage
  R.dispatchMessage = function (this: object, type: string | number, message: unknown) {
    if (rooms.game) lastGameRoom = rooms.game // retain the game room for the after-game download
    push(msgCaptures, this, { t: Date.now(), seq: seq++, kind: "message", type, payload: serializePayload(message) })
    return origDispatch.call(this, type, message)
  }
}

/** Captured frame count + span for the given room (for the recording indicator). O(1): frames are
 * pushed in receive order, so first/last elements bound the span — avoids spreading thousands of
 * frames on every poll (which caused GC jank during long games). */
export function getCaptureInfo(room: Room | undefined): { frames: number; ms: number } {
  if (!room) return { frames: 0, ms: 0 }
  const s = stateCaptures.get((room as unknown as { serializer: object }).serializer) ?? []
  const m = msgCaptures.get(room) ?? []
  const frames = s.length + m.length
  if (frames === 0) return { frames: 0, ms: 0 }
  const firstT = Math.min(s.length ? s[0].t : Infinity, m.length ? m[0].t : Infinity)
  const lastT = Math.max(s.length ? s[s.length - 1].t : -Infinity, m.length ? m[m.length - 1].t : -Infinity)
  return { frames, ms: lastT - firstT }
}

/** Assemble a .colreplay manifest from what this client received for `room`. */
export function buildReplay(room: Room, viewerUid: string): ReplayManifest {
  const ser = (room as unknown as { serializer: object }).serializer
  const sframes = stateCaptures.get(ser) ?? []
  const mframes = msgCaptures.get(room) ?? []
  const all = [...sframes, ...mframes].sort((a, b) => a.seq - b.seq)
  const t0 = all.length ? all[0].t : 0
  const frames = all.map((f) =>
    f.kind === "message"
      ? { t: f.t - t0, kind: "message" as const, type: f.type, payload: f.payload }
      : { t: f.t - t0, kind: f.kind, offset: f.offset, b64: bytesToB64(f.bytes!) }
  )
  return {
    format: "colreplay-v0",
    schemaVersion: 0,
    // TODO: source these from a build-time constant once available; the viewer plays back in the
    // same build, so exact values aren't load-bearing for the PoC.
    game: { version: "6.10.1", commit: "deployed", serializerId: "schema" },
    room: "game",
    viewerUid,
    recordedAt: new Date().toISOString(),
    frames
  }
}

/** Build the replay and trigger a browser download. */
export function downloadReplay(room: Room, viewerUid: string) {
  const manifest = buildReplay(room, viewerUid)
  const blob = new Blob([JSON.stringify(manifest)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `replay-${manifest.recordedAt.replace(/[:.]/g, "-")}.colreplay.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
