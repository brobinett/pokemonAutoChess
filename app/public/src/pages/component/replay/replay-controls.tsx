import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  nextPhase,
  nextStage,
  prevPhase,
  prevStage,
  segmentAt,
  segmentBandKind,
  type ReplayIndex
} from "../../../game/replay-index"
import type { ReplayRoom } from "../../../game/replay-room"
import "./replay-ui.css"

// Overlay controls for the replay viewer: play/pause, scrub, speed (0.5–8×), skip-by-phase/stage, a
// phase-colored timeline with event markers, and frame-step. Polls the ReplayRoom (which
// owns playback timing) a few times a second
// to reflect its state. Styled with the game's native classes (.my-container/.bubbly) so it reads as
// part of the UI, and draggable (position persisted) so the viewer can move it off the shop.
//
// Skip buttons + markers + bands come from a derived transcript index (replay-index.ts); when it
// isn't available (decode failure / older capture) the bar degrades to the plain scrubber.

// Playback speeds, shown as a dropdown (not a button row) to keep the bar compact. Capped at 4× — higher
// multipliers can't be sustained (every Colyseus patch must be applied + rendered, so playback is
// CPU/render-bound) and a control that silently throttles is worse than not offering it; the slow end goes
// to 0.125× (8× slower) for frame-by-frame combat watching. Matches replay.tsx's keyboard-cycle SPEEDS.
const SPEEDS = [0.125, 0.25, 0.5, 1, 2, 4]
const POS_KEY = "replay.controls.pos"
const DOCK_GAP = 8 // px gap between the bar's bottom edge and the shop's top edge when default-docked

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
// Speed label: sub-1× speeds read as fractions (1/8× not 0.125×) — shorter, and the dropdown is
// fixed-width so no option resizes the bar. Whole multipliers stay as N×.
const speedLabel = (s: number) => (s < 1 ? `1/${Math.round(1 / s)}×` : `${s}×`)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const loadPos = (): { x: number; y: number } | null => {
  try {
    const s = localStorage.getItem(POS_KEY)
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

// Inline SVG control icons (24×24, filled with currentColor so they inherit the button's text color and
// the disabled dim). The game styles its own buttons with SVG assets, so these match house style and, unlike
// the old Unicode glyphs (▶ ⏸ ‹ › ⏮ ⏭), render at one uniform weight on every machine — the glyphs' per-font
// metrics made pause tiny and the phase steps look like thin `<` `>`.
const RcIcon = ({ d, d2 }: { d: string; d2?: string }) => (
  <svg className="rc-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d={d} />
    {d2 ? <path d={d2} /> : null}
  </svg>
)
// Skip-STAGE = bar + triangle (⏮ ⏭); skip-PHASE = a bare triangle (◀ ▶); play/pause/restart share the
// center button. Paths are Material-style transport glyphs on a 24×24 grid.
const IC = {
  play: "M8 5l11 7-11 7z",
  triLeft: "M16 5L5 12l11 7z",
  triRight: "M8 5l11 7-11 7z",
  pauseL: "M6 5h4v14H6z",
  pauseR: "M14 5h4v14h-4z",
  skipPrevBar: "M6 6h2v12H6z",
  skipPrevTri: "M18 6L9 12l9 6z",
  skipNextBar: "M16 6h2v12h-2z",
  skipNextTri: "M6 6l9 6-9 6z",
  restart:
    "M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"
}

export default function ReplayControls({
  room,
  index,
  navMs,
  onSeek,
  onRestart,
  onStepForward,
  onStepBackward,
  eventLogOpen,
  onToggleEventLog
}: {
  room: ReplayRoom
  index: ReplayIndex | null
  navMs: () => number
  onSeek: (ms: number) => void
  onRestart: () => void
  onStepForward: () => void
  onStepBackward: () => void
  eventLogOpen: boolean
  onToggleEventLog: () => void
}) {
  const { t } = useTranslation()
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1e6), 150)
    return () => clearInterval(id)
  }, [])

  // Scrubber hover preview: the re-based time + stage·phase at the cursor, shown before you commit a
  // seek — seeking reboots, so aiming first is worth it. Index data only, no render. xPct positions the
  // tooltip + guide line along the track.
  const [hover, setHover] = useState<{ xPct: number; ms: number } | null>(null)

  // Draggable position. null → default dock just above the shop (between the shop and the bench).
  const barRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(loadPos)

  // Default dock: just above the shop strip, LEFT-anchored (not centered). We measure the live
  // `.game-shop` (its position is viewport-relative) and the bar's own width, then anchor the bar's
  // upper-left corner over the shop. Anchoring the left edge — rather than the center — keeps that
  // corner put so any width change extends the bar rightward instead of recentering it; the frame-step
  // buttons are now always present (constant width), so toggling play/pause no longer shifts the bar.
  // `bottom` re-tracks the shop each measure (it mounts/settles async, height changes on resize);
  // `left` is frozen on the first good measure so it never drifts. A user drag switches to a persisted
  // px position and stops the auto-dock (effect early-returns once `pos` is set).
  const [dock, setDock] = useState<{ left: number; bottom: number } | null>(null)
  useEffect(() => {
    if (pos) return
    const measure = () => {
      const shop = document.querySelector(".game-shop")?.getBoundingClientRect()
      const bar = barRef.current?.getBoundingClientRect()
      if (shop && shop.height > 0 && bar && bar.width > 0) {
        const bottom = window.innerHeight - shop.top + DOCK_GAP
        setDock((d) => ({
          left:
            d?.left ??
            clamp(shop.left + (shop.width - bar.width) / 2, 8, window.innerWidth - bar.width - 8),
          bottom
        }))
      }
    }
    measure()
    window.addEventListener("resize", measure)
    const id = setInterval(measure, 500)
    return () => {
      window.removeEventListener("resize", measure)
      clearInterval(id)
    }
  }, [pos])

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
  // Dragged → absolute px. Otherwise the left-anchored dock above the shop (bottom-anchored vertically,
  // since the bar is position:fixed). Fall back to top-center until the shop + bar have been measured.
  const posStyle: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : dock
      ? { left: dock.left, bottom: dock.bottom }
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

  // Marker / band fraction along the re-based track [0,1].
  const frac = (t: number) => clamp((t - base) / span, 0, 1)
  const skip = (target: number | null) => target != null && onSeek(target)
  // Compute the skip target LIVE at click time (from navMs), so two fast clicks accumulate even within
  // one 150ms poll cycle (the render-time `targets` below would still hold the pre-first-click jump).
  const go = (fn: (i: ReplayIndex, ms: number) => number | null) => index && skip(fn(index, navMs()))

  // Track hover → preview the moment (time + stage·phase) under the cursor.
  const onTrackHover = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const xPct = clamp(((e.clientX - r.left) / r.width) * 100, 0, 100)
    setHover({ xPct, ms: base + (xPct / 100) * span })
  }

  return (
    <div ref={barRef} className="replay-controls my-container" style={posStyle}>
      {/* Row 1 — the timeline spans the full width of the bar; everything else sits centered below it. */}
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
          {/* Stage-typed bands: the match rhythm at a glance, colored to match the wiki "Stages" page —
              PvE (red) vs PvP (grey) fights, portal (yellow) vs item-carousel (green) towns, prep neutral
              (see segmentBandKind). Behind the fill and markers; the track's own click handler still seeks. */}
          {index?.segments.map((s, i) => {
            const start = frac(s.t)
            const end = i + 1 < index.segments.length ? frac(index.segments[i + 1].t) : 1
            return (
              <div
                key={`band-${i}`}
                className={`rc-band ${segmentBandKind(s)}`}
                style={{ left: `${start * 100}%`, width: `${Math.max(0, end - start) * 100}%` }}
              />
            )
          })}
          <div className="rc-fill" style={{ width: `${pct}%` }} />
          <div className="rc-playhead" style={{ left: `${pct}%` }} />
          {/* Stage-start ticks only — the per-phase ticks were visual clutter. Click-to-seek to the stage;
              finer seeking is the hover tooltip + the ‹ › ⏮ ⏭ skip buttons. stopPropagation so the tick
              jumps to the boundary exactly, not the coarse track click. */}
          {index?.stages.map((st, i) => (
            <button
              key={`stage-${i}`}
              className="rc-mark stage"
              style={{ left: `${frac(st.t) * 100}%` }}
              onClick={(e) => {
                e.stopPropagation()
                onSeek(st.t)
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
                {seg ? (
                  <span className={`rc-hover-seg ${segmentBandKind(seg)}`}>
                    {t("replay.controls.pos", { stage: seg.stage, phase: seg.phaseLabel })}
                  </span>
                ) : null}
              </div>
            )
          })()}
      </div>

      {/* Row 2 — a centered 3-column bar: status badges (left) · transport (center) · tools (right).
          The center cell is `auto` between two equal `1fr` sides, so the transport cluster stays pinned to
          the middle no matter how wide the badges/tools get (no recentering when the stage·phase text or
          speed label changes width). */}
      <div className="rc-bar">
        <div className="rc-side rc-left">
          <span className="rc-handle" title={t("replay.controls.drag")} onMouseDown={onHandleDown}>
            ⠿
          </span>
          {/* Time + stage·phase as small PAC-style HUD pills (like the life/gold readouts). rc-pos doubles
              as the REPLAY / Replay-ended badge. */}
          <span className="rc-badge rc-time">
            {fmt(elapsed)}/{fmt(span)}
          </span>
          <span className={`rc-badge rc-pos${room.ended ? " ended" : ""}`}>
            {room.ended
              ? t("replay.controls.ended")
              : here
                ? t("replay.controls.pos", { stage: here.stage, phase: here.phaseLabel })
                : t("replay.controls.badge")}
          </span>
        </div>

        <div className="rc-center">
          {targets && (
            <>
              <button className="bubbly rc-skip" title={t("replay.controls.prev_stage")} disabled={targets.prevStage == null} onClick={() => go(prevStage)}>
                <RcIcon d={IC.skipPrevTri} d2={IC.skipPrevBar} />
              </button>
              <button className="bubbly rc-skip" title={t("replay.controls.prev_phase")} disabled={targets.prevPhase == null} onClick={() => go(prevPhase)}>
                <RcIcon d={IC.triLeft} />
              </button>
            </>
          )}

          <button
            className="bubbly blue rc-play"
            title={room.ended ? t("replay.controls.restart") : room.paused ? t("replay.controls.play") : t("replay.controls.pause")}
            onClick={() => (room.ended ? onRestart() : room.togglePause())}
          >
            {room.ended ? <RcIcon d={IC.restart} /> : room.paused ? <RcIcon d={IC.play} /> : <RcIcon d={IC.pauseL} d2={IC.pauseR} />}
          </button>

          {targets && (
            <>
              <button className="bubbly rc-skip" title={t("replay.controls.next_phase")} disabled={targets.nextPhase == null} onClick={() => go(nextPhase)}>
                <RcIcon d={IC.triRight} />
              </button>
              <button className="bubbly rc-skip" title={t("replay.controls.next_stage")} disabled={targets.nextStage == null} onClick={() => go(nextStage)}>
                <RcIcon d={IC.skipNextTri} d2={IC.skipNextBar} />
              </button>
            </>
          )}
        </div>

        <div className="rc-side rc-right">
          {/* Frame-step — the inspect-a-fight-tick-by-tick tool. While playing, the step handlers pause
              first, then advance/rewind one frame. Back is a reboot-seek (the decoder is forward-only) so
              it's a touch slower than forward. */}
          <span className="rc-step">
            <button className="bubbly rc-skip" title={t("replay.controls.step_back")} onClick={onStepBackward}>
              −1
            </button>
            <button className="bubbly rc-skip" title={t("replay.controls.step_forward")} onClick={onStepForward}>
              +1
            </button>
          </span>

          <select
            className="rc-speed-select"
            value={room.getSpeed()}
            onChange={(e) => room.setSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {speedLabel(s)}
              </option>
            ))}
          </select>

          <button
            className={`bubbly rc-events${eventLogOpen ? " blue" : ""}`}
            title={t("replay.controls.events")}
            onClick={onToggleEventLog}
          >
            ☰
          </button>
        </div>
      </div>
    </div>
  )
}
