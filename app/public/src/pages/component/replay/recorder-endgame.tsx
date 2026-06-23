import { type CSSProperties } from "react"
import { downloadReplay, getActiveGameRoom, getCaptureInfo } from "../../../game/recorder"
import { useAppSelector } from "../../../hooks"

// Prominent "Download replay" button shown on the after-game screen. Uses the game room retained by
// the recorder (rooms.game is cleared once the game ends), so the match you just played is still
// available to download. Mounted alongside <AfterGame/> by the /after route — no edits to that page.
export default function RecorderEndGame() {
  const uid = useAppSelector((s) => s.network.uid)
  const room = getActiveGameRoom()
  const info = getCaptureInfo(room ?? undefined)
  if (!room || info.frames === 0) return null

  return (
    <div style={S.bar}>
      <span style={S.label}>Match recorded</span>
      <span style={S.meta}>
        {info.frames} frames · {Math.round(info.ms / 1000)}s
      </span>
      <button style={S.btn} onClick={() => downloadReplay(room, uid)}>
        ⬇ Download replay
      </button>
      <span style={S.hint}>opens in /replay</span>
    </div>
  )
}

const S: Record<string, CSSProperties> = {
  bar: {
    position: "fixed",
    bottom: 16,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    background: "rgba(20,24,33,0.95)",
    border: "1px solid #3a4358",
    borderRadius: 10,
    color: "#dfe5ef",
    font: "13px/1 sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,0.5)"
  },
  label: { fontWeight: 700, letterSpacing: 0.5 },
  meta: { opacity: 0.7, fontVariantNumeric: "tabular-nums" },
  btn: {
    height: 32,
    padding: "0 16px",
    background: "#3b7ddd",
    border: "1px solid #3b7ddd",
    borderRadius: 6,
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer"
  },
  hint: { opacity: 0.5, fontSize: 11 }
}
