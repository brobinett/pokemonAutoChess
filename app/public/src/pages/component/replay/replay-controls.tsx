import { useEffect, useRef, useState } from "react"
import {
  nextPhase,
  nextStage,
  prevPhase,
  prevStage,
  segmentAt,
  type ReplayEvent,
  type ReplayIndex
} from "../../../game/replay-index"
import type { ReplayRoom } from "../../../game/replay-room"
import "./replay-ui.css"

// Overlay controls for the replay viewer: play/pause, scrub, speed, skip-by-phase/stage, a
// phase-colored timeline with event markers, focus auto-speed (fast-forward prep or fights),
// frame-step, and copy-link. Polls the ReplayRoom (which owns playback timing) a few times a second
// to reflect its state. Styled with the game's native classes (.my-container/.bubbly) so it reads as
// part of the UI, and draggable (position persisted) so the viewer can move it off the shop.
//
// Skip buttons + markers + bands come from a derived transcript index (replay-index.ts); when it
// isn't available (decode failure / older capture) the bar degrades to the plain scrubber.

const SPEEDS = [0.5, 1, 2, 4]
const POS_KEY = "replay.controls.pos"

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const loadPos = (): { x: number; y: number } | null => {
  try {
    const s = localStorage.getItem(POS_KEY)
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

export default function ReplayControls({
  room,
  index,
  navMs,
  onSeek,
  onRestart,
  onStepForward,
  onStepBackward,
  onCopyLink
}: {
  room: ReplayRoom
  index: ReplayIndex | null
  navMs: () => number
  onSeek: (ms: number) => void
  onRestart: () => void
  onStepForward: () => void
  onStepBackward: () => void
  onCopyLink: () => Promise<boolean>
}) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1e6), 150)
    return () => clearInterval(id)
  }, [])

  const [copied, setCopied] = useState(false)
  // Scrubber hover preview: what's at the cursor (re-based time + stage·phase, or the nearest event)
  // shown before you commit a seek — seeking reboots, so aiming first is worth it. Index data only,
  // no render. xPct positions the tooltip + guide line along the track.
  const [hover, setHover] = useState<{ xPct: number; ms: number; event: ReplayEvent | null } | null>(null)

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

  // Both directions reboot the scene at the target time (replay.tsx boot()), so seeking is in-page and
  // never breaks sprites; the controls just report where to jump.
  //
  // Re-base the timeline so 0:00 = game start (the carousel), not recording start (mid-loading-wait):
  // the recorder starts capturing while players are still loading, so raw frame times include that wait.
  // Displayed times subtract the offset and the scrubber spans [gameStart, end]; seek targets stay
  // absolute (what boot() wants).
  const base = room.gameStartMs
  const span = Math.max(1, room.totalMs - base)
  const elapsed = Math.max(0, room.currentMs - base)
  const pct = Math.min(100, Math.max(0, (elapsed / span) * 100))
  const posStyle = pos
    ? { left: pos.x, top: pos.y }
    : { left: "50%", top: 58, transform: "translateX(-50%)" }

  // Skip-button targets from the index. Navigate from the in-flight seek target while a seek is
  // rebuilding (navMs) so rapid skips / a held arrow key accumulate instead of recomputing the same
  // jump from a frozen position; null → at the end → disabled. The position chip below uses the LIVE
  // currentMs (where playback actually is), not the nav reference.
  const navNow = navMs()
  const targets = index
    ? {
        prevStage: prevStage(index, navNow),
        prevPhase: prevPhase(index, navNow),
        nextPhase: nextPhase(index, navNow),
        nextStage: nextStage(index, navNow)
      }
    : null

  const here = index ? segmentAt(index, room.currentMs) : null
  const focus = room.getFocusMode()
  const paused = room.paused && !room.ended

  // Marker / band fraction along the re-based track [0,1].
  const frac = (t: number) => clamp((t - base) / span, 0, 1)
  const skip = (target: number | null) => target != null && onSeek(target)
  // Compute the skip target LIVE at click time (from navMs), so two fast clicks accumulate even within
  // one 150ms poll cycle (the render-time `targets` below would still hold the pre-first-click jump).
  const go = (fn: (i: ReplayIndex, ms: number) => number | null) => index && skip(fn(index, navMs()))

  // Track hover → preview the moment under the cursor; snap to a nearby event marker if close.
  const onTrackHover = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - r.left
    const xPct = clamp((cx / r.width) * 100, 0, 100)
    let near: ReplayEvent | null = null
    if (index?.events.length) {
      let best = 10 // px: snap the preview to an event marker within this distance of the cursor
      for (const ev of index.events) {
        const d = Math.abs(frac(ev.t) * r.width - cx)
        if (d < best) {
          best = d
          near = ev
        }
      }
    }
    setHover({ xPct, ms: base + (xPct / 100) * span, event: near })
  }

  const copy = async () => {
    if (await onCopyLink()) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }
  }

  return (
    <div ref={barRef} className="replay-controls my-container" style={posStyle}>
      <span className="rc-handle" title="Drag to move" onMouseDown={onHandleDown}>
        ⠿
      </span>

      {targets && (
        <>
          <button className="bubbly rc-skip" title="Previous stage (Shift+←)" disabled={targets.prevStage == null} onClick={() => go(prevStage)}>
            ⏮
          </button>
          <button className="bubbly rc-skip" title="Previous phase (←)" disabled={targets.prevPhase == null} onClick={() => go(prevPhase)}>
            ‹
          </button>
        </>
      )}

      <button
        className="bubbly blue rc-play"
        title={room.ended ? "Restart" : room.paused ? "Play (Space)" : "Pause (Space)"}
        onClick={() => (room.ended ? onRestart() : room.togglePause())}
      >
        {room.ended ? "↻" : room.paused ? "▶" : "⏸"}
      </button>

      {targets && (
        <>
          <button className="bubbly rc-skip" title="Next phase (→)" disabled={targets.nextPhase == null} onClick={() => go(nextPhase)}>
            ›
          </button>
          <button className="bubbly rc-skip" title="Next stage (Shift+→)" disabled={targets.nextStage == null} onClick={() => go(nextStage)}>
            ⏭
          </button>
        </>
      )}

      {/* Frame-step appears when paused — the inspect-a-fight-tick-by-tick tool. Back is a reboot-seek
          (decoder is forward-only) so it's a touch slower than forward. */}
      {paused && (
        <span className="rc-step">
          <button className="bubbly rc-skip" title="Step back one frame (,)" onClick={onStepBackward}>
            −1
          </button>
          <button className="bubbly rc-skip" title="Step forward one frame (.)" onClick={onStepForward}>
            +1
          </button>
        </span>
      )}

      <span className="rc-time">{fmt(elapsed)}</span>

      <div className="rc-track-wrap">
      <div
        className="rc-track"
        onMouseMove={index ? onTrackHover : undefined}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onSeek(base + ((e.clientX - r.left) / r.width) * span)
        }}
      >
        {/* Phase-colored bands: the match rhythm at a glance (prep vs fight vs town). Behind the fill
            and markers; the track's own click handler still seeks within them. */}
        {index?.segments.map((s, i) => {
          const start = frac(s.t)
          const end = i + 1 < index.segments.length ? frac(index.segments[i + 1].t) : 1
          return (
            <div
              key={`band-${i}`}
              className={`rc-band ${s.phaseLabel.toLowerCase()}`}
              style={{ left: `${start * 100}%`, width: `${Math.max(0, end - start) * 100}%` }}
            />
          )
        })}
        <div className="rc-fill" style={{ width: `${pct}%` }} />
        <div className="rc-playhead" style={{ left: `${pct}%` }} />
        {/* Stage/phase boundary ticks (stage-starts emphasized) + elimination markers, click-to-seek.
            stopPropagation so a marker click jumps to that boundary exactly, not the coarse track click. */}
        {index?.segments.map((s, i) => {
          const isStageStart = index.stages.some((st) => st.t === s.t)
          return (
            <button
              key={`seg-${i}`}
              className={`rc-mark${isStageStart ? " stage" : ""}`}
              style={{ left: `${frac(s.t) * 100}%` }}
              title={`Stage ${s.stage} · ${s.phaseLabel}  (${fmt(s.t - base)})`}
              onClick={(e) => {
                e.stopPropagation()
                onSeek(s.t)
              }}
            />
          )
        })}
        {index?.events.map((ev, i) => (
          <button
            key={`ev-${i}`}
            className={`rc-mark ${ev.type}`}
            style={{ left: `${frac(ev.t) * 100}%` }}
            title={`${ev.label}  (${fmt(ev.t - base)})`}
            onClick={(e) => {
              e.stopPropagation()
              onSeek(ev.t)
            }}
          />
        ))}
        {hover && <div className="rc-hover-line" style={{ left: `${hover.xPct}%` }} />}
      </div>
        {hover &&
          (() => {
            const seg = index ? segmentAt(index, hover.ms) : null
            return (
              <div className="rc-hover-tip" style={{ left: `${clamp(hover.xPct, 7, 93)}%` }}>
                <span className="rc-hover-time">{fmt(hover.ms - base)}</span>
                {hover.event ? (
                  <span className="rc-hover-evt">{hover.event.label}</span>
                ) : seg ? (
                  <span className={`rc-hover-seg ${seg.phaseLabel.toLowerCase()}`}>
                    S{seg.stage} · {seg.phaseLabel}
                  </span>
                ) : null}
              </div>
            )
          })()}
      </div>

      <span className="rc-time">{fmt(span)}</span>

      <div className="rc-speeds">
        {SPEEDS.map((s) => (
          <button key={s} className={`bubbly${room.getSpeed() === s ? " blue" : ""}`} onClick={() => room.setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>

      {/* Focus auto-speed: fast-forward one part of the match, watch the other at the chosen speed. */}
      <div className="rc-focus" title="Fast-forward one part of the match, watch the rest">
        <span className="rc-focus-label">FF</span>
        <button className={`bubbly${focus === "prep" ? " blue" : ""}`} title="Fast-forward prep, watch the fights" onClick={() => room.setFocusMode("prep")}>
          Prep
        </button>
        <button className={`bubbly${focus === "fights" ? " blue" : ""}`} title="Fast-forward fights, watch prep (where you actually decide)" onClick={() => room.setFocusMode("fights")}>
          Fights
        </button>
      </div>

      <button className={`bubbly rc-copy${copied ? " green" : ""}`} title="Copy a link to this moment (c)" onClick={copy}>
        {copied ? "✓" : "🔗"}
      </button>

      <span className={`rc-label${room.ended ? " ended" : ""}`}>
        {room.ended ? "Replay ended" : here ? `S${here.stage} · ${here.phaseLabel}` : "REPLAY"}
      </span>
    </div>
  )
}
