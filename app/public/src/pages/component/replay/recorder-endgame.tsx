import { useEffect, useState } from "react"
import {
  downloadReplay,
  getActiveGameRoom,
  getStoredCaptureInfo
} from "../../../game/recorder"
import { useAppSelector } from "../../../hooks"
import "./replay-ui.css"

// Prominent "Download replay" button shown on the after-game screen. Uses the game room retained by
// the recorder (rooms.game is cleared once the game ends), so the match you just played is still
// available to download. Mounted alongside <AfterGame/> by the /after route — no edits to that page.
// Frame count/span come from the DURABLE store (so they reflect a recording that survived a crash +
// reconnect), polled while mounted as the final frames finish flushing. Styled with the game's native
// classes (.my-container/.bubbly) so it matches the after-game UI.
export default function RecorderEndGame() {
  const uid = useAppSelector((s) => s.network.uid)
  const room = getActiveGameRoom()
  const roomId = room?.roomId
  const [info, setInfo] = useState<{ frames: number; ms: number } | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = () =>
      getStoredCaptureInfo(room ?? undefined)
        .then((i) => alive && setInfo(i))
        .catch(() => {})
    refresh()
    const id = setInterval(refresh, 1500) // converge as the last frames flush to storage
    return () => {
      alive = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  if (!room || !info || info.frames === 0) return null

  return (
    <div className="recorder-endgame my-container">
      <span className="re-label">Match recorded</span>
      <span className="re-meta">
        {info.frames} frames · {Math.round(info.ms / 1000)}s
      </span>
      <button className="bubbly blue" onClick={() => void downloadReplay(room, uid)}>
        ⬇ Download replay
      </button>
      <span className="re-hint">opens in /replay</span>
    </div>
  )
}
