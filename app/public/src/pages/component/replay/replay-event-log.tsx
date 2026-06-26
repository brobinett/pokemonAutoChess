import { useEffect, useMemo, useRef, useState } from "react"
import { PkmByIndex } from "../../../../../types/enum/Pokemon"
import { prettyName, type ReplayIndex } from "../../../game/replay-index"
import type { ReplayRoom } from "../../../game/replay-room"
import "./replay-event-log.css"

// Combat-event naming, grounded in the actual payloads:
//   ABILITY        → { id: simulationId, skill, positionX/Y (caster tile), targetX/Y (target tile) }
//   POKEMON_DAMAGE → { index: ATTACKER species, amount, type (AttackType), x/y: victim tile }
//   POKEMON_HEAL   → { index: HEALER  species, amount, type (HealType),  x/y: target tile }
// Damage/heal name the SOURCE from the species `index` (→ PkmByIndex). Every payload identifies the
// OTHER units only by tile, so the index resolves those tiles against the simulation positions (passed
// in as `names`): the ABILITY caster + target, and the damage/heal target.

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
// Events are grouped into a handful of player-facing CATEGORIES (combat / economy / match-flow /
// synergy / flavor / engine), each with a filter chip in the header. Engine (board/sim bookkeeping)
// is off by default since it's high-frequency plumbing; the rest are on. Filtering only hides rows —
// it never drops data from the recording — so the format's "downgradeable to an analysis log"
// property (FORMAT.md) is preserved.
//
// Purely additive + replay-only (rendered only by the /replay page), reading the manifest frames the
// ReplayRoom already holds, plus the shared useDraggable hook the game's other windows use — no effect
// on live play. The panel is draggable (by its header) and resizable (CSS resize handle).

type Category = "combat" | "economy" | "items" | "flow" | "synergy" | "flavor" | "positioning" | "engine"

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
  // engine / internal — board-sim bookkeeping + renderer setup + rare system/error frames (off by default)
  CLEAR_BOARD_EVENT: "engine",
  BOARD_EVENT: "engine",
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
  { key: "economy", label: "Economy" },
  { key: "items", label: "Items" },
  { key: "flow", label: "Match flow" },
  { key: "synergy", label: "Synergy" },
  { key: "flavor", label: "Flavor" },
  { key: "positioning", label: "Positioning" },
  { key: "engine", label: "Engine" }
]

const DEFAULT_ON: Record<Category, boolean> = {
  combat: true,
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
  item: "items",
  craft: "items",
  equip: "items",
  unequip: "items",
  egg: "synergy",
  fish: "synergy",
  hatch: "synergy",
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
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

// AttackType: PHYSICAL=0, SPECIAL=1, TRUE=2 (app/types/enum/Game.ts).
const DMG_TYPE = ["physical", "special", "true"]

// Best-effort one-line summary of a ROOM_DATA payload. Kept defensive (payloads vary by type/version);
// unknown shapes just show the type. Copy is intentionally terse — Blake owns the wording pass.
function summarize(type: string, payload: unknown, names?: { caster?: string; target?: string }): string {
  const p = payload as Record<string, unknown> | number | null
  try {
    switch (type) {
      case "ABILITY": {
        const o = p as { skill?: string; positionX?: number; positionY?: number }
        const skill = prettyName(o?.skill)
        const head = names?.caster ? `${prettyName(names.caster)} · ${skill}` : skill
        if (names?.target) return `${head} → ${prettyName(names.target)}`
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
      case "DISPLAY_TEXT": { const o = p as { text?: string }; return String(o?.text ?? "") }
      case "PLAYER_DAMAGE": return `${typeof p === "number" ? p : (p as { value?: number })?.value ?? "?"} life lost`
      case "PLAYER_INCOME": return `+${typeof p === "number" ? p : (p as { value?: number })?.value ?? "?"} gold`
      case "FINAL_RANK": return `placed #${typeof p === "number" ? p : (p as { value?: number })?.value ?? "?"}`
      case "PRELOAD_MAPS": return Array.isArray(payload) ? `${payload.length} region maps` : ""
      case "LOADING_COMPLETE": return "game start"
      case "GAME_END": return "game over"
      case "COOK": { const o = p as { dishes?: string[] }; return Array.isArray(o?.dishes) && o.dishes.length ? `cooked ${o.dishes.map(prettyName).join(", ")}` : "cooked a dish" }
      case "DIG": { const o = p as { buriedItem?: string | null }; return o?.buriedItem ? `dug up ${prettyName(o.buriedItem)}` : "dug — nothing" }
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
  const [, force] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
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

  // Build the full event list once per recording: every message frame + phase/stage + elimination,
  // each tagged with its category.
  const events = useMemo<LogEvent[]>(() => {
    const out: LogEvent[] = []
    room.manifest.frames.forEach((f, i) => {
      if (f.kind === "message") {
        const type = String(f.type)
        out.push({ t: f.t, frame: i, type, summary: summarize(type, f.payload, index?.combatUnits?.[i]), cat: CATEGORY_OF[type] ?? "engine", kind: "msg" })
      }
    })
    index?.segments.forEach((s) => out.push({ t: s.t, frame: -1, type: "PHASE", summary: `Stage ${s.stage} · ${s.phaseLabel}`, cat: "flow", kind: "phase" }))
    index?.events.filter((e) => e.type === "elimination").forEach((e) => out.push({ t: e.t, frame: -1, type: "ELIMINATION", summary: e.label, cat: "flow", kind: "elim" }))
    // POV-player actions → categories: shop/board management to Economy, synergy-driven gains (egg/fish/
    // hatch) to Synergy, proposition picks to Match flow.
    index?.actions.forEach((a) => out.push({ t: a.t, frame: -1, type: a.type.toUpperCase(), summary: a.label, cat: ACTION_CAT[a.type] ?? "economy", kind: a.type === "pick" ? "pick" : "action" }))
    return out.sort((a, b) => a.t - b.t || a.frame - b.frame)
  }, [room, index])

  const base = index?.gameStartMs ?? 0
  const visible = useMemo(() => events.filter((e) => enabled[e.cat]), [events, enabled])

  // The visible row at the playhead: the last one with t <= currentMs.
  const cur = room.currentMs
  let activeIdx = -1
  for (let i = 0; i < visible.length; i++) {
    if (visible[i].t <= cur) activeIdx = i
    else break
  }
  const activeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeIdx, open])

  if (!open) return null
  const toggle = (k: Category) => setEnabled((e) => ({ ...e, [k]: !e[k] }))
  // default dock until dragged: right-anchored under the DPS meter; once dragged, absolute top-left.
  const posStyle: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { right: DEFAULT_RIGHT, top: DEFAULT_TOP }
  return (
    <div ref={panelRef} className="replay-eventlog my-container" style={posStyle}>
      <header className="rel-head" onMouseDown={onHeadDown}>
        <span className="rel-title">Event log</span>
        <span className="rel-count" title={`${visible.length} shown of ${events.length} total events`}>
          {visible.length} / {events.length}
        </span>
        <button className="rel-close" title="Close" onClick={onClose}>×</button>
      </header>
      <div className="rel-filters">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={`rel-chip rel-chip-${c.key}${enabled[c.key] ? " on" : ""}`}
            title={`Toggle ${c.label} events`}
            onClick={() => toggle(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="rel-list">
        {visible.map((e, i) => (
          <div
            key={`${e.frame}:${e.t}:${i}`}
            ref={i === activeIdx ? activeRef : undefined}
            className={`rel-row rel-${e.kind} rel-cat-${e.cat}${i === activeIdx ? " active" : ""}`}
            title={`seek to ${fmt(e.t - base)}`}
            onClick={() => onSeek(e.t)}
          >
            <span className="rel-t">{fmt(e.t - base)}</span>
            <span className="rel-frame">{e.frame >= 0 ? `#${e.frame}` : "·"}</span>
            <span className="rel-type">{e.type}</span>
            <span className="rel-sum">{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
