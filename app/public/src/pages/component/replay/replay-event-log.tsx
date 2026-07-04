import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { type FrameInfo, formatMessageRow, formatReplayEvent, phaseWord, statLabel, statusLabel } from "../../../game/replay-event-format"
import { prettyName, type ReplayIndex } from "../../../game/replay-index"
import type { ReplayRoom } from "../../../game/replay-room"
import "./replay-event-log.css"

// Combat-event naming, grounded in the actual payloads:
//   ABILITY        → { id: simulationId, skill, positionX/Y (caster tile), targetX/Y (target tile) }
//   POKEMON_DAMAGE → { index: ATTACKER species, amount, type (AttackType), x/y: victim tile }
//   POKEMON_HEAL   → { index: HEALER  species, amount, type (HealType),  x/y: target tile }
// Damage/heal name the SOURCE from the species `index` (→ PkmByIndex) and the OTHER unit by tile (→
// resolved against the simulation positions, passed in as `names`). The ABILITY caster is resolved the
// same way; its targetX/Y is NOT used — broadcastAbility defaults it to the caster's attack-enemy, so it
// lies for self/ally effects, and the real target is the adjacent damage/heal row's anyway.

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
// Fallback dock (used only if the layout anchors below can't be measured): right edge ~6vw from the
// screen edge, top below the DPS meter. Drag/resize take over from here; both persist (localStorage).
const DEFAULT_TOP = "57vh"
const DEFAULT_RIGHT = "6vw"

// The default box fills the empty region to the RIGHT of the playback bar and ABOVE the shop, mirroring the
// gap the game leaves between the playback bar and the shop on all four sides: left → the playback control
// bar, right → the player-portrait column, top → the (unexpanded) battle-stats panel, bottom → the shop's
// level pill. Every anchor is stable across the match EXCEPT the battle stats (`.game-dps-meter`), which is
// FIGHT-only — in town its top falls back to a matching constant (~the same y, so the box barely moves). We
// read the collapsed battle-stats bottom; if a user has expanded it the box just opens a little lower. The
// gap is measured (shop.top − bar.bottom) so it tracks the game's responsive scaling; clamped for safety.
// Returns null until the stable anchors are on screen (→ the CSS fallback dock applies).
const clampGap = (v: number) => Math.max(4, Math.min(40, v))
function measureDefaultBox(): { left: number; top: number; width: number; height: number } | null {
  if (typeof document === "undefined") return null
  const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect()
  const players = rect("#game-players")
  const controls = rect(".replay-controls")
  const shop = rect(".game-pokemons-store")
  if (!players || !controls || !shop) return null
  const levelPill = rect(".game-experience > span") // the "Lvl N" pill on the shop bar
  const dps = rect(".game-dps-meter") // battle-stats panel — FIGHT-only
  const gap = clampGap(Math.round(shop.top - controls.bottom))
  const left = Math.round(controls.right + gap)
  const right = Math.round(players.left - gap)
  const top = Math.round(dps ? dps.bottom + gap : window.innerHeight * 0.11)
  const bottom = Math.round((levelPill ?? shop).top - gap)
  const width = Math.max(240, right - left)
  const height = Math.max(140, bottom - top)
  return { left, top, width, height }
}

// Toggleable event log for the replay viewer: lists the actual frames the replay is rebuilt from —
// the typed ROOM_DATA messages (abilities, damage, heals, income, eliminations, final rank…) plus the
// phase/stage transitions derived from the state stream — each stamped with the re-based mm:ss AND its
// frame index. Clicking a row seeks there; the row at the playhead is highlighted and auto-scrolled.
//
// Events are grouped into player-facing CATEGORIES (combat / economy / items / match-flow / synergy /
// flavor / positioning / engine), each with a filter chip in the header. Three are OFF by default
// because they're high-volume and bury the match "story": Combat (~92% of all rows — per-tick
// ability/damage/heal; toggle on to drill into a fight), Positioning (every unit move), and Engine
// (board/sim plumbing). The default view is the readable arc of the game — buys, rounds, synergies,
// items, eliminations. Filtering only hides rows — it never drops data from the recording — so the
// format's "downgradeable to an analysis log" property (FORMAT.md) is preserved.
//
// Purely additive + replay-only (rendered only by the /replay page), reading the manifest frames the
// ReplayRoom already holds, plus the shared useDraggable hook the game's other windows use — no effect
// on live play. The panel is draggable (by its header) and resizable (CSS resize handle).

type Category = "combat" | "economy" | "items" | "flow" | "synergy" | "flavor" | "positioning" | "engine" | "status" | "stats"

// Server→client message type → category. The full set was traced from the game source (every
// broadcast / client.send / broadcastToSpectators reachable inside a game room). Unmapped types fall
// back to "engine" so an unexpected frame is hidden-but-available rather than mis-bucketed.
const CATEGORY_OF: Record<string, Category> = {
  // combat — what happened in the fight
  ABILITY: "combat",
  POKEMON_DAMAGE: "combat",
  POKEMON_HEAL: "combat",
  DISPLAY_TEXT: "combat",
  // economy — gold gained, life lost
  PLAYER_INCOME: "economy",
  PLAYER_DAMAGE: "economy",
  // match flow — the milestones (derived PHASE/ELIMINATION are tagged "flow" directly below)
  FINAL_RANK: "flow",
  GAME_END: "flow",
  LOADING_COMPLETE: "flow",
  // synergy effects — Ground (DIG) and Gourmet (COOK)
  DIG: "synergy",
  COOK: "synergy",
  // flavor — cosmetic chatter
  SHOW_EMOTE: "flavor",
  NPC_DIALOG: "flavor",
  // board effect — a tile hazard/field appeared in a fight; owner-tagged per board via simTileOwner in
  // replay-index (ghost/PvE sides hidden), so it rides the Combat chip under the owning player, not its own.
  BOARD_EVENT: "combat",
  // engine / internal — board-sim bookkeeping + renderer setup + rare system/error frames (off by default)
  CLEAR_BOARD_EVENT: "engine", // the paired "expired/cleared" firehose (480–2309/game) — stays engine
  CLEAR_BOARD: "engine",
  SIMULATION_STOP: "engine",
  PRELOAD_MAPS: "engine",
  DRAG_DROP_CANCEL: "engine",
  ALERT: "engine",
  RECONNECT_PROMPT: "engine"
}

// Display order for the filter chips; the visible label is t(`replay.eventlog.cat.<key>`) at render.
const CAT_ORDER: Category[] = [
  "combat",
  "status",
  "stats",
  "economy",
  "items",
  "flow",
  "synergy",
  "flavor",
  "positioning",
  "engine"
]

// Chip label → i18n key. Four categories reuse existing game strings instead of replay.* duplicates;
// status/stats are folded into the Combat chip so only items/synergy actually render here, but mapping all
// four lets us drop the replay.eventlog.cat.{status,stats,items,synergy} keys. "Synergies" is the only
// existing key (no singular "Synergy").
const CAT_LABEL_KEY = {
  combat: "replay.eventlog.cat.combat",
  status: "status_label",
  stats: "stats",
  economy: "replay.eventlog.cat.economy",
  items: "wiki.nav.items_label",
  flow: "replay.eventlog.cat.flow",
  synergy: "synergies",
  flavor: "replay.eventlog.cat.flavor",
  positioning: "replay.eventlog.cat.positioning",
  engine: "replay.eventlog.cat.engine"
} as const satisfies Record<Category, string>

// The combat-family categories share one "Combat" chip — they're all combat, just from different sources
// (casts/damage are camera-scoped messages; status/stats are all-boards state). The chip toggles the three
// together; its drill-down breaks them out by source (the section labels below) and then by type.
const COMBAT_CATS: Category[] = ["combat", "status", "stats"]
// Combat message types → t() sub-keys for the drill-down chip labels (resolved as
// t(`replay.eventlog.sub.<key>`); types not listed here fall back to prettyName(type)). The value is a
// literal union (not `string`) so the template-literal key stays a known i18n key for the typed `t`.
type CombatSubKey = "casts" | "damage" | "heals" | "text" | "board_effects" | "weather"
const COMBAT_SUBKEY: Record<string, CombatSubKey> = {
  ABILITY: "casts",
  POKEMON_DAMAGE: "damage",
  POKEMON_HEAL: "heals",
  DISPLAY_TEXT: "text",
  BOARD_EVENT: "board_effects",
  WEATHER: "weather"
}
// Sub-chip label → i18n key. "Ability" / "Weather" reuse existing game strings (already translated) instead
// of replay.* duplicates, matching the CAT_LABEL_KEY approach; the rest keep replay keys.
const SUB_LABEL_KEY = {
  casts: "wiki.pokemons.ability_label",
  damage: "replay.eventlog.sub.damage",
  heals: "replay.eventlog.sub.heals",
  text: "replay.eventlog.sub.text",
  board_effects: "replay.eventlog.sub.board_effects",
  weather: "wiki.nav.weather_label"
} as const satisfies Record<CombatSubKey, string>
// Drill-down sections for the merged Combat chip. The source note honors the real distinction: casts/damage/
// heal/text are broadcastToSpectators (only the board the recorder was watching), while board effects,
// weather, status and stats are recovered for every board (owner-tagged). The `combat` category is split
// across the first two sections by sub-type (`only`); status/stats are their own categories. `labelKey` is
// resolved as t(`replay.eventlog.section.<labelKey>`) at render — a literal union so the key stays known.
type SectionKey = "casts_pov" | "board_weather" | "status_all" | "stats_all"
const COMBAT_SECTIONS: { cat: Category; labelKey: SectionKey; only?: string[] }[] = [
  { cat: "combat", labelKey: "casts_pov", only: ["ABILITY", "POKEMON_DAMAGE", "POKEMON_HEAL", "DISPLAY_TEXT"] },
  { cat: "combat", labelKey: "board_weather", only: ["BOARD_EVENT", "WEATHER"] },
  { cat: "status", labelKey: "status_all" },
  { cat: "stats", labelKey: "stats_all" }
]
// Section header → i18n key. "Status" / "Stats" reuse existing game strings; the two composite headers keep
// replay keys.
const SECTION_LABEL_KEY = {
  casts_pov: "replay.eventlog.section.casts_pov",
  board_weather: "replay.eventlog.section.board_weather",
  status_all: "status_label",
  stats_all: "stats"
} as const satisfies Record<SectionKey, string>

const DEFAULT_ON: Record<Category, boolean> = {
  combat: false, // ~92% of all rows (per-tick ability/damage/heal) — buries the match story; opt-in
  status: false, // combat status effects (burn/poison/freeze/…) — combat-volume, opt-in
  stats: false, // combat stat changes (atk/speed/ap/hp/…) — a firehose, opt-in
  economy: true,
  items: true,
  flow: true,
  synergy: true,
  flavor: true,
  positioning: false, // every unit move (deploy/bench/rearrange) — high-frequency, opt-in
  engine: false // high-frequency board/sim plumbing — opt-in
}

// Derived POV-action types (from replay-index) → category. Defaults to economy (shop/board management);
// items, synergy-driven bench gains, proposition picks, round results, and unit moves are routed explicitly.
const ACTION_CAT: Record<string, Category> = {
  pick: "flow",
  round: "flow",
  town: "flow",
  region: "flow",
  rule: "flow",
  scarf: "items",
  weather: "combat", // a fight property (any board's fight, owner-tagged) → grouped under Combat, not Synergy
  berries: "synergy",
  status: "status",
  stat: "stats",
  item: "items",
  craft: "items",
  equip: "items",
  unequip: "items",
  egg: "synergy",
  fish: "synergy",
  hatch: "synergy",
  synergy: "synergy",
  berry: "synergy",
  flower: "synergy",
  wanderer: "synergy",
  move: "positioning"
}

const FILTER_KEY = "replay.eventlog.filters"
const BOX_KEY = "replay.eventlog.box" // { x, y, w, h }

type SavedBox = { x?: number; y?: number; w?: number; h?: number }
// Read the persisted drag/size box fresh from localStorage. The size effect re-reads it (rather than a
// mount-time memo) so an in-session resize wins over the layout-measured default on the next reflow.
function readBox(): SavedBox {
  try {
    const b = JSON.parse(localStorage.getItem(BOX_KEY) || "null")
    if (b && typeof b === "object") return b as SavedBox
  } catch {
    /* ignore */
  }
  return {}
}

type LogEvent = {
  t: number // ms since first frame (absolute on the transcript clock)
  frame: number // frame index in the manifest (-1 for derived phase/elim events)
  type: string
  summary: string
  cat: Category
  kind: "msg" | "phase" | "elim" | "action" | "pick"
  // The player this event belongs to — the per-player filter slices on it. Owner-tagged: a player's
  // board/economy/combat-status/stats all carry their uid; uid-less rows are game-level milestones (phase
  // / elim / town / rule) and always show. Combat MESSAGES (cast/damage/heal/text) are camera-scoped
  // (broadcastToSpectators), so they carry the WATCHED board's uid at that frame (the recorder's camera) —
  // captured only for boards the camera visited (the single-POV gap), under whichever board was watched.
  uid?: string
  // Optional sub-type for the fine-grained filter (the stat field / status name); absent → the `type`
  // column IS the filterable granularity. `subKey()` below resolves the effective key either way.
  key?: string
}

// The fine-grained filter operates on a per-category sub-type: the explicit `key` (stat field / status
// name) when present, else the display `type` (ABILITY / BUY / …). Namespaced by category for the toggle set.
const subKey = (e: { key?: string; type: string }) => e.key ?? e.type
const subId = (cat: Category, sub: string) => `${cat}:${sub}`

const SUBOFF_KEY = "replay.eventlog.suboff" // sub-types explicitly turned off (within an enabled category)
const PLAYERON_KEY = "replay.eventlog.playeron" // players shown in the per-player filter (default: the POV only)

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

// Row CONTENT is now localized at render time by replay-event-format (formatMessageRow for the ROOM_DATA
// message rows; formatReplayEvent for the per-player / elimination / combat-scan rows). The index emits
// STRUCTURED descriptors instead of English labels, so word order + plurals live in the per-language
// `replay.eventlog.row.*` templates and game-data nouns route through the game's own locale keys. The two
// remaining English facets are intentional: the raw `type` column (a stable event-type tag, like a log
// level) and the non-combat sub-filter chip tokens (BUY / CRAFT / … — type identifiers, not prose).

function loadFilters(): Record<Category, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "null")
    if (saved && typeof saved === "object") return { ...DEFAULT_ON, ...saved }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_ON }
}

export default function ReplayEventLog({
  room,
  index,
  onSeek,
  open,
  onClose
}: {
  room: ReplayRoom
  index: ReplayIndex | null
  onSeek: (ms: number) => void
  // open/close are owned by the parent so the toggle can live in the playback control bar (where players
  // look for it) rather than as a stray fixed button. This component renders only the panel.
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const viewerUid = room.manifest.viewerUid
  const [enabled, setEnabled] = useState<Record<Category, boolean>>(loadFilters)
  // Fine-grained filter: sub-types explicitly turned off within their (still-enabled) category. Default
  // empty → an enabled category shows all its sub-types. `expanded` is which category's drill-down is open.
  const [subOff, setSubOff] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SUBOFF_KEY) || "[]")
      if (Array.isArray(saved)) return new Set<string>(saved)
    } catch {
      /* ignore */
    }
    return new Set<string>()
  })
  const [expanded, setExpanded] = useState<Category | null>(null)
  // Per-player filter: which players' events are shown. Defaults to the recording player only (the common
  // "review my own game" view); add opponents' chips to scout / compare. Stored as the ON set (the default
  // is small) so it survives a reload; applies to ALL categories — it focuses the whole timeline.
  const [playerOn, setPlayerOn] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PLAYERON_KEY) || "null")
      if (Array.isArray(saved)) return new Set<string>(saved)
    } catch {
      /* ignore */
    }
    return new Set<string>([viewerUid])
  })
  // Auto-follow the playhead (scroll the active row into view each tick). Off → the user can scroll the
  // log freely while playback continues in the background without being yanked back to the current event.
  // Re-enabling jumps back to the playhead. A manual wheel-scroll auto-unlocks (feels natural).
  const [follow, setFollow] = useState(true)
  const [, force] = useState(0)
  // Virtualized row list: render only the rows in (and just around) the scroll viewport. The firehose
  // categories (Stats ~15k, Combat ~5k) would otherwise mount tens of thousands of DOM nodes and hang the
  // tab. scrollTop + viewportH window the slice; rowH is the measured single-row height (spacers above/
  // below stand in for the off-screen rows so the scrollbar stays accurate).
  const [scrollTop, setScrollTop] = useState(0)
  const [rowH, setRowH] = useState(18)
  const [viewportH, setViewportH] = useState(400)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null) // scroll container; the active-row class is applied here imperatively
  // onSeek is recreated by the parent each render; hold it in a ref so the memoized row list (below) isn't
  // invalidated by its changing identity on every 200ms poll tick.
  const onSeekRef = useRef(onSeek)
  onSeekRef.current = onSeek
  // restore the saved box (drag position {x,y} + size {w,h}). Position drives the panel only once it's
  // been dragged; until then the default dock (via posStyle) applies. Size is applied imperatively so
  // the CSS resize handle stays the source of truth.
  const saved = useMemo<SavedBox>(() => readBox(), [])
  const [pos, setPos] = useState<{ x: number; y: number } | null>(
    saved.x != null && saved.y != null ? { x: saved.x, y: saved.y } : null
  )
  // The layout-measured default box. Supplies position AND/OR size per-dimension — whichever the user
  // hasn't overridden (a saved drag wins position, a saved resize wins size; see posStyle + the size
  // effect). Recomputed on open + window resize so it adapts. null → fallback dock. Skipped only when the
  // user has BOTH dragged and resized (it would never be used).
  const [autoBox, setAutoBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const fullyPlaced = saved.x != null && saved.w != null
  // Measure the default box SYNCHRONOUSLY before paint (useLayoutEffect, not a post-paint rAF): the HUD
  // anchors it reads (#game-players / .replay-controls / .game-dps-meter) are already laid out when the
  // panel mounts, so measuring here sets the box before the first paint — otherwise the panel paints once
  // at the fallback anchor and visibly jumps to the measured spot. Re-measures on window resize too.
  useLayoutEffect(() => {
    if (!open || fullyPlaced) return
    const measure = () => setAutoBox(measureDefaultBox())
    measure()
    window.addEventListener("resize", measure)
    return () => {
      window.removeEventListener("resize", measure)
    }
  }, [open, fullyPlaced])

  // Drag by the header (same hand-rolled pattern as the control bar — avoids the shared hook's
  // mount-time on-screen clamp, which mis-fires before the panel has laid out). Clicks on the chips /
  // close button don't start a drag. The new top-left is clamped on-screen and persisted on release.
  const onHeadDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, label, input")) return
    e.preventDefault()
    const rect = panelRef.current!.getBoundingClientRect()
    const dx = e.clientX - rect.left
    const dy = e.clientY - rect.top
    const { width, height } = rect
    const onMove = (ev: MouseEvent) =>
      setPos({
        x: clamp(ev.clientX - dx, 0, window.innerWidth - width),
        y: clamp(ev.clientY - dy, 0, window.innerHeight - height)
      })
    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      const r = panelRef.current?.getBoundingClientRect()
      if (r) {
        try {
          const b = JSON.parse(localStorage.getItem(BOX_KEY) || "{}")
          localStorage.setItem(BOX_KEY, JSON.stringify({ ...b, x: r.left, y: r.top }))
        } catch {
          /* ignore */
        }
      }
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  // poll the room clock only while the panel is open (keep the playhead cursor live)
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => force((n) => (n + 1) % 1e6), 200)
    return () => clearInterval(id)
  }, [open])

  // persist the filter selection
  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(enabled))
    } catch {
      /* ignore */
    }
  }, [enabled])

  // persist the per-sub-type off-set
  useEffect(() => {
    try {
      localStorage.setItem(SUBOFF_KEY, JSON.stringify([...subOff]))
    } catch {
      /* ignore */
    }
  }, [subOff])

  // persist the per-player on-set
  useEffect(() => {
    try {
      localStorage.setItem(PLAYERON_KEY, JSON.stringify([...playerOn]))
    } catch {
      /* ignore */
    }
  }, [playerOn])

  // Reconcile the persisted ON-set against THIS recording's roster. The set is stored under one global key
  // but keyed by per-recording uids (opponents — and the POV uid of a downloaded replay — differ every
  // game), so a stale selection from another replay would match no rows and never re-default. Prune to
  // players that exist here; an empty intersection falls back to the POV. Idempotent (re-runs settle once
  // every member is valid), so it can't loop.
  useEffect(() => {
    if (!index) return
    const roster = index.playerNames
    const pruned = [...playerOn].filter((u) => roster[u] !== undefined)
    if (pruned.length === playerOn.size) return
    // Fall back to the POV when the intersection is empty, but guard against a re-run loop: if the POV uid
    // itself isn't in this recording's roster (a truncated capture whose POV name never synced, or a foreign
    // file), Set([viewerUid]) would re-prune to empty every run → unbounded setState (white-screening the
    // route, since this panel renders outside the error boundary). Bail once the next set equals the current.
    const next = pruned.length ? new Set(pruned) : new Set<string>([viewerUid])
    if (next.size === playerOn.size && [...next].every((u) => playerOn.has(u))) return
    setPlayerOn(next)
  }, [index, viewerUid, playerOn])

  // restore the saved size + persist on resize. The CSS resize handle mutates the element directly;
  // a ResizeObserver writes the new size back so it survives a reload.
  useEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    // Re-read the box FRESH (not the mount-time `saved` memo): once the user resizes, the observer below
    // persists w/h, so a later window-resize re-run must apply THAT, not the layout-measured default —
    // otherwise autoBox would clobber the user's size and the observer would persist the default back.
    const box = readBox()
    // The user's saved size wins; otherwise apply the layout-measured default (so the panel fills the
    // right column). Width/height are set imperatively to keep the CSS resize handle the source of truth.
    if (box.w) el.style.width = `${box.w}px`
    else if (autoBox) el.style.width = `${autoBox.width}px`
    if (box.h) el.style.height = `${box.h}px`
    else if (autoBox) el.style.height = `${autoBox.height}px`
    // ResizeObserver.observe() delivers an INITIAL callback immediately. That first fire reflects the
    // programmatic size we just applied above (autoBox default or the restored box), NOT a user resize —
    // persisting it would freeze the default into localStorage as if dragged, after which readBox() wins over
    // the recomputed autoBox and the panel stops adapting to window resizes (and poisons fullyPlaced on later
    // mounts). So skip persistence on the first callback; still sync the viewport height on every fire.
    let initialFire = true
    const ro = new ResizeObserver(() => {
      // keep the virtualization viewport in sync with the live panel height, or a resize leaves the new
      // space below the last windowed row blank until something else re-measures (a filter toggle).
      const lh = listRef.current?.clientHeight
      if (lh) setViewportH(lh)
      if (initialFire) {
        initialFire = false
        return
      }
      try {
        const b = JSON.parse(localStorage.getItem(BOX_KEY) || "{}")
        localStorage.setItem(BOX_KEY, JSON.stringify({ ...b, w: el.offsetWidth, h: el.offsetHeight }))
      } catch {
        /* ignore */
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, autoBox])

  const playerNames = index?.playerNames ?? {}

  // Build the full event list once per recording: every message frame + phase/stage + elimination +
  // per-player action, each tagged with its category and the player it belongs to (uid).
  const events = useMemo<LogEvent[]>(() => {
    const out: LogEvent[] = []
    // DIG / COOK / SHOW_EMOTE are room-broadcast to every client, so the POV capture holds other players'
    // too; the index flags the non-POV ones (by the owning unit / emote uid) — hide them. Combat messages
    // (cast/damage/heal/text) are camera-scoped (broadcastToSpectators), so the index tags them with the
    // recorder's camera at that frame (`combatUnits[i].owner` = the watched board) — a fight watched by
    // scouting shows under THAT player, not the POV. Non-combat messages have no owner → the viewer uid.
    const foreign = new Set(index?.foreignFrames ?? [])
    room.manifest.frames.forEach((f, i) => {
      if (f.kind === "message" && !foreign.has(i)) {
        const type = String(f.type)
        const info: FrameInfo = { ...index?.combatUnits?.[i], dig: index?.digInfo?.[i], income: index?.incomeInfo?.[i] }
        out.push({ t: f.t, frame: i, type, summary: formatMessageRow(t, type, f.payload, info), cat: CATEGORY_OF[type] ?? "engine", kind: "msg", uid: info.owner ?? viewerUid })
      }
    })
    // Game-level milestones (phase / elimination) carry no uid → they always show.
    index?.segments.forEach((s) => out.push({ t: s.t, frame: -1, type: "PHASE", summary: t("replay.eventlog.row.phase", { stage: s.stage, phase: phaseWord(t, s.phaseLabel) }), cat: "flow", kind: "phase" }))
    index?.events.filter((e) => e.type === "elimination").forEach((e) => out.push({ t: e.t, frame: -1, type: "ELIMINATION", summary: formatReplayEvent(t, e), cat: "flow", kind: "elim" }))
    // Per-player actions → categories: shop/board management to Economy, synergy-driven gains to Synergy,
    // proposition picks to Match flow, combat status/stat to Status/Stats. The action's own uid carries the
    // owning player (uid-less = the game-level town/rule rows); the per-player filter slices on it.
    index?.actions.forEach((a) => out.push({ t: a.t, frame: -1, type: a.type.toUpperCase(), summary: formatReplayEvent(t, a), cat: ACTION_CAT[a.type] ?? "economy", kind: a.type === "pick" ? "pick" : "action", uid: a.uid, key: a.key }))
    return out.sort((a, b) => a.t - b.t || a.frame - b.frame)
    // Key on the stable manifest, not `room`: boot() makes a new ReplayRoom (new identity) on every seek,
    // but the manifest object is the same — depending on `room` rebuilt this whole list on each scrub.
  }, [room.manifest, index, viewerUid, t])

  // Sub-types present per category, projected through the per-player filter → drives the category chips
  // AND the per-category drill-down. Counting only rows visible under the current `playerOn` selection
  // (uid-less game-level rows always count) keeps a chip from showing when every row in that category
  // belongs to an unselected player (e.g. POV-only combat casts while a non-POV player is selected).
  const subtypesByCat = useMemo(() => {
    const m = new Map<Category, Set<string>>()
    for (const e of events) {
      if (!(e.uid == null || playerOn.has(e.uid))) continue
      if (!m.has(e.cat)) m.set(e.cat, new Set())
      m.get(e.cat)!.add(subKey(e))
    }
    return m
  }, [events, playerOn])

  // Player chip order for the per-player filter: the recording player first, then the rest alphabetically
  // by name. Built from the index's roster (every player that appeared, incl. eliminated).
  const playerOrder = useMemo(() => {
    const names = index?.playerNames ?? {}
    return Object.keys(names).sort((a, b) =>
      a === viewerUid ? -1 : b === viewerUid ? 1 : (names[a] || "").localeCompare(names[b] || "")
    )
  }, [index, viewerUid])
  // Show the player-name column only when more than one player is selected (the single-player default
  // doesn't need it). Drives the row layout + the panel's wide-column class.
  const multiPlayer = playerOn.size > 1

  const base = index?.gameStartMs ?? 0
  // Category + sub-type + per-player filter. A row shows when its category (and sub-type) is enabled and
  // either it's a uid-less game-level row (phase/elim/town/rule, always shown) or its owning player is
  // selected. Combat is owner-tagged in the index, so selecting a player shows that player's whole
  // timeline incl. their board's status/stats (cast/damage stay POV-only — the single-POV gap).
  const visible = useMemo(
    () =>
      events.filter(
        (e) =>
          enabled[e.cat] &&
          !subOff.has(subId(e.cat, subKey(e))) &&
          (e.uid == null || playerOn.has(e.uid))
      ),
    [events, enabled, subOff, playerOn]
  )

  // The visible row at the playhead: the last one with t <= currentMs.
  const cur = room.currentMs
  let activeIdx = -1
  for (let i = 0; i < visible.length; i++) {
    if (visible[i].t <= cur) activeIdx = i
    else break
  }

  // Virtualization window: the slice of `visible` to actually render, plus an overscan buffer. Only ~one
  // viewport of rows is ever in the DOM, so a 15k-row firehose category mounts ~50 nodes, not 15k.
  const OVERSCAN = 12
  const total = visible.length
  const startIdx = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const endIdx = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN)
  const windowRows = open ? visible.slice(startIdx, endIdx) : []

  // Measure the real row height + viewport once rows are on screen (and when the row shape changes — the
  // player-name column appears when >1 player is selected, but rows stay one line). Keeps the spacers
  // and scrollbar accurate.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    if (list.clientHeight) setViewportH(list.clientHeight)
    const firstRow = list.querySelector<HTMLElement>(".rel-row")
    if (firstRow && firstRow.offsetHeight > 0) setRowH(firstRow.offsetHeight)
  }, [open, multiPlayer, total])

  // Debug hook for the headless harnesses: the list is virtualized, so the DOM holds only a window of rows.
  // Expose the full filtered set (for counts / per-type samples) under ?debug; cleared on unmount.
  useEffect(() => {
    if (typeof window === "undefined" || !new URLSearchParams(window.location.search).has("debug")) return
    const w = window as unknown as { __eventLogRows?: LogEvent[] }
    w.__eventLogRows = visible
    return () => {
      delete w.__eventLogRows
    }
  }, [visible])

  // Follow the playhead: keep the active row in view by scrolling the container (the active row may not be
  // mounted, so we can't scrollIntoView it — compute its position from the index instead). A manual wheel
  // unlocks follow (onWheel below); programmatic scrollTop only fires `scroll`, so it won't unlock it.
  useEffect(() => {
    if (!open || !follow) return
    const list = listRef.current
    if (!list || activeIdx < 0) return
    const top = activeIdx * rowH
    if (top < list.scrollTop || top + rowH > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 2)
    }
  }, [activeIdx, open, follow, rowH])

  if (!open) return null
  const toggle = (k: Category) => setEnabled((e) => ({ ...e, [k]: !e[k] }))
  // One drill-down sub-type toggle (shared by the flat per-category list and the Combat sections). `label`
  // may differ from the stored `sub` key (e.g. ABILITY → "Casts"); the off-set is keyed by the raw sub.
  const renderSubchip = (cat: Category, sub: string, label: string) => {
    const id = subId(cat, sub)
    const on = !subOff.has(id)
    return (
      <button
        key={id}
        className={`rel-subchip${on ? " on" : ""}`}
        onClick={() =>
          setSubOff((s) => {
            const n = new Set(s)
            if (on) n.add(id)
            else n.delete(id)
            return n
          })
        }
      >
        {label}
      </button>
    )
  }
  // Position: the user's dragged spot wins; else the layout-measured default; else the fallback dock.
  const posStyle: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : autoBox
      ? { left: autoBox.left, top: autoBox.top }
      : { right: DEFAULT_RIGHT, top: DEFAULT_TOP }
  return (
    <div ref={panelRef} className={`replay-eventlog my-container${multiPlayer ? " multi-player" : ""}`} style={posStyle}>
      <header className="rel-head" onMouseDown={onHeadDown}>
        <span className="rel-title">{t("replay.eventlog.title")}</span>
        <span className="rel-count">
          {visible.length} / {events.length}
        </span>
        <button
          className={`rel-follow${!follow ? " on" : ""}`}
          onClick={() => setFollow((f) => !f)}
        >
          {t("replay.eventlog.free_scroll")}
        </button>
        <button className="rel-close" title={t("close")} onClick={onClose}>×</button>
      </header>
      <div className="rel-filters">
        {/* The merged Combat chip (casts/damage + status + stats); toggles all three together, drill-down
            below splits them by source then type. Only shown if the recording has any combat events. */}
        {COMBAT_CATS.some((c) => subtypesByCat.has(c)) &&
          (() => {
            const anyOn = COMBAT_CATS.some((c) => enabled[c])
            return (
              <span className="rel-chip-wrap has-caret">
                <button
                  className={`rel-chip rel-chip-combat${anyOn ? " on" : ""}`}
                  onClick={() => setEnabled((e) => {
                    const v = !COMBAT_CATS.some((c) => e[c])
                    return { ...e, combat: v, status: v, stats: v }
                  })}
                >
                  {t("replay.eventlog.cat.combat")}
                </button>
                <button
                  className={`rel-caret${expanded === "combat" ? " open" : ""}`}
                  onClick={() => setExpanded((x) => (x === "combat" ? null : "combat"))}
                >
                  ▾
                </button>
              </span>
            )
          })()}
        {/* The other categories — one chip each, only when the recording has events of that category (same
            data-driven rule as the drill-down, so no empty chip filters to nothing). */}
        {CAT_ORDER.filter((key) => !COMBAT_CATS.includes(key) && subtypesByCat.has(key)).map((key) => {
          const drillable = (subtypesByCat.get(key)?.size ?? 0) > 1
          const label = t(CAT_LABEL_KEY[key])
          return (
            <span key={key} className={`rel-chip-wrap${drillable ? " has-caret" : ""}`}>
              <button
                className={`rel-chip rel-chip-${key}${enabled[key] ? " on" : ""}`}
                onClick={() => toggle(key)}
              >
                {label}
              </button>
              {drillable && (
                <button
                  className={`rel-caret${expanded === key ? " open" : ""}`}
                  onClick={() => setExpanded((x) => (x === key ? null : key))}
                >
                  ▾
                </button>
              )}
            </span>
          )
        })}
      </div>
      {expanded && (
        // Per-type drill-down: toggle individual sub-types without losing the rest. Data-driven from the
        // recording; takes effect when the parent category is enabled; sub-types ON unless in the off-set.
        // The merged Combat chip drills into three labeled sections (casts/damage · status · stats) so the
        // different sources read clearly; every other category is a flat list of its types.
        <div className="rel-subfilters">
          {expanded === "combat"
            ? COMBAT_SECTIONS.map((sec) => {
                let subs = [...(subtypesByCat.get(sec.cat) ?? [])].sort()
                const only = sec.only
                if (only) subs = subs.filter((s) => only.includes(s))
                if (!subs.length) return null
                return (
                  <Fragment key={sec.labelKey}>
                    <span className="rel-subhead">{t(SECTION_LABEL_KEY[sec.labelKey])}</span>
                    {subs.map((sub) =>
                      renderSubchip(
                        sec.cat,
                        sub,
                        // status/stats sub-keys are stable field names (burn / speed) → localized chip
                        // label; combat-message sub-keys use the replay.* sub-key (else prettyName).
                        sec.cat === "status"
                          ? statusLabel(t, sub)
                          : sec.cat === "stats"
                            ? statLabel(t, sub)
                            : COMBAT_SUBKEY[sub]
                              ? t(SUB_LABEL_KEY[COMBAT_SUBKEY[sub]])
                              : prettyName(sub)
                      )
                    )}
                  </Fragment>
                )
              })
            : [...(subtypesByCat.get(expanded) ?? [])].sort().map((sub) => renderSubchip(expanded, sub, sub))}
        </div>
      )}
      {playerOrder.length > 0 && (
        // Per-player filter: focus the whole timeline on one or more players. Defaults to the recording
        // player; add opponents to scout/compare. Combat status/stats are owner-tagged, so a player's chip
        // surfaces their board's fight too (cast/damage stay POV-only — the single-POV capture gap).
        <div className="rel-players">
          {playerOrder.map((uid) => {
            const on = playerOn.has(uid)
            return (
              <button
                key={uid}
                className={`rel-pchip${on ? " on" : ""}${uid === viewerUid ? " pov" : ""}`}
                onClick={() =>
                  setPlayerOn((s) => {
                    const n = new Set(s)
                    if (on) n.delete(uid)
                    else n.add(uid)
                    return n
                  })
                }
              >
                {playerNames[uid] || uid}
              </button>
            )
          })}
        </div>
      )}
      <div
        className="rel-list"
        ref={listRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onWheel={() => follow && setFollow(false)}
      >
        {/* full-height sizer establishes the scrollbar; only the windowed rows are mounted, each absolutely
            positioned at its index so off-screen rows cost nothing. */}
        <div className="rel-sizer" style={{ height: total * rowH }}>
          {windowRows.map((e, k) => {
            const i = startIdx + k
            return (
              <div
                key={`${e.frame}:${e.t}:${i}`}
                data-i={i}
                className={`rel-row rel-${e.kind} rel-cat-${e.cat}${i === activeIdx ? " active" : ""}`}
                style={{ top: i * rowH }}
                onClick={() => onSeekRef.current(e.t)}
              >
                <span className="rel-t">{fmt(e.t - base)}</span>
                {multiPlayer ? (
                  // the player this event belongs to (uid-less game-level rows show blank)
                  <span className="rel-player" title={e.uid ? playerNames[e.uid] : ""}>{e.uid ? playerNames[e.uid] ?? "" : ""}</span>
                ) : (
                  <span className="rel-frame">{e.frame >= 0 ? `#${e.frame}` : "·"}</span>
                )}
                <span className="rel-type">{e.type}</span>
                <span className="rel-sum">{e.summary}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
