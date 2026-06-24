import { SchemaSerializer, type Room } from "@colyseus/sdk"
import type { Iterator } from "@colyseus/schema"
import type GameState from "../../../rooms/states/game-state"
import { GamePhaseState } from "../../../types/enum/Game"

// "Focus" auto-speed: watch one part of the match at the chosen speed and fast-forward the rest, by
// flexing the playback cadence per phase (no reboot/seek — it just changes the frame interval).
//   "off"    — the chosen speed everywhere
//   "prep"   — fast-forward PICK/TOWN, watch FIGHTs at the chosen speed (the action)
//   "fights" — fast-forward FIGHTs, watch PICK/TOWN at the chosen speed (where the player actually decides)
export type FocusMode = "off" | "prep" | "fights"
const FAST_SPEED = 8 // multiplier used for the fast-forwarded phase

// A ReplayRoom plays back a recorded match transcript through the EXISTING client renderer
// without a live server. The client renders entirely from Colyseus decoder callbacks
// (GameContainer: `this.$ = getStateCallbacks(room)` → `$(state)...onAdd/listen`), and
// `getStateCallbacks(room)` only needs `room.serializer.decoder`. We hold a real SchemaSerializer,
// seed it from the recorded `handshake` frame (which carries the schema reflection, so no live
// connection is needed), apply the initial full `state`, then play the remaining `patch` frames on
// a timer at the recorded cadence. Each applied frame fires the same decoder callbacks the renderer
// already subscribes to — so combat, prep, economy etc. animate exactly as they did live.
//
// This is purely additive: it implements the subset of the Colyseus `Room` surface the game page
// uses, so no edits to game.tsx / game-container.ts are required.

export interface ReplayFrame {
  t: number // ms since the first frame
  kind: "handshake" | "state" | "patch" | "message"
  // state frames (handshake/state/patch):
  offset?: number // decoder payload start within the frame bytes
  b64?: string // base64 of the whole inbound message buffer
  // message frames (ROOM_DATA): a typed onMessage event
  type?: string | number
  payload?: unknown // JSON value, or { __bytes__: base64 } for ROOM_DATA_BYTES
}

export interface ReplayManifest {
  format: string
  schemaVersion: number
  game: { version: string; commit: string; serializerId: string }
  room: string
  viewerUid: string
  recordedAt: string
  frames: ReplayFrame[]
}

type Handler = (...args: any[]) => void
const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

export class ReplayRoom {
  // --- Room surface the game page reads ---
  readonly serializer = new SchemaSerializer<GameState>()
  readonly roomId = "replay"
  readonly sessionId = "replay"
  readonly name = "game"
  reconnectionToken = "replay"
  hasJoined = true
  connection = { isOpen: true, close: () => {} }

  // --- playback state ---
  readonly manifest: ReplayManifest
  readonly totalMs: number
  // Game start ≈ the first LOADING_COMPLETE broadcast (server ran startGame → the carousel begins).
  // Used to re-base the scrubber so 0:00 = game start, not recording start (which is mid-loading-wait).
  readonly gameStartMs: number
  private queue: ReplayFrame[] = []
  private idx = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private baseSpeed: number // the user-chosen speed (0.5–4×); the "focus" mode may run faster per phase
  private focusMode: FocusMode = "off"
  private startMs: number
  private started = false
  private revealed = false
  private revealScheduled = false
  private preloadMapsPayload: unknown = null // PRELOAD_MAPS captured during a seek fast-forward (see above)
  // exposed for the replay-controls UI (polled):
  currentMs = 0
  paused = false
  ended = false
  private endedHandlers = new Set<() => void>()

  // --- listener registries (mirror Colyseus Room emitters) ---
  private messageHandlers = new Map<string | number, Set<Handler>>()
  private stateChangeHandlers = new Set<Handler>()
  private leaveHandlers = new Set<Handler>()
  private errorHandlers = new Set<Handler>()
  private dropHandlers = new Set<Handler>()
  private reconnectHandlers = new Set<Handler>()

  constructor(
    manifest: ReplayManifest,
    opts: { speed?: number; startMs?: number; focusMode?: FocusMode } = {}
  ) {
    this.manifest = manifest
    this.baseSpeed = opts.speed && opts.speed > 0 ? opts.speed : 1
    this.focusMode = opts.focusMode ?? "off" // carried across seek reboots so the mode sticks
    this.startMs = opts.startMs && opts.startMs > 0 ? opts.startMs : 0
    this.totalMs = manifest.frames.length ? manifest.frames[manifest.frames.length - 1].t : 0
    this.gameStartMs =
      manifest.frames.find((f) => f.kind === "message" && f.type === "LOADING_COMPLETE")?.t ?? 0

    // Apply the handshake + the initial full-state snapshot synchronously, so `room.state` is fully
    // populated by the time the game page mounts. When the renderer later attaches its callbacks,
    // Colyseus `onAdd`/`listen` fire `triggerAll` for this initial state → the starting board draws.
    // Everything else (patches AND messages) is queued for timed playback — messages must wait until
    // the page registers its onMessage handlers, so e.g. PRELOAD_MAPS reaches the renderer.
    const frames = manifest.frames
    const firstStateIdx = frames.findIndex((f) => f.kind === "state")
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]
      if (i <= firstStateIdx && (f.kind === "handshake" || f.kind === "state")) {
        this.applyFrame(f)
      } else {
        this.queue.push(f)
      }
    }

    // For a seek (startMs > 0) advance the STATE to the target HERE, before the scene boots, so the
    // scene boots already at the target: startGame() then builds the board/battle managers and reads the
    // map from the state at T (like a fresh game / the carousel start). Fast-forwarding AFTER the scene
    // attached instead leaves a stale map + sprites.
    if (this.startMs > 0) this.fastForwardStateTo(this.startMs)
  }

  /** Constructor-time fast-forward for a seek: advance the decoder STATE to `ms` with no renderer
   * attached. Pre-T ROOM_DATA messages are transient (damage popups, income) EXCEPT PRELOAD_MAPS, the
   * one-time setup that loads the region tilemaps — we stash its payload to re-emit once the scene is up
   * (startPlayback), so setMap() at the target has a loaded tilemap (else the region map renders black). */
  private fastForwardStateTo(ms: number) {
    while (this.idx < this.queue.length && this.queue[this.idx].t <= ms) {
      const f = this.queue[this.idx]
      if (f.kind === "message") {
        if (f.type === "PRELOAD_MAPS") this.preloadMapsPayload = this.decodePayload(f.payload)
      } else {
        this.applyFrame(f)
      }
      this.currentMs = f.t
      this.idx++
    }
  }

  get state(): GameState {
    return this.serializer.getState()
  }

  private applyFrame(f: ReplayFrame) {
    if (f.kind === "message") {
      this.emitMessage(f.type!, this.decodePayload(f.payload))
      return
    }
    const bytes = b64ToBytes(f.b64!)
    const it: Iterator = { offset: f.offset ?? 1 }
    if (f.kind === "handshake") this.serializer.handshake(bytes, it)
    else if (f.kind === "state") this.serializer.setState(bytes, it)
    else if (f.kind === "patch") this.serializer.patch(bytes, it)
  }

  private decodePayload(payload: unknown): unknown {
    if (payload && typeof payload === "object" && "__bytes__" in (payload as object)) {
      return b64ToBytes((payload as { __bytes__: string }).__bytes__)
    }
    return payload
  }

  private fire(set: Set<Handler>, ...args: any[]) {
    set.forEach((h) => {
      try {
        h(...args)
      } catch (e) {
        // a renderer callback throwing must not halt playback
        console.error("[replay] handler error", e)
      }
    })
  }

  /** Fire a synthetic inbound message to the registered onMessage handlers. */
  private emitMessage(type: string | number, payload?: unknown) {
    this.messageHandlers.get(type)?.forEach((h) => {
      try {
        h(payload)
      } catch (e) {
        console.error("[replay] message handler error", e)
      }
    })
  }

  /** Reveal the game UI without playing the match yet. The game page keeps a loading overlay up
   * until a LOADING_COMPLETE *message* arrives (game.tsx); firing it reveals the board container so
   * the Phaser scene boots. We must do this BEFORE playing the queue, because the scene (and thus
   * gameScene.board, which board-sprite creation needs) only exists once the UI is revealed. */
  reveal() {
    if (this.revealed) return
    this.revealed = true
    this.emitMessage("LOADING_COMPLETE")
  }

  /** Begin playing the queued frames at the recorded cadence. Idempotent. The caller should wait
   * until the Phaser scene's board exists (see replay.tsx) so the one-shot board/combat onAdd
   * callbacks land on a live renderer. If `startMs` was given, fast-forwards there first. */
  startPlayback() {
    if (this.started) return
    this.started = true
    this.reveal()
    // startMs (a seek target) was already fast-forwarded in the constructor, so the scene booted at the
    // target. For a fresh load (startMs === 0) trim the pre-game loading wait so we open on the carousel.
    if (this.startMs === 0) {
      this.skipLoadingPhase()
    } else if (this.preloadMapsPayload != null) {
      // Scene is up now (startPlayback runs after the board exists). Replaying the captured PRELOAD_MAPS
      // preloads the region tilemaps; its load-complete handler then swaps to the target's map.
      this.emitMessage("PRELOAD_MAPS", this.preloadMapsPayload)
    }
    this.scheduleNext()
  }

  /** Fast-apply frames (no delay) through the pre-game *loading wait* only, stopping the instant the
   * match actually begins — the opening t0 portal carousel. That carousel is a TOWN-phase minigame at
   * stageLevel 0 whose avatars/portals populate the moment the server runs startGame(); everything
   * before it is just the loading screen (players' loadingProgress climbing to 100). We detect "game
   * started" by the minigame being live (`avatars` present) rather than by stageLevel, because
   * stageLevel only reaches 1 AFTER the ~23s carousel — gating on it skipped the carousel entirely and
   * opened the replay on round 1 (round-2 play-test feedback). The stageLevel>=1 fallback guards a
   * recording that somehow opens past the carousel, so we still never skip the whole match. */
  private skipLoadingPhase() {
    let guard = 0
    const gameStarted = () =>
      (this.state?.avatars?.size ?? 0) > 0 || (this.state?.stageLevel ?? 1) >= 1
    while (this.idx < this.queue.length && !gameStarted() && guard++ < this.queue.length) {
      if (!this.applyNext()) break
    }
  }

  /** Apply the next queued frame, advance currentMs, notify state listeners. Returns false at end. */
  private applyNext(): boolean {
    if (this.idx >= this.queue.length) return false
    const f = this.queue[this.idx]
    this.applyFrame(f)
    this.currentMs = f.t
    if (f.kind !== "message") this.fire(this.stateChangeHandlers, this.state)
    this.idx++
    return true
  }

  private scheduleNext() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.paused || this.ended) return
    const next = this.queue[this.idx]
    if (!next) {
      this.finish()
      return
    }
    const dt = Math.max(0, (next.t - this.currentMs) / this.effectiveSpeed())
    this.timer = setTimeout(() => {
      if (this.paused || this.ended) return
      if (!this.applyNext()) this.finish()
      else this.scheduleNext()
    }, dt)
  }

  /** Graceful end: stop on the final frame and notify; do NOT fire onLeave (that would trigger the
   * client's "connection failed" disconnect UI — a replay simply ended). */
  private finish() {
    if (this.ended) return
    this.ended = true
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.endedHandlers.forEach((h) => h())
  }

  // --- replay controls (driven by ReplayControls) ---------------------------------------------
  pause() {
    if (this.ended) return
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  resume() {
    if (this.ended || !this.paused) return
    this.paused = false
    this.scheduleNext()
  }

  togglePause() {
    this.paused ? this.resume() : this.pause()
  }

  setSpeed(speed: number) {
    if (speed > 0) this.baseSpeed = speed
    if (!this.paused && !this.ended) this.scheduleNext() // reschedule with the new cadence
  }

  getSpeed() {
    return this.baseSpeed
  }

  /** The cadence the next interval should play at: the chosen speed, or FAST_SPEED for the phase the
   * current focus mode fast-forwards (read off the live state.phase). */
  private effectiveSpeed(): number {
    if (this.focusMode === "off") return this.baseSpeed
    const isFight = this.state?.phase === GamePhaseState.FIGHT
    const fast = Math.max(FAST_SPEED, this.baseSpeed * 2)
    if (this.focusMode === "prep") return isFight ? this.baseSpeed : fast
    return isFight ? fast : this.baseSpeed // "fights": fast-forward the fights
  }

  /** Set the focus auto-speed mode; selecting the active one again turns it off. Reschedules so the
   * new cadence takes effect immediately. */
  setFocusMode(mode: FocusMode) {
    this.focusMode = this.focusMode === mode ? "off" : mode
    if (!this.paused && !this.ended) this.scheduleNext()
  }

  getFocusMode(): FocusMode {
    return this.focusMode
  }

  /** Frame-step forward one visible update while paused: apply frames until one state/patch lands
   * (consuming any cosmetic messages in between), so combat/board can be inspected tick by tick.
   * Backward stepping is a reboot-seek (the decoder is forward-only) handled in replay.tsx. */
  stepForward(): boolean {
    if (this.ended) return false
    this.pause()
    let advanced = false
    while (this.idx < this.queue.length) {
      const kind = this.queue[this.idx].kind
      if (!this.applyNext()) break
      advanced = true
      if (kind !== "message") break // stop after one real state update
    }
    return advanced
  }

  // Seeking is handled by replay.tsx rebooting a fresh ReplayRoom at the target time (boot()) — both
  // directions — so there is no in-place seek here; the decoder is forward-only and rewinding it in
  // place would desync the bound renderer. `fastForwardTo` (used by startPlayback for startMs) is what
  // lands a fresh decoder on the target frame.

  onEnded(cb: () => void) {
    this.endedHandlers.add(cb)
    if (this.ended) cb()
    return () => this.endedHandlers.delete(cb)
  }

  /** game.tsx registers its onMessage handlers during init; once it has, reveal the UI next tick so
   * the scene can boot. Playback itself is started later by the bootstrap, after the board exists. */
  private maybeReveal() {
    if (this.revealed || this.revealScheduled) return
    this.revealScheduled = true
    setTimeout(() => this.reveal(), 0)
  }

  // --- Colyseus Room API subset ---------------------------------------------------------------
  onMessage(type: string | number, cb: Handler) {
    if (!this.messageHandlers.has(type)) this.messageHandlers.set(type, new Set())
    this.messageHandlers.get(type)!.add(cb)
    this.maybeReveal()
    return () => this.messageHandlers.get(type)?.delete(cb)
  }

  onStateChange(cb: Handler) {
    this.stateChangeHandlers.add(cb)
    return () => this.stateChangeHandlers.delete(cb)
  }

  onLeave(cb: Handler) {
    this.leaveHandlers.add(cb)
    return () => this.leaveHandlers.delete(cb)
  }

  onError(cb: Handler) {
    this.errorHandlers.add(cb)
    return () => this.errorHandlers.delete(cb)
  }

  onDrop(cb: Handler) {
    this.dropHandlers.add(cb)
    return () => this.dropHandlers.delete(cb)
  }

  onReconnect(cb: Handler) {
    this.reconnectHandlers.add(cb)
    return () => this.reconnectHandlers.delete(cb)
  }

  /** Inbound player commands are meaningless in a replay — swallow them, EXCEPT LOADING_COMPLETE. The
   * GameScene sends LOADING_COMPLETE once its OWN assets finish loading (preload's load.once("complete"))
   * and runs startGame() only when that message comes back — the real server broadcasts it to the sender.
   * We mirror that broadcast so startGame() (which builds board/battle/minigame + sets the map) runs
   * reliably AFTER assets load on every (re)mount. Without it a seek-remount can miss our one-shot
   * reveal() emit and never start the game (no board/battle → mid-game seeks render nothing). */
  send(type: string | number, _message?: unknown) {
    if (type === "LOADING_COMPLETE") this.emitMessage("LOADING_COMPLETE")
  }
  sendBytes(_type: string | number, _bytes?: unknown) {}

  removeAllListeners() {
    this.messageHandlers.clear()
    this.stateChangeHandlers.clear()
    this.leaveHandlers.clear()
    this.errorHandlers.clear()
    this.dropHandlers.clear()
    this.reconnectHandlers.clear()
  }

  async leave(_consented = true): Promise<number> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.connection.isOpen = false
    this.fire(this.leaveHandlers, 1000)
    return 1000
  }
}

/** Construct a ReplayRoom and present it as a `Room<GameState>` to the existing game page. */
export function createReplayRoom(
  manifest: ReplayManifest,
  opts?: { speed?: number }
): Room<GameState> {
  return new ReplayRoom(manifest, opts) as unknown as Room<GameState>
}
