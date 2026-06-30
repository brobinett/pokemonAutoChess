import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  downloadReplay,
  getActiveGameRoom,
  getStoredCaptureInfo
} from "../../../game/recorder"
import { useAppSelector } from "../../../hooks"
import "./replay-ui.css"

// "Download replay" button shown on the after-game screen, just below its Back-to-Lobby button (rendered
// by <AfterGame/>). Uses the game room retained by the recorder (rooms.game is cleared once the game ends),
// so the match you just played is still available to download.
// The DURABLE store's frame count gates the button (poll while mounted as the final frames flush): show
// it only once a non-empty recording exists — survives a crash + reconnect — never for an empty capture.
// Styled with the game's native .bubbly button class so it matches the Back-to-Lobby button above it.
export default function RecorderEndGame() {
  const { t } = useTranslation()
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
    <div className="recorder-endgame">
      <button className="bubbly blue" onClick={() => void downloadReplay(room, uid)}>
        ⬇ {t("replay.endgame.download")}
      </button>
    </div>
  )
}
