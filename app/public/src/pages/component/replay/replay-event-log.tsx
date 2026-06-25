import { useEffect, useMemo, useRef, useState } from "react"
import type { ReplayIndex } from "../../../game/replay-index"
import type { ReplayRoom } from "../../../game/replay-room"
import "./replay-event-log.css"

// Toggleable event log for the replay viewer: lists the actual frames the replay is rebuilt from —
// the typed ROOM_DATA messages (abilities, damage, heals, income, eliminations, final rank…) plus the
// phase/stage transitions derived from the state stream — each stamped with the re-based mm:ss AND its
// frame index. Clicking a row seeks there; the row at the playhead is highlighted and auto-scrolled.
// Combat-detail spam (per-hit damage/heal/board events) is hidden by default behind a toggle, so the
// default view is the high-level beat of the match (what ability fired, who took life damage, etc.).
//
// Purely additive + replay-only (rendered only by the /replay page), reading the manifest frames the
// ReplayRoom already holds — no effect on live play. It's also the concrete first step of the format's
// "downgradeable to an analysis log" property (FORMAT.md).

// Message types that are high-frequency per-hit combat detail — hidden unless "combat detail" is on.
const COMBAT_DETAIL = new Set([
  "POKEMON_DAMAGE", "POKEMON_HEAL", "CLEAR_BOARD_EVENT", "CLEAR_BOARD", "BOARD_EVENT", "SIMULATION_STOP", "DIG"
])

type LogEvent = {
  t: number // ms since first frame (absolute on the transcript clock)
  frame: number // frame index in the manifest (-1 for derived phase/elim events)
  type: string
  summary: string
  detail: boolean // true → only shown when "combat detail" is enabled
  kind: "msg" | "phase" | "elim"
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

// Best-effort one-line summary of a ROOM_DATA payload. Kept defensive (payloads vary by type/version);
// unknown shapes just show the type. Copy is intentionally terse — Blake owns the wording pass.
function summarize(type: string, payload: unknown): string {
  const p = payload as Record<string, unknown> | number | null
  try {
    switch (type) {
      case "ABILITY": return String((p as { skill?: string })?.skill ?? "")
      case "POKEMON_DAMAGE": { const o = p as { amount?: number; x?: number; y?: number }; return `${o?.amount ?? "?"} dmg @(${o?.x},${o?.y})` }
      case "POKEMON_HEAL": { const o = p as { amount?: number }; return `+${o?.amount ?? "?"} HP` }
      case "PLAYER_DAMAGE": return `${typeof p === "number" ? p : (p as { value?: number })?.value ?? "?"} life lost`
      case "PLAYER_INCOME": return `+${typeof p === "number" ? p : (p as { value?: number })?.value ?? "?"} gold`
      case "FINAL_RANK": return `placed #${typeof p === "number" ? p : (p as { value?: number })?.value ?? "?"}`
      case "PRELOAD_MAPS": return Array.isArray(payload) ? `${payload.length} region maps` : ""
      case "LOADING_COMPLETE": return "game start"
      case "NPC_DIALOG": return String((p as { dialog?: string })?.dialog ?? "dialog")
      case "SHOW_EMOTE": return "emote"
      default: return ""
    }
  } catch {
    return ""
  }
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
  // look for it) rather than as a stray fixed button. This component now renders only the panel.
  open: boolean
  onClose: () => void
}) {
  const [showDetail, setShowDetail] = useState(false)
  const [, force] = useState(0)
  // poll the room clock only while the panel is open (keep the playhead cursor live)
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => force((n) => (n + 1) % 1e6), 200)
    return () => clearInterval(id)
  }, [open])

  // Build the full event list once per recording: every message frame + phase/stage + elimination.
  const events = useMemo<LogEvent[]>(() => {
    const out: LogEvent[] = []
    room.manifest.frames.forEach((f, i) => {
      if (f.kind === "message") {
        const type = String(f.type)
        out.push({ t: f.t, frame: i, type, summary: summarize(type, f.payload), detail: COMBAT_DETAIL.has(type), kind: "msg" })
      }
    })
    index?.segments.forEach((s) => out.push({ t: s.t, frame: -1, type: "PHASE", summary: `Stage ${s.stage} · ${s.phaseLabel}`, detail: false, kind: "phase" }))
    index?.events.filter((e) => e.type === "elimination").forEach((e) => out.push({ t: e.t, frame: -1, type: "ELIMINATION", summary: e.label, detail: false, kind: "elim" }))
    return out.sort((a, b) => a.t - b.t || a.frame - b.frame)
  }, [room, index])

  const base = index?.gameStartMs ?? 0
  const visible = useMemo(() => (showDetail ? events : events.filter((e) => !e.detail)), [events, showDetail])

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
  return (
    <div className="replay-eventlog my-container">
      <header className="rel-head">
        <span className="rel-title">Event log</span>
        <label className="rel-detail-toggle" title="Include per-hit combat events (damage / heal / board)">
          <input type="checkbox" checked={showDetail} onChange={(e) => setShowDetail(e.target.checked)} /> combat detail
        </label>
        <span className="rel-count">{visible.length}</span>
        <button className="rel-close" title="Close" onClick={onClose}>×</button>
      </header>
      <div className="rel-list">
        {visible.map((e, i) => (
          <div
            key={`${e.frame}:${e.t}:${i}`}
            ref={i === activeIdx ? activeRef : undefined}
            className={`rel-row rel-${e.kind}${i === activeIdx ? " active" : ""}`}
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
