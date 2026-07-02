// Render-time localization of the event log's ROW CONTENT. The index (replay-index.ts) and the combat
// scan (replay-combat-scan.ts) no longer build English label strings — they emit STRUCTURED descriptors
// ({ type, a, key }) carrying raw game-data values (enum names) + numbers. This module turns a descriptor
// into a localized line at render time, the same shape as the build-skew refactor (detectBuildSkew →
// { kind, ...params }): word order + plurals live in the per-language `replay.eventlog.row.*` templates,
// not in code, and game-data nouns route through the game's OWN locale keys (pkm.* / ability.* / item.* /
// map.* / weather.* / synergy.* / status.* / stat.* / effect.* / damage.*), which already ship in every
// community language. So a French viewer sees "Dracaufeu", a translator controls "Beat {{opponent}}" word
// order, and a submodule bump needs no new strings for the nouns.
//
// The one i18n ceiling we share with the rest of the PAC UI: game nouns are fixed translated strings
// dropped into templates, so deep morphological agreement (case/gender declension of the noun by its role)
// isn't expressible — same limit every `t(`pkm.${x}`)` in the app has. For terse analysis-log lines that's
// a minor readability nit, not a correctness gap.
import type { TFunction } from "i18next"
import { PkmByIndex } from "../../../types/enum/Pokemon"
import { prettyName, statusName } from "./replay-combat-scan"

// A picked proposition option: the constituent pokemon (a duo expands to two) and/or an item. Pokemon
// propositions carry pkms (+ an optional item shown in parens); item propositions carry just item.
export type PickOption = { pkms?: string[]; item?: string }

// The structured params an event carries instead of a pre-built English label. Loose by design — the
// formatter's per-type case is the single authority on each type's shape (an exhaustive discriminated
// union across ~30 types would bloat the producers for no real safety the formatter + harnesses don't
// already give). Values are raw enum names (localized here), numbers, or the pick options.
export type ReplayEventArgs = {
  [k: string]: string | number | boolean | string[] | PickOption[] | undefined
}

// Game-data namespaces are keyed by enum VALUES resolved at runtime (they always exist), and a dynamic
// `t(`pkm.${v}`)` with a plain-string `v` would widen to `${string}` and fail the typed `t`. Route those
// through this deliberate escape hatch; the static `replay.eventlog.*` template keys below still use the
// typed `t` directly, so THOSE stay compile-checked.
type TD = (key: string, opts?: Record<string, unknown>) => string
const td = (t: TFunction): TD => t as unknown as TD

export const pkmName = (t: TFunction, v: string): string => td(t)(`pkm.${v}`)
export const abilityName = (t: TFunction, v: string): string => td(t)(`ability.${v}`)
export const itemName = (t: TFunction, v: string): string => td(t)(`item.${v}`)
export const mapName = (t: TFunction, v: string): string => td(t)(`map.${v}`, { defaultValue: prettyName(v) })
export const synergyName = (t: TFunction, v: string): string => td(t)(`synergy.${v}`)
export const weatherLabel = (t: TFunction, v: string): string => td(t)(`weather.${v}`)
const effectLabel = (t: TFunction, v: string): string => td(t)(`effect.${v}`, { defaultValue: prettyName(v) })
// AttackType: PHYSICAL=0, SPECIAL=1, TRUE=2 (app/types/enum/Game.ts) → damage.* ("physical damage", …).
const DMG_TYPE_KEY = ["PHYSICAL", "SPECIAL", "TRUE"]
const damageType = (t: TFunction, n: number | undefined): string =>
  td(t)(`damage.${DMG_TYPE_KEY[n ?? 0] ?? "PHYSICAL"}`)

// camelCase status field → the game's status.* enum key. The enum NAMES diverge from the field names
// (armorReduction → ARMOR_BREAK, poisonStacks → POISONNED, enraged → RAGE, charm → "Infatuation"), and
// ~11 internal/combat flags (resurrecting, spikeArmor, magicBounce, reflect, light, the curse sub-flags,
// skydiving, tree) have NO locale key at all → they fall back to the derived English statusName(). Only
// fields present here localize; the rest are obscure flags in the default-off Status firehose.
const STATUS_LOCALE_KEY: Record<string, string> = {
  burn: "BURN", silence: "SILENCE", fatigue: "FATIGUE", poisonStacks: "POISONNED",
  freeze: "FREEZE", protect: "PROTECT", sleep: "SLEEP", confusion: "CONFUSION",
  wound: "WOUND", resurrection: "RESURRECTION", paralysis: "PARALYSIS", pokerus: "POKERUS",
  possessed: "POSSESSED", locked: "LOCKED", blinded: "BLINDED", armorReduction: "ARMOR_BREAK",
  runeProtect: "RUNE_PROTECT", charm: "CHARM", flinch: "FLINCH", electricField: "ELECTRIC_FIELD",
  psychicField: "PSYCHIC_FIELD", grassField: "GRASS_FIELD", fairyField: "FAIRY_FIELD",
  curse: "CURSE", enraged: "RAGE"
}
// camelCase stat field → the game's stat.* enum key. maxHP has no stat.* key (only HP / MAX_PP exist) →
// derived-English fallback; everything else localizes to the game's canonical (full-word) stat names.
const STAT_LOCALE_KEY: Record<string, string> = {
  atk: "ATK", def: "DEF", speDef: "SPE_DEF", ap: "AP", speed: "SPEED", range: "RANGE",
  critChance: "CRIT_CHANCE", critPower: "CRIT_POWER", luck: "LUCK", maxPP: "MAX_PP",
  hp: "HP", pp: "PP", shield: "SHIELD"
}

// Localized label for a status / stat field — also used by the event-log sub-filter chips (so the chip
// reads in the viewer's language while the stored sub-type token stays the stable field name).
export const statusLabel = (t: TFunction, field: string): string => {
  const k = STATUS_LOCALE_KEY[field]
  return k ? td(t)(`status.${k}`) : statusName(field)
}
export const statLabel = (t: TFunction, field: string): string => {
  const k = STAT_LOCALE_KEY[field]
  return k ? td(t)(`stat.${k}`) : field === "maxHP" ? "Max HP" : prettyName(field)
}

// Phase token (PICK / FIGHT / TOWN, from the index segments) → localized word for the "Stage N · Phase"
// row. Unknown values pass through (defensive; the enum is stable).
const PHASE_KEY: Record<string, "pick" | "fight" | "town"> = { PICK: "pick", FIGHT: "fight", TOWN: "town" }
export const phaseWord = (t: TFunction, label: string): string => {
  const k = PHASE_KEY[label]
  return k ? t(`replay.eventlog.phase.${k}`) : label
}

// Signed gold delta with the in-game "g" unit, e.g. "+2g" / "-3g". (The unit stays "g" across locales —
// it's the game's universal gold glyph; word order around it lives in the template.)
const goldStr = (n: number): string => `${n > 0 ? "+" : ""}${n}g`

// One picked option → its display string. Pokemon option: "Pkm (+ Pkm) (Item)"; item-only option: "Item".
const pickOption = (t: TFunction, o: PickOption): string => {
  if (o.pkms && o.pkms.length) {
    const base = o.pkms.map((p) => pkmName(t, p)).join(" + ")
    return o.item ? `${base} (${itemName(t, o.item)})` : base
  }
  return o.item ? itemName(t, o.item) : ""
}

// Localize a structured per-player / elimination / combat-scan event (everything that used to be a
// pre-built `label` in the index). The `info`-driven message rows go through formatMessageRow below.
export function formatReplayEvent(t: TFunction, ev: { type: string; a?: ReplayEventArgs; key?: string }): string {
  const a = ev.a ?? {}
  const R = "replay.eventlog.row"
  switch (ev.type) {
    case "elimination": return t(`${R}.elimination`, { player: String(a.player ?? "") })
    case "round": {
      // PvE opponents (a.isPvE) are themselves locale keys ("pkm.MAGIKARP" / "tower_duo" / …) → t()
      // resolves them; PvP opponents are the player's display name, used verbatim. A shiny PvE encounter
      // (Celebi / Shiny Hunter) wraps the name. result is a stable "win"/"loss"/"draw" token from the index.
      const opp = a.isPvE ? td(t)(String(a.opponent)) : String(a.opponent || "opponent")
      const opponent = a.isPvE && a.shiny ? t(`${R}.shiny_opponent`, { opponent: opp }) : opp
      return a.result === "win"
        ? t(`${R}.round_win`, { opponent })
        : a.result === "loss"
          ? t(`${R}.round_loss`, { opponent })
          : t(`${R}.round_draw`, { opponent })
    }
    case "region": return t(`${R}.region`, { region: mapName(t, String(a.map)) })
    case "artifact": return t(`${R}.artifact`, { item: itemName(t, String(a.item)) })
    case "hatch": return t(`${R}.hatch`, { pkm: pkmName(t, String(a.pkm)) })
    case "evolve": return t(`${R}.evolve`, { from: pkmName(t, String(a.from)), to: pkmName(t, String(a.to)) })
    case "buy":
      return a.gold != null
        ? t(`${R}.buy_gold`, { pkm: pkmName(t, String(a.pkm)), gold: goldStr(Number(a.gold)) })
        : pkmName(t, String(a.pkm))
    case "remove": return pkmName(t, String(a.pkm))
    case "sell":
      return a.gold != null
        ? t(`${R}.sell_gold`, { pkm: pkmName(t, String(a.pkm)), gold: goldStr(Number(a.gold)) })
        : pkmName(t, String(a.pkm))
    case "reroll":
      return a.gold != null ? t(`${R}.reroll`, { gold: goldStr(Number(a.gold)) }) : t(`${R}.shop_refresh`)
    case "xp": return t(`${R}.xp`, { amount: Number(a.amount), gold: goldStr(Number(a.gold)) })
    case "egg":
      return a.pkm
        ? a.golden
          ? t(`${R}.egg_golden`, { pkm: pkmName(t, String(a.pkm)) })
          : t(`${R}.egg_named`, { pkm: pkmName(t, String(a.pkm)) })
        : t(`${R}.egg`)
    case "fish": return t(`${R}.fish`, { pkm: pkmName(t, String(a.pkm)) })
    case "gained": return t(`${R}.gained`, { pkm: pkmName(t, String(a.pkm)) })
    case "item": return t(`${R}.got_item`, { item: itemName(t, String(a.item)) })
    case "equip": return t(`${R}.equip`, { item: itemName(t, String(a.item)), unit: pkmName(t, String(a.unit)) })
    case "unequip": return t(`${R}.unequip`, { item: itemName(t, String(a.item)), unit: pkmName(t, String(a.unit)) })
    case "craft": {
      const c0 = itemName(t, String(a.c0))
      const c1 = itemName(t, String(a.c1))
      const result = itemName(t, String(a.result))
      return a.unit != null
        ? t(`${R}.craft_on`, { c0, c1, result, unit: pkmName(t, String(a.unit)) })
        : t(`${R}.craft`, { c0, c1, result })
    }
    case "move": return t(`${R}.move`, { pkm: pkmName(t, String(a.pkm)), x: Number(a.x), y: Number(a.y) })
    case "level": return t(`${R}.level`, { level: Number(a.level) })
    case "synergy": return t(`${R}.synergy`, { synergy: synergyName(t, String(a.synergy)), count: Number(a.count) })
    case "berry": return t(`${R}.berry_ripe`, { berry: itemName(t, String(a.berry)) })
    case "berries": {
      const list = (a.list as string[] | undefined) ?? []
      return t(`${R}.berry_trees`, { list: list.map((b) => itemName(t, b)).join(", ") })
    }
    case "flower": return t(`${R}.flower`, { flower: pkmName(t, String(a.flower)) })
    case "wanderer": return t(`${R}.wanderer`, { pkm: pkmName(t, String(a.pkm)) })
    case "pick": {
      const options = (a.options as PickOption[] | undefined) ?? []
      const idx = Number(a.chosenIdx ?? 0)
      const chosen = pickOption(t, options[idx] ?? {})
      const alts = options.filter((_, i) => i !== idx).map((o) => pickOption(t, o))
      return alts.length ? t(`${R}.pick_over`, { chosen, alternatives: alts.join(", ") }) : t(`${R}.pick`, { chosen })
    }
    case "town": return t(`${R}.town`, { npc: prettyName(String(a.npc)) })
    case "rule": return t(`${R}.rule`, { rule: prettyName(String(a.rule)) })
    case "weather": return t(`${R}.weather`, { weather: weatherLabel(t, String(a.weather)) })
    case "status":
      return a.field === "poisonStacks"
        ? t(`${R}.status_poison`, { unit: pkmName(t, String(a.unit)), count: Number(a.count) })
        : t(`${R}.status`, { unit: pkmName(t, String(a.unit)), status: statusLabel(t, String(a.field)) })
    case "stat": {
      const d = Number(a.delta)
      return t(`${R}.stat`, { unit: pkmName(t, String(a.unit)), stat: statLabel(t, String(a.field)), delta: `${d > 0 ? "+" : ""}${d}` })
    }
    default: return ""
  }
}

// Render-time info threaded from the index for a message row: the combat caster/target unit NAMES (pkm
// enum values, resolved by tile against the decoded sim), the recorder's camera owner (ignored here), and
// the dig-site / income breakdowns the index pre-derived from POV state.
export type FrameInfo = {
  caster?: string
  target?: string
  owner?: string
  dig?: { x: number; y: number; depth: number }
  income?: { base: number; interest: number; streak: number }
}

// Localize a ROOM_DATA message frame (the camera-scoped combat rows + the POV economy/flavor messages).
// Replaces the old summarize(): same grounding in the real payload shapes, but every noun routes through
// the game locale and every sentence through a `replay.eventlog.row.*` template. Defensive — an unknown /
// malformed payload yields "" (hidden-but-available), never throws.
export function formatMessageRow(t: TFunction, type: string, payload: unknown, info?: FrameInfo): string {
  const p = payload as Record<string, unknown> | number | null
  const R = "replay.eventlog.row"
  try {
    switch (type) {
      case "ABILITY": {
        // Caster + skill only: broadcastAbility defaults targetX/Y to the caster's attack-enemy, so a
        // self/ally effect would mis-render "→ enemy"; the real target is the adjacent damage/heal row's.
        const o = p as { skill?: string; positionX?: number; positionY?: number }
        const skill = abilityName(t, String(o?.skill))
        if (info?.caster) return t(`${R}.cast`, { caster: pkmName(t, info.caster), skill })
        // No resolved caster: a caster-less / team-wide cast (e.g. TIDAL_WAVE's (0,0) sentinel) has no
        // meaningful tile — render the skill alone rather than a fabricated "at (0,0)".
        if (o?.positionX == null || (o.positionX === 0 && o.positionY === 0)) return skill
        return t(`${R}.cast_at`, { skill, x: o.positionX, y: o.positionY })
      }
      case "POKEMON_DAMAGE": {
        const o = p as { index?: string; amount?: number; type?: number; x?: number; y?: number }
        const src = o?.index ? pkmName(t, PkmByIndex[o.index]) : "?"
        const target = info?.target ? pkmName(t, info.target) : `(${o?.x},${o?.y})`
        return t(`${R}.dmg`, { src, amount: o?.amount ?? "?", type: damageType(t, o?.type), target })
      }
      case "POKEMON_HEAL": {
        const o = p as { index?: string; amount?: number; type?: number; x?: number; y?: number }
        const src = o?.index ? pkmName(t, PkmByIndex[o.index]) : "?"
        const target = info?.target ? pkmName(t, info.target) : `(${o?.x},${o?.y})`
        return o?.type === 0
          ? t(`${R}.heal_shield`, { src, amount: o?.amount ?? "?", target })
          : t(`${R}.heal`, { src, amount: o?.amount ?? "?", target })
      }
      case "BOARD_EVENT": {
        const o = p as { effect?: string; x?: number; y?: number }
        return t(`${R}.board_effect`, { effect: effectLabel(t, String(o?.effect)), x: o?.x, y: o?.y })
      }
      case "DISPLAY_TEXT": {
        // DisplayText is either `ability.<ABILITY>` (a big cast, e.g. Mimic/Metronome copies) or a
        // snake_case status key ("belly_full", "full"…) — both are valid locale keys → t() resolves them;
        // an unknown value falls back to the derived English.
        const o = p as { text?: string }
        const text = String(o?.text ?? "")
        return td(t)(text, { defaultValue: prettyName(text.replace(/^ability\./, "")) })
      }
      case "PLAYER_DAMAGE": {
        const n = typeof p === "number" ? p : (p as { value?: number })?.value ?? 0
        return t(`${R}.life_lost`, { count: n })
      }
      case "PLAYER_INCOME": {
        const total = typeof p === "number" ? p : (p as { value?: number })?.value
        if (total == null) return t(`${R}.income_plain`, { total: "?" })
        const b = info?.income
        if (b) {
          const parts = [t(`${R}.income_base`, { n: b.base })]
          if (b.interest) parts.push(t(`${R}.income_interest`, { n: b.interest }))
          if (b.streak) parts.push(t(`${R}.income_streak`, { n: b.streak }))
          return t(`${R}.income`, { total, parts: parts.join(" + ") })
        }
        return t(`${R}.income_plain`, { total })
      }
      case "FINAL_RANK": return t(`${R}.placed`, { rank: typeof p === "number" ? p : (p as { value?: number })?.value ?? "?" })
      case "PRELOAD_MAPS": return Array.isArray(payload) ? t(`${R}.region_maps`, { count: payload.length }) : ""
      case "LOADING_COMPLETE": return t(`${R}.game_start`)
      case "GAME_END": return t(`${R}.game_over`)
      case "COOK": {
        const o = p as { dishes?: string[] }
        return Array.isArray(o?.dishes) && o.dishes.length
          ? t(`${R}.cooked`, { dishes: o.dishes.map((d) => itemName(t, d)).join(", ") })
          : t(`${R}.cooked_dish`)
      }
      case "DIG": {
        const o = p as { buriedItem?: string | null }
        const d = info?.dig
        const item = o?.buriedItem ? itemName(t, o.buriedItem) : ""
        if (d) return o?.buriedItem ? t(`${R}.dug_found`, { x: d.x, y: d.y, depth: d.depth, item }) : t(`${R}.dug`, { x: d.x, y: d.y, depth: d.depth })
        return o?.buriedItem ? t(`${R}.dug_up`, { item }) : t(`${R}.dug_hole`)
      }
      case "NPC_DIALOG": {
        const o = p as { npc?: string; dialog?: string }
        return t(`${R}.npc_dialog`, { npc: prettyName(String(o?.npc)), dialog: o?.dialog ?? "" }).trim()
      }
      case "SHOW_EMOTE": return t(`${R}.emote`)
      default: return ""
    }
  } catch {
    return ""
  }
}
