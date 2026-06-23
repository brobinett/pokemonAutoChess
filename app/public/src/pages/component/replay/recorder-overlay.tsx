import { type CSSProperties, useEffect, useState } from "react"
import { downloadReplay, getCaptureInfo } from "../../../game/recorder"
import { useAppSelector } from "../../../hooks"
import { rooms } from "../../../network"

// Small overlay shown during a game: a recording indicator + a "Download replay" button that saves
// what this client has received so far as a .colreplay (playable in /replay). Mounted alongside
// <Game/> by the /game route, so it needs no edits to the game page itself.
export default function RecorderOverlay() {
  const uid = useAppSelector((s) => s.network.uid)
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => (n + 1) % 1e6), 500)
    return () => clearInterval(id)
  }, [])

  const room = rooms.game
  const info = getCaptureInfo(room)
  const ready = !!room && info.frames > 0
  const secs = Math.round(info.ms / 1000)

  return (
    <div style={S.bar}>
      <span style={S.dot} />
      <span style={S.label}>REC</span>
      <span style={S.meta}>
        {info.frames} frames · {secs}s
      </span>
      <button
        style={{ ...S.btn, ...(ready ? null : S.btnDisabled) }}
        disabled={!ready}
        title={ready ? "Download this match as a .colreplay" : "Nothing recorded yet"}
        onClick={() => room && downloadReplay(room, uid)}
      >
        ⬇ Download replay
      </button>
    </div>
  )
}

const S: Record<string, CSSProperties> = {
  bar: {
    position: "fixed",
    top: 8,
    right: 8,
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 10px",
    background: "rgba(20,24,33,0.92)",
    border: "1px solid #3a4358",
    borderRadius: 8,
    color: "#dfe5ef",
    font: "12px/1 sans-serif",
    boxShadow: "0 2px 10px rgba(0,0,0,0.4)",
    userSelect: "none"
  },
  dot: { width: 9, height: 9, borderRadius: "50%", background: "#e0556b", boxShadow: "0 0 6px #e0556b" },
  label: { letterSpacing: 1, fontWeight: 700 },
  meta: { opacity: 0.7, fontVariantNumeric: "tabular-nums" },
  btn: {
    height: 26,
    padding: "0 10px",
    background: "#3b7ddd",
    border: "1px solid #3b7ddd",
    borderRadius: 5,
    color: "#fff",
    cursor: "pointer"
  },
  btnDisabled: { background: "#2b3346", borderColor: "#3a4358", color: "#7a8499", cursor: "default" }
}
