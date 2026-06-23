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
import ReplayErrorBoundary from "./component/replay/replay-error-boundary"
import "./component/replay/replay-readonly.css"
import Game, { getGameContainer } from "./game"

// The own-POV action controls (lock shop, reroll, buy XP, buy from shop, pick a proposition) are
// rendered by the unchanged game UI and would call into the (no-op) ReplayRoom.send — i.e. they look
// clickable but do nothing. Rather than edit those game components, we mark <body> read-only and
// swallow their clicks in the capture phase (before React's handlers run). The board is already
// read-only because the viewer runs with spectate enabled (pokemon sprites are only draggable when
// scene.spectate === false). Shop slots keep their hover tooltips — only the buy-click is blocked.
const READONLY_CONTROLS =
  ".game-shop-actions .lock-icon," +
  ".game-shop-actions .refresh-button," +
  ".game-experience .buy-xp-button," +
  ".game-pokemons-store .game-pokemon-portrait.clickable," +
  ".game-choice .clickable"

function installReadonlyGuard(): () => void {
  document.body.classList.add("replay-mode")
  const block = (e: Event) => {
    const target = e.target
    if (target instanceof Element && target.closest(READONLY_CONTROLS)) {
      e.stopPropagation()
      e.preventDefault()
    }
  }
  document.addEventListener("click", block, true)
  return () => {
    document.body.classList.remove("replay-mode")
    document.removeEventListener("click", block, true)
  }
}

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
  const [seeking, setSeeking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gen, setGen] = useState(0) // identifies the current boot → keys the mounted <Game/>
  const [showGame, setShowGame] = useState(false) // unmounted between boots so the old scene is gone first
  const [bootNonce, setBootNonce] = useState(0) // drives the step-2 (rebuild) effect, one per boot
  const initialized = useRef(false)
  const replayRoom = useRef<ReplayRoom | null>(null)
  const manifestRef = useRef<ReplayManifest | null>(null)
  const bootPausedRef = useRef(false)
  const pendingBoot = useRef<{ atMs: number; paused: boolean; speed: number } | null>(null)

  const params = new URLSearchParams(window.location.search)
  const speed = Number(params.get("speed") ?? "1")
  const startMs = Number(params.get("startMs") ?? "0") // optional deep-link start offset

  // Make the viewer read-only: dim the inert own-POV action controls and swallow their clicks.
  useEffect(installReadonlyGuard, [])

  // Boot (or, on a seek, reboot) the viewer at time `atMs`. We ALWAYS start from a fresh ReplayRoom +
  // scene fast-forwarded to the target — the one render path known to be correct (it's how the carousel
  // start works), so seeking never breaks board/combat sprites, and it's in-page (no reload), so a
  // dropped-file replay survives a backward seek.
  //
  // Two steps, to avoid a Phaser lifecycle race (a new game booting while the old one's deferred
  // destroy() is still in flight throws on the torn-down scene): step 1 here just stops the old room and
  // unmounts <Game/> (its host cleanup destroys the old Phaser game); step 2 (the effect below) waits a
  // beat for that teardown, then builds the fresh room and remounts. `isSeek` preserves play/pause+speed.
  const boot = (atMs: number, isSeek: boolean) => {
    if (!manifestRef.current) return
    const prev = replayRoom.current
    pendingBoot.current = {
      atMs: Math.max(0, atMs),
      paused: isSeek ? !!prev?.paused : false,
      speed: prev?.getSpeed() ?? speed
    }
    prev?.pause() // stop the outgoing timer so it can't apply frames into the scene being torn down
    setSeeking(isSeek)
    setPlaying(false)
    setShowGame(false) // unmount <Game/> → ReplayGameHost cleanup destroys the old Phaser game
    setBootNonce((n) => n + 1)
  }

  // Step 2 of boot: once <Game/> has unmounted, give Phaser a beat to finish its deferred teardown, then
  // build the fresh room (and run the "self" dispatches now that no stale game components are mounted)
  // and remount. Re-fires per boot via bootNonce.
  useEffect(() => {
    const job = pendingBoot.current
    if (!job) return
    let cancelled = false
    const id = setTimeout(() => {
      if (cancelled) return
      const manifest = manifestRef.current
      if (!manifest) return
      const room = new ReplayRoom(manifest, { speed: job.speed, startMs: job.atMs })
      replayRoom.current = room
      rooms.game = room as unknown as Room<GameState>
      // Present the recording's viewer as the logged-in user so the page's "self" logic resolves.
      dispatch(logIn({ uid: manifest.viewerUid, displayName: manifest.viewerUid } as User))
      // Pre-set the spectated player so the renderer's map/board callbacks target the right player.
      const self = room.state?.players?.get(manifest.viewerUid)
      if (self) dispatch(setPlayer(self))
      bootPausedRef.current = job.paused
      pendingBoot.current = null
      setReady(true)
      setShowGame(true)
      setGen((g) => g + 1)
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [bootNonce])

  const loadManifest = (manifest: ReplayManifest) => {
    manifestRef.current = manifest
    boot(startMs, false)
  }

  // Controls callbacks: every seek (either direction) and restart reboots at the target — see boot().
  const seekTo = (ms: number) => boot(ms, true)
  const restart = () => boot(0, true)

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
  // After each (re)boot, wait for the fresh Phaser scene to be render-ready, then start playback. Reruns
  // on every `gen` bump (initial load and each seek). We gate on the container belonging to the CURRENT
  // room so we don't latch onto the scene we just tore down during a seek.
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
      if (bootPausedRef.current) room.pause() // keep a paused scrub paused at the new time
      setPlaying(true)
    }
    const waitReady = () => {
      if (cancelled) return
      const gc = getGameContainer()
      const isCurrent = gc?.room === (room as unknown as Room<GameState>)
      // Wait for the current room's board (its startGame ran). The loader is never fully idle in a game
      // scene, so we don't gate on it; once the board exists we give the map/assets a short grace so
      // playback doesn't open on a half-loaded scene. The 25s cap is a last resort for a very slow boot.
      if (isCurrent && gc?.gameScene?.board) setTimeout(() => begin(gc), 2000)
      else if (Date.now() - t0 > 25000) begin(gc)
      else setTimeout(waitReady, 100)
    }
    waitReady()
    return () => {
      cancelled = true
    }
  }, [ready, gen])

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
      {/* The game is unmounted between boots (showGame=false) so the old Phaser scene is fully torn
          down before the next one mounts; keyed by `gen` for a clean boundary + fresh GameContainer per
          boot. ReplayErrorBoundary contains render errors (e.g. clicking unsupported UI) to a
          recoverable fallback instead of unmounting the whole app. */}
      {showGame && (
        <ReplayErrorBoundary key={gen}>
          <ReplayGameHost />
        </ReplayErrorBoundary>
      )}
      {/* Cover the (re)booting scene until playback starts (high z-index so it sits over the sidebar/HUD),
          so it doesn't look frozen / start mid-round, and so a seek doesn't flash the half-built scene. */}
      {!playing && (
        <div style={{ ...P.wrap, zIndex: 1500 }}>
          <div style={P.card}>
            <div style={P.title}>{seeking ? "Seeking…" : "Loading replay…"}</div>
            <div style={P.sub}>{seeking ? "rebuilding the scene" : "preparing the match"}</div>
          </div>
        </div>
      )}
      {replayRoom.current && (
        <ReplayControls room={replayRoom.current} onSeek={seekTo} onRestart={restart} />
      )}
    </>
  )
}

// Wraps the unchanged <Game/> and destroys its Phaser game on unmount. Nothing else does (the game's
// own teardown only runs on the leave flow), and a seek unmounts this host to start a fresh scene, so
// the old game must be torn down here or it leaks and its callbacks fire into a dead scene.
function ReplayGameHost() {
  useEffect(
    () => () => {
      try {
        getGameContainer()?.game?.destroy(true)
      } catch {
        /* already gone */
      }
    },
    []
  )
  return <Game />
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
