import { useEffect, useRef, useState } from "react"
import type { ReplayRoom } from "../../../game/replay-room"
import "./replay-ui.css"

// Overlay controls for the replay viewer: play/pause, scrub, speed, and a graceful "ended" state.
// Polls the ReplayRoom (which owns playback timing) a few times a second to reflect its state.
// Styled with the game's native classes (.my-container/.bubbly) so it reads as part of the UI, and
// draggable (position persisted) so the viewer can move it off the shop / wherever they like.

const SPEEDS = [0.5, 1, 2, 4]
const POS_KEY = "replay.controls.pos"

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const reloadWith = (params: Record<string, string | null>) => {
  const url = new URL(window.location.href)
  for (const [k, v] of Object.entries(params)) {
    if (v === null) url.searchParams.delete(k)
    else url.searchParams.set(k, v)
  }
  window.location.href = url.toString()
}

const loadPos = (): { x: number; y: number } | null => {
  try {
    const s = localStorage.getItem(POS_KEY)
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

export default function ReplayControls({ room }: { room: ReplayRoom }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1e6), 150)
    return () => clearInterval(id)
  }, [])

  // Draggable position. null → default top-center (clear of the shop, which spans the bottom).
  const barRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(loadPos)

  const onHandleDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const rect = barRef.current!.getBoundingClientRect()
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
      const r = barRef.current?.getBoundingClientRect()
      if (r) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }))
        } catch {
          /* ignore quota/availability errors */
        }
      }
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  const seek = (ms: number) => {
    // Forward seeks fast-apply in place; backward needs a fresh decoder → reload at that offset.
    if (room.seek(ms) === "reload") reloadWith({ startMs: String(Math.round(ms)) })
  }
  const restart = () => reloadWith({ startMs: null })

  const pct = room.totalMs ? Math.min(100, (room.currentMs / room.totalMs) * 100) : 0
  const posStyle = pos
    ? { left: pos.x, top: pos.y }
    : { left: "50%", top: 58, transform: "translateX(-50%)" }

  return (
    <div ref={barRef} className="replay-controls my-container" style={posStyle}>
      <span className="rc-handle" title="Drag to move" onMouseDown={onHandleDown}>
        ⠿
      </span>

      <button
        className="bubbly blue rc-play"
        title={room.ended ? "Restart" : room.paused ? "Play" : "Pause"}
        onClick={() => (room.ended ? restart() : room.togglePause())}
      >
        {room.ended ? "↻" : room.paused ? "▶" : "⏸"}
      </button>

      <span className="rc-time">{fmt(room.currentMs)}</span>

      <div
        className="rc-track"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          seek(((e.clientX - r.left) / r.width) * room.totalMs)
        }}
      >
        <div className="rc-fill" style={{ width: `${pct}%` }} />
      </div>

      <span className="rc-time">{fmt(room.totalMs)}</span>

      <div className="rc-speeds">
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={`bubbly${room.getSpeed() === s ? " blue" : ""}`}
            onClick={() => room.setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>

      <span className={`rc-label${room.ended ? " ended" : ""}`}>
        {room.ended ? "Replay ended" : "REPLAY"}
      </span>
    </div>
  )
}
