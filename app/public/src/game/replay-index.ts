import { SchemaSerializer } from "@colyseus/sdk"
import type { Iterator } from "@colyseus/schema"
import type GameState from "../../../rooms/states/game-state"
import { GamePhaseState } from "../../../types/enum/Game"
import type { ReplayFrame } from "./replay-room"

// A compact index of where the interesting moments are in a recording: every phase-within-stage
// boundary (PICK/FIGHT/TOWN) and significant events (eliminations). It powers the viewer's
// skip/seek-by-phase-&-stage controls and the timeline markers on the scrubber — seeking already
// targets an absolute ms (ReplayRoom reboot), so the controls only need the target times.
//
// It is DERIVED, not stored: we decode the recorded transcript once with a throwaway
// SchemaSerializer (the same decode path ReplayRoom plays back through) and watch state.phase /
// state.stageLevel / player.life change between frames. So the .colreplay stays a pure raw
// transcript (FORMAT.md) and the index is robust across patches (only transition timestamps, no
// balance numbers). Computed once per loaded manifest (replay.tsx), not per seek.
//
// The offline reference + CLI is replay/build-index.mjs in the superproject (verified there against
// real recordings); this is the in-browser port.

export const REPLAY_INDEX_SCHEMA_VERSION = 2

const PHASE_LABEL: Record<number, string> = {
  [GamePhaseState.PICK]: "PICK",
  [GamePhaseState.FIGHT]: "FIGHT",
  [GamePhaseState.TOWN]: "TOWN"
}

export interface ReplaySegment {
  t: number // absolute ms (frame t)
  stage: number
  phase: number // GamePhaseState
  phaseLabel: string
}
export interface ReplayStageMark {
  stage: number
  t: number // absolute ms the stage first appears
}
// "elimination" comes from any player's life crossing 0; the rest are POV-player actions derived by
// diffing the recording player's own synced state (money / shop / board / level / proposition choices)
// — they're recoverable only for the POV because opponents' shops/gold aren't synced to this client.
export type ReplayEventType =
  | "elimination"
  | "reroll"
  | "buy"
  | "sell"
  | "level"
  | "pick"
export interface ReplayEvent {
  t: number // absolute ms
  type: ReplayEventType
  label: string
  uid?: string
}
export interface ReplayIndex {
  schemaVersion: number
  gameStartMs: number // first LOADING_COMPLETE — the controls' 0:00 re-base origin
  durationMs: number
  segments: ReplaySegment[] // phase-within-stage boundaries, anchored at/after gameStartMs
  stages: ReplayStageMark[] // first t per distinct stage
  events: ReplayEvent[] // eliminations, sorted by t — these drive the scrubber's event markers
  // POV-player actions (reroll/buy/sell/level/proposition pick), sorted by t. Kept separate from
  // `events` so they feed the event log WITHOUT flooding the scrubber with a marker per reroll/buy.
  actions: ReplayEvent[]
}

// PAC enum values are SCREAMING_SNAKE (Pkm.SWINUB = "SWINUB", Ability.ICE_SPINNER); render them as
// "Swinub" / "Ice Spinner". Derived from the value, so it survives a submodule bump (no i18n dep).
export function prettyName(v: string | undefined | null): string {
  if (!v) return ""
  return v
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

// A player is eliminated the frame their life first crosses from positive to <= 0. Pure so the
// crossing logic can be unit-tested (recordings rarely reach a death in the captured stages).
export function isElimination(prevLife: number | undefined, life: number): boolean {
  return typeof prevLife === "number" && prevLife > 0 && life <= 0
}

// How many shop slots must differ between frames to read as a reroll (a refresh replaces the whole
// shop; a single buy empties one slot). 3+ changed slots is unambiguously a refresh, not a buy.
const REROLL_MIN_CHANGED_SLOTS = 3

export function buildReplayIndex(frames: ReplayFrame[], viewerUid?: string): ReplayIndex {
  const ser = new SchemaSerializer<GameState>()
  let hasState = false
  let gameStartMs: number | null = null
  let durationMs = 0

  const segments: ReplaySegment[] = []
  const events: ReplayEvent[] = [] // eliminations only (scrubber markers + log)
  const actions: ReplayEvent[] = [] // POV reroll/buy/sell/level/pick (log only)

  let prevPhase: number | undefined
  let prevStage: number | undefined
  const lifePrev = new Map<string, number>()
  const eliminated = new Set<string>()

  // POV-player snapshots for the action derivation (money/level/shop/board/proposition-choices).
  let povMoney: number | undefined
  let povLevel: number | undefined
  let povShop: string[] | undefined
  let povBoard: Map<string, string> | undefined // unit id → name
  let povChoices: Set<string> | undefined // choice ids currently offered

  for (const f of frames) {
    durationMs = Math.max(durationMs, f.t)

    if (f.kind === "message") {
      if (f.type === "LOADING_COMPLETE" && gameStartMs === null) gameStartMs = f.t
      continue
    }

    try {
      const bytes = b64ToBytes(f.b64!)
      const it: Iterator = { offset: f.offset ?? 1 }
      if (f.kind === "handshake") ser.handshake(bytes, it)
      else if (f.kind === "state") {
        ser.setState(bytes, it)
        hasState = true
      } else ser.patch(bytes, it)
    } catch {
      continue // a bad frame shouldn't sink the index; ReplayRoom drives the actual playback
    }
    if (!hasState) continue

    const state = ser.getState()
    const ph = state.phase
    const st = state.stageLevel
    if (typeof ph === "number" && typeof st === "number" && (ph !== prevPhase || st !== prevStage)) {
      segments.push({ t: f.t, stage: st, phase: ph, phaseLabel: PHASE_LABEL[ph] ?? String(ph) })
      prevPhase = ph
      prevStage = st
    }

    state.players?.forEach((p, uid) => {
      const life = p.life
      if (typeof life !== "number") return
      if (isElimination(lifePrev.get(uid), life) && !eliminated.has(uid)) {
        eliminated.add(uid)
        events.push({ t: f.t, type: "elimination", uid, label: `${p.name} eliminated` })
      }
      lifePrev.set(uid, life)
    })

    // POV-player actions, derived by diffing the recording player's own state frame-to-frame.
    const pov = viewerUid ? state.players?.get(viewerUid) : undefined
    if (pov) {
      const money = pov.money
      const level = pov.experienceManager?.level
      const shop = pov.shop ? Array.from(pov.shop as ArrayLike<string>) : []
      const board = new Map<string, string>()
      pov.board?.forEach((u, id) => board.set(id, u.name))
      const choices = new Set<string>()
      pov.choices?.forEach((c) => choices.add(c.id))

      if (povBoard && povShop) {
        const dMoney = typeof money === "number" && typeof povMoney === "number" ? money - povMoney : 0
        const added = [...board].filter(([id]) => !povBoard!.has(id))
        const removed = [...povBoard].filter(([id]) => !board.has(id))
        const choiceResolved = !!povChoices && [...povChoices].some((id) => !choices.has(id))
        const changedSlots = shop.filter((s, i) => s !== povShop![i]).length +
          Math.abs(shop.length - povShop.length)
        // a bought unit leaves the shop: its name was offered last frame and is gone now
        const boughtName = added.find(([, name]) => povShop!.includes(name) && !shop.includes(name))?.[1]

        // Priority order so one underlying action emits one event.
        if (choiceResolved && added.length) {
          actions.push({ t: f.t, type: "pick", label: `Picked ${prettyName(added[0][1])}` })
        } else if (boughtName) {
          actions.push({ t: f.t, type: "buy", label: `${prettyName(boughtName)}${dMoney < 0 ? ` (${dMoney})` : ""}` })
        } else if (removed.length && !added.length && dMoney > 0) {
          actions.push({ t: f.t, type: "sell", label: `${prettyName(removed[0][1])} (+${dMoney})` })
        } else if (changedSlots >= REROLL_MIN_CHANGED_SLOTS) {
          actions.push({ t: f.t, type: "reroll", label: dMoney < 0 ? `${dMoney} gold` : "free roll" })
        }
        if (typeof level === "number" && typeof povLevel === "number" && level > povLevel) {
          actions.push({ t: f.t, type: "level", label: `→ ${level}` })
        }
      }
      povMoney = money
      povLevel = level
      povShop = shop
      povBoard = board
      povChoices = choices
    }
  }

  // The opening frames arrive during the loading screen, so the transcript starts on a phantom
  // TOWN/stage-0 segment well before the carousel renders. Collapse everything before game start into
  // one carousel segment anchored at gameStartMs, so "seek to start" lands on the carousel (where the
  // renderer reveals) not the black loading screen. Mirrors ReplayRoom.gameStartMs so the controls'
  // re-based scrubber and these markers share an origin.
  const origin = gameStartMs ?? segments[0]?.t ?? 0
  const opener = segments.filter((s) => s.t <= origin).at(-1)
  const indexedSegments: ReplaySegment[] = [
    ...(opener ? [{ ...opener, t: origin }] : []),
    ...segments.filter((s) => s.t > origin)
  ]

  const stages: ReplayStageMark[] = []
  const seen = new Set<number>()
  for (const s of indexedSegments) {
    if (!seen.has(s.stage)) {
      seen.add(s.stage)
      stages.push({ stage: s.stage, t: s.t })
    }
  }

  return {
    schemaVersion: REPLAY_INDEX_SCHEMA_VERSION,
    gameStartMs: origin,
    durationMs,
    segments: indexedSegments,
    stages,
    events: events.sort((a, b) => a.t - b.t),
    actions: actions.sort((a, b) => a.t - b.t)
  }
}

// --- navigation helpers (pure; used by ReplayControls) ----------------------------------------
// EPS is a grace window around a boundary so "prev" near a boundary goes to the PREVIOUS one (iPod
// behaviour) while "prev" well into a segment restarts the current one, and "next" never re-selects
// the segment you're essentially already on.
const EPS = 500

const marks = (index: ReplayIndex, kind: "segments" | "stages"): number[] =>
  (kind === "segments" ? index.segments : index.stages).map((m) => m.t)

/** First boundary strictly after the current time (+grace), or null if already at/after the last. */
function nextMark(ts: number[], currentMs: number): number | null {
  return ts.find((t) => t > currentMs + EPS) ?? null
}
/** Last boundary strictly before the current time (−grace), or null if already at/before the first. */
function prevMark(ts: number[], currentMs: number): number | null {
  return [...ts].reverse().find((t) => t < currentMs - EPS) ?? null
}

export const nextPhase = (i: ReplayIndex, ms: number) => nextMark(marks(i, "segments"), ms)
export const prevPhase = (i: ReplayIndex, ms: number) => prevMark(marks(i, "segments"), ms)
export const nextStage = (i: ReplayIndex, ms: number) => nextMark(marks(i, "stages"), ms)
export const prevStage = (i: ReplayIndex, ms: number) => prevMark(marks(i, "stages"), ms)

/** The segment live at a given time (for labelling "you are here"). */
export function segmentAt(index: ReplayIndex, ms: number): ReplaySegment | null {
  let cur: ReplaySegment | null = null
  for (const s of index.segments) {
    if (s.t <= ms + EPS) cur = s
    else break
  }
  return cur ?? index.segments[0] ?? null
}
