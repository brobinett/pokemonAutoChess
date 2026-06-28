import { pack, unpack } from "@colyseus/msgpackr"
import type { ReplayFrame, ReplayManifest } from "./replay-room"

// Shared `.colreplay` format module (browser side) — the in-client twin of the offline
// replay/replay-format.mjs in the superproject. It reads BOTH formats:
//   v0  base64-in-JSON envelope (what the recorder writes today; FORMAT.md § v0)
//   v1  binary "CLRP" container  (FORMAT.md § v1 — denser, msgpack message payloads)
// and normalizes v1 to the same in-memory `ReplayFrame[]` the consumers already use, so a v1 file plays
// back through the exact same ReplayRoom / buildReplayIndex path. `encodeReplayV1` is the writer Step 4
// (the recorder's export) will call; for now the recorder still emits v0 and these readers dual-read.
//
// Byte layout (LE; "varint" = unsigned LEB128) — kept identical to replay-format.mjs:
//   magic "CLRP" | u8 containerVer=1 | u32 metaLen | metadata JSON | frames…
//   frame: u8 kind(0=hs,1=state,2=patch,3=msg) | varint tDelta
//     state-like: varint offset | varint len | len bytes
//     message:    u8 typeTag(0=num,1=str) | type | u8 enc(0=msgpack,1=bytes,2=none) | [varint len | bytes]

const MAGIC = [0x43, 0x4c, 0x52, 0x50] // "CLRP"
const CONTAINER_V1 = 1
const KIND = { handshake: 0, state: 1, patch: 2, message: 3 } as const
const KIND_NAME = ["handshake", "state", "patch", "message"] as const
const ENC_MSGPACK = 0
const ENC_BYTES = 1
const ENC_NONE = 2

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

// ── byte writer / reader ────────────────────────────────────────────────────────────────────────────
class ByteWriter {
  // ArrayBuffer-backed (not ArrayBufferLike) so `done()` returns a value that is a valid Blob/BufferSource
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(4096)
  private len = 0
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length
    while (cap < this.len + n) cap *= 2
    const nb = new Uint8Array(cap)
    nb.set(this.buf.subarray(0, this.len))
    this.buf = nb
  }
  u8(v: number) {
    this.ensure(1)
    this.buf[this.len++] = v & 0xff
  }
  u32(v: number) {
    this.ensure(4)
    v = v >>> 0
    this.buf[this.len++] = v & 0xff
    this.buf[this.len++] = (v >>> 8) & 0xff
    this.buf[this.len++] = (v >>> 16) & 0xff
    this.buf[this.len++] = (v >>> 24) & 0xff
  }
  varint(v: number) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`varint: expected a non-negative integer, got ${v}`)
    this.ensure(10)
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80
      v = Math.floor(v / 128)
    }
    this.buf[this.len++] = v
  }
  bytes(u8: Uint8Array) {
    this.ensure(u8.length)
    this.buf.set(u8, this.len)
    this.len += u8.length
  }
  done(): Uint8Array<ArrayBuffer> {
    return this.buf.subarray(0, this.len)
  }
}

class ByteReader {
  pos = 0
  constructor(private u8: Uint8Array) {}
  u8r(): number {
    return this.u8[this.pos++]
  }
  u32(): number {
    const b = this.u8
    const p = this.pos
    this.pos += 4
    return ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) >>> 0) + b[p + 3] * 0x1000000
  }
  varint(): number {
    let shift = 1
    let result = 0
    let b: number
    do {
      b = this.u8[this.pos++]
      result += (b & 0x7f) * shift
      shift *= 128
    } while (b & 0x80)
    return result
  }
  bytes(n: number): Uint8Array {
    const out = this.u8.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  get eof(): boolean {
    return this.pos >= this.u8.length
  }
  get length(): number {
    return this.u8.length
  }
}

const te = new TextEncoder()
const td = new TextDecoder()

// ── encode: a manifest (raw v0 or normalized) → v1 binary (used by the recorder's export, Step 4) ─────
export function encodeReplayV1(manifest: ReplayManifest): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter()
  w.bytes(encodeHeaderV1(manifest))
  let prevT = 0 // rebased manifests open at t=0, so the first frame's tDelta is 0
  for (const f of manifest.frames) prevT = writeFrame(w, f, prevT)
  return w.done()
}

/** The fixed file prefix: magic + version + length-prefixed metadata JSON. The OPFS worker writes this
 * ONCE at open, then appends frame records (encodeFrameV1). */
export function encodeHeaderV1(manifest: {
  game: ReplayManifest["game"]
  room: string
  viewerUid: string
  recordedAt: string
}): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter()
  for (const c of MAGIC) w.u8(c)
  w.u8(CONTAINER_V1)
  const meta = {
    format: "colreplay-v1",
    schemaVersion: CONTAINER_V1,
    game: manifest.game,
    room: manifest.room,
    viewerUid: manifest.viewerUid,
    recordedAt: manifest.recordedAt
  }
  const metaBytes = te.encode(JSON.stringify(meta))
  w.u32(metaBytes.length)
  w.bytes(metaBytes)
  return w.done()
}

/** The metadata object stored in the v1 header (what encodeHeaderV1 wrote). */
export interface ReplayHeaderMeta {
  format: string
  schemaVersion: number
  game: { version: string; commit: string; serializerId: string }
  room: string
  viewerUid: string
  recordedAt: string
}

/** Parse ONLY the v1 header (magic + version + length-prefixed metadata JSON) from the front of a
 * `.colreplay` file, decoding no frames — used to list stored recordings cheaply (read a small prefix,
 * show recordedAt / build / viewerUid without loading a multi-MB file). `bytes` may be a short prefix of
 * the file. Returns null if it isn't a CLRP v1 file or the header isn't fully present / is corrupt; callers
 * then fall back to the filename + mtime. */
export function readReplayHeader(bytes: Uint8Array): ReplayHeaderMeta | null {
  try {
    if (bytes.length < 9) return null
    for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return null
    const r = new ByteReader(bytes)
    for (let i = 0; i < MAGIC.length; i++) r.u8r() // magic
    if (r.u8r() !== CONTAINER_V1) return null // container version
    const metaLen = r.u32()
    // The header must fit inside the bytes we were handed (the list path reads a generous prefix).
    if (metaLen <= 0 || 9 + metaLen > bytes.length) return null
    return JSON.parse(td.decode(r.bytes(metaLen))) as ReplayHeaderMeta
  } catch {
    return null
  }
}

/** Encode ONE frame record for streaming append. `prevT` = the previous frame's t; pass null for the
 * first frame of a (re)opened file → tDelta 0 (a reconnect-after-reload segment continues from the file's
 * accumulated time, collapsing the disconnect gap — dead time anyway). Returns this frame's t. */
export function encodeFrameV1(frame: ReplayFrame, prevT: number | null): { bytes: Uint8Array<ArrayBuffer>; t: number } {
  const w = new ByteWriter()
  const t = writeFrame(w, frame, prevT == null ? (frame.t ?? 0) : prevT)
  return { bytes: w.done(), t }
}

// Shared per-frame writer — both encodeReplayV1 and the streaming encodeFrameV1 use it, so the one-shot
// and incremental paths are byte-identical by construction (proven in replay/verify-stream-encode.mjs).
function writeFrame(w: ByteWriter, f: ReplayFrame, prevT: number): number {
  if (!(f.kind in KIND)) throw new Error(`encodeReplayV1: unknown frame kind "${f.kind}"`)
  const kind = KIND[f.kind]
  w.u8(kind)
  const t = f.t ?? 0
  let dt = t - prevT
  let nextPrevT = t
  // The live recorder stamps t = Date.now() (non-monotonic). A backward clock step would make dt < 0;
  // don't throw (that aborts the worker's flush batch and loses those frames) — clamp the gap to 0 and pin
  // to prevT so the timeline can't go backward and the next delta is measured from the last good time.
  // Rebased one-shot manifests are monotonic, so this never fires there (byte output unchanged).
  if (dt < 0) {
    console.warn(`[colreplay] non-monotonic frame t (dt=${dt}); clamping to 0`)
    dt = 0
    nextPrevT = prevT
  }
  w.varint(dt)
  if (kind === KIND.message) {
    if (typeof f.type === "number") {
      w.u8(0)
      w.varint(f.type)
    } else {
      w.u8(1)
      const tb = te.encode(String(f.type))
      w.varint(tb.length)
      w.bytes(tb)
    }
    const p = messagePayload(f.payload)
    if (p === undefined) {
      w.u8(ENC_NONE)
    } else if (p instanceof Uint8Array) {
      w.u8(ENC_BYTES)
      w.varint(p.length)
      w.bytes(p)
    } else {
      w.u8(ENC_MSGPACK)
      const pb = pack(p)
      w.varint(pb.length)
      w.bytes(pb)
    }
  } else {
    w.varint(f.offset ?? 1)
    const b = f.bytes ?? (f.b64 ? b64ToBytes(f.b64) : new Uint8Array(0))
    w.varint(b.length)
    w.bytes(b)
  }
  return nextPrevT
}

function messagePayload(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && !(payload instanceof Uint8Array) && "__bytes__" in payload) {
    return b64ToBytes((payload as { __bytes__: string }).__bytes__)
  }
  return payload
}

// ── decode: v1 binary → normalized manifest (frames carry `bytes` / decoded `payload`) ────────────────
export function decodeReplayV1(bytes: Uint8Array): ReplayManifest {
  const r = new ByteReader(bytes)
  for (const c of MAGIC) {
    if (r.u8r() !== c) throw new Error("decodeReplayV1: bad magic (not a CLRP file)")
  }
  const ver = r.u8r()
  if (ver !== CONTAINER_V1) throw new Error(`decodeReplayV1: unsupported container version ${ver}`)
  const metaLen = r.u32()
  const meta = JSON.parse(td.decode(r.bytes(metaLen)))

  const frames: ReplayFrame[] = []
  let prevT = 0
  // Recover the valid PREFIX of a truncated/corrupt file (a recording cut off by a crash mid-write) rather
  // than throwing it all away: parse a frame into a local and only push it if it parsed fully (the cursor
  // stayed in bounds); on a short read or bad kind/payload, warn and stop with what was read so far.
  while (r.pos < r.length) {
    const frameStart = r.pos
    let frame: ReplayFrame
    let t: number
    try {
      const kind = r.u8r()
      t = prevT + r.varint()
      if (kind === KIND.message) {
        const typeTag = r.u8r()
        const type = typeTag === 0 ? r.varint() : td.decode(r.bytes(r.varint()))
        const enc = r.u8r()
        let payload: unknown
        if (enc === ENC_NONE) payload = undefined
        else if (enc === ENC_BYTES) payload = r.bytes(r.varint())
        else payload = unpack(r.bytes(r.varint()))
        frame = { t, kind: "message", type, payload }
      } else {
        const kindName = KIND_NAME[kind]
        if (kindName === undefined) throw new Error(`unknown frame kind byte ${kind}`)
        const offset = r.varint()
        const len = r.varint()
        frame = { t, kind: kindName, offset, bytes: r.bytes(len) }
      }
      if (r.pos > r.length) throw new Error("frame extends past end of file")
    } catch (e) {
      console.warn(`[colreplay] decode stopped at a truncated/corrupt frame @${frameStart} (recovered ${frames.length} frames): ${(e as Error).message}`)
      break
    }
    prevT = t
    frames.push(frame)
  }
  return { ...meta, frames }
}

// ── dual-read: sniff v1-binary vs v0-JSON, return a manifest the consumers (which dual-read frames) use ─
export function loadReplay(input: ArrayBuffer | Uint8Array | string): ReplayManifest {
  if (typeof input === "string") return JSON.parse(input) as ReplayManifest
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input)
  const isCLRP = u8.length >= 4 && u8[0] === MAGIC[0] && u8[1] === MAGIC[1] && u8[2] === MAGIC[2] && u8[3] === MAGIC[3]
  if (isCLRP) return decodeReplayV1(u8)
  return JSON.parse(td.decode(u8)) as ReplayManifest
}
