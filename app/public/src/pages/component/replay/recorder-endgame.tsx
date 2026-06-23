import { downloadReplay, getActiveGameRoom, getCaptureInfo } from "../../../game/recorder"
import { useAppSelector } from "../../../hooks"
import "./replay-ui.css"

// Prominent "Download replay" button shown on the after-game screen. Uses the game room retained by
// the recorder (rooms.game is cleared once the game ends), so the match you just played is still
// available to download. Mounted alongside <AfterGame/> by the /after route — no edits to that page.
// Styled with the game's native classes (.my-container/.bubbly) so it matches the after-game UI.
export default function RecorderEndGame() {
  const uid = useAppSelector((s) => s.network.uid)
  const room = getActiveGameRoom()
  const info = getCaptureInfo(room ?? undefined)
  if (!room || info.frames === 0) return null

  return (
    <div className="recorder-endgame my-container">
      <span className="re-label">Match recorded</span>
      <span className="re-meta">
        {info.frames} frames · {Math.round(info.ms / 1000)}s
      </span>
      <button className="bubbly blue" onClick={() => downloadReplay(room, uid)}>
        ⬇ Download replay
      </button>
      <span className="re-hint">opens in /replay</span>
    </div>
  )
}
