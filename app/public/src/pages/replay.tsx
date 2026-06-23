import type { Room } from "@colyseus/sdk"
import type { User } from "@firebase/auth-types"
import { type CSSProperties, useEffect, useRef, useState } from "react"
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
// stream drives the same renderer that runs live. Loads either a served file (?file=…, used by the
// dev harness) or a file the player picks/drops (e.g. one they recorded + downloaded in-game).
//
// Playback start is gated on the Phaser scene's board existing: board/combat sprites are created by
// one-shot (triggerAll:false) schema onAdd callbacks, dropped if state is applied before the scene
// boots. So we reveal the UI (ReplayRoom emits LOADING_COMPLETE → scene boots), wait for
// `gameScene.board`, then play.
export default function Replay() {
  const dispatch = useAppDispatch()
  const [ready, setReady] = useState(false)
  const [needFile, setNeedFile] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initialized = useRef(false)
  const replayRoom = useRef<ReplayRoom | null>(null)

  const params = new URLSearchParams(window.location.search)
  const speed = Number(params.get("speed") ?? "1")
  const startMs = Number(params.get("startMs") ?? "0") // set by a backward scrub (reload-based seek)

  const loadManifest = (manifest: ReplayManifest) => {
    const room = new ReplayRoom(manifest, { speed, startMs })
    replayRoom.current = room
    rooms.game = room as unknown as Room<GameState>
    // Present the recording's viewer as the logged-in user so the page's "self" logic resolves.
    dispatch(logIn({ uid: manifest.viewerUid, displayName: manifest.viewerUid } as User))
    // Pre-set the spectated player so the renderer's map/board callbacks target the right player.
    const self = room.state?.players?.get(manifest.viewerUid)
    if (self) dispatch(setPlayer(self))
    setReady(true)
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    const file = params.get("file")
    if (!file) {
      setNeedFile(true) // no served URL → let the player pick/drop a downloaded recording
      return
    }
    fetch(file)
      .then((r) => {
        if (!r.ok) throw new Error(`failed to load ${file}: ${r.status}`)
        return r.json()
      })
      .then(loadManifest)
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  // Once <Game/> is mounted and revealed, wait for the Phaser scene to be fully render-ready before
  // starting the playback clock. Starting earlier (e.g. while the map/assets are still loading) makes
  // the wall-clock advance with nothing on screen — so when the scene finally draws, it has jumped
  // ahead. We gate on board + map existing AND the loader idle, and show a loading overlay meanwhile.
  useEffect(() => {
    if (!ready) return
    const room = replayRoom.current
    if (!room) return
    let cancelled = false
    const t0 = Date.now()
    const begin = (gc: ReturnType<typeof getGameContainer>) => {
      if (cancelled) return
      // A replay is a spectate session: enabling spectate makes clicking a player's portrait switch
      // to their board (playerClick only does the local view-switch when scene.spectate is true).
      if (gc) {
        gc.spectate = true
        if (gc.gameScene) gc.gameScene.spectate = true
      }
      room.startPlayback()
      setPlaying(true)
    }
    const waitReady = () => {
      if (cancelled) return
      const gc = getGameContainer()
      // Wait for the board (i.e. the scene's startGame ran). The loader is never fully idle in a game
      // scene, so we don't gate on it; instead, once the board exists we give the initial map/assets a
      // short grace to finish so playback doesn't open on a half-loaded scene. The 25s cap is a last
      // resort for a very slow boot.
      if (gc?.gameScene?.board) setTimeout(() => begin(gc), 2000)
      else if (Date.now() - t0 > 25000) begin(gc)
      else setTimeout(waitReady, 100)
    }
    waitReady()
    return () => {
      cancelled = true
    }
  }, [ready])

  const pick = (f: File) =>
    f
      .text()
      .then((txt) => loadManifest(JSON.parse(txt) as ReplayManifest))
      .catch((e) => setError(String(e?.message ?? e)))

  if (error) return <div id="status-message">Replay error: {error}</div>
  if (needFile && !ready) return <FilePicker onPick={pick} />
  if (!ready) return <div id="status-message">Loading replay…</div>
  return (
    <>
      <Game />
      {/* Cover the booting scene until playback starts, so it doesn't look frozen / start mid-round. */}
      {!playing && (
        <div style={P.wrap}>
          <div style={P.card}>
            <div style={P.title}>Loading replay…</div>
            <div style={P.sub}>preparing the match</div>
          </div>
        </div>
      )}
      {replayRoom.current && <ReplayControls room={replayRoom.current} />}
    </>
  )
}

function FilePicker({ onPick }: { onPick: (f: File) => void }) {
  const [over, setOver] = useState(false)
  return (
    <div
      style={P.wrap}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files?.[0]
        if (f) onPick(f)
      }}
    >
      <div style={{ ...P.card, ...(over ? P.cardOver : null) }}>
        <div style={P.title}>Watch a replay</div>
        <div style={P.sub}>
          Drop a <code>.colreplay.json</code> file here, or choose one:
        </div>
        <input
          type="file"
          accept=".json,.colreplay,application/json"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onPick(f)
          }}
        />
      </div>
    </div>
  )
}

const P: Record<string, CSSProperties> = {
  wrap: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#11151c",
    color: "#dfe5ef",
    font: "14px/1.5 sans-serif"
  },
  card: {
    padding: "28px 36px",
    background: "rgba(28,33,45,0.95)",
    border: "1px dashed #3a4358",
    borderRadius: 12,
    textAlign: "center",
    maxWidth: 420
  },
  cardOver: { borderColor: "#3b7ddd", background: "rgba(40,60,95,0.95)" },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 8 },
  sub: { opacity: 0.8, marginBottom: 16 }
}
