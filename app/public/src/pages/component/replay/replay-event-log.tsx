import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { PkmByIndex } from "../../../../../types/enum/Pokemon"
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

// The default box is measured from the live game layout so the log fills the right-hand column: vertically
// between the (minimized) battle-stats pane and the playback controls, horizontally between the board and
// the player portraits. The DPS meter already sits right of the board, so its LEFT edge is our left anchor;
// `#game-players` (the portrait column) is the right anchor; `.replay-controls` (the bar) is the bottom.
// GAP ≈ the breathing room the game leaves between the controls and the shop. Returns null if the anchors
// aren't on screen yet (→ the fallback dock applies until they are).
const GAP = 8
function measureDefaultBox(): { left: number; top: number; width: number; height: number } | null {
  if (typeof document === "undefined") return null
  // Right + bottom anchors are always on screen; require them. The battle-stats pane is FIGHT-only, so
  // it's optional — when it's up we align the top/left to it; otherwise we fall back to a right-column box.
  const players = document.querySelector("#game-players")?.getBoundingClientRect()
  const bar = document.querySelector(".replay-controls")?.getBoundingClientRect()
  if (!players || !bar) return null
  const dps = document.querySelector(".game-dps-meter")?.getBoundingClientRect()
  const rightEdge = players.left - GAP
  const left = dps ? Math.round(dps.left) : Math.round(rightEdge - 360)
  const top = dps ? Math.round(dps.bottom + GAP) : Math.round(window.innerHeight * 0.12)
  const width = Math.max(240, Math.round(rightEdge - left))
  const height = Math.max(140, Math.round(bar.top - GAP - top))
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
  // board effect — a tile hazard/field appeared in the POV's fight (POV-scoped in replay-index); a combat
  // event, so it rides the Combat chip rather than its own.
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

// Display order + labels for the filter chips. Blake owns the final copy/visual pass.
const CATEGORIES: { key: Category; label: string }[] = [
  { key: "combat", label: "Combat" },
  { key: "status", label: "Status" },
  { key: "stats", label: "Stats" },
  { key: "economy", label: "Economy" },
  { key: "items", label: "Items" },
  { key: "flow", label: "Match flow" },
  { key: "synergy", label: "Synergy" },
  { key: "flavor", label: "Flavor" },
  { key: "positioning", label: "Positioning" },
  { key: "engine", label: "Engine" }
]

// The combat-family categories share one "Combat" chip — they're all combat, just from different sources
// (casts/damage are camera-scoped messages; status/stats are all-boards state). The chip toggles the three
// together; its drill-down breaks them out by source (the section labels below) and then by type.
const COMBAT_CATS: Category[] = ["combat", "status", "stats"]
// Combat message types → readable group labels for the drill-down (status/stats already have readable keys).
const COMBAT_SUBLABEL: Record<string, string> = {
  ABILITY: "Casts",
  POKEMON_DAMAGE: "Damage",
  POKEMON_HEAL: "Heals",
  DISPLAY_TEXT: "Text",
  BOARD_EVENT: "Board effects",
  WEATHER: "Weather"
}
// Drill-down sections for the merged Combat chip. The source note honors the real distinction: casts/damage
// only exist for the board the recorder was watching, while status/stats are recovered for every board.
const COMBAT_SECTIONS: { cat: Category; label: string }[] = [
  { cat: "combat", label: "Casts / damage / weather · recorder's PoV" },
  { cat: "status", label: "Status · all boards" },
  { cat: "stats", label: "Stats · all boards" }
]

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
  artifact: "items",
  weather: "combat", // a fight property (the recorder's-fight weather) → grouped under Combat, not Synergy
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

// AttackType: PHYSICAL=0, SPECIAL=1, TRUE=2 (app/types/enum/Game.ts).
const DMG_TYPE = ["physical", "special", "true"]

// Best-effort one-line summary of a ROOM_DATA payload. Kept defensive (payloads vary by type/version);
// unknown shapes just show the type. Copy is intentionally terse — Blake owns the wording pass.
type FrameInfo = {
  caster?: string
  target?: string
  owner?: string // the recorder's camera (spectatedPlayerId) for a camera-scoped combat row; summarize ignores it
  dig?: { x: number; y: number; depth: number }
  income?: { base: number; interest: number; streak: number }
}
function summarize(type: string, payload: unknown, info?: FrameInfo): string {
  const p = payload as Record<string, unknown> | number | null
  const names = info // combat caster/target naming reads `names` below; dig/income read `info`
  try {
    switch (type) {
      case "ABILITY": {
        // No "→ target": broadcastAbility defaults targetX/Y to the caster's *attack-enemy*, so a
        // self/ally effect (Grass Heal, Supercharge, a buff/heal ability…) would render "→ enemy". The
        // real targets are carried correctly by the POKEMON_DAMAGE (victim) / POKEMON_HEAL (recipient)
        // rows, so the cast row just says who cast what. (See the header note.)
        const o = p as { skill?: string; positionX?: number; positionY?: number }
        const skill = prettyName(o?.skill)
        const head = names?.caster ? `${prettyName(names.caster)} · ${skill}` : skill
        return names?.caster || o?.positionX == null ? head : `${head} @(${o.positionX},${o.positionY})`
      }
      case "POKEMON_DAMAGE": {
        const o = p as { index?: string; amount?: number; type?: number; x?: number; y?: number }
        const src = o?.index ? PkmByIndex[o.index] : undefined
        const tgt = names?.target ? prettyName(names.target) : `(${o?.x},${o?.y})`
        return `${src ? prettyName(src) : "?"} ${o?.amount ?? "?"} ${DMG_TYPE[o?.type ?? 0] ?? ""} → ${tgt}`
      }
      case "POKEMON_HEAL": {
        const o = p as { index?: string; amount?: number; type?: number; x?: number; y?: number }
        const src = o?.index ? PkmByIndex[o.index] : undefined
        const tgt = names?.target ? prettyName(names.target) : `(${o?.x},${o?.y})`
        return `${src ? prettyName(src) : "?"} +${o?.amount ?? "?"}${o?.type === 0 ? " shield" : ""} → ${tgt}`
      }
      case "BOARD_EVENT": {
        const o = p as { effect?: string; x?: number; y?: number }
        return `${prettyName(o?.effect)} at (${o?.x},${o?.y})`
      }
      case "DISPLAY_TEXT": {
        // DisplayText (app/types/strings/DisplayText.ts) is either `ability.<ABILITY>` (a big ability
        // cast, e.g. Mimic/Metronome copies) or a snake_case status ("belly_full", "full"…). Strip the
        // "ability." prefix; prettyName title-cases the rest either way → "Meteor Mash" / "Belly Full".
        const o = p as { text?: string }
        const t = String(o?.text ?? "")
        return prettyName(t.startsWith("ability.") ? t.slice("ability.".length) : t)
      }
      case "PLAYER_DAMAGE": return `${typeof p === "number" ? p : (p as { value?: number })?.value ?? "?"} life lost`
      case "PLAYER_INCOME": {
        const total = typeof p === "number" ? p : (p as { value?: number })?.value
        if (total == null) return "+? gold"
        const b = info?.income
        if (b) {
          // The income breakdown (base = 5 + red-scale bonus, interest, win-streak bonus). Show only the
          // components that contributed; base is always present.
          const parts = [`${b.base} base`]
          if (b.interest) parts.push(`${b.interest} interest`)
          if (b.streak) parts.push(`${b.streak} streak`)
          return `+${total}g (${parts.join(" + ")})`
        }
        return `+${total}g`
      }
      case "FINAL_RANK": return `placed #${typeof p === "number" ? p : (p as { value?: number })?.value ?? "?"}`
      case "PRELOAD_MAPS": return Array.isArray(payload) ? `${payload.length} region maps` : ""
      case "LOADING_COMPLETE": return "game start"
      case "GAME_END": return "game over"
      case "COOK": { const o = p as { dishes?: string[] }; return Array.isArray(o?.dishes) && o.dishes.length ? `cooked ${o.dishes.map(prettyName).join(", ")}` : "cooked a dish" }
      case "DIG": {
        const o = p as { buriedItem?: string | null }
        const found = o?.buriedItem ? `, found ${prettyName(o.buriedItem)}` : ""
        const d = info?.dig
        if (d) return `Dug (${d.x},${d.y}) to depth ${d.depth}${found}`
        return o?.buriedItem ? `Dug up ${prettyName(o.buriedItem)}` : "Dug a hole"
      }
      case "NPC_DIALOG": { const o = p as { npc?: string; dialog?: string }; return `${prettyName(o?.npc)}: ${o?.dialog ?? ""}`.trim() }
      case "SHOW_EMOTE": return "emote"
      default: return ""
    }
  } catch {
    return ""
  }
}

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
  const saved = useMemo(() => {
    try {
      const b = JSON.parse(localStorage.getItem(BOX_KEY) || "null")
      if (b && typeof b === "object") return b as { x?: number; y?: number; w?: number; h?: number }
    } catch {
      /* ignore */
    }
    return {} as { x?: number; y?: number; w?: number; h?: number }
  }, [])
  const [pos, setPos] = useState<{ x: number; y: number } | null>(
    saved.x != null && saved.y != null ? { x: saved.x, y: saved.y } : null
  )
  // The layout-measured default box. Supplies position AND/OR size per-dimension — whichever the user
  // hasn't overridden (a saved drag wins position, a saved resize wins size; see posStyle + the size
  // effect). Recomputed on open + window resize so it adapts. null → fallback dock. Skipped only when the
  // user has BOTH dragged and resized (it would never be used).
  const [autoBox, setAutoBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const fullyPlaced = saved.x != null && saved.w != null
  useEffect(() => {
    if (!open || fullyPlaced) return
    // measure after layout settles (the panel + game HUD are on screen); also track window resizes
    const measure = () => setAutoBox(measureDefaultBox())
    const id = requestAnimationFrame(measure)
    window.addEventListener("resize", measure)
    return () => {
      cancelAnimationFrame(id)
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

  // restore the saved size + persist on resize. The CSS resize handle mutates the element directly;
  // a ResizeObserver writes the new size back so it survives a reload.
  useEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    // The user's saved size wins; otherwise apply the layout-measured default (so the panel fills the
    // right column). Width/height are set imperatively to keep the CSS resize handle the source of truth.
    if (saved.w) el.style.width = `${saved.w}px`
    else if (autoBox) el.style.width = `${autoBox.width}px`
    if (saved.h) el.style.height = `${saved.h}px`
    else if (autoBox) el.style.height = `${autoBox.height}px`
    const ro = new ResizeObserver(() => {
      // keep the virtualization viewport in sync with the live panel height, or a resize leaves the new
      // space below the last windowed row blank until something else re-measures (a filter toggle).
      const lh = listRef.current?.clientHeight
      if (lh) setViewportH(lh)
      try {
        const b = JSON.parse(localStorage.getItem(BOX_KEY) || "{}")
        localStorage.setItem(BOX_KEY, JSON.stringify({ ...b, w: el.offsetWidth, h: el.offsetHeight }))
      } catch {
        /* ignore */
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, saved, autoBox])

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
        out.push({ t: f.t, frame: i, type, summary: summarize(type, f.payload, info), cat: CATEGORY_OF[type] ?? "engine", kind: "msg", uid: info.owner ?? viewerUid })
      }
    })
    // Game-level milestones (phase / elimination) carry no uid → they always show.
    index?.segments.forEach((s) => out.push({ t: s.t, frame: -1, type: "PHASE", summary: `Stage ${s.stage} · ${s.phaseLabel}`, cat: "flow", kind: "phase" }))
    index?.events.filter((e) => e.type === "elimination").forEach((e) => out.push({ t: e.t, frame: -1, type: "ELIMINATION", summary: e.label, cat: "flow", kind: "elim" }))
    // Per-player actions → categories: shop/board management to Economy, synergy-driven gains to Synergy,
    // proposition picks to Match flow, combat status/stat to Status/Stats. The action's own uid carries the
    // owning player (uid-less = the game-level town/rule rows); the per-player filter slices on it.
    index?.actions.forEach((a) => out.push({ t: a.t, frame: -1, type: a.type.toUpperCase(), summary: a.label, cat: ACTION_CAT[a.type] ?? "economy", kind: a.type === "pick" ? "pick" : "action", uid: a.uid, key: a.key }))
    return out.sort((a, b) => a.t - b.t || a.frame - b.frame)
  }, [room, index, viewerUid])

  // Sub-types present per category (data-driven from the recording) → drives the per-category drill-down.
  const subtypesByCat = useMemo(() => {
    const m = new Map<Category, Set<string>>()
    for (const e of events) {
      if (!m.has(e.cat)) m.set(e.cat, new Set())
      m.get(e.cat)!.add(subKey(e))
    }
    return m
  }, [events])

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
        title={`Toggle ${label}`}
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
        <span className="rel-title">Event log</span>
        <span className="rel-count" title={`${visible.length} shown of ${events.length} total events`}>
          {visible.length} / {events.length}
        </span>
        <button
          className={`rel-follow${follow ? " on" : ""}`}
          title={follow ? "Following playback — click to scroll the log freely" : "Free scroll — click to follow playback"}
          onClick={() => setFollow((f) => !f)}
        >
          Follow
        </button>
        <button className="rel-close" title="Close" onClick={onClose}>×</button>
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
                  title="Toggle combat — casts, damage, status, and stat changes"
                  onClick={() => setEnabled((e) => {
                    const v = !COMBAT_CATS.some((c) => e[c])
                    return { ...e, combat: v, status: v, stats: v }
                  })}
                >
                  Combat
                </button>
                <button
                  className={`rel-caret${expanded === "combat" ? " open" : ""}`}
                  title="Filter combat by casts / damage / status / stats"
                  onClick={() => setExpanded((x) => (x === "combat" ? null : "combat"))}
                >
                  ▾
                </button>
              </span>
            )
          })()}
        {/* The other categories — one chip each, only when the recording has events of that category (same
            data-driven rule as the drill-down, so no empty chip filters to nothing). */}
        {CATEGORIES.filter((c) => !COMBAT_CATS.includes(c.key) && subtypesByCat.has(c.key)).map((c) => {
          const drillable = (subtypesByCat.get(c.key)?.size ?? 0) > 1
          return (
            <span key={c.key} className={`rel-chip-wrap${drillable ? " has-caret" : ""}`}>
              <button
                className={`rel-chip rel-chip-${c.key}${enabled[c.key] ? " on" : ""}`}
                title={`Toggle ${c.label} events`}
                onClick={() => toggle(c.key)}
              >
                {c.label}
              </button>
              {drillable && (
                <button
                  className={`rel-caret${expanded === c.key ? " open" : ""}`}
                  title={`Filter individual ${c.label} types`}
                  onClick={() => setExpanded((x) => (x === c.key ? null : c.key))}
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
                const subs = [...(subtypesByCat.get(sec.cat) ?? [])].sort()
                if (!subs.length) return null
                return (
                  <Fragment key={sec.cat}>
                    <span className="rel-subhead">{sec.label}</span>
                    {subs.map((sub) =>
                      renderSubchip(sec.cat, sub, sec.cat === "combat" ? COMBAT_SUBLABEL[sub] ?? prettyName(sub) : sub)
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
                title={`Toggle ${playerNames[uid] || uid}'s events`}
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
                title={`seek to ${fmt(e.t - base)}`}
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
