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
  if (manifest.summary) w.bytes(encodeReplayTrailer(manifest.summary))
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
  game: { version: string; assetsVersion: string; serializerId: string }
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

// ── match-summary trailer (footer at EOF) ─────────────────────────────────────────────────────────────
// A compact per-recording summary — the POV player's final team + placement — appended AFTER the last frame
// so the /replay library can show it WITHOUT decoding the multi-MB body: it's a FOOTER (length + magic at
// the very end), so a small tail read locates it. Optional + back-compatible — a file written before this
// (or any non-CLRP file) simply has no footer and readReplayTrailer returns null.
//   layout:  [ summary JSON bytes ][ u32 summaryLen (LE) ][ TRAILER_MAGIC "CLTR" ]
const TRAILER_MAGIC = [0x43, 0x4c, 0x54, 0x52] // "CLTR"
const TRAILER_FOOTER_LEN = 4 + TRAILER_MAGIC.length // u32 summaryLen + magic

/** One deployed unit in the POV's final board, enough to render a portrait thumbnail + tooltip. */
export interface ReplaySummaryUnit {
  /** Pkm enum name, for the tooltip */
  name: string
  /** sprite index ("0025"), for the portrait */
  index: string
  shiny?: boolean
}

/** The POV player's end-of-game snapshot stored in the trailer. Fields are optional/extensible — the reader
 * tolerates a partial or future-extended summary. */
export interface ReplaySummary {
  /** final placement, 1 (winner) … 8 */
  rank?: number
  /** POV final board (deployed units), for portrait thumbnails */
  team?: ReplaySummaryUnit[]
  /** POV player display name */
  name?: string
}

/** Derive the POV's final placement for the trailer from the last state the recording captured.
 *
 * `player.rank` is the LIVE provisional standing (the server's `rankPlayers` re-ranks the living by life
 * then level after every combat round and it freezes at elimination — game-room.ts `rankPlayers`,
 * simulation.ts). It's authoritative once the POV was eliminated (`alive === false`). But a POV who LEAVES
 * while still alive surrenders, and the server assigns the surrender placement (life → -99, re-rank → last
 * among the living) only in `onLeave` — AFTER our socket closed, so that final patch never reaches the
 * recording. The captured `player.rank` is then whatever provisional value the POV last saw (round 1 with
 * everyone at 100 life it's often 1), which reads as a bogus "top 1".
 *
 * Mirror the server for a still-alive POV: they place at the count of players still alive — a sole survivor
 * (the winner, `alive` with everyone else eliminated) → 1; a round-1 leaver in a full lobby → 8. Both the
 * winner and the surrenderer fall out of the same rule, so no separate "did they win vs leave" signal is
 * needed (which matters because `gameFinished` is server-only, not synced into the recording).
 * @param povRank    the POV player's captured `rank` (0/undefined if never set)
 * @param povAlive   the POV player's captured `alive` flag
 * @param aliveCount number of players with `alive === true` in the captured state (includes the POV)
 */
export function deriveFinalRank(
  povRank: number | undefined,
  povAlive: boolean,
  aliveCount: number
): number | undefined {
  if (povAlive) return aliveCount > 0 ? aliveCount : povRank || undefined
  return povRank || undefined
}

/** Encode the trailer footer for `summary` (append it after the last frame at close). */
export function encodeReplayTrailer(summary: ReplaySummary): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter()
  const body = te.encode(JSON.stringify(summary))
  w.bytes(body)
  w.u32(body.length)
  for (const c of TRAILER_MAGIC) w.u8(c)
  return w.done()
}

/** Parse the trailer FOOTER at the end of `buf` — the whole file OR just a tail slice (the footer sits at
 * the very end either way). Returns the summary + the trailer's total byte length (so the decoder can bound
 * the frame region) or null when there's no valid footer (old/foreign file, or the tail slice is too short
 * to hold the whole trailer). */
function parseTrailerFooter(buf: Uint8Array): { summary: ReplaySummary; byteLength: number } | null {
  try {
    const L = buf.length
    if (L < TRAILER_FOOTER_LEN) return null
    for (let i = 0; i < TRAILER_MAGIC.length; i++) {
      if (buf[L - TRAILER_MAGIC.length + i] !== TRAILER_MAGIC[i]) return null
    }
    const lenPos = L - TRAILER_FOOTER_LEN
    const summaryLen = (buf[lenPos] | (buf[lenPos + 1] << 8) | (buf[lenPos + 2] << 16)) + buf[lenPos + 3] * 0x1000000
    const start = lenPos - summaryLen
    if (summaryLen <= 0 || start < 0) return null // trailer not fully inside `buf` (tail slice too short) / corrupt
    const summary = JSON.parse(td.decode(buf.subarray(start, lenPos))) as ReplaySummary
    // Require an object: JSON.parse also accepts primitives (`1234`, `true`, `null`), so a frame body that
    // coincidentally ends in `<json-primitive><u32 len>"CLTR"` would be mis-read as a trailer — truncating
    // real frame bytes on the resume path. A real summary is always an object.
    if (typeof summary !== "object" || summary === null) return null
    return { summary, byteLength: summaryLen + TRAILER_FOOTER_LEN }
  } catch {
    return null
  }
}

/** Read the match-summary trailer from a `.colreplay` file (or its tail slice); null when absent. */
export function readReplayTrailer(buf: Uint8Array): ReplaySummary | null {
  return parseTrailerFooter(buf)?.summary ?? null
}

/** Total byte length of the EOF match-summary trailer in `buf` (summary body + footer), or null when there
 *  is no valid trailer. Used on resume (opfs-replay-writer) to truncate a sealed file's trailer off before
 *  appending reconnect frames — otherwise they land past the trailer and the decoder mis-bounds the frame
 *  region. `buf` may be the whole file or a tail slice big enough to hold the trailer. */
export function trailerByteLength(buf: Uint8Array): number | null {
  return parseTrailerFooter(buf)?.byteLength ?? null
}

/** Ensure a v1 `.colreplay` buffer carries a match-summary footer: append one for `summary` when the buffer
 *  doesn't already end with a trailer, else return it UNCHANGED. Used by the after-game download, whose source
 *  is the still-open OPFS file — that file only gets its trailer written at close (lobby-return), so a download
 *  taken on the after-game screen would otherwise be trailer-less (no team/placement when re-opened, unlike the
 *  library's post-lobby copy). Appending in-memory to the downloaded bytes keeps the portable file self-contained
 *  without writing into the still-growing OPFS file. Never double-appends (a second footer would push the first
 *  into the frame region and corrupt the decode), and no-ops when there's no summary to add. */
export function ensureReplayTrailer(
  bytes: Uint8Array<ArrayBuffer>,
  summary: ReplaySummary | null | undefined
): Uint8Array<ArrayBuffer> {
  if (!summary || parseTrailerFooter(bytes)) return bytes
  const trailer = encodeReplayTrailer(summary)
  const out = new Uint8Array(bytes.length + trailer.length)
  out.set(bytes, 0)
  out.set(trailer, bytes.length)
  return out
}

/** A detected build-skew between a recording and the viewer's running build — `kind` selects the message
 * and carries the version/build strings to interpolate. Null (no skew) when the builds match or the
 * recorded build is unknown. The viewer maps this to a localized string via `t("replay.skew.<kind>", skew)`
 * (see replay.tsx); keeping detection here — pure, no i18n — leaves it usable from the worker + Node tests. */
export type ReplaySkew =
  | { kind: "version"; recorded: string; running: string }
  | { kind: "serializer"; recorded: string; running: string }
  | { kind: "build"; version: string; recorded: string; running: string }

/** Compare a recording's stamped build (`manifest.game`) against the build running the viewer, returning a
 * skew descriptor when they differ, or null when they match (or the recorded build is unknown).
 *
 * State decode is reflection-driven (the schema definition rides the handshake frame), so a balance patch —
 * same schema shape, different numbers — plays back correctly with no gating. The case this guards is a
 * STRUCTURAL schema change between record and playback: `serializer.patch` then throws per frame, and
 * `applyNext`/`buildReplayIndex` swallow those throws (skip-and-continue), so playback silently degrades to a
 * frozen / partial scene. The viewer shows this message as a non-blocking banner so the degradation is
 * explained rather than mysterious — we still attempt playback (a same-shape patch release usually works).
 *
 * Pure (no package.json import) so it stays usable from the worker bundle and Node harnesses; the caller
 * passes the running build (the client reads it from package.json, exactly as it's stamped at record time).
 *
 * Compares at the SEMVER level so the message is symmetric and friendly regardless of which recorder wrote
 * the file. The two recorders disagree on what `version` holds: the in-client recorder (recorder.ts) stamps
 * a clean semver ("6.10.1") plus a separate dated `assetsVersion`; the standalone extension
 * (replay-recorder/) stamps the dated `assetsVersion` string ("6.10.2.2026-06-23.0") INTO `version` with no
 * separate field. `semver()` takes the leading `major.minor.patch` from either, so both sides display the
 * same precision ("6.10.2" vs "6.10.1", not "6.10.2.2026-06-23.0" vs "6.10.1") and a same-patch capture from
 * either recorder is treated as the same version. The finer `assetsVersion` (build-date) check only fires
 * when BOTH sides carry a real `assetsVersion` — so a pre-`assetsVersion` capture (old in-client `commit`
 * field, or an extension capture with no separate field) doesn't false-alarm on the same patch; it just
 * can't distinguish builds within a patch, which is an under-warn, not a wrong-warn. */
export function detectBuildSkew(
  recorded:
    | { version?: string; assetsVersion?: string; serializerId?: string }
    | null
    | undefined,
  running: { version: string; assetsVersion: string; serializerId?: string }
): ReplaySkew | null {
  if (!recorded?.version) return null // unknown / foreign header — nothing to compare against
  const recV = semver(recorded.version)
  const runV = semver(running.version)
  if (recV !== runV) return { kind: "version", recorded: recV, running: runV }
  if (
    recorded.serializerId &&
    running.serializerId &&
    recorded.serializerId !== running.serializerId
  )
    return { kind: "serializer", recorded: recorded.serializerId, running: running.serializerId }
  if (
    recorded.assetsVersion &&
    running.assetsVersion &&
    recorded.assetsVersion !== running.assetsVersion
  )
    return { kind: "build", version: runV, recorded: recorded.assetsVersion, running: running.assetsVersion }
  return null
}

/** The leading `major.minor.patch` of a version/build string — "6.10.1" from "6.10.1", and "6.10.2" from a
 * dated `assetsVersion` like "6.10.2.2026-06-23.0". Returns the input unchanged when it isn't semver-shaped
 * (e.g. the extension's "live-unknown" fallback). */
function semver(v: string): string {
  return (typeof v === "string" && v.match(/^\d+\.\d+\.\d+/)?.[0]) || v
}

/** Encode ONE frame record for streaming append. `prevT` = the previous frame's t; pass null for the
 * first frame of a (re)opened file → tDelta 0 (a reconnect-after-reload segment continues from the file's
 * accumulated time, collapsing the disconnect gap — dead time anyway). Returns this frame's t. */
export function encodeFrameV1(frame: ReplayFrame, prevT: number | null): { bytes: Uint8Array<ArrayBuffer>; t: number } {
  const w = new ByteWriter()
  const t = writeFrame(w, frame, prevT == null ? (frame.t ?? 0) : prevT)
  return { bytes: w.done(), t }
}

// Shared per-frame writer — both encodeReplayV1 and the streaming encodeFrameV1 use it. The one-shot and
// incremental paths are byte-identical for a REBASED manifest (frames[0].t === 0); on Date.now-stamped
// frames they differ in the first frame's tDelta alone (one-shot opens prevT=0 → absolute varint, the
// streaming writer opens prevT=null → 0). Moot in production: the streaming encodeFrameV1 is the sole app
// writer (encodeReplayV1 has no caller in app/), so the two never encode the same frames. Parity on rebased
// input is checked in replay/verify-stream-encode.mjs.
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
    // A state frame always carries bytes (or v0 b64) in practice; the empty fallback is a defensive
    // no-throw. (The .mjs twin's stateFrameBytes throws here instead — a benign divergence on an
    // unreachable input, gone once v0 is stripped for the PR.)
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

  // A match-summary trailer (footer at EOF) is not a frame — bound the frame loop to exclude it so its bytes
  // aren't mis-parsed as a frame. Absent (old/foreign file) → framesEnd is the file end.
  const trailer = parseTrailerFooter(bytes)
  const framesEnd = trailer ? bytes.length - trailer.byteLength : bytes.length

  const frames: ReplayFrame[] = []
  let prevT = 0
  // Recover the valid PREFIX of a truncated/corrupt file (a recording cut off by a crash mid-write) rather
  // than throwing it all away: parse a frame into a local and only push it if it parsed fully (the cursor
  // stayed in bounds); on a short read or bad kind/payload, warn and stop with what was read so far.
  while (r.pos < framesEnd) {
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
  return { ...meta, frames, summary: trailer?.summary }
}

// ── dual-read: sniff v1-binary vs v0-JSON, return a manifest the consumers (which dual-read frames) use ─
// v0 contract (intentionally divergent from the replay/replay-format.mjs twin, which EAGER-normalizes via
// normalizeV0): here the v0 branch returns the raw JSON.parse unchanged — frames keep their `b64`/`{__bytes__}`
// — because every TS consumer dual-reads (`f.bytes ?? b64ToBytes(f.b64)` in writeFrame; messagePayload for
// payloads). The .mjs twin's consumer (reconstruct.mjs) reads bare `f.bytes`, so it normalizes up front. Each
// side matches its own consumer; the v1 binary layout stays lockstep. The divergence disappears when v0 is
// stripped for the upstream PR (v0 is our dev-only base64-in-JSON fixtures; upstream never had it).
export function loadReplay(input: ArrayBuffer | Uint8Array | string): ReplayManifest {
  if (typeof input === "string") return JSON.parse(input) as ReplayManifest
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input)
  const isCLRP = u8.length >= 4 && u8[0] === MAGIC[0] && u8[1] === MAGIC[1] && u8[2] === MAGIC[2] && u8[3] === MAGIC[3]
  if (isCLRP) return decodeReplayV1(u8)
  return JSON.parse(td.decode(u8)) as ReplayManifest
}
