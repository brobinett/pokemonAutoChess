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
  private buf = new Uint8Array(4096)
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
  done(): Uint8Array {
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
}

const te = new TextEncoder()
const td = new TextDecoder()

// ── encode: a manifest (raw v0 or normalized) → v1 binary (used by the recorder's export, Step 4) ─────
export function encodeReplayV1(manifest: ReplayManifest): Uint8Array {
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

  let prevT = 0
  for (const f of manifest.frames) {
    const kind = KIND[f.kind]
    w.u8(kind)
    const t = f.t ?? 0
    const dt = t - prevT
    if (dt < 0) throw new Error(`encodeReplayV1: non-monotonic t (dt=${dt})`)
    w.varint(dt)
    prevT = t
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
  }
  return w.done()
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
  while (!r.eof) {
    const kind = r.u8r()
    const t = prevT + r.varint()
    prevT = t
    if (kind === KIND.message) {
      const typeTag = r.u8r()
      const type = typeTag === 0 ? r.varint() : td.decode(r.bytes(r.varint()))
      const enc = r.u8r()
      let payload: unknown
      if (enc === ENC_NONE) payload = undefined
      else if (enc === ENC_BYTES) payload = r.bytes(r.varint())
      else payload = unpack(r.bytes(r.varint()))
      frames.push({ t, kind: "message", type, payload })
    } else {
      const offset = r.varint()
      const len = r.varint()
      frames.push({ t, kind: KIND_NAME[kind], offset, bytes: r.bytes(len) })
    }
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
