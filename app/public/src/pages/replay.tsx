import type { Room } from "@colyseus/sdk"
import type { User } from "@firebase/auth-types"
import firebase from "firebase/compat/app"
import { useEffect, useRef, useState } from "react"
import pkg from "../../../../package.json"
import type GameState from "../../../rooms/states/game-state"
import { GamePhaseState } from "../../../types/enum/Game"
import {
  buildReplayIndex,
  nextPhase,
  nextStage,
  prevPhase,
  prevStage,
  type ReplayIndex
} from "../game/replay-index"
import {
  deleteStoredReplay,
  downloadStoredReplay,
  listReplays,
  loadStoredReplay,
  type ReplayFileInfo
} from "../game/recorder"
import { buildSkewMessage, loadReplay } from "../game/replay-format"
import { ReplayRoom, type ReplayManifest } from "../game/replay-room"
import { useAppDispatch, useAppSelector } from "../hooks"
import { rooms } from "../network"
import { usePreference } from "../preferences"
import { leaveGame, setPlayer } from "../stores/GameStore"
import { logIn } from "../stores/NetworkStore"
import ReplayControls from "./component/replay/replay-controls"
import ReplayEventLog from "./component/replay/replay-event-log"
import ReplayErrorBoundary from "./component/replay/replay-error-boundary"
import "./component/replay/replay-readonly.css"
import "./component/replay/replay-ui.css" // overlay/file-picker styles (needed before ReplayControls mounts)
import Game, { getGameContainer, reattachReplayRoom } from "./game"
import { clearPortraitBase64Cache } from "./component/game/game-pokemon-portrait"

// The build running this viewer, read from package.json the same way the recorder stamps it into the file
// header (recorder.ts GAME_BUILD). Compared against the recorded build on load to warn on schema skew.
const RUNNING_BUILD = { version: pkg.version, assetsVersion: pkg.assetsVersion }

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
  // Suppress the browser's native context menu across the whole replay route. The live game already
  // does this on `#game-wrapper` (right-click is PAC's unit/item detail, handled by Phaser, not the DOM
  // contextmenu event) — but the replay's own overlays (loading/seeking/error cards, file picker,
  // controls bar) render as SIBLINGS of `#game-wrapper`, so a right-click on them escapes that handler
  // and pops the browser menu (most visibly while the seek/loading overlay covers the screen). A
  // capture-phase document handler closes that gap without touching the live page.
  const blockContextMenu = (e: Event) => e.preventDefault()
  document.addEventListener("click", block, true)
  document.addEventListener("contextmenu", blockContextMenu, true)
  return () => {
    document.body.classList.remove("replay-mode")
    document.removeEventListener("click", block, true)
    document.removeEventListener("contextmenu", blockContextMenu, true)
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
  const [buildSkew, setBuildSkew] = useState<string | null>(null) // set at load when the recording's build != the running build; shown in the loading overlay
  const [gen, setGen] = useState(0) // keys the mounted <Game/>; bumps only on the initial mount (seeks re-attach in place)
  const [showGame, setShowGame] = useState(false) // <Game/> mounts once and stays mounted; seeks re-attach the scene
  const [seekEpoch, setSeekEpoch] = useState(0) // bumps per (re)boot to (re)run the wait-for-scene → startPlayback effect
  const [eventLogOpen, setEventLogOpen] = useState(false) // owned here so its toggle can live in the control bar
  const initialized = useRef(false)
  const replayRoom = useRef<ReplayRoom | null>(null)
  const manifestRef = useRef<ReplayManifest | null>(null)
  const indexRef = useRef<ReplayIndex | null>(null) // phase/stage/event index — built synchronously per manifest
  const bootPausedRef = useRef(false)
  // The spectated board at the moment a seek begins. A re-attach restarts the scene, which builds a
  // brand-new BoardManager; we wait for `board !== prevBoard` so we don't latch onto the outgoing scene.
  const prevBoardRef = useRef<unknown>(null)
  // The player the viewer is currently watching, carried across a seek so the new scene re-centres on
  // the SAME board rather than snapping to whoever the recorded POV was looking at at the seek target
  // (the POV's spectatedPlayerId, a synced field, drives the board otherwise). Defaults to the
  // recording's POV player on the initial load; refreshed to the live view at the start of each seek.
  const spectateTargetRef = useRef<string | null>(null)
  // While a seek is rebuilding the scene, room.currentMs is stale (the new room/scene isn't ready yet),
  // so phase/stage skips would all recompute the same jump from the frozen position — rapid clicks or a
  // held arrow key wouldn't accumulate. Track the in-flight seek target and navigate relative to it
  // until the seek settles; then fall back to the live position. Cleared in begin() when the scene is up.
  const seekTargetRef = useRef<number | null>(null)
  const navMs = () =>
    seekTargetRef.current ?? replayRoom.current?.currentMs ?? 0
  // Serialize seeks. A seek restarts the Phaser scene (reattachReplayRoom → scene.start); firing another
  // scene.start before the first finishes rebuilding stacks restarts and can wedge the renderer (the
  // rapid-seek "stuck forever" hang). seekInFlight is true from a seek boot() until its begin() settles;
  // a seek requested meanwhile just records its target in pendingSeek (and updates navMs), and begin()
  // applies the latest one as a single clean reboot once the current seek lands.
  const seekInFlightRef = useRef(false)
  const pendingSeekRef = useRef<number | null>(null)

  const params = new URLSearchParams(window.location.search)
  const speed = Number(params.get("speed") ?? "1")
  const startMs = Number(params.get("startMs") ?? "0") // optional deep-link start offset
  // Dev/test only: with ?debug, expose the ReplayRoom on window so the headless verify harnesses can read
  // ms-precise playback state. Off by default, so the upstream build ships no global hook.
  const debug = params.get("debug") != null

  // The real signed-in identity, captured on first render BEFORE the first boot overwrites Redux's
  // network.uid with the recording's POV uid (so the renderer treats the recorded player as "self").
  // We must restore it when the viewer unmounts: starting a live game does NOT re-dispatch logIn
  // (only auth-state changes do), so a leftover replay uid makes the next game fail to resolve "self"
  // — its shop never refreshes off the replay's (the phantom Herdier slot) and self/board/combat
  // rendering breaks (blank-screen crash at the first PvP). Captured once via the ref guard.
  const realUid = useAppSelector((s) => s.network.uid)
  const realDisplayName = useAppSelector((s) => s.network.displayName)
  const realIdentity = useRef<{ uid: string; displayName: string } | null>(null)
  if (realIdentity.current === null && realUid) {
    realIdentity.current = { uid: realUid, displayName: realDisplayName }
  }

  // Make the viewer read-only: dim the inert own-POV action controls and swallow their clicks.
  useEffect(installReadonlyGuard, [])

  // Full teardown on leaving the /replay route (any exit path — leave button, sidebar nav, back
  // button): restore the real session so the next live game is clean. Restores the real uid, resets
  // the GameStore (clears the spectated player's stale shop/board/players), and drops the dead
  // ReplayRoom from rooms.game. Without this, replay state leaks into the next real match.
  useEffect(
    () => () => {
      // Restore the real uid. Prefer the captured Redux identity (keeps the real displayName); fall back
      // to firebase.auth().currentUser — the replay only ever overwrites the Redux uid, never firebase —
      // so the restore can't be defeated even if the early capture missed a not-yet-resolved auth.
      const captured = realIdentity.current
      const fbUser = firebase.auth().currentUser
      const real = captured?.uid
        ? captured
        : fbUser
          ? { uid: fbUser.uid, displayName: fbUser.displayName ?? "" }
          : null
      if (real?.uid)
        dispatch(
          logIn({ uid: real.uid, displayName: real.displayName } as User)
        )
      dispatch(leaveGame(undefined)) // arity-0 reducer; RTK types it as needing an (ignored) payload
      rooms.game = undefined
      // Drop the dev/test hooks so they can't retain the last ReplayRoom (+ its whole transcript) or the
      // game scene into the next live game.
      delete (window as unknown as { __replayRoom?: ReplayRoom }).__replayRoom
      delete (window as unknown as { __gameScene?: () => unknown }).__gameScene
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Boot the viewer at time `atMs`. A fresh ReplayRoom is built with its decoder fast-forwarded to the
  // target (cheap — pure decode), then:
  //  - INITIAL load: mount <Game/> once, which creates the Phaser game (assets load) and binds it.
  //  - SEEK (game already mounted): RE-ATTACH — swap the live GameContainer/scene onto the fresh room
  //    without tearing down Phaser, so the loaded assets are reused and the seek is near-instant. The
  //    decoder is forward-only, so a backward seek is just a fresh decoder fast-forwarded to the target;
  //    re-attach makes that as cheap as a forward one. `isSeek` preserves play/pause + speed + focus.
  const boot = (atMs: number, isSeek: boolean) => {
    const manifest = manifestRef.current
    if (!manifest) return
    const prev = replayRoom.current
    const target = Math.max(0, atMs)
    // A seek is still rebuilding the scene: don't start a second scene.start now (stacking restarts is
    // what wedges the renderer). Record the latest target — begin() will apply it as one clean reboot
    // when the in-flight seek lands — and keep navMs accumulating toward it. (Initial load is never a
    // seek, so it's never blocked here.)
    if (isSeek && seekInFlightRef.current) {
      pendingSeekRef.current = target
      seekTargetRef.current = target
      return
    }
    if (isSeek) seekInFlightRef.current = true
    // Carry play/pause across a seek (a paused scrub stays paused) EXCEPT when (re)starting after the
    // replay ended: finish() leaves the room paused+ended, so without the !ended guard a restart would
    // boot paused and the play button would need a second press to actually play.
    bootPausedRef.current = isSeek && !prev?.ended ? !!prev?.paused : false
    seekTargetRef.current = target // navigate relative to this until the seek settles (begin() clears it)
    prev?.pause() // stop the outgoing timer so it can't apply frames into the scene being re-attached

    const room = new ReplayRoom(manifest, {
      speed: prev?.getSpeed() ?? speed,
      startMs: target
    })
    replayRoom.current = room
    // Dev/test hook (?debug only): lets the headless verify harness read playback state (currentMs, focus,
    // paused) at ms precision, below the controls' mm:ss display. Off in the shipped build.
    if (debug) {
      (window as unknown as { __replayRoom?: ReplayRoom }).__replayRoom = room
      // Live accessor for the Phaser scene, so headless harnesses can assert the renderer actually
      // built sprites (board/combat/carousel) — the seek-heavy suites only ever exercised the
      // re-attach path and missed an initial-load scene that silently built nothing.
      ;(
        window as unknown as { __gameScene?: () => unknown }
      ).__gameScene = () => getGameContainer()?.gameScene
    }
    rooms.game = room as unknown as Room<GameState>
    // Who to watch after this (re)boot: keep the player the viewer is currently on across a seek
    // (read the live GameContainer BEFORE the re-attach restarts its scene); default to the recording's
    // POV player on the initial load.
    spectateTargetRef.current = isSeek
      ? getGameContainer()?.player?.id ??
        spectateTargetRef.current ??
        manifest.viewerUid
      : manifest.viewerUid
    // Pre-set the spectated player so the renderer's map/board callbacks target the right player.
    const watched =
      room.state?.players?.get(spectateTargetRef.current) ??
      room.state?.players?.get(manifest.viewerUid)
    if (watched) dispatch(setPlayer(watched))
    // A recording that spanned a disconnect/reconnect has a 2nd handshake mid-stream; crossing it during
    // timed playback would swap the decoder and freeze the renderer. Re-attach across it via the seek
    // path (which rebuilds the decoder with no renderer attached, then re-binds) — the boundary frame's
    // huge wall-clock gap is collapsed by the seek too.
    room.onRebindNeeded((ms) => boot(ms, true))
    setSeeking(isSeek)
    setPlaying(false)

    const gc = getGameContainer()
    if (isSeek && gc?.game) {
      // Re-attach: remember the outgoing board so the wait-effect can tell the fresh scene apart, then
      // re-point the persistent GameContainer at the new room and restart its scene (Phaser kept alive).
      prevBoardRef.current = gc.gameScene?.board ?? null
      reattachReplayRoom(
        room as unknown as Room<GameState>,
        spectateTargetRef.current ?? undefined
      )
    } else {
      // Initial load: present the recording's viewer as the logged-in user so the page resolves "self",
      // then mount <Game/> (its init creates the Phaser game + installs the re-attach hook).
      dispatch(
        logIn({
          uid: manifest.viewerUid,
          displayName: manifest.viewerUid
        } as User)
      )
      prevBoardRef.current = null
      setReady(true)
      setShowGame(true)
      setGen((g) => g + 1)
    }
    setSeekEpoch((n) => n + 1) // (re)run the wait-for-scene effect → startPlayback once the board is ready
  }

  const loadManifest = (manifest: ReplayManifest) => {
    manifestRef.current = manifest
    // Warn when the recording's stamped build differs from this client's: a structural schema change makes
    // per-frame patches throw and silently skip, degrading to a frozen/partial scene. We still attempt
    // playback — same-shape patch releases usually decode fine — but the loading overlay shows this so the
    // degradation is explained up front rather than leaving it mysterious. (Rendered in the load overlays.)
    setBuildSkew(buildSkewMessage(manifest.game, RUNNING_BUILD))
    // Build the index (phase/stage boundaries + eliminations + per-player event log) for the skip controls,
    // timeline markers, and event log. Synchronous on purpose: it runs while the CSS-animated "Loading
    // replay" spinner is up (pick() / the served-file path switch to it first), and boot() reveals the
    // controls + log together once it's done — no progressive pop-in. Enhancement-only, so a decode hiccup
    // must not block playback: swallow errors. (The combat status/stat scan dominates the cost on a long
    // capture; if that ever needs to come off the critical path, derive it lazily when Status/Stats is
    // enabled rather than eagerly — that keeps the common build fast without a worker. See BACKLOG.)
    try {
      indexRef.current = buildReplayIndex(manifest.frames, manifest.viewerUid)
    } catch (e) {
      console.error("[replay] failed to build index", e)
      indexRef.current = null
    }
    boot(startMs, false)
  }

  // Controls callbacks: every seek (either direction) and restart reboots at the target — see boot().
  const seekTo = (ms: number) => boot(ms, true)
  const restart = () => boot(0, true)

  // Frame-step. Forward is instant (apply the next state update in place); backward is a reboot-seek
  // to the previous state/patch frame (the decoder is forward-only, so there's no in-place rewind).
  const stepForward = () => replayRoom.current?.stepForward()
  const stepBackward = () => {
    const room = replayRoom.current
    const frames = manifestRef.current?.frames
    if (!room || !frames) return
    room.pause() // frame-stepping implies paused (mirrors stepForward) so the reboot-seek lands paused
    let prevT = 0
    for (const f of frames) {
      if (f.kind === "message") continue
      if (f.t < room.currentMs) prevT = f.t
      else break
    }
    seekTo(prevT)
  }

  const SPEEDS = [0.5, 1, 2, 4]
  const cycleSpeed = (dir: number) => {
    const room = replayRoom.current
    if (!room) return
    const i = SPEEDS.indexOf(room.getSpeed())
    room.setSpeed(
      SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 1 : i) + dir))]
    )
  }

  // Keyboard shortcuts. Registered in the capture phase so they beat the game's own in-scene hotkeys
  // (which are no-ops in a replay anyway). Refs keep the once-registered handler current.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const room = replayRoom.current
      if (!room) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      const idx = indexRef.current
      const seekIf = (t: number | null) => t != null && seekTo(t)
      let handled = true
      switch (e.key) {
        case " ":
          room.ended ? restart() : room.togglePause()
          break
        case "ArrowRight":
          seekIf(
            idx &&
              (e.shiftKey ? nextStage(idx, navMs()) : nextPhase(idx, navMs()))
          )
          break
        case "ArrowLeft":
          seekIf(
            idx &&
              (e.shiftKey ? prevStage(idx, navMs()) : prevPhase(idx, navMs()))
          )
          break
        case "ArrowUp":
          cycleSpeed(1)
          break
        case "ArrowDown":
          cycleSpeed(-1)
          break
        case "Home":
          seekTo(0)
          break
        case "End":
          seekTo(room.totalMs)
          break
        case ".":
          stepForward()
          break
        case ",":
          stepBackward()
          break
        default:
          handled = false
      }
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        return r.arrayBuffer() // bytes, not .json() — loadReplay sniffs v1-binary vs v0-JSON
      })
      .then((buf) => loadManifest(loadReplay(buf)))
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
    let pending: ReturnType<typeof setTimeout> | null = null // the in-flight poll OR grace timer
    const t0 = Date.now()
    const begin = (gc: ReturnType<typeof getGameContainer>) => {
      if (cancelled) return
      seekTargetRef.current = null // seek settled — navigate from the live position again
      // A replay is a spectate session: enabling spectate makes clicking a player's portrait switch
      // to their board (playerClick only does the local view-switch when scene.spectate is true).
      if (gc) {
        gc.spectate = true
        if (gc.gameScene) gc.gameScene.spectate = true
      }
      // Point the scene at the player the viewer should be watching (spectateTargetRef: the recording's
      // POV on the initial load, or the board carried across a seek). startGame() builds off
      // firebase.auth().currentUser (the real signed-in user, NOT the recorded POV) with spectate off,
      // or players[0] with spectate on — neither is necessarily the right board, and when the signed-in
      // uid isn't in the recording at all startGame builds nothing (black scene). setPlayer() here
      // re-centres on the intended player (and, on a seek, re-loads its map — a brief tileset reload).
      const watched = room.state?.players?.get(
        spectateTargetRef.current ?? manifestRef.current?.viewerUid ?? ""
      )
      if (gc && watched) gc.setPlayer(watched)
      room.startPlayback()
      if (bootPausedRef.current) room.pause() // keep a paused scrub paused at the new time
      // A mid-fight seek boots with the battle simulation already populated, so the one-shot combat
      // onAdd callbacks never fired and no unit sprites exist. Build them from the current simulation
      // (idempotent — addPokemonEntitySprite skips ids it already has) and make them visible. Prep-phase
      // board units are rebuilt by the BoardManager at startGame, so only FIGHT needs this.
      if (gc?.gameScene?.battle && room.state?.phase === GamePhaseState.FIGHT) {
        gc.gameScene.battle.buildPokemons()
        gc.gameScene.battle.onSimulationStart()
      }
      setPlaying(true)
      // Seek settled — release the serialization gate. If seeks were requested while this one was
      // rebuilding, they coalesced into pendingSeek (latest wins); apply it now as one clean reboot.
      // Cleared before the drained boot() so that boot proceeds instead of re-queuing onto itself.
      seekInFlightRef.current = false
      const pendingSeek = pendingSeekRef.current
      if (pendingSeek != null) {
        pendingSeekRef.current = null
        boot(pendingSeek, true)
      }
    }
    const waitReady = () => {
      if (cancelled) return
      const gc = getGameContainer()
      const isCurrent = gc?.room === (room as unknown as Room<GameState>)
      const board = gc?.gameScene?.board
      // Wait for the CURRENT room's scene to build a FRESH board (its startGame ran). A re-attach
      // restarts the scene → a brand-new BoardManager, so we compare against the outgoing board to avoid
      // latching onto the scene we just left. The loader is never fully idle in a game scene, so we
      // don't gate on it; once the fresh board exists we give the map/assets a short grace — brief on a
      // warm re-attach seek (assets cached), longer on the cold initial load. 25s cap = slow-boot guard.
      if (isCurrent && board && board !== prevBoardRef.current) {
        pending = setTimeout(() => begin(gc), prevBoardRef.current ? 600 : 2000)
      } else if (Date.now() - t0 > 25000) {
        begin(gc)
      } else {
        pending = setTimeout(waitReady, 100)
      }
    }
    waitReady()
    return () => {
      cancelled = true
      if (pending) clearTimeout(pending) // don't let a stale poll/grace timer fire begin() after a re-seek
    }
  }, [ready, seekEpoch])

  if (error)
    return (
      <div className="replay-overlay">
        <div className="my-container replay-overlay-card">
          <div className="replay-overlay-title">Replay error</div>
          <div className="replay-overlay-sub">{error}</div>
        </div>
      </div>
    )
  if (needFile && !ready)
    return (
      <ReplayLibrary
        // Swap the library for the "Loading replay" spinner BEFORE the (async) read, so the spinner — not a
        // frozen library — is on screen while the synchronous index build runs. The async read gives React a
        // chance to paint the spinner before the build blocks the main thread.
        onLoadStart={() => setNeedFile(false)}
        onManifest={loadManifest}
        onError={(msg) => setError(msg)}
      />
    )
  if (!ready)
    return (
      <div className="replay-overlay">
        <div className="my-container replay-overlay-card">
          <div className="replay-spinner" />
          <div className="replay-overlay-title">Loading replay…</div>
          <div className="replay-overlay-sub">preparing the match</div>
          {buildSkew && (
            <div className="replay-overlay-skew">⚠ {buildSkew}</div>
          )}
        </div>
      </div>
    )
  return (
    <>
      {/* <Game/> mounts once and stays mounted for the whole session — seeks re-attach the scene in
          place (reattachReplayRoom) rather than remount, so the Phaser game and its loaded assets
          persist. `gen` keys a clean boundary per mount (only the initial load bumps it).
          ReplayErrorBoundary contains render errors (e.g. clicking unsupported UI) to a recoverable
          fallback instead of unmounting the whole app. */}
      {showGame && (
        <ReplayErrorBoundary key={gen}>
          <ReplayGameHost />
        </ReplayErrorBoundary>
      )}
      {/* Cover the (re)booting scene until playback starts (high z-index so it sits over the sidebar/HUD),
          so it doesn't look frozen / start mid-round, and so a seek doesn't flash the half-built scene. */}
      {!playing && (
        <div className="replay-overlay">
          <div className="my-container replay-overlay-card">
            <div className="replay-spinner" />
            <div className="replay-overlay-title">
              {seeking ? "Seeking…" : "Loading replay…"}
            </div>
            <div className="replay-overlay-sub">
              {seeking ? "rebuilding the scene" : "preparing the match"}
            </div>
            {/* On the initial load only (not seeks — it'd nag on every scrub): warn when the recording's
                build differs from this client's. Shown here, during the multi-second load the user is
                already reading, rather than as a banner over playback. */}
            {buildSkew && !seeking && (
              <div className="replay-overlay-skew">⚠ {buildSkew}</div>
            )}
          </div>
        </div>
      )}
      {replayRoom.current && (
        <ReplayControls
          room={replayRoom.current}
          index={indexRef.current}
          navMs={navMs}
          onSeek={seekTo}
          onRestart={restart}
          onStepForward={stepForward}
          onStepBackward={stepBackward}
          eventLogOpen={eventLogOpen}
          onToggleEventLog={() => setEventLogOpen((o) => !o)}
        />
      )}
      {replayRoom.current && (
        <ReplayEventLog
          room={replayRoom.current}
          index={indexRef.current}
          onSeek={seekTo}
          open={eventLogOpen}
          onClose={() => setEventLogOpen(false)}
        />
      )}
    </>
  )
}

// Wraps the unchanged <Game/> and destroys its Phaser game on unmount. The game's own teardown only
// runs on the live leave flow (which a replay skips), and this host now stays mounted across seeks
// (they re-attach in place), so this fires only when leaving the /replay route — tearing the Phaser
// game down there so it doesn't leak or fire callbacks into a dead scene.
function ReplayGameHost() {
  useEffect(
    () => () => {
      try {
        // Drop the portrait base64 cache with the textures it mirrors, so a later recording (or a live
        // game entered after this route) with different POV customs can't show this one's cached sprites.
        clearPortraitBase64Cache()
        getGameContainer()?.game?.destroy(true)
      } catch {
        /* already gone */
      }
    },
    []
  )
  return <Game />
}

// Format a stored recording's timestamp for a list row: the header's recordedAt when present, else the
// file's mtime. Both are wall-clock instants shown in the viewer's locale.
function formatWhen(f: ReplayFileInfo): string {
  const ms = f.recordedAt ? Date.parse(f.recordedAt) : Number.NaN
  return new Date(Number.isFinite(ms) ? ms : f.mtime).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  })
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

// The /replay landing screen: a library of recordings stored in this browser (OPFS) plus the option to
// open an external `.colreplay` file. Each stored row can be Watched (loaded straight from OPFS — no
// manual file pick), Downloaded (to a portable file), or Deleted. A "keep most recent N" control edits the
// retention pref the recorder's new-game prune honors. onLoadStart fires the parent's spinner before a
// load; onManifest hands the parent a loaded manifest to boot; onError surfaces a failure.
function ReplayLibrary({
  onLoadStart,
  onManifest,
  onError
}: {
  onLoadStart: () => void
  onManifest: (m: ReplayManifest) => void
  onError: (msg: string) => void
}) {
  const [files, setFiles] = useState<ReplayFileInfo[] | null>(null) // null = still listing
  const [busy, setBusy] = useState(false) // a watch/download is in flight — disable row actions
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null) // roomId pending inline confirm
  const [over, setOver] = useState(false) // drag-over highlight for the external-file dropzone
  const [keep, setKeep] = usePreference("keepReplays")
  const [recording] = usePreference("recordReplays")
  const fail = (e: unknown) => onError(String((e as Error)?.message ?? e))

  const refresh = () =>
    listReplays()
      .then(setFiles)
      .catch(() => setFiles([]))
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const watchStored = (roomId: string) => {
    onLoadStart()
    loadStoredReplay(roomId).then(onManifest).catch(fail)
  }
  const watchFile = (f: File) => {
    onLoadStart()
    f.arrayBuffer()
      .then((b) => onManifest(loadReplay(b)))
      .catch(fail)
  }
  const download = (f: ReplayFileInfo) => {
    setBusy(true)
    downloadStoredReplay(f.roomId, f.recordedAt)
      .catch(fail)
      .finally(() => setBusy(false))
  }
  const remove = (roomId: string) => {
    setConfirmDelete(null)
    deleteStoredReplay(roomId).then(refresh).catch(fail)
  }

  return (
    <div className="replay-overlay">
      <div
        className="my-container replay-overlay-card replay-library-card"
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files?.[0]
          if (f) watchFile(f)
        }}
      >
        <div className="replay-overlay-title">Watch a replay</div>

        <div className="replay-library">
          <div className="replay-library-head">
            <span className="replay-library-label">Saved in this browser</span>
            <label className="replay-keep">
              Keep&nbsp;
              <select
                value={keep}
                onChange={(e) => setKeep(Number(e.target.value))}
              >
                {[1, 2, 3, 5, 10, 20].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              &nbsp;most recent
            </label>
          </div>

          {files === null ? (
            <div className="replay-library-empty">Loading saved replays…</div>
          ) : files.length === 0 ? (
            <div className="replay-library-empty">
              No replays are saved in this browser yet.{" "}
              {recording
                ? "They'll appear here after you finish a game."
                : "Recording is currently off — turn it on in Options."}
            </div>
          ) : (
            <ul className="replay-library-list">
              {files.map((f) => (
                <li key={f.roomId} className="replay-row">
                  <div className="replay-row-info">
                    <span className="replay-row-when">{formatWhen(f)}</span>
                    <span className="replay-row-meta">
                      {formatSize(f.bytes)}
                      {f.game ? ` · ${f.game.version}` : ""}
                      {f.game && buildSkewMessage(f.game, RUNNING_BUILD) ? (
                        <span
                          className="replay-row-skew"
                          title="Recorded on a different game build — playback may be incomplete"
                        >
                          other build
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {confirmDelete === f.roomId ? (
                    <div className="replay-row-actions">
                      <span className="replay-confirm-q">Delete?</span>
                      <button
                        className="bubbly red replay-row-btn"
                        onClick={() => remove(f.roomId)}
                      >
                        Yes
                      </button>
                      <button
                        className="bubbly replay-row-btn"
                        onClick={() => setConfirmDelete(null)}
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <div className="replay-row-actions">
                      <button
                        className="bubbly blue replay-row-btn"
                        disabled={busy}
                        onClick={() => watchStored(f.roomId)}
                      >
                        ▶ Watch
                      </button>
                      <button
                        className="bubbly replay-row-btn"
                        disabled={busy}
                        title="Download to your computer"
                        onClick={() => download(f)}
                      >
                        ⬇
                      </button>
                      <button
                        className="bubbly replay-row-btn"
                        title="Delete from this browser"
                        onClick={() => setConfirmDelete(f.roomId)}
                      >
                        🗑
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="replay-keep-hint">
            Older replays are removed automatically when you start a new game. Download any you want to keep
            — a downloaded file is permanent and shareable.
          </p>
        </div>

        <div className={`replay-dropzone${over ? " over" : ""}`}>
          <div className="replay-overlay-sub">
            Or open a <code>.colreplay</code> file from your computer:
          </div>
          <label className="bubbly blue replay-file-label">
            Choose a file
            <input
              type="file"
              accept=".json,.colreplay,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) watchFile(f)
              }}
            />
          </label>
        </div>

        <div className="replay-limitations">
          <div className="replay-limitations-title">About replays</div>
          <p>
            Replays are saved <strong>in this browser, on this device only</strong> — they aren't
            cloud-saved, backed up, or shared across devices or browsers. Clearing your browser's site data
            deletes them, and replays recorded in a private / incognito window disappear when you close it.
            Download the ones you want to keep.
          </p>
          <p>
            A replay is recorded from one player's client, so the event log rebuilds most of the match for{" "}
            <em>every</em> player from shared game state — use the per-player chips to follow anyone. A few
            things are only knowable for the recording player.
          </p>
          <div className="replay-limitations-sub">Reconstructed for all players</div>
          <ul>
            <li>
              boards, unit moves, evolutions, items, synergies, levels, gold &amp; life, round results,
              and eliminations
            </li>
            <li>
              in-combat <strong>status effects</strong>, <strong>stat changes</strong>,{" "}
              <strong>board effects</strong>, and each fight's <strong>weather</strong> — for every board
            </li>
            <li>
              <strong>digs</strong>, <strong>cooks</strong>, and <strong>emotes</strong> — shown under the
              player who did them
            </li>
          </ul>
          <div className="replay-limitations-sub">Only the recording player</div>
          <ul>
            <li>
              <strong>Shop</strong> — rerolls, buys, and shop removals. Everyone else's shop is hidden, so an
              opponent buying a unit just reads as "gained."
            </li>
            <li>
              <strong>Combat casts &amp; damage</strong> — ability casts and damage / heal numbers follow the
              recorder's camera (captured only for the board being watched), so scouting another board
              mid-fight gets you its casts but misses your own.
            </li>
            <li>
              <strong>Income breakdown</strong> — the per-round income split (base / interest / streak) is
              sent only to the recording player.
            </li>
          </ul>
          <p>A disconnect during recording leaves a short gap.</p>
        </div>
      </div>
    </div>
  )
}
