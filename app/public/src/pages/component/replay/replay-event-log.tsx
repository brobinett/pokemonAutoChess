import { useEffect, useMemo, useRef, useState } from "react"
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
// Default dock: right edge ~6vw from the screen edge (aligned under the DPS meter, which clears the
// right-edge portrait column), top below the DPS meter's expanded extent. Drag/resize take over from
// here; both persist (localStorage).
const DEFAULT_TOP = "57vh"
const DEFAULT_RIGHT = "6vw"

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
  weather: "synergy",
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
  // The player this event was derived for. Drives the two tabs: the "recorded POV" tab shows the
  // recording player's own events (uid === viewer) plus uid-less game-level milestones (phase / elim /
  // town / rule); the "everyone" tab shows all players, labelled by name. Combat messages are the POV's
  // own fight (broadcastToSpectators), so they carry the viewer uid.
  uid?: string
  // Optional sub-type for the fine-grained filter (the stat field / status name); absent → the `type`
  // column IS the filterable granularity. `subKey()` below resolves the effective key either way.
  key?: string
}

// The fine-grained filter operates on a per-category sub-type: the explicit `key` (stat field / status
// name) when present, else the display `type` (ABILITY / BUY / …). Namespaced by category for the toggle set.
const subKey = (e: { key?: string; type: string }) => e.key ?? e.type
const subId = (cat: Category, sub: string) => `${cat}:${sub}`

const TAB_KEY = "replay.eventlog.tab"
const SUBOFF_KEY = "replay.eventlog.suboff" // sub-types explicitly turned off (within an enabled category)

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
  const [enabled, setEnabled] = useState<Record<Category, boolean>>(loadFilters)
  // Which tab is active: "pov" = the recording player only (perfect info); "all" = everyone (best
  // effort — opponents' boards/economy are derived from synced state, but their shop rolls and combat
  // cast/damage aren't captured). Persisted; defaults to the focused POV view.
  const [tab, setTab] = useState<"pov" | "all">(() => {
    try {
      return localStorage.getItem(TAB_KEY) === "all" ? "all" : "pov"
    } catch {
      return "pov"
    }
  })
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

  // persist the active tab
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab)
    } catch {
      /* ignore */
    }
  }, [tab])

  // persist the per-sub-type off-set
  useEffect(() => {
    try {
      localStorage.setItem(SUBOFF_KEY, JSON.stringify([...subOff]))
    } catch {
      /* ignore */
    }
  }, [subOff])

  // restore the saved size + persist on resize. The CSS resize handle mutates the element directly;
  // a ResizeObserver writes the new size back so it survives a reload.
  useEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    if (saved.w) el.style.width = `${saved.w}px`
    if (saved.h) el.style.height = `${saved.h}px`
    const ro = new ResizeObserver(() => {
      try {
        const b = JSON.parse(localStorage.getItem(BOX_KEY) || "{}")
        localStorage.setItem(BOX_KEY, JSON.stringify({ ...b, w: el.offsetWidth, h: el.offsetHeight }))
      } catch {
        /* ignore */
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, saved])

  const viewerUid = room.manifest.viewerUid
  const playerNames = index?.playerNames ?? {}

  // Build the full event list once per recording: every message frame + phase/stage + elimination +
  // per-player action, each tagged with its category and the player it belongs to (uid).
  const events = useMemo<LogEvent[]>(() => {
    const out: LogEvent[] = []
    // DIG / COOK / SHOW_EMOTE are room-broadcast to every client, so the POV capture holds other players'
    // too; the index flags the non-POV ones (by the owning unit / emote uid) — hide them. (Combat is
    // spectator-scoped to the POV's own fight, so message frames carry the viewer uid; GAME_END/LOADING
    // are game-level but stay attributed to the POV stream — they don't surface a foreign player.)
    const foreign = new Set(index?.foreignFrames ?? [])
    room.manifest.frames.forEach((f, i) => {
      if (f.kind === "message" && !foreign.has(i)) {
        const type = String(f.type)
        const info: FrameInfo = { ...index?.combatUnits?.[i], dig: index?.digInfo?.[i], income: index?.incomeInfo?.[i] }
        out.push({ t: f.t, frame: i, type, summary: summarize(type, f.payload, info), cat: CATEGORY_OF[type] ?? "engine", kind: "msg", uid: viewerUid })
      }
    })
    // Game-level milestones (phase / elimination) carry no uid → they show in BOTH tabs.
    index?.segments.forEach((s) => out.push({ t: s.t, frame: -1, type: "PHASE", summary: `Stage ${s.stage} · ${s.phaseLabel}`, cat: "flow", kind: "phase" }))
    index?.events.filter((e) => e.type === "elimination").forEach((e) => out.push({ t: e.t, frame: -1, type: "ELIMINATION", summary: e.label, cat: "flow", kind: "elim" }))
    // Per-player actions → categories: shop/board management to Economy, synergy-driven gains to Synergy,
    // proposition picks to Match flow. The action's own uid carries the owning player (uid-less = the
    // game-level town/rule rows).
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

  const base = index?.gameStartMs ?? 0
  // Tab + category filter. "pov" keeps only the recording player's events (uid === viewer) plus uid-less
  // game-level rows; "all" keeps everyone. Category chips apply within the active tab.
  const visible = useMemo(
    () =>
      events.filter(
        (e) =>
          enabled[e.cat] &&
          !subOff.has(subId(e.cat, subKey(e))) &&
          (tab === "all" || e.uid == null || e.uid === viewerUid)
      ),
    [events, enabled, subOff, tab, viewerUid]
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
  // player column in the "all" tab is wider but still one line). Keeps the spacers/scrollbar accurate.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    if (list.clientHeight) setViewportH(list.clientHeight)
    const firstRow = list.querySelector<HTMLElement>(".rel-row")
    if (firstRow && firstRow.offsetHeight > 0) setRowH(firstRow.offsetHeight)
  }, [open, tab, total])

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
  // default dock until dragged: right-anchored under the DPS meter; once dragged, absolute top-left.
  const posStyle: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { right: DEFAULT_RIGHT, top: DEFAULT_TOP }
  // Tab 1 label = the recording player's in-game name (most informative); fall back to a generic label.
  const povLabel = playerNames[viewerUid] || "Recorded POV"
  return (
    <div ref={panelRef} className={`replay-eventlog my-container${tab === "all" ? " tab-all" : ""}`} style={posStyle}>
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
      <div className="rel-tabs">
        <button
          className={`rel-tab${tab === "pov" ? " on" : ""}`}
          title="The recording player's own timeline — perfect information"
          onClick={() => setTab("pov")}
        >
          {povLabel}
        </button>
        <button
          className={`rel-tab${tab === "all" ? " on" : ""}`}
          title="Everyone — opponents' boards, economy, and synergies derived from synced state (best effort: their shop rolls and combat cast/damage aren't captured client-side)"
          onClick={() => setTab("all")}
        >
          Everyone
        </button>
      </div>
      <div className="rel-filters">
        {CATEGORIES.map((c) => {
          const drillable = (subtypesByCat.get(c.key)?.size ?? 0) > 1
          return (
            <span key={c.key} className="rel-chip-wrap">
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
        // Per-type drill-down for the expanded category: toggle individual sub-types (e.g. a single stat
        // or status) without losing the rest. Data-driven from the recording; takes effect when the parent
        // category is enabled. Sub-types are kept ON unless explicitly added to the off-set.
        <div className="rel-subfilters">
          {[...(subtypesByCat.get(expanded) ?? [])].sort().map((sub) => {
            const id = subId(expanded, sub)
            const on = !subOff.has(id)
            return (
              <button
                key={id}
                className={`rel-subchip${on ? " on" : ""}`}
                title={`Toggle ${sub}`}
                onClick={() =>
                  setSubOff((s) => {
                    const n = new Set(s)
                    if (on) n.add(id)
                    else n.delete(id)
                    return n
                  })
                }
              >
                {sub}
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
                {tab === "all" ? (
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
