import { SchemaSerializer } from "@colyseus/sdk"
import type { Iterator } from "@colyseus/schema"
import type GameState from "../../../rooms/states/game-state"
import type Player from "../../../models/colyseus-models/player"
import { getPokemonData } from "../../../models/precomputed/precomputed-pokemon-data"
import { getLevelUpCost } from "../../../models/colyseus-models/experience-manager"
import { PVEStages } from "../../../models/pve-stages"
import { BOARD_HEIGHT, BOARD_WIDTH } from "../../../config/game/board"
import { PortalCarouselStages } from "../../../config/game/stages"
import { SynergyTriggers } from "../../../config/game/synergies"
import { BattleResult, GamePhaseState, PokemonActionState } from "../../../types/enum/Game"
import { ItemRecipe } from "../../../types/enum/Item"
import { Pkm, PkmDuos } from "../../../types/enum/Pokemon"
import type { Synergy } from "../../../types/enum/Synergy"
import type { ReplayFrame } from "./replay-room"
import { type CombatFrameState, type EntitySnap, prettyName, scanFrameCombat } from "./replay-combat-scan"
import type { PickOption, ReplayEventArgs } from "./replay-event-format"

// prettyName lives in replay-combat-scan (so the lean foreign-combat worker can reuse it); re-export it
// here for the existing callers (the event-log component imports it from this module).
export { prettyName }

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

// Timeline band colour class for a segment, matching the wiki "Stages" page taxonomy
// (app/pages/component/wiki/wiki-stages.css --stage-*-color): a FIGHT is "pve" on a scripted PvE stage
// (PVEStages) else "pvp"; a TOWN is "portal" on the starter/unique/legendary carousels
// (PortalCarouselStages = [0,10,20]) else "carousel" (item carousels); PICK stays neutral ("prep").
// Add-pick stages (AdditionalPicksStages) are deliberately NOT distinguished — they aren't their own
// phase (they ride a normal PICK), so they never surface as a segment. Kept as a pure helper so the
// scrubber and any future consumer classify segments identically.
export function segmentBandKind(seg: ReplaySegment): "prep" | "pve" | "pvp" | "carousel" | "portal" {
  if (seg.phase === GamePhaseState.FIGHT) return PVEStages[seg.stage] ? "pve" : "pvp"
  if (seg.phase === GamePhaseState.TOWN) return PortalCarouselStages.includes(seg.stage) ? "portal" : "carousel"
  return "prep"
}
export interface ReplayStageMark {
  stage: number
  t: number // absolute ms the stage first appears
}
// "elimination" comes from any player's life crossing 0; the rest are per-player actions derived by
// diffing each player's synced state (board / money / level / synergies / items / history / …). The
// Player schema @view-hides ONLY the shop (shop / shopLocked / shopFreeRolls), so we derive these for
// EVERY player, not just the recording POV — each action carries a `uid`. The shop-only signals
// (reroll / "remove", and the buy-vs-gained distinction) are recoverable for the POV alone.
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
  | "region" // any player entered a new region (player.map; derived for all players, owner-tagged)
  | "artifact" // a Normal-synergy scarf was crafted (scarvesItems; Fairy wands log via `pick`)
  | "weather" // a fight started with weather (its simulation's weather, ≠ NEUTRAL) — owner-tagged, any board
  | "berries" // a player's berry-tree species repopulated (berryTreesType; derived for all players)
  | "rule" // a special game rule is in effect (state.specialGameRule — scribble modes; once, at start)
  | "status" // a combat status flipped on for a unit on any board, owner-tagged (burn/poison/freeze/… — entity.status)
  | "stat" // a combat stat changed for a unit on any board, owner-tagged (atk/speed/ap/hp/… — entity stat field)
  | "item" // an item entered player.items with no unit losing it (pve reward, town, synergy, dig…)
  | "craft" // components combined into a completed item (player.items bench-combine OR onto a unit)
  | "equip" // an item left player.items and landed on a board unit
  | "unequip" // an item returned from a board unit to player.items (benching removable items)
  | "move" // a board unit's (x,y) changed (deploy / bench / rearrange) — own "positioning" chip
  | "level"
  | "xp" // bought experience (level-up cost gold → 4 XP) — OnLevelUpCommand
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

// Every PvE opponent name a round can store (PVEStages[*].name) — both "pkm.<SPECIES>" and the
// snake_case boss encounters ("tower_duo", "legendary_birds", …). A round event carries this name + an
// `isPvE` flag; the formatter localizes a PvE name (it IS a locale key) and leaves a PvP display name
// verbatim. Derived from source so a new PvE boss is covered without an edit here.
const PVE_OPPONENT_NAMES = new Set<string>(Object.values(PVEStages).map((s) => s.name))

export interface ReplayEvent {
  t: number // absolute ms
  type: ReplayEventType
  // Structured args for the render-time formatter (replaces the old pre-built English `label`): raw
  // game-data enum values + numbers, localized by formatReplayEvent. Absent for events with no params.
  a?: ReplayEventArgs
  uid?: string
  // Optional sub-type within the event's category, for the fine-grained filter — the stat field
  // ("Speed", "Shield") or status name ("Burn") for the stat/status firehose, which otherwise collapse
  // into a single type. Absent for events whose `type` already IS the filterable granularity.
  key?: string
}
export interface ReplayIndex {
  schemaVersion: number
  gameStartMs: number // first LOADING_COMPLETE — the controls' 0:00 re-base origin
  durationMs: number
  segments: ReplaySegment[] // phase-within-stage boundaries, anchored at/after gameStartMs
  stages: ReplayStageMark[] // first t per distinct stage
  events: ReplayEvent[] // eliminations, sorted by t — these drive the scrubber's event markers
  // Per-player actions (reroll/buy/sell/level/proposition pick/synergy/items/…), sorted by t. Each
  // carries `uid` (the player it belongs to) so the log can show one player or everyone; game-level
  // rows (town / special-rule) are uid-less. Kept separate from `events` so they feed the event log
  // WITHOUT flooding the scrubber with a marker per reroll/buy.
  actions: ReplayEvent[]
  // uid → the player's in-game name (display name for the per-player log column / tab labels). Built
  // from the final reconstructed state, so it covers every player that appeared.
  playerNames: Record<string, string>
  // Per message-frame (keyed by index in manifest.frames): the combat unit names resolved by tile
  // (caster/target — payloads identify units by (simulationId, x, y), looked up against the decoded sim
  // positions) AND `owner` = the player the row is tagged to (the per-player filter slices on it). For
  // camera-scoped combat (ABILITY/DAMAGE/HEAL/DISPLAY_TEXT) `owner` is the recorder's camera at that frame
  // (the watched board); for room-broadcast player events (DIG/COOK = digging player, SHOW_EMOTE = emoting
  // player) it's the resolved owner — so a scouted cast / an opponent's dig shows under THAT player.
  combatUnits: Record<number, { caster?: string; target?: string; owner?: string }>
  // DIG message frames (own POV only) → the dig site resolved from POV state: the digging unit's board
  // tile (x,y) and the hole depth AFTER this dig (groundHoles[(y-1)·BOARD_WIDTH+x] + 1, capped at 5).
  // The DIG payload only carries { pokemonId, buriedItem }, so coordinate + depth come from the state.
  digInfo: Record<number, { x: number; y: number; depth: number }>
  // PLAYER_INCOME message frames (own POV) → the round-income breakdown derived from POV state, when it
  // reconciles to the message total (base = total − interest − streak, base ≥ 0). Absent for combat/kill
  // gold (same message type, won't reconcile) → the log shows just the total there.
  incomeInfo: Record<number, { base: number; interest: number; streak: number }>
  // Message-frame indices that belong to ANOTHER player and must be hidden from this single-POV log.
  // DIG / COOK / SHOW_EMOTE are `room.broadcast` (every client receives them), so the POV capture
  // contains other players' digs/cooks/emotes; we resolve the owner (the digging/cooking unit's player,
  // or the emote's uid) and flag the non-POV ones. Combat is `broadcastToSpectators` (the POV's own
  // fight) and GAME_END / LOADING_COMPLETE are game-level, so those are NOT filtered.
  foreignFrames: number[]
}

// Region (player.map), weather, and gold deltas were formerly stringified here (regionName / weatherName /
// goldStr); they now emit raw values in the event args and the formatter localizes them via the game's
// map.* / weather.* keys (the map.* keys even cover the *Unused legacy renames, so the old override table
// is gone). All-boards combat status/stat diff lives in scanFrameCombat (replay-combat-scan.ts); the build
// loop below calls it once per state frame to emit owner-tagged status/stat events for every simulation.

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

// A proposition entry (player.choices[].pokemons) is a PkmProposition = Pkm | PkmDuo. A duo (e.g.
// Latios+Latias) resolves to TWO Pokémon that both land on the board (PkmDuos), so expand it to its
// constituents — both to MATCH the chosen entry against the board units that appeared, and to render it
// (the formatter joins them "Latios + Latias"). A plain Pkm is its own single constituent.
const propositionConstituents = (p: string): string[] =>
  p in PkmDuos ? [...PkmDuos[p as keyof typeof PkmDuos]] : [p]

// The full slate of a player.choices entry, snapshotted per frame so that when a choice is resolved
// (it leaves player.choices the frame the player picks) we can recover the options that were offered.
type ChoiceSlate = { type: string; pokemons: string[]; items: string[] }

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

// The player on whose side a board tile (x,y) sits in a simulation — for owner-tagging a BOARD_EVENT (a
// field/hazard on a tile; its payload carries no player). A unit on the tile gives its team's player; an
// empty tile falls to the board half (blue fills the bottom rows, red the top — getFirstFreeCell). Returns
// the owner ONLY when that player's own simulationId points back to this sim, so ghost/PvE sides drop out
// (matching scanFrameCombat); undefined otherwise → the caller hides it.
function simTileOwner(
  state: GameState,
  simId: string | undefined,
  x: number | undefined,
  y: number | undefined
): string | undefined {
  if (!simId || x == null || y == null) return undefined
  const sim = state.simulations?.get(simId) as
    | {
        bluePlayerId?: string
        redPlayerId?: string
        blueTeam?: { forEach?: (cb: (e: { positionX?: number; positionY?: number }) => void) => void }
        redTeam?: { forEach?: (cb: (e: { positionX?: number; positionY?: number }) => void) => void }
      }
    | undefined
  if (!sim) return undefined
  let side: "blue" | "red" | undefined
  sim.blueTeam?.forEach?.((e) => { if (e?.positionX === x && e?.positionY === y) side = "blue" })
  sim.redTeam?.forEach?.((e) => { if (e?.positionX === x && e?.positionY === y) side = "red" })
  if (!side) side = y < BOARD_HEIGHT / 2 ? "blue" : "red" // empty tile → board half (blue = bottom rows)
  const owner = side === "blue" ? sim.bluePlayerId : sim.redPlayerId
  return owner && state.players?.get(owner)?.simulationId === simId ? owner : undefined
}

// Casts sent with `room.broadcast` (every client) rather than `broadcastToSpectators` (only clients whose
// camera is on that fight). The recorded camera (spectatedPlayerId) therefore does NOT identify their
// board, so these are owner-tagged by the payload tile's own sim (simTileOwner), not the camera — else
// opponents' team-wide casts leak onto whatever board the recorder was watching. Maintenance: a new
// `room.broadcast(Transfer.ABILITY)` added upstream must be listed here. As of the pin: TIDAL_WAVE
// (simulation.ts triggerTidalWave), COMET_CRASH (COMET_SHARD skydive), CURSE_EFFECT (status.ts updateCurse).
const ROOM_BROADCAST_ABILITIES = new Set(["TIDAL_WAVE", "COMET_CRASH", "CURSE_EFFECT"])

// Which player's board (bench + board) currently holds `unitId`. Used to attribute a `room.broadcast`
// DIG / COOK (payload `pokemonId` = the digging/cooking unit) to its owner so the row shows under that
// player. Returns undefined if the unit isn't on any board this frame.
function playerOwningUnit(state: GameState, unitId: string): string | undefined {
  let owner: string | undefined
  state.players?.forEach((p, uid) => {
    if (!owner && (p as { board?: { get?: (id: string) => unknown } }).board?.get?.(unitId)) owner = uid
  })
  return owner
}

// Where the POV's own dig landed, for the "Dug (x,y) to depth N" label. The DIG payload only names the
// digging unit (pokemonId); the hole is at that unit's board tile, and groundHoles indexes the board by
// (positionY-1)·BOARD_WIDTH+positionX (game-commands.ts dig handler). The depth is incremented in a
// deferred clock.setTimeout AFTER the broadcast, so at this frame groundHoles[index] is the PRE-dig
// depth → the post-dig depth is min(it+1, 5) (Ground caps holes at 5; a dig only fires below max).
function digSite(state: GameState, uid: string, unitId: string): { x: number; y: number; depth: number } | undefined {
  const unit = (state.players?.get(uid) as { board?: { get?: (id: string) => { positionX?: number; positionY?: number } } } | undefined)?.board?.get?.(unitId)
  if (!unit || unit.positionX == null || unit.positionY == null) return undefined
  const x = unit.positionX
  const y = unit.positionY
  const holes = (state.players?.get(uid) as { groundHoles?: ArrayLike<number> } | undefined)?.groundHoles
  const before = holes ? holes[(y - 1) * BOARD_WIDTH + x] ?? 0 : 0
  return { x, y, depth: Math.min(before + 1, 5) }
}

// The per-player "previous frame" state the diff-derivation compares against. One of these is kept per
// player (prevByPlayer) and refreshed each state frame. `shop` is empty for non-POV players (the only
// @view-hidden field), so the shop-dependent branches below simply don't fire for them.
interface PlayerSnapshot {
  money: number | undefined
  level: number | undefined
  shop: string[]
  board: Map<string, string> // unit id → name
  choices: Map<string, ChoiceSlate> // choice id → its offered slate
  historyLen: number
  items: string[] // bench items (multiset)
  unitItems: Map<string, string[]> // unit id → pokemon.items
  unitPos: Map<string, { x: number; y: number }> // unit id → (positionX, positionY)
  synSteps: Map<string, number> // synergy → active tier step
  berryStages: number[]
  berryTypes: string[] // filtered species list (for the repopulate diff)
  flowers: string[]
  wandererIds: Set<string>
  map: string | undefined
  scarves: string[]
}

type DeriveCtx = { t: number; specialGameRule: Parameters<typeof getLevelUpCost>[0]; shinyEncounter: boolean }

// Derive one player's state-diff events for this frame by comparing its synced state against the prior
// snapshot. Runs for EVERY player (Tab 2 = everyone) — the same logic the recording POV gets, minus the
// shop-only signals (reroll / "remove" / buy-vs-gained), which need the @view-hidden shop and so only
// fire for the POV (whose snapshot carries a populated `shop`). Pure: returns the events (caller tags
// them with the player's uid) + the fresh snapshot to store. On the first frame a player is seen `prev`
// is undefined → no diffs, just a baseline snapshot. Combat (status/stat/weather) is NOT here — it's
// single-POV (the recorder's camera) and stays in buildReplayIndex.
function derivePlayerStateEvents(
  p: Player,
  prev: PlayerSnapshot | undefined,
  ctx: DeriveCtx
): { events: { t: number; type: ReplayEventType; a: ReplayEventArgs }[]; snap: PlayerSnapshot } {
  const events: { t: number; type: ReplayEventType; a: ReplayEventArgs }[] = []
  const push = (type: ReplayEventType, a: ReplayEventArgs) => events.push({ t: ctx.t, type, a })

  // --- current-frame reads (needed for the snapshot regardless of prev) ---
  const money = p.money
  const level = p.experienceManager?.level
  const map = (p as { map?: string }).map
  const scarves = p.scarvesItems ? [...(p.scarvesItems as Iterable<string>)] : []
  const shop = p.shop ? Array.from(p.shop as ArrayLike<string>) : []
  const board = new Map<string, string>()
  const unitItems = new Map<string, string[]>()
  const unitPos = new Map<string, { x: number; y: number }>()
  p.board?.forEach((u, id) => {
    board.set(id, u.name)
    unitItems.set(id, u.items ? [...(u.items as Iterable<string>)] : [])
    unitPos.set(id, { x: u.positionX ?? 0, y: u.positionY ?? 0 })
  })
  const choices = new Set<string>()
  const choiceSlates = new Map<string, ChoiceSlate>()
  p.choices?.forEach((c) => {
    choices.add(c.id)
    choiceSlates.set(c.id, {
      type: c.type,
      pokemons: c.pokemons ? [...(c.pokemons as Iterable<string>)] : [],
      items: c.items ? [...(c.items as Iterable<string>)] : []
    })
  })
  const items = p.items ? Array.from(p.items as ArrayLike<string>) : []
  const historyLen = p.history?.length ?? 0
  // synergy tier step = how many SynergyTriggers thresholds the current count meets (mirrors getSynergyStep)
  const synSteps = new Map<string, number>()
  p.synergies?.forEach((count, syn) => {
    const triggers = SynergyTriggers[syn as Synergy] ?? []
    let step = 0
    for (const tr of triggers) if ((count ?? 0) >= tr) step++
    if (step > 0) synSteps.set(syn, step)
  })
  const berryStages = p.berryTreesStages ? Array.from(p.berryTreesStages as ArrayLike<number>) : []
  const berryTypes = p.berryTreesType ? Array.from(p.berryTreesType as ArrayLike<string>) : []
  const species = berryTypes.filter(Boolean)
  const flowers: string[] = []
  p.flowerPots?.forEach((pot) => flowers.push(pot?.name ?? ""))
  const wandererIds = new Set<string>()
  const wandererPkm = new Map<string, string>()
  p.wanderers?.forEach((w, id) => {
    wandererIds.add(id)
    wandererPkm.set(id, (w as { pkm?: string })?.pkm ?? "")
  })

  if (prev) {
    // Region change — player.map is set to the portal's destination when one is taken.
    if (prev.map !== undefined && map && map !== prev.map) push("region", { map })
    // Normal-synergy scarf craft: scarvesItems grows (lands outside player.items, so the item diffs miss it).
    for (const x of multisetDiff(prev.scarves, scarves).added) push("artifact", { item: x })

    // Choices resolved this frame: present last frame, gone now (the player picked → left player.choices).
    // Their snapshotted slate is what the pick was made FROM. Auto-pick on timeout can resolve several.
    const resolved = [...prev.choices].filter(([id]) => !choices.has(id)).map(([, slate]) => slate)
    // Set by the board branch when a combined pokemon+item proposition is picked (the item shows inline in
    // the pick label); the item branch then consumes it without re-logging.
    let combinedPickItem: string | null = null

    {
      const dMoney = typeof money === "number" && typeof prev.money === "number" ? money - prev.money : 0
      const levelUpCost = getLevelUpCost(ctx.specialGameRule)
      const added = [...board].filter(([id]) => !prev.board.has(id))
      const removed = [...prev.board].filter(([id]) => !board.has(id))
      const choiceResolved = resolved.length > 0
      // A pokemon proposition resolved this frame: match the chosen entry against the units that appeared
      // (a duo adds both) so we can show what it was picked OVER. null if we can't match it to a board add.
      const pokeSlate = resolved.find((s) => s.pokemons.length > 0)
      // Structured pick options (the chosen + the alternatives), formatted at render. Each option is its
      // constituent pokemon (a duo → both) plus the optional item shown in parens.
      let pokePick: { options: PickOption[]; chosenIdx: number } | null = null
      if (pokeSlate) {
        const addedNames = new Set(added.map(([, n]) => n))
        const chosenIdx = pokeSlate.pokemons.findIndex((pp) =>
          propositionConstituents(pp).some((c) => addedNames.has(c))
        )
        if (chosenIdx >= 0) {
          const withItems = pokeSlate.items.length > 0
          const options: PickOption[] = pokeSlate.pokemons.map((pp, i) => ({
            pkms: propositionConstituents(pp),
            ...(withItems && pokeSlate.items[i] ? { item: pokeSlate.items[i] } : {})
          }))
          pokePick = { options, chosenIdx }
          if (withItems && pokeSlate.items[chosenIdx]) combinedPickItem = pokeSlate.items[chosenIdx]
        }
      }
      const boardChanged = added.length > 0 || removed.length > 0 || board.size !== prev.board.size
      // Slots cleared to Pkm.DEFAULT this frame: a buy (also board.set → boardChanged) or a "remove" ("e",
      // never touches the board). Empty for non-POV players (their shop isn't synced).
      const emptied: string[] = []
      for (let s = 0; s < prev.shop.length && s < shop.length; s++) {
        if (prev.shop[s] !== Pkm.DEFAULT && shop[s] === Pkm.DEFAULT) emptied.push(prev.shop[s])
      }
      const refreshed = shop.filter((s, k) => s !== prev.shop[k] && s !== Pkm.DEFAULT).length

      // Evolution: a board churn where an added unit is the evolution of a removed one (or a same-species
      // combine). Detected independently of the shop branch — a 3-combine on BUY emits both a buy and an evolve.
      if (added.length && removed.length) {
        if (removed.some(([, n]) => n === Pkm.EGG)) {
          push("hatch", { pkm: added[0][1] })
        } else {
          let pair: [string, string] | undefined
          for (const [, ev] of added) {
            const base = removed.find(([, b]) => evolvesTo(b, ev))?.[1]
            if (base) {
              pair = [base, ev]
              break
            }
          }
          if (!pair && added.length === 1) {
            const counts = new Map<string, number>()
            for (const [, b] of removed) counts.set(b, (counts.get(b) ?? 0) + 1)
            const combinedBase = [...counts].find(([, n]) => n >= 2)?.[0]
            if (combinedBase) pair = [combinedBase, added[0][1]]
          }
          if (pair) push("evolve", { from: pair[0], to: pair[1] })
        }
      }

      // Priority so one underlying SHOP action emits one event. (Buy/remove/reroll need the shop → POV only.)
      if (emptied.length) {
        const kind = boardChanged ? "buy" : "remove"
        emptied.forEach((name) => {
          const withGold = kind === "buy" && emptied.length === 1 && dMoney < 0
          push(kind, withGold ? { pkm: name, gold: dMoney } : { pkm: name })
        })
      } else if (choiceResolved && added.length) {
        push("pick", pokePick ?? { options: [{ pkms: [added[0][1]] }], chosenIdx: 0 })
      } else if (removed.length && !added.length && removed.length <= 3 && p.alive !== false) {
        // Sell — structural (a board unit leaves with no add and no shop-slot buy), mode-independent.
        push("sell", dMoney > 0 ? { pkm: removed[0][1], gold: dMoney } : { pkm: removed[0][1] })
      } else if (!boardChanged && refreshed >= REROLL_MIN_REFRESHED_SLOTS) {
        push("reroll", dMoney < 0 ? { gold: dMoney } : {})
      } else if (dMoney === -levelUpCost && !boardChanged && emptied.length === 0 && refreshed === 0) {
        push("xp", { amount: 4, gold: dMoney })
      } else if (added.length && !removed.length) {
        // A unit appeared with no buy/pick/evolution behind it: Baby egg, Water fish, or a free gain. (For a
        // non-POV player a real buy lands here too — we can't see the shop — so it reads as "Gained".)
        for (const [id, name] of added) {
          if (name === Pkm.EGG) {
            const egg = p.board.get(id) as { evolution?: string; shiny?: boolean } | undefined
            const hatchPkm = egg?.evolution && egg.evolution !== Pkm.DEFAULT ? egg.evolution : ""
            push("egg", hatchPkm ? { pkm: hatchPkm, golden: !!egg?.shiny } : {})
          } else if (p.board.get(id)?.action === PokemonActionState.FISH) {
            push("fish", { pkm: name })
          } else {
            push("gained", { pkm: name })
          }
        }
      }
      if (typeof level === "number" && typeof prev.level === "number" && level > prev.level) {
        push("level", { level })
      }
    }

    // Round results — each new player.history entry is a resolved fight (win/loss/draw vs opponent).
    if (p.history && historyLen > prev.historyLen) {
      for (let h = prev.historyLen; h < historyLen; h++) {
        const hi = p.history.at(h)
        if (!hi) continue
        // PvE opponent names are locale keys ("pkm.MAGIKARP" / boss keys); PvP names are display names —
        // the formatter localizes the former and leaves the latter verbatim (isPvE distinguishes). result
        // is normalized to a stable token so the formatter needn't import BattleResult.
        const isPvE = hi.name?.startsWith("pkm.") || PVE_OPPONENT_NAMES.has(hi.name)
        const result = hi.result === BattleResult.WIN ? "win" : hi.result === BattleResult.DEFEAT ? "loss" : "draw"
        push("round", { result, opponent: hi.name, isPvE: !!isPvE, shiny: ctx.shinyEncounter })
      }
    }

    // Item events — classify the player.items diff against this frame's per-unit pokemon.items movements
    // (equip / on-unit craft / bench craft / bench unequip / sell return / gain). See the long note that
    // used to sit here; full rationale lives in replay/EVENT-LOG.md.
    {
      const { added: pAdded, removed: pRemoved } = multisetDiff(prev.items, items)
      type UnitDelta = { id: string; name: string; item: string; present: boolean }
      const uGained: UnitDelta[] = []
      const uLost: UnitDelta[] = []
      const ids = new Set<string>([...prev.unitItems.keys(), ...unitItems.keys()])
      for (const id of ids) {
        // raw pokemon enum value (the formatter localizes it via pkm.*); was prettified here pre-i18n
        const name = board.get(id) ?? prev.board.get(id) ?? ""
        const present = board.has(id)
        const d = multisetDiff(prev.unitItems.get(id) ?? [], unitItems.get(id) ?? [])
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

      // 0) Item proposition pick: a resolved choice whose slate is items. The chosen item entered
      //    player.items this frame — log it as a pick and consume it so it isn't re-read as a craft/gain.
      const itemSlate = resolved.find((s) => s.items.length > 0)
      if (itemSlate) {
        if (itemSlate.pokemons.length > 0) {
          const chosen = combinedPickItem ?? itemSlate.items.find((it) => pAdded.includes(it))
          if (chosen) takeStr(pAdded, chosen)
        } else {
          const chosen = itemSlate.items.find((it) => pAdded.includes(it))
          if (chosen) {
            takeStr(pAdded, chosen)
            // item-only proposition: chosen first (chosenIdx 0), then the alternatives — each an item option.
            const options: PickOption[] = [chosen, ...itemSlate.items.filter((it) => it !== chosen)].map((it) => ({ item: it }))
            push("pick", { options, chosenIdx: 0 })
          }
        }
      }

      // 1) On-unit craft: a unit gained result R and lost component D, player.items lost C, ItemRecipe[R]={C,D}.
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
        push("craft", { c0: recipe[0], c1: recipe[1], result: R, unit: uGained[g].name })
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
        push("craft", { c0: recipe[0], c1: recipe[1], result: pAdded[a] })
        pAdded.splice(a, 1)
      }

      // 3) Equip: player.items lost X and a unit gained X this frame.
      for (let i = pRemoved.length - 1; i >= 0; i--) {
        const u = takeUnit(uGained, (g) => g.item === pRemoved[i])
        if (u) {
          push("equip", { item: pRemoved[i], unit: u.name })
          pRemoved.splice(i, 1)
        }
      }

      // 4) Remaining player.items additions: unequip return (still-present unit), sell return (deleted
      //    unit → suppress; the sell already fired), else a genuine gain.
      for (const x of pAdded) {
        const u = takeUnit(uLost, (l) => l.item === x)
        if (u) {
          if (u.present) push("unequip", { item: x, unit: u.name })
        } else {
          push("item", { item: x })
        }
      }
    }

    // Positioning — any board unit whose (x,y) changed (deploy / bench / rearrange). Own chip, default off.
    unitPos.forEach((pos, id) => {
      const prv = prev.unitPos.get(id)
      if (prv && (prv.x !== pos.x || prv.y !== pos.y)) {
        push("move", { pkm: board.get(id) ?? "", x: pos.x, y: pos.y })
      }
    })

    // Synergy thresholds — player.synergies crossing a SynergyTriggers tier (increase only).
    synSteps.forEach((step, syn) => {
      const prv = prev.synSteps.get(syn) ?? 0
      if (step > prv) {
        const triggers = SynergyTriggers[syn as Synergy] ?? []
        for (let s = prv; s < step; s++) push("synergy", { synergy: syn, count: triggers[s] })
      }
    })

    // Grass — a berry tree ripened (stage reached 3). berryTypes[i] names the berry (an item.* key).
    for (let i = 0; i < berryStages.length; i++) {
      if ((prev.berryStages[i] ?? 0) < 3 && (berryStages[i] ?? 0) >= 3) {
        push("berry", { berry: berryTypes[i] ?? "" })
      }
    }
    // Berry-tree species set — repopulates on each portal (so this fires alongside a region change).
    if (species.length > 0 && species.join() !== prev.berryTypes.join()) {
      push("berries", { list: species })
    }

    // Flora — a flower in a pot evolved in place (mulch-fed).
    for (let i = 0; i < flowers.length; i++) {
      const prv = prev.flowers[i]
      if (prv && flowers[i] && prv !== flowers[i] && evolvesTo(prv, flowers[i])) {
        push("flower", { flower: flowers[i] })
      }
    }

    // Wanderer — a catchable pokemon appeared (player.wanderers gains a fresh-uuid entry).
    wandererIds.forEach((id) => {
      if (!prev.wandererIds.has(id)) push("wanderer", { pkm: wandererPkm.get(id) ?? "" })
    })
  }

  const snap: PlayerSnapshot = {
    money,
    level,
    shop,
    board,
    choices: choiceSlates,
    historyLen,
    items,
    unitItems,
    unitPos,
    synSteps,
    berryStages,
    berryTypes: species,
    flowers,
    wandererIds,
    map,
    scarves
  }
  return { events, snap }
}

export function buildReplayIndex(frames: ReplayFrame[], viewerUid?: string): ReplayIndex {
  const ser = new SchemaSerializer<GameState>()
  let hasState = false
  let gameStartMs: number | null = null
  let durationMs = 0

  const segments: ReplaySegment[] = []
  const events: ReplayEvent[] = [] // eliminations only (scrubber markers + log)
  const actions: ReplayEvent[] = [] // POV reroll/buy/sell/level/pick (log only)
  const combatUnits: Record<number, { caster?: string; target?: string; owner?: string }> = {}
  const digInfo: Record<number, { x: number; y: number; depth: number }> = {} // POV digs → tile + depth
  const incomeInfo: Record<number, { base: number; interest: number; streak: number }> = {} // round income
  const foreignFrames: number[] = [] // non-POV DIG/COOK/SHOW_EMOTE message frames (room.broadcast leak)
  // uid → in-game name, accumulated across ALL frames (not just the final state): a player who leaves before
  // stage 6 is deleted from state.players (game-room onLeave), but their owner-tagged rows remain — keep
  // their name so they still get a chip in the per-player filter.
  const playerNames: Record<string, string> = {}

  let prevPhase: number | undefined
  let prevStage: number | undefined
  let prevTownEncounter: string | null | undefined // state.townEncounter (shared town NPC)
  let prevRule: string | null | undefined // state.specialGameRule (scribble mode; set once at start)
  // Combat-entity tracking (status + stats) for EVERY board, owner-tagged (scanFrameCombat). prevBySim:
  // simId → (entity id → last snapshot); persists across frames (a new round's sim has a new id → fresh
  // baseline). Status/stats sync for all sims (no @view), so this covers all 8 players, not just the POV.
  const prevBySim = new Map<string, Map<string, EntitySnap>>()
  const lifePrev = new Map<string, number>()
  const eliminated = new Set<string>()

  // A PLAYER_INCOME message awaiting its breakdown (resolved on the next PICK-phase state frame, when
  // this round's interest/streak have been patched in). { idx: message frame, total: the gold amount }.
  let pendingIncome: { idx: number; total: number } | null = null
  // Per-player snapshot of the previous state frame, keyed by uid — the diff baseline for
  // derivePlayerStateEvents (Tab 2 = everyone). Undefined for a player until its first state frame.
  const prevByPlayer = new Map<string, PlayerSnapshot>()
  const prevWeatherBySim = new Map<string, string>() // simId → its last non-NEUTRAL weather (all boards)

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    durationMs = Math.max(durationMs, f.t)

    if (f.kind === "message") {
      if (f.type === "LOADING_COMPLETE" && gameStartMs === null) gameStartMs = f.t
      // ABILITY / POKEMON_DAMAGE / POKEMON_HEAL / DISPLAY_TEXT are `broadcastToSpectators` — sent only to
      // clients whose CAMERA (spectatedPlayerId) is on that fight AT THAT INSTANT. So these rows belong to
      // whatever board the recorder was watching, NOT necessarily their own — tag them by the recorded
      // camera (`owner`) so a fight watched by scouting shows under THAT player, not the POV. (The recorded
      // spectatedPlayerId is set in the same handler as the server's broadcast filter, so it reconstructs
      // exactly which board's combat was captured.) Unit NAMES still resolve against the message's own
      // simId, so "X's Charizard" is correct regardless of the tag.
      if (hasState && (f.type === "ABILITY" || f.type === "POKEMON_DAMAGE" || f.type === "POKEMON_HEAL" || f.type === "DISPLAY_TEXT")) {
        const state = ser.getState()
        const pl = f.payload as {
          id?: string; skill?: string; positionX?: number; positionY?: number; targetX?: number; targetY?: number; x?: number; y?: number
        }
        const pov = viewerUid
          ? (state.players?.get(viewerUid) as { spectatedPlayerId?: string; alive?: boolean; hasLeftGame?: boolean } | undefined)
          : undefined
        const owner = pov?.spectatedPlayerId
        // Death/leave force `spectatedPlayerId` back to self (checkDeath / the onLeave handler) WITHOUT
        // resetting the server's broadcast filter (client.userData), which keeps pointing at the last
        // board the POV scouted. So a dead/left POV still receives THAT board's combat while the schema
        // reads self — tagging by `owner` would mis-file a scouted fight onto the POV (who has no fight of
        // their own). userData isn't in the transcript, so we can't recover which board it was → drop these
        // camera-scoped rows as foreign. A dead POV who re-spectates sets spectatedPlayerId ≠ self → kept.
        const cameraSelfForced = owner === viewerUid && (pov?.alive === false || pov?.hasLeftGame === true)
        if (f.type === "ABILITY") {
          // Only the caster: the ABILITY target (targetX/Y) is the caster's attack-enemy by default, so
          // it mis-names self/ally effects — the log drops it (the real target is the damage/heal row's).
          const caster = unitAt(state, pl?.id, pl?.positionX, pl?.positionY)
          if (pl?.skill && ROOM_BROADCAST_ABILITIES.has(pl.skill)) {
            // A room.broadcast cast: the camera doesn't own it. Tag by the payload tile's own sim, else hide
            // (an unresolved / ghost-PvE side → foreignFrames), the same rule scanFrameCombat/BOARD_EVENT use.
            const boardOwner = simTileOwner(state, pl?.id, pl?.positionX, pl?.positionY)
            if (boardOwner) combatUnits[i] = { caster, owner: boardOwner }
            else foreignFrames.push(i)
          } else if (cameraSelfForced) {
            foreignFrames.push(i)
          } else {
            combatUnits[i] = { caster, owner }
          }
        } else if (cameraSelfForced) {
          foreignFrames.push(i)
        } else if (f.type === "DISPLAY_TEXT") {
          combatUnits[i] = { owner } // no tile to name; just carry the camera owner
        } else {
          const target = unitAt(state, pl?.id, pl?.x, pl?.y)
          combatUnits[i] = { target, owner }
        }
      }
      // Owner-tag the `room.broadcast` player events (every client receives all of them, so the capture
      // has every player's): DIG / COOK → the digging/cooking unit's owner (payload.pokemonId), SHOW_EMOTE
      // → payload.id (the emoting player), BOARD_EVENT → the player on whose side of the fight the tile sits
      // (simTileOwner). The row shows under that player's chip (default POV-only). A non-resolved or
      // ghost/PvE-side board-event is hidden (foreignFrames).
      if (viewerUid) {
        if (f.type === "SHOW_EMOTE") {
          const id = (f.payload as { id?: string })?.id
          if (id) combatUnits[i] = { owner: id }
        } else if (hasState && (f.type === "DIG" || f.type === "COOK")) {
          const pid = (f.payload as { pokemonId?: string })?.pokemonId
          const owner = pid ? playerOwningUnit(ser.getState(), pid) : undefined
          if (owner) combatUnits[i] = { owner }
          if (f.type === "DIG" && pid) {
            const site = digSite(ser.getState(), owner ?? viewerUid, pid)
            if (site) digInfo[i] = site
          }
        } else if (hasState && f.type === "BOARD_EVENT") {
          const bp = f.payload as { simulationId?: string; x?: number; y?: number }
          const owner = simTileOwner(ser.getState(), bp?.simulationId, bp?.x, bp?.y)
          if (owner) combatUnits[i] = { owner }
          else foreignFrames.push(i)
        }
      }
      // Round-income breakdown: PLAYER_INCOME (a POV-only client.send) carries just the total, but the
      // regular round income = base(5 + red scales) + interest + win-streak bonus (computeIncome). We
      // back out base = total − interest − streak, but the message arrives a frame or two BEFORE the
      // state patch that updates this round's interest/streak — so we DEFER the breakdown to the next
      // PICK-phase state frame (when they've landed). Stash it; the state loop resolves it below.
      if (hasState && viewerUid && f.type === "PLAYER_INCOME") {
        const total = typeof f.payload === "number" ? f.payload : (f.payload as { value?: number })?.value
        if (typeof total === "number") pendingIncome = { idx: i, total }
      }
      continue
    }

    try {
      const bytes = f.bytes ?? b64ToBytes(f.b64!) // v1 carries raw bytes; v0 decodes base64
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
      actions.push({ t: f.t, type: "town", a: { npc: te } })
    }
    prevTownEncounter = te

    // Special game rule (scribble modes) — set once at game start, never changes; log its first sighting.
    const rule = (state as { specialGameRule?: string | null }).specialGameRule ?? null
    if (rule && rule !== prevRule) {
      actions.push({ t: f.t, type: "rule", a: { rule } })
    }
    prevRule = rule

    state.players?.forEach((p, uid) => {
      if (p?.name) playerNames[uid] = p.name
      const life = p.life
      if (typeof life !== "number") return
      if (isElimination(lifePrev.get(uid), life) && !eliminated.has(uid)) {
        eliminated.add(uid)
        events.push({ t: f.t, type: "elimination", uid, a: { player: p.name } })
      }
      lifePrev.set(uid, life)
    })

    // --- POV-only income breakdown ---
    // PLAYER_INCOME is a POV-only client.send carrying just the total; resolve its base/interest/streak
    // split now that this PICK frame's interest/streak have landed (it's the recorder's own, viewer-tagged).
    const pov = viewerUid ? state.players?.get(viewerUid) : undefined
    if (pov && pendingIncome && ph === GamePhaseState.PICK) {
      // base = total − interest − streak (= 5 + red scales, always ≥ 0 for a real round income). The
      // PICK-phase gate rejects combat/kill gold (same PLAYER_INCOME message, sent during FIGHT) → it
      // falls back to the plain total. The real base is always 5 + 5·(red scales) — a positive multiple of
      // 5; show the breakdown only when it works out to that (also rejects the rare frame where a loss-round
      // streak reset hasn't been patched in yet → base 2–4 → falls back to the plain total).
      const interest = typeof pov.interest === "number" ? pov.interest : 0
      const streak = Math.min(typeof pov.streak === "number" ? pov.streak : 0, 5)
      const base = pendingIncome.total - interest - streak
      if (base >= 5 && base % 5 === 0) incomeInfo[pendingIncome.idx] = { base, interest, streak }
      pendingIncome = null
    }

    // --- All-boards weather ---
    // sim.weather syncs for every simulation (no @view), so each fight's weather is recoverable, not just
    // the recorder's. Emit it owner-tagged to each real player in the sim (so it shows under their chip)
    // when their fight's weather first turns non-NEUTRAL. Low-volume (≈ one per fight).
    const simsForWeather = state.simulations as unknown as
      | { forEach?: (cb: (sim: { weather?: string; bluePlayerId?: string; redPlayerId?: string }, id: string) => void) => void }
      | undefined
    simsForWeather?.forEach?.((sim, simId) => {
      const weather = sim.weather
      if (!weather || weather === "NEUTRAL" || weather === prevWeatherBySim.get(simId)) return
      prevWeatherBySim.set(simId, weather)
      for (const owner of [sim.bluePlayerId, sim.redPlayerId]) {
        if (owner && state.players?.get(owner)?.simulationId === simId)
          actions.push({ t: f.t, type: "weather", a: { weather }, uid: owner })
      }
    })

    // --- All-boards combat (status + stats) ---
    // Diff every simulation's units, owner-tagged (scanFrameCombat handles the ghost/PvE exclusion). A
    // status flips false→true (poisonStacks ↑); a buff stat changes value. Combat-volume → the default-off
    // Status/Stats categories. Owner-tagged so each player's combat shows under their name in the log.
    scanFrameCombat(state as unknown as CombatFrameState, prevBySim, f.t, actions)

    // --- Per-player state-diff events ---
    // Board / economy / items / synergy / round / region / berry / flower / wanderer derivation, run for
    // EVERY player and tagged with its uid (the log's per-player filter slices on it). The shop-only
    // signals (reroll / "remove" / buy-vs-gained) only fire for the POV, whose snapshot carries a shop.
    const deriveCtx: DeriveCtx = {
      t: f.t,
      specialGameRule: state.specialGameRule,
      shinyEncounter: !!(state as { shinyEncounter?: boolean }).shinyEncounter
    }
    state.players?.forEach((p, uid) => {
      const { events: playerEvents, snap } = derivePlayerStateEvents(p, prevByPlayer.get(uid), deriveCtx)
      for (const e of playerEvents) actions.push({ t: e.t, type: e.type, a: e.a, uid })
      prevByPlayer.set(uid, snap)
    })
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
    combatUnits,
    digInfo,
    incomeInfo,
    foreignFrames,
    playerNames
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
