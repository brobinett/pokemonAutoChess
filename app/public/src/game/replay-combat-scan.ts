// Combat-entity status/stat diff — the firehose buildReplayIndex runs for every board. Pure: no game
// imports, the caller passes a decoded GameState (scanFrameCombat) or a single entity + prettified name
// (scanCombatEntity).
//
// status + stats are synced @type fields on each PokemonEntity, so they're recoverable for EVERY board
// in the capture (the simulations map has no @view), owner-tagged. Cast/damage/heal are NOT here — those
// are broadcastToSpectators messages, present only for the recorder's own fight (the single-POV gap).

// PAC enum values are SCREAMING_SNAKE (Pkm.SWINUB = "SWINUB", Ability.ICE_SPINNER); render them as
// "Swinub" / "Ice Spinner". Derived from the value, so it survives a submodule bump (no i18n dep). Lives
// here (not in replay-index) so the lean foreign-combat worker can reuse it without the heavy index
// imports; replay-index re-exports it for its existing callers.
export function prettyName(v: string | undefined | null): string {
  if (!v) return ""
  return v
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

// All 37 status fields (the names look odd but each IS a status); poisonStacks is a counter, the rest
// booleans (false→true = applied).
export const STATUS_FIELDS = [
  "burn", "silence", "fatigue", "poisonStacks", "freeze", "protect", "sleep",
  "confusion", "wound", "resurrection", "resurrecting", "paralysis", "pokerus",
  "possessed", "locked", "blinded", "armorReduction", "runeProtect", "charm",
  "flinch", "electricField", "psychicField", "grassField", "fairyField",
  "spikeArmor", "magicBounce", "reflect", "light", "curse", "curseVulnerability",
  "curseWeakness", "curseTorment", "curseFate", "enraged", "skydiving", "tree"
] as const
// Every numeric stat, including hp/pp/shield (NOT duplicates of damage/heal — a POKEMON_DAMAGE can come
// off shield OR hp and doesn't say which, and pp/cast-charge has no other event).
export const STAT_FIELDS = [
  "atk", "def", "speDef", "ap", "speed", "range", "critChance", "critPower",
  "luck", "maxHP", "maxPP", "hp", "pp", "shield"
] as const
export const STAT_LABEL: Record<string, string> = {
  atk: "ATK", def: "DEF", speDef: "Sp.DEF", ap: "AP", speed: "Speed",
  range: "Range", critChance: "Crit%", critPower: "Crit Pow", luck: "Luck",
  maxHP: "Max HP", maxPP: "Max PP", hp: "HP", pp: "PP", shield: "Shield"
}
// camelCase status field → readable label ("armorReduction" → "Armor Reduction"; poisonStacks inline).
export const statusName = (k: string): string => {
  const s = k.replace(/([a-z])([A-Z])/g, "$1 $2")
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// One entity's last-seen status/stat values — the diff baseline. The caller stores it keyed by entity
// (the POV path resets the map on a new simulation; the worker keys by `${simId}:${id}` across sims).
export interface EntitySnap {
  status: Record<string, unknown>
  stats: Record<string, number>
}

// A status/stat change row. Structurally a subset of ReplayEvent (type ⊂ ReplayEventType, key always
// set) so it pushes straight into the index's actions[] without a conversion.
export interface CombatScanEvent {
  t: number
  type: "status" | "stat"
  label: string
  uid?: string
  key: string
}

// A push-only sink for the scan output. Typed as a sink (not CombatScanEvent[]) so callers can collect
// straight into a wider ReplayEvent[] — a CombatScanEvent IS a ReplayEvent, and the contravariant push
// makes the wider array assignable, no cast needed at the call site.
type CombatSink = { push: (e: CombatScanEvent) => void }

// Diff one combat entity vs its previous snapshot; push the status flips (false→true / poison ↑) and
// stat changes (tagged `ownerUid`) into `out`, and return the new snapshot for the caller to store.
// `name` is the already-prettified unit name. Logic is identical to the original inline POV scan.
export function scanCombatEntity(
  e: Record<string, unknown>,
  prev: EntitySnap | undefined,
  t: number,
  name: string,
  ownerUid: string | undefined,
  out: CombatSink
): EntitySnap {
  const st = e.status as Record<string, unknown> | undefined
  const statusSnap: Record<string, unknown> = {}
  for (const k of STATUS_FIELDS) {
    const cur = st?.[k]
    statusSnap[k] = cur
    const was = prev?.status?.[k]
    if (k === "poisonStacks") {
      if (typeof cur === "number" && cur > 0 && cur !== was)
        out.push({ t, type: "status", label: `${name} · Poisoned (${cur})`, uid: ownerUid, key: "Poison" })
    } else if (cur === true && was !== true) {
      out.push({ t, type: "status", label: `${name} · ${statusName(k)}`, uid: ownerUid, key: statusName(k) })
    }
  }
  const statsSnap: Record<string, number> = {}
  for (const k of STAT_FIELDS) {
    const cur = e[k]
    if (typeof cur !== "number") continue
    statsSnap[k] = cur
    const was = prev?.stats?.[k]
    if (was != null && cur !== was) {
      const d = cur - was
      out.push({ t, type: "stat", label: `${name} ${STAT_LABEL[k]} ${d > 0 ? "+" : ""}${d}`, uid: ownerUid, key: STAT_LABEL[k] })
    }
  }
  return { status: statusSnap, stats: statsSnap }
}

type TeamSchema = {
  forEach?: (cb: (e: Record<string, unknown>, id: string) => void) => void
}
type SimSchema = {
  bluePlayerId?: string
  redPlayerId?: string
  blueTeam?: TeamSchema
  redTeam?: TeamSchema
}
// The decoded GameState fields scanFrameCombat reads (loosely typed so this module stays game-import-free
// and bundles tiny). simulations + players are Colyseus MapSchemas (forEach / get).
export interface CombatFrameState {
  simulations?: { forEach?: (cb: (sim: SimSchema, id: string) => void) => void }
  players?: { get?: (uid: string) => { simulationId?: string } | undefined }
}

// Scan ONE decoded state frame: emit owner-tagged status/stat changes for every simulation's units,
// diffing against `prevBySim` (simId → entity id → snapshot; persists across frames — a new round's sim
// has a new id so it starts a fresh baseline). Owner-tag rule: a team's units belong to its side's
// player ONLY when that player's own simulationId points back to this sim. That drops (a) ghost teams —
// a ghost copies a player who is really fighting in a DIFFERENT sim, so their simulationId ≠ this one;
// their real combat comes from their own sim — and (b) PvE monsters, whose redPlayerId ("pve") matches
// no player. So each player's combat is attributed once, from the fight they are actually in. (Verified
// on real captures: every ghost team + PvE team excluded, zero double-scans.)
export function scanFrameCombat(
  state: CombatFrameState,
  prevBySim: Map<string, Map<string, EntitySnap>>,
  t: number,
  out: CombatSink
): void {
  const players = state.players
  state.simulations?.forEach?.((sim, simId) => {
    const blueOwner = sim.bluePlayerId
    const redOwner = sim.redPlayerId
    const blueValid = !!blueOwner && players?.get?.(blueOwner)?.simulationId === simId
    const redValid = !!redOwner && players?.get?.(redOwner)?.simulationId === simId
    if (!blueValid && !redValid) return
    let prev = prevBySim.get(simId)
    if (!prev) {
      prev = new Map<string, EntitySnap>()
      prevBySim.set(simId, prev)
    }
    const prevMap = prev
    const scanTeam = (team: TeamSchema | undefined, owner: string) => {
      team?.forEach?.((e, id) => {
        const nm = prettyName((e.name as string) ?? "")
        prevMap.set(id, scanCombatEntity(e, prevMap.get(id), t, nm, owner, out))
      })
    }
    if (blueValid) scanTeam(sim.blueTeam, blueOwner as string)
    if (redValid) scanTeam(sim.redTeam, redOwner as string)
  })
}
