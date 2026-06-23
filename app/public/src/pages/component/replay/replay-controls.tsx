import { type CSSProperties, useEffect, useState } from "react"
import type { ReplayRoom } from "../../../game/replay-room"

// Overlay controls for the replay viewer: play/pause, scrub, speed, and a graceful "ended" state.
// Polls the ReplayRoom (which owns playback timing) a few times a second to reflect its state.

const SPEEDS = [0.5, 1, 2, 4]
const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const reloadWith = (params: Record<string, string | null>) => {
  const url = new URL(window.location.href)
  for (const [k, v] of Object.entries(params)) {
    if (v === null) url.searchParams.delete(k)
    else url.searchParams.set(k, v)
  }
  window.location.href = url.toString()
}

export default function ReplayControls({ room }: { room: ReplayRoom }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1e6), 150)
    return () => clearInterval(id)
  }, [])

  const seek = (ms: number) => {
    // Forward seeks fast-apply in place; backward needs a fresh decoder → reload at that offset.
    if (room.seek(ms) === "reload") reloadWith({ startMs: String(Math.round(ms)) })
  }
  const restart = () => reloadWith({ startMs: null })

  const pct = room.totalMs ? Math.min(100, (room.currentMs / room.totalMs) * 100) : 0

  return (
    <div style={S.bar}>
      <button
        style={S.btn}
        title={room.ended ? "Restart" : room.paused ? "Play" : "Pause"}
        onClick={() => (room.ended ? restart() : room.togglePause())}
      >
        {room.ended ? "↻" : room.paused ? "▶" : "⏸"}
      </button>

      <span style={S.time}>{fmt(room.currentMs)}</span>

      <div
        style={S.track}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          seek(((e.clientX - r.left) / r.width) * room.totalMs)
        }}
      >
        <div style={{ ...S.fill, width: `${pct}%` }} />
      </div>

      <span style={S.time}>{fmt(room.totalMs)}</span>

      <div style={S.speeds}>
        {SPEEDS.map((s) => (
          <button
            key={s}
            style={{ ...S.btn, ...(room.getSpeed() === s ? S.btnActive : null) }}
            onClick={() => room.setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>

      <span style={S.label}>{room.ended ? "Replay ended" : "REPLAY"}</span>
    </div>
  )
}

const S: Record<string, CSSProperties> = {
  bar: {
    position: "fixed",
    bottom: 8,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 12px",
    background: "rgba(20,24,33,0.92)",
    border: "1px solid #3a4358",
    borderRadius: 8,
    color: "#dfe5ef",
    font: "13px/1 sans-serif",
    boxShadow: "0 2px 10px rgba(0,0,0,0.4)",
    userSelect: "none"
  },
  btn: {
    minWidth: 30,
    height: 26,
    padding: "0 8px",
    background: "#2b3346",
    border: "1px solid #3a4358",
    borderRadius: 5,
    color: "#dfe5ef",
    cursor: "pointer"
  },
  btnActive: { background: "#3b7ddd", borderColor: "#3b7ddd", color: "#fff" },
  time: { fontVariantNumeric: "tabular-nums", opacity: 0.85, minWidth: 34, textAlign: "center" },
  track: {
    position: "relative",
    width: 320,
    height: 8,
    background: "#202736",
    border: "1px solid #3a4358",
    borderRadius: 5,
    cursor: "pointer"
  },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0, background: "#3b7ddd", borderRadius: 5 },
  speeds: { display: "flex", gap: 4 },
  label: { letterSpacing: 1, fontSize: 11, opacity: 0.7, minWidth: 78, textAlign: "right" }
}
