import { SchemaSerializer } from "@colyseus/sdk"
import type { Iterator } from "@colyseus/schema"
import type GameState from "../../../rooms/states/game-state"
import { getPokemonData } from "../../../models/precomputed/precomputed-pokemon-data"
import { SynergyTriggers } from "../../../config/game/synergies"
import { BattleResult, GamePhaseState, PokemonActionState } from "../../../types/enum/Game"
import { ItemRecipe } from "../../../types/enum/Item"
import { Pkm } from "../../../types/enum/Pokemon"
import type { Synergy } from "../../../types/enum/Synergy"
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
  | "berry" // Grass: a berry tree ripened (reached stage 3) — harvest itself surfaces as an item gain
  | "flower" // Flora: a flower in a pot evolved (mulch-fed)
  | "wanderer" // a catchable wandering pokemon appeared (catching it = a "gained")
  | "gained" // a unit appeared on the bench from some other effect (wanderer catch, reward…)
  | "round" // a fight resolved → win / loss / draw vs the opponent (player.history)
  | "synergy" // a synergy tier activated/upgraded — player.synergies crossed a SynergyTriggers threshold
  | "town" // a town encounter NPC appeared (state.townEncounter — shared, game-level)
  | "item" // an item entered player.items with no unit losing it (pve reward, town, synergy, dig…)
  | "craft" // components combined into a completed item (player.items bench-combine OR onto a unit)
  | "equip" // an item left player.items and landed on a board unit
  | "unequip" // an item returned from a board unit to player.items (benching removable items)
  | "move" // a board unit's (x,y) changed (deploy / bench / rearrange) — own "positioning" chip
  | "level"
  | "pick"

// Duplicate-aware diff of two string multisets (item/component lists): what was added / removed going
// prev→cur. Used for the player.items diff and the per-unit pokemon.items diff (duplicates matter — a
// player can hold two of the same component).
function multisetDiff(prev: string[], cur: string[]): { added: string[]; removed: string[] } {
  const count = (arr: string[]) => {
    const m = new Map<string, number>()
    for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1)
    return m
  }
  const a = count(prev)
  const b = count(cur)
  const added: string[] = []
  const removed: string[] = []
  b.forEach((n, k) => { for (let j = 0; j < n - (a.get(k) ?? 0); j++) added.push(k) })
  a.forEach((n, k) => { for (let j = 0; j < n - (b.get(k) ?? 0); j++) removed.push(k) })
  return { added, removed }
}

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
  let prevTownEncounter: string | null | undefined // state.townEncounter (shared town NPC)
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
  let povUnitItems: Map<string, string[]> | undefined // unit id → its pokemon.items (for equip/unequip)
  let povUnitPos: Map<string, { x: number; y: number }> | undefined // unit id → (positionX, positionY)
  let povSynSteps: Map<string, number> | undefined // synergy → active tier step (#thresholds met)
  let povBerryStages: number[] | undefined // player.berryTreesStages (Grass: 1→3 ripen cycle)
  let povFlowers: string[] | undefined // player.flowerPots[i].name (Flora: evolves in place)
  let povWandererIds: Set<string> | undefined // player.wanderers keys (uuid per appearance)

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

    // Town encounter — a shared, game-level NPC (state.townEncounter), not POV-specific. Its rewards
    // land in player state separately (items / money / etc.), captured by those diffs.
    const te = (state as { townEncounter?: string | null }).townEncounter ?? null
    if (prevTownEncounter !== undefined && te && te !== prevTownEncounter) {
      actions.push({ t: f.t, type: "town", label: `Town: ${prettyName(te)}` })
    }
    prevTownEncounter = te

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
      // Per-unit item sets (pokemon.items is a SetSchema) + positions, captured this frame for the
      // equip/unequip and positioning diffs below.
      const unitItems = new Map<string, string[]>()
      const unitPos = new Map<string, { x: number; y: number }>()
      pov.board?.forEach((u, id) => {
        board.set(id, u.name)
        unitItems.set(id, u.items ? [...(u.items as Iterable<string>)] : [])
        unitPos.set(id, { x: u.positionX ?? 0, y: u.positionY ?? 0 })
      })
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

      // Item events — classify the player.items diff against this frame's per-unit pokemon.items
      // movements, so a removal/addition is correctly read as an equip / unequip / on-unit craft / sell
      // return rather than a bare "gained". Item flow between the player inventory and units:
      //   • equip          (OnDragDropItemCommand): player.items loses X, the dropped unit gains X.
      //   • on-unit craft  (OnDragDropItemCommand): a basic component C is dropped onto a unit already
      //                     holding a component D → the unit's items go D→R (ItemRecipe[R]={C,D}) while
      //                     player.items loses C. Distinct from the bench craft (player.items: 2→1).
      //   • bench craft    (OnDragDropItemCommand): two components in player.items combine into a result.
      //   • bench unequip  (onPokemonChangePosition, newY===0): RemovableItems on the unit return to
      //                     player.items; the unit stays on the board (positionY→0). Detected
      //                     structurally (unit loses X + player gains X, unit still present) — no need to
      //                     hardcode the RemovableItems list, so it stays mode-independent (SLAMINGO too).
      //   • sell return    (OnSellPokemonCommand): the unit is deleted and ALL its items return to
      //                     player.items. These are NOT new gains — the sell event already fired, so we
      //                     suppress them (don't emit "Got X").
      //   • gained         (everything else): a player.items addition with no unit losing it and no
      //                     craft behind it — pve/town rewards, synergy grants, abilities, dig, harvest…
      // (Caveat: a Human-TM return on bench arrives via pokemon.tm, not pokemon.items, so it currently
      // reads as a plain "gained" — a minor edge case not worth per-unit tm tracking.)
      if (povItems !== undefined && povUnitItems !== undefined && povBoard) {
        const { added: pAdded, removed: pRemoved } = multisetDiff(povItems, items)

        // Per-unit item movements this frame, with the unit's (prettified) name — current board name,
        // else the previous-frame name (a unit deleted this frame, e.g. a sell). `present` distinguishes
        // a bench unequip (unit still on board) from a sell return (unit gone).
        type UnitDelta = { id: string; name: string; item: string; present: boolean }
        const uGained: UnitDelta[] = []
        const uLost: UnitDelta[] = []
        const ids = new Set<string>([...povUnitItems.keys(), ...unitItems.keys()])
        for (const id of ids) {
          const name = prettyName(board.get(id) ?? povBoard.get(id) ?? "")
          const present = board.has(id)
          const d = multisetDiff(povUnitItems.get(id) ?? [], unitItems.get(id) ?? [])
          for (const it of d.added) uGained.push({ id, name, item: it, present })
          for (const it of d.removed) uLost.push({ id, name, item: it, present })
        }
        const takeStr = (arr: string[], x: string): boolean => {
          const k = arr.indexOf(x)
          if (k < 0) return false
          arr.splice(k, 1)
          return true
        }
        const takeUnit = (arr: UnitDelta[], pred: (u: UnitDelta) => boolean): UnitDelta | undefined => {
          const k = arr.findIndex(pred)
          return k < 0 ? undefined : arr.splice(k, 1)[0]
        }

        // 1) On-unit craft: a unit gained result R and lost component D, player.items lost the other
        //    component C, with ItemRecipe[R] = {C, D}. Run first so it consumes its parts (R, D, C).
        for (let g = uGained.length - 1; g >= 0; g--) {
          const R = uGained[g].item
          const recipe = ItemRecipe[R as keyof typeof ItemRecipe]
          if (!recipe || recipe.length !== 2) continue
          const lostD = uLost.find((u) => u.id === uGained[g].id && (u.item === recipe[0] || u.item === recipe[1]))
          if (!lostD) continue
          const C = lostD.item === recipe[0] ? recipe[1] : recipe[0]
          if (!pRemoved.includes(C)) continue
          takeStr(pRemoved, C)
          takeUnit(uLost, (u) => u === lostD)
          actions.push({ t: f.t, type: "craft", label: `${prettyName(recipe[0])} + ${prettyName(recipe[1])} → ${prettyName(R)} on ${uGained[g].name}` })
          uGained.splice(g, 1)
        }

        // 2) Bench craft (player.items only): a result enters and both its components leave player.items.
        for (let a = pAdded.length - 1; a >= 0; a--) {
          const recipe = ItemRecipe[pAdded[a] as keyof typeof ItemRecipe]
          if (!recipe || recipe.length !== 2) continue
          const i0 = pRemoved.indexOf(recipe[0])
          if (i0 < 0) continue
          const rest = [...pRemoved]
          rest.splice(i0, 1)
          if (rest.indexOf(recipe[1]) < 0) continue
          pRemoved.splice(pRemoved.indexOf(recipe[0]), 1)
          pRemoved.splice(pRemoved.indexOf(recipe[1]), 1)
          actions.push({ t: f.t, type: "craft", label: `${prettyName(recipe[0])} + ${prettyName(recipe[1])} → ${prettyName(pAdded[a])}` })
          pAdded.splice(a, 1)
        }

        // 3) Equip: player.items lost X and a unit gained X this frame.
        for (let i = pRemoved.length - 1; i >= 0; i--) {
          const u = takeUnit(uGained, (g) => g.item === pRemoved[i])
          if (u) {
            actions.push({ t: f.t, type: "equip", label: `Equipped ${prettyName(pRemoved[i])} on ${u.name}` })
            pRemoved.splice(i, 1)
          }
        }

        // 4) Remaining player.items additions: an unequip return (a still-present unit lost it), a sell
        //    return (a deleted unit lost it → suppress; the sell already fired), else a genuine gain.
        for (const x of pAdded) {
          const u = takeUnit(uLost, (l) => l.item === x)
          if (u) {
            if (u.present) actions.push({ t: f.t, type: "unequip", label: `Unequipped ${prettyName(x)} from ${u.name}` })
            // else: sold unit's item returning — folded into the sell event, not a gain.
          } else {
            actions.push({ t: f.t, type: "item", label: `Got ${prettyName(x)}` })
          }
        }
      }

      // Positioning — any board unit whose (positionX, positionY) changed: a deploy (bench→board),
      // benching (board→bench), or a same-zone rearrange (Fighting's training cares about bench order).
      // Very high-frequency, so it lives in its own "positioning" chip (default OFF, like Engine). Only
      // units present in both frames qualify; a fresh buy/evolve has no prior position (handled above).
      if (povUnitPos) {
        unitPos.forEach((p, id) => {
          const prev = povUnitPos!.get(id)
          if (prev && (prev.x !== p.x || prev.y !== p.y)) {
            actions.push({ t: f.t, type: "move", label: `${prettyName(board.get(id) ?? "")} → (${p.x},${p.y})` })
          }
        })
      }

      // Synergy thresholds — when player.synergies crosses a SynergyTriggers tier (e.g. Electric 3).
      // The "step" is how many thresholds the current count meets (mirrors getSynergyStep); a step
      // increase = a tier activated/upgraded. We label with the threshold VALUE that was reached
      // (triggers[s]) so it reads as the in-game synergy bar ("Electric 3"). Counts are locked in prep
      // (computeSynergies), so this never fires mid-combat. We only report increases — a downgrade from
      // selling isn't an activation. (Terrain / Falinks effects live in player.effects, not synergies —
      // they're board-driven battlefield states, out of scope for the synergy-tier event.)
      const synSteps = new Map<string, number>()
      pov.synergies?.forEach((count, syn) => {
        const triggers = SynergyTriggers[syn as Synergy] ?? []
        let step = 0
        for (const t of triggers) if ((count ?? 0) >= t) step++
        if (step > 0) synSteps.set(syn, step)
      })
      if (povSynSteps) {
        synSteps.forEach((step, syn) => {
          const prev = povSynSteps!.get(syn) ?? 0
          if (step > prev) {
            const triggers = SynergyTriggers[syn as Synergy] ?? []
            for (let s = prev; s < step; s++) {
              actions.push({ t: f.t, type: "synergy", label: `${prettyName(syn)} ${triggers[s]}` })
            }
          }
        })
      }

      // --- Grass / Flora / wanderer events (UNVERIFIED off-source — the fixture runs none of these
      // synergies; signals are source-cited, to be confirmed against a Grass/Flora/wanderer capture). ---

      // Grass — a berry tree ripened (stage reached 3, harvestable). Picking it returns the berry to
      // player.items (already caught as an item gain), so the ripen is the distinct, decoupled signal.
      // berryTreesType[i] names the berry. A portal/region change zeroes stages (mini-game.ts) — a drop,
      // not a ripen — so it never fires here. (OnPickBerryCommand / berry growth in game-commands.ts.)
      const berryStages = pov.berryTreesStages ? Array.from(pov.berryTreesStages as ArrayLike<number>) : []
      const berryTypes = pov.berryTreesType ? Array.from(pov.berryTreesType as ArrayLike<string>) : []
      if (povBerryStages) {
        for (let i = 0; i < berryStages.length; i++) {
          if ((povBerryStages[i] ?? 0) < 3 && (berryStages[i] ?? 0) >= 3) {
            actions.push({ t: f.t, type: "berry", label: `${prettyName(berryTypes[i] ?? "Berry")} ripe` })
          }
        }
      }

      // Flora — a flower in a pot evolved. flowerPots is seeded full at game start (initFlowerPots) and
      // evolves in place (rich-mulch drop), so the discrete event is a slot's species changing to its
      // evolution. (OnDragDropItemCommand flower-pot-zone in game-commands.ts.)
      const flowers: string[] = []
      pov.flowerPots?.forEach((p) => flowers.push(p?.name ?? ""))
      if (povFlowers) {
        for (let i = 0; i < flowers.length; i++) {
          const prev = povFlowers[i]
          if (prev && flowers[i] && prev !== flowers[i] && evolvesTo(prev, flowers[i])) {
            actions.push({ t: f.t, type: "flower", label: `Flower → ${prettyName(flowers[i])}` })
          }
        }
      }

      // Wanderer — a catchable pokemon appeared (player.wanderers gains an entry, keyed by a fresh uuid;
      // spawnWanderingPokemon in player.ts). Catching it adds a board unit (a "gained"); clears/catches
      // delete keys. So new keys = appearances.
      const wandererIds = new Set<string>()
      const wandererPkm = new Map<string, string>()
      pov.wanderers?.forEach((w, id) => {
        wandererIds.add(id)
        wandererPkm.set(id, (w as { pkm?: string })?.pkm ?? "")
      })
      if (povWandererIds) {
        wandererIds.forEach((id) => {
          if (!povWandererIds!.has(id)) {
            actions.push({ t: f.t, type: "wanderer", label: `Wandering ${prettyName(wandererPkm.get(id) ?? "")}` })
          }
        })
      }

      povMoney = money
      povLevel = level
      povShop = shop
      povBoard = board
      povChoices = choices
      povHistoryLen = historyLen
      povItems = items
      povUnitItems = unitItems
      povUnitPos = unitPos
      povSynSteps = synSteps
      povBerryStages = berryStages
      povFlowers = flowers
      povWandererIds = wandererIds
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
