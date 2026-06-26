import { SchemaSerializer } from "@colyseus/sdk"
import type { Iterator } from "@colyseus/schema"
import type GameState from "../../../rooms/states/game-state"
import { getPokemonData } from "../../../models/precomputed/precomputed-pokemon-data"
import { BattleResult, GamePhaseState, PokemonActionState } from "../../../types/enum/Game"
import { ItemRecipe } from "../../../types/enum/Item"
import { Pkm } from "../../../types/enum/Pokemon"
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
  | "remove" // cleared a shop slot via "e" (REMOVE_FROM_SHOP) — distinct from a buy
  | "sell"
  | "evolve"
  | "hatch" // an egg hatched into a pokemon
  | "egg" // Baby synergy laid an egg
  | "fish" // Water synergy fished a pokemon onto the bench
  | "gained" // a unit appeared on the bench from some other effect (wanderer catch, reward…)
  | "round" // a fight resolved → win / loss / draw vs the opponent (player.history)
  | "item" // an item entered player.items (pve reward, town, synergy grant, ability, dig…)
  | "craft" // two components combined into a completed item (player.items, via ItemRecipe)
  | "level"
  | "pick"

// Is `evolved` a (possibly divergent) evolution of `base`? Used to confirm a board churn is really an
// evolution — and to label it — rather than a coincidental same-frame remove+add.
function evolvesTo(base: string, evolved: string): boolean {
  const d = getPokemonData(base as Pkm)
  return d?.evolution === evolved || (d?.evolutions?.includes(evolved as Pkm) ?? false)
}

// Round outcome label. `name` is the opponent: a PvE round stores an i18n key like "pkm.MAGIKARP"
// (prettify the species), a PvP round stores the player's display name (use as-is — prettifying would
// mangle mixed-case names).
function roundLabel(result: string, name: string): string {
  const opp = name?.startsWith("pkm.") ? prettyName(name.slice(4)) : name || "opponent"
  if (result === BattleResult.WIN) return `Beat ${opp}`
  if (result === BattleResult.DEFEAT) return `Lost to ${opp}`
  return `Draw vs ${opp}`
}
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
  // Combat-event unit names resolved by tile, keyed by the message frame's index in manifest.frames.
  // The ABILITY / POKEMON_DAMAGE / POKEMON_HEAL payloads identify units by (simulationId, x, y), not
  // by id, so we look the tile up against the simulation positions decoded as of that frame.
  combatUnits: Record<number, { caster?: string; target?: string }>
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

// How many shop slots must be replaced with new (non-empty) values to read as a reroll. A single buy
// empties exactly one slot (→ DEFAULT) and replaces none, so 3+ refreshed slots is unambiguously a roll.
const REROLL_MIN_REFRESHED_SLOTS = 3

// The unit occupying a tile in a simulation, as of the currently-decoded state. Combat messages key
// units by (simulationId, x, y), so this is how we name a damage target or an ability's caster/target.
function unitAt(
  state: GameState,
  simId: string | undefined,
  x: number | undefined,
  y: number | undefined
): string | undefined {
  if (!simId || x == null || y == null) return undefined
  const sim = state.simulations?.get(simId)
  if (!sim) return undefined
  let name: string | undefined
  const scan = (team: { forEach?: (cb: (e: { positionX?: number; positionY?: number; name?: string }) => void) => void } | undefined) =>
    team?.forEach?.((e) => {
      if (e?.positionX === x && e?.positionY === y) name = e.name
    })
  scan((sim as { blueTeam?: unknown }).blueTeam as never)
  scan((sim as { redTeam?: unknown }).redTeam as never)
  return name
}

export function buildReplayIndex(frames: ReplayFrame[], viewerUid?: string): ReplayIndex {
  const ser = new SchemaSerializer<GameState>()
  let hasState = false
  let gameStartMs: number | null = null
  let durationMs = 0

  const segments: ReplaySegment[] = []
  const events: ReplayEvent[] = [] // eliminations only (scrubber markers + log)
  const actions: ReplayEvent[] = [] // POV reroll/buy/sell/level/pick (log only)
  const combatUnits: Record<number, { caster?: string; target?: string }> = {}

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
  let povHistoryLen: number | undefined // length of player.history (each new entry = a round result)
  let povItems: string[] | undefined // player.items (bench items; multiset — duplicates matter)

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    durationMs = Math.max(durationMs, f.t)

    if (f.kind === "message") {
      if (f.type === "LOADING_COMPLETE" && gameStartMs === null) gameStartMs = f.t
      // Resolve combat-event units by tile against the state decoded so far (ABILITY caster + target;
      // damage/heal target — their SOURCE comes from the message's own species `index`).
      if (hasState && (f.type === "ABILITY" || f.type === "POKEMON_DAMAGE" || f.type === "POKEMON_HEAL")) {
        const state = ser.getState()
        const pl = f.payload as {
          id?: string; positionX?: number; positionY?: number; targetX?: number; targetY?: number; x?: number; y?: number
        }
        if (f.type === "ABILITY") {
          const caster = unitAt(state, pl?.id, pl?.positionX, pl?.positionY)
          const target = unitAt(state, pl?.id, pl?.targetX, pl?.targetY)
          if (caster || target) combatUnits[i] = { caster, target }
        } else {
          const target = unitAt(state, pl?.id, pl?.x, pl?.y)
          if (target) combatUnits[i] = { target }
        }
      }
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
      const items = pov.items ? Array.from(pov.items as ArrayLike<string>) : []
      const historyLen = pov.history?.length ?? 0

      if (povBoard && povShop) {
        const dMoney = typeof money === "number" && typeof povMoney === "number" ? money - povMoney : 0
        const added = [...board].filter(([id]) => !povBoard!.has(id))
        const removed = [...povBoard].filter(([id]) => !board.has(id))
        const choiceResolved = !!povChoices && [...povChoices].some((id) => !choices.has(id))
        // Board changed this frame? A buy always does `player.board.set` (the bought unit lands on the
        // bench); nothing else here that empties a shop slot touches the board.
        const boardChanged = added.length > 0 || removed.length > 0 || board.size !== povBoard.size
        // Slots cleared to Pkm.DEFAULT this frame. Two actions do this and ONLY these two:
        //   • OnShopCommand (buy): deducts gold (0 in FREE_MARKET) AND board.set → board changes.
        //   • OnRemoveFromShopCommand ("e"): clears the slot + locks the shop, never touches the board.
        // So board-changed is the mode-independent discriminator (gold would misread a 0-cost buy).
        const emptied: string[] = []
        for (let s = 0; s < povShop.length && s < shop.length; s++) {
          if (povShop[s] !== Pkm.DEFAULT && shop[s] === Pkm.DEFAULT) emptied.push(povShop[s])
        }
        // A reroll replaces slots with new non-empty values (buy/remove replace none → 0 refreshed);
        // gating on !boardChanged keeps a board-touching action (e.g. an Unown buy that resets the
        // whole shop) from reading as a roll.
        const refreshed = shop.filter((s, k) => s !== povShop![k] && s !== Pkm.DEFAULT).length

        // Evolution: a board churn where an added unit is the evolution of a removed one. Detected
        // independently of the shop branch below — a 3-combine on BUY emits both a buy and an evolve.
        // The evolution handlers delete the consumed copies and set one new evolved entity (count =
        // 3-combine, plus item/hatch/money/placement/stack/state single-step evolves), so the diff is
        // base(s) removed + evolved added. Verifying the relationship (vs labelling any remove+add an
        // evolve) rejects a coincidental same-frame sell+buy.
        if (added.length && removed.length) {
          if (removed.some(([, n]) => n === Pkm.EGG)) {
            // an egg was consumed and a pokemon appeared → it hatched
            actions.push({ t: f.t, type: "hatch", label: `Egg → ${prettyName(added[0][1])}` })
          } else {
            let pair: [string, string] | undefined
            for (const [, ev] of added) {
              const base = removed.find(([, b]) => evolvesTo(b, ev))?.[1]
              if (base) {
                pair = [base, ev]
                break
              }
            }
            // Fallback for divergent / runtime-computed evolutions the static table doesn't map: 2+ copies
            // of the SAME species consumed for one new unit is unambiguously a combine (a multi-sell has no
            // added unit, so this can't be one).
            if (!pair && added.length === 1) {
              const counts = new Map<string, number>()
              for (const [, b] of removed) counts.set(b, (counts.get(b) ?? 0) + 1)
              const combinedBase = [...counts].find(([, n]) => n >= 2)?.[0]
              if (combinedBase) pair = [combinedBase, added[0][1]]
            }
            if (pair) actions.push({ t: f.t, type: "evolve", label: `${prettyName(pair[0])} → ${prettyName(pair[1])}` })
          }
        }

        // Priority so one underlying SHOP action emits one event.
        if (emptied.length) {
          const kind = boardChanged ? "buy" : "remove"
          emptied.forEach((name) =>
            actions.push({ t: f.t, type: kind, label: `${prettyName(name)}${kind === "buy" && emptied.length === 1 && dMoney < 0 ? ` (${dMoney})` : ""}` })
          )
        } else if (choiceResolved && added.length) {
          actions.push({ t: f.t, type: "pick", label: `Picked ${prettyName(added[0][1])}` })
        } else if (removed.length && !added.length && removed.length <= 3 && pov.alive !== false) {
          // Sell — structural (a board unit leaves with no add and no shop-slot buy), so it's
          // mode-independent (catches FREE_MARKET 0-gold sells). Eliminations don't clear the board
          // (units are released to the pool but kept), so this can't fire on cleanup; the ≤3 cap and
          // alive guard are belt-and-suspenders. Gold shown only when it changed.
          actions.push({ t: f.t, type: "sell", label: `${prettyName(removed[0][1])}${dMoney > 0 ? ` (+${dMoney})` : ""}` })
        } else if (!boardChanged && refreshed >= REROLL_MIN_REFRESHED_SLOTS) {
          actions.push({ t: f.t, type: "reroll", label: dMoney < 0 ? `${dMoney} gold` : "free roll" })
        } else if (added.length && !removed.length) {
          // A unit appeared on the bench with no buy/pick/evolution behind it: Baby synergy egg, Water
          // synergy fish (spawnOnBench sets action=FISH), or some other free gain (wanderer catch, reward).
          for (const [id, name] of added) {
            if (name === Pkm.EGG) {
              actions.push({ t: f.t, type: "egg", label: "Egg laid" })
            } else if (pov.board.get(id)?.action === PokemonActionState.FISH) {
              actions.push({ t: f.t, type: "fish", label: `Fished ${prettyName(name)}` })
            } else {
              actions.push({ t: f.t, type: "gained", label: `Gained ${prettyName(name)}` })
            }
          }
        }
        if (typeof level === "number" && typeof povLevel === "number" && level > povLevel) {
          actions.push({ t: f.t, type: "level", label: `→ ${level}` })
        }
      }

      // Round results — each new player.history entry is a resolved fight (win/loss/draw vs opponent).
      if (povHistoryLen !== undefined && pov.history && historyLen > povHistoryLen) {
        for (let h = povHistoryLen; h < historyLen; h++) {
          const hi = pov.history.at(h)
          if (hi) actions.push({ t: f.t, type: "round", label: roundLabel(hi.result, hi.name) })
        }
      }

      // Item changes (player.items multiset diff): a craft (2 components → 1 result via ItemRecipe), else
      // an item gained. Sources of "gained" are many (pve/town rewards, synergy grants, abilities, dig,
      // harvest…); the diff catches them all. (Removals — equip onto a unit / unequip return — are not
      // yet split out; that needs per-unit pokemon.items tracking — a follow-up.)
      if (povItems !== undefined) {
        const count = (arr: string[]) => {
          const m = new Map<string, number>()
          for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1)
          return m
        }
        const prevC = count(povItems)
        const curC = count(items)
        const added: string[] = []
        const removed: string[] = []
        curC.forEach((n, k) => { for (let j = 0; j < n - (prevC.get(k) ?? 0); j++) added.push(k) })
        prevC.forEach((n, k) => { for (let j = 0; j < n - (curC.get(k) ?? 0); j++) removed.push(k) })
        // crafts first, consuming their components+result from the pools so they aren't double-counted
        for (let a = added.length - 1; a >= 0; a--) {
          const recipe = ItemRecipe[added[a] as keyof typeof ItemRecipe]
          if (recipe && recipe.length === 2) {
            const pool = [...removed]
            const i0 = pool.indexOf(recipe[0])
            if (i0 >= 0) pool.splice(i0, 1)
            const i1 = i0 >= 0 ? pool.indexOf(recipe[1]) : -1
            if (i0 >= 0 && i1 >= 0) {
              actions.push({ t: f.t, type: "craft", label: `${prettyName(recipe[0])} + ${prettyName(recipe[1])} → ${prettyName(added[a])}` })
              removed.splice(removed.indexOf(recipe[0]), 1)
              removed.splice(removed.indexOf(recipe[1]), 1)
              added.splice(a, 1)
            }
          }
        }
        for (const x of added) actions.push({ t: f.t, type: "item", label: `Got ${prettyName(x)}` })
      }

      povMoney = money
      povLevel = level
      povShop = shop
      povBoard = board
      povChoices = choices
      povHistoryLen = historyLen
      povItems = items
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
    actions: actions.sort((a, b) => a.t - b.t),
    combatUnits
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
