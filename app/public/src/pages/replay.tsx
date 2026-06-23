import type { Room } from "@colyseus/sdk"
import type { User } from "@firebase/auth-types"
import { useEffect, useRef, useState } from "react"
import type GameState from "../../../rooms/states/game-state"
import { ReplayRoom, type ReplayManifest } from "../game/replay-room"
import { useAppDispatch } from "../hooks"
import { rooms } from "../network"
import { setPlayer } from "../stores/GameStore"
import { logIn } from "../stores/NetworkStore"
import ReplayControls from "./component/replay/replay-controls"
import Game, { getGameContainer } from "./game"

// Replay viewer: load a recorded `.colreplay` transcript, present it to the existing game page as a
// ReplayRoom, and render the unchanged <Game/> UI. No server, no re-simulation — the recorded state
// stream drives the same renderer that runs live.
//
//   /replay?file=/replays/sample.colreplay.json&speed=1
//
// Playback start is gated on the Phaser scene's board existing: board/combat sprites are created by
// one-shot (triggerAll:false) schema onAdd callbacks, which are dropped if state is applied before
// the scene has booted. So we reveal the UI (ReplayRoom emits LOADING_COMPLETE → the scene boots),
// wait for `gameScene.board`, then start playing the queue.
export default function Replay() {
  const dispatch = useAppDispatch()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initialized = useRef(false)
  const replayRoom = useRef<ReplayRoom | null>(null)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const params = new URLSearchParams(window.location.search)
    const file = params.get("file") ?? "/replays/sample.colreplay.json"
    const speed = Number(params.get("speed") ?? "1")
    const startMs = Number(params.get("startMs") ?? "0") // set by a backward scrub (reload-based seek)

    fetch(file)
      .then((r) => {
        if (!r.ok) throw new Error(`failed to load ${file}: ${r.status}`)
        return r.json()
      })
      .then((manifest: ReplayManifest) => {
        const room = new ReplayRoom(manifest, { speed, startMs })
        replayRoom.current = room
        rooms.game = room as unknown as Room<GameState>
        // Present the recording's viewer as the logged-in user so the page's "self" logic resolves.
        dispatch(
          logIn({
            uid: manifest.viewerUid,
            displayName: manifest.viewerUid
          } as User)
        )
        // Pre-set the spectated player so the renderer's map/board callbacks target the right player.
        const self = room.state?.players?.get(manifest.viewerUid)
        if (self) dispatch(setPlayer(self))
        setReady(true)
      })
      .catch((e) => setError(String(e?.message ?? e)))
  }, [dispatch])

  // Once <Game/> is mounted and revealed, wait for the Phaser board to exist, then play the match.
  useEffect(() => {
    if (!ready) return
    const room = replayRoom.current
    if (!room) return
    let cancelled = false
    const t0 = Date.now()
    const waitForBoard = () => {
      if (cancelled) return
      const board = getGameContainer()?.gameScene?.board
      if (board || Date.now() - t0 > 15000) {
        room.startPlayback()
      } else {
        setTimeout(waitForBoard, 100)
      }
    }
    waitForBoard()
    return () => {
      cancelled = true
    }
  }, [ready])

  if (error) return <div id="status-message">Replay error: {error}</div>
  if (!ready) return <div id="status-message">Loading replay…</div>
  return (
    <>
      <Game />
      {replayRoom.current && <ReplayControls room={replayRoom.current} />}
    </>
  )
}
