import { SchemaSerializer, type Room } from "@colyseus/sdk"
import type { Iterator } from "@colyseus/schema"
import type GameState from "../../../rooms/states/game-state"

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
  private baseSpeed: number // the user-chosen speed (0.5–8×)
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
  // Fired when timed playback reaches a reconnect boundary (a 2nd handshake mid-stream, from a recording
  // that spanned a disconnect). The page must re-attach there rather than let us apply it: re-applying a
  // handshake builds a NEW decoder, orphaning the renderer's callbacks → the board freezes. replay.tsx
  // wires this to its seek path, which rebuilds a fresh ReplayRoom fast-forwarded past the boundary and
  // re-binds the new decoder (the proven seek machinery).
  private rebindHandlers = new Set<(ms: number) => void>()

  // --- listener registries (mirror Colyseus Room emitters) ---
  private messageHandlers = new Map<string | number, Set<Handler>>()
  private stateChangeHandlers = new Set<Handler>()
  private leaveHandlers = new Set<Handler>()
  private errorHandlers = new Set<Handler>()
  private dropHandlers = new Set<Handler>()
  private reconnectHandlers = new Set<Handler>()

  constructor(
    manifest: ReplayManifest,
    opts: { speed?: number; startMs?: number } = {}
  ) {
    this.manifest = manifest
    this.baseSpeed = opts.speed && opts.speed > 0 ? opts.speed : 1
    this.startMs = opts.startMs && opts.startMs > 0 ? opts.startMs : 0
    this.totalMs = manifest.frames.length
      ? manifest.frames[manifest.frames.length - 1].t
      : 0
    this.gameStartMs =
      manifest.frames.find(
        (f) => f.kind === "message" && f.type === "LOADING_COMPLETE"
      )?.t ?? 0

    // Apply the handshake + the initial full-state snapshot synchronously, so `room.state` is fully
    // populated by the time the game page mounts. When the renderer later attaches its callbacks,
    // Colyseus `onAdd`/`listen` fire `triggerAll` for this initial state → the starting board draws.
    // Everything else (patches AND messages) is queued for timed playback — messages must wait until
    // the page registers its onMessage handlers, so e.g. PRELOAD_MAPS reaches the renderer.
    const frames = manifest.frames
    const firstStateIdx = frames.findIndex((f) => f.kind === "state")
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]
      if (
        i <= firstStateIdx &&
        (f.kind === "handshake" || f.kind === "state")
      ) {
        this.applyFrame(f)
      } else {
        this.queue.push(f)
      }
    }

    // Advance the STATE HERE, before the scene boots, so startGame() builds the board/battle managers and
    // reads the map from the already-advanced state: a seek (startMs > 0) lands at its target; a fresh load
    // (startMs === 0) lands on the opening carousel, with the pre-game loading wait skipped. Doing this
    // before the renderer attaches keeps the burst of loading-wait/seek frames OFF the first-render path —
    // the scene then draws the carousel/target in one triggerAll instead of lagging as the frames stream in.
    if (this.startMs > 0) this.fastForwardStateTo(this.startMs)
    else this.skipLoadingPhase()
  }

  /** Constructor-time fast-forward for a seek: advance the decoder STATE to `ms` with no renderer
   * attached. Pre-T ROOM_DATA messages are transient (damage popups, income) EXCEPT PRELOAD_MAPS, the
   * one-time setup that loads the region tilemaps — we stash its payload to re-emit once the scene is up
   * (startPlayback), so setMap() at the target has a loaded tilemap (else the region map renders black). */
  private fastForwardStateTo(ms: number) {
    while (this.idx < this.queue.length && this.queue[this.idx].t <= ms) {
      const f = this.queue[this.idx]
      try {
        if (f.kind === "message") {
          if (f.type === "PRELOAD_MAPS")
            this.preloadMapsPayload = this.decodePayload(f.payload)
        } else {
          this.applyFrame(f)
        }
      } catch (e) {
        // A corrupt / cross-version frame must not throw out of the constructor: a SEEK calls boot()
        // (→ new ReplayRoom) directly from a UI handler, not inside a promise chain, so an uncaught throw
        // would dead-end the seek silently (the new room is never assigned; the old one stays paused).
        // Skip the bad frame and keep fast-forwarding — matching applyNext / buildReplayIndex.
        console.error("[replay] fast-forward frame error (skipped)", e)
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
    if (
      payload &&
      typeof payload === "object" &&
      "__bytes__" in (payload as object)
    ) {
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
    // The pre-game loading wait (fresh load) / pre-target frames (seek) were already advanced in the
    // constructor, with PRELOAD_MAPS stashed. Re-emit it now that the scene's onMessage handlers exist so
    // the region tilemaps load (its load-complete handler then sets the current map); then play.
    if (this.preloadMapsPayload != null) {
      this.emitMessage("PRELOAD_MAPS", this.preloadMapsPayload)
    }
    this.scheduleNext()
  }

  /** Constructor-time skip through the pre-game *loading wait* to the opening t0 portal carousel, with no
   * renderer attached (mirrors fastForwardStateTo for a seek): advancing here, BEFORE the scene boots,
   * keeps the loading-wait frames off the carousel's first-render path so it doesn't lag on open. We stash
   * PRELOAD_MAPS (re-emitted in startPlayback once the scene's onMessage handlers exist) and drop the other
   * transient loading messages. We stop the instant the match begins — the carousel, a TOWN-phase minigame
   * at stageLevel 0 whose avatars populate the moment the server runs startGame(); everything before it is
   * just the loading screen. We detect that by the minigame being live (`avatars` present) rather than
   * stageLevel, which only reaches 1 AFTER the ~23s carousel — gating on it skipped the carousel entirely
   * (round-2 play-test feedback). The stageLevel>=1 fallback guards a recording that opens past the
   * carousel, so we still never skip the whole match. */
  private skipLoadingPhase() {
    let guard = 0
    const gameStarted = () =>
      (this.state?.avatars?.size ?? 0) > 0 || (this.state?.stageLevel ?? 1) >= 1
    while (
      this.idx < this.queue.length &&
      !gameStarted() &&
      guard++ < this.queue.length
    ) {
      const f = this.queue[this.idx]
      try {
        if (f.kind === "message") {
          if (f.type === "PRELOAD_MAPS")
            this.preloadMapsPayload = this.decodePayload(f.payload)
        } else {
          this.applyFrame(f)
        }
      } catch (e) {
        // As in fastForwardStateTo: a bad frame during the constructor loading-skip must not throw out
        // of the constructor. Skip and continue.
        console.error("[replay] skip-loading frame error (skipped)", e)
      }
      this.currentMs = f.t
      this.idx++
    }
  }

  /** Apply the next queued frame, advance currentMs, notify state listeners. Returns false at end. */
  private applyNext(): boolean {
    if (this.idx >= this.queue.length) return false
    const f = this.queue[this.idx]
    try {
      this.applyFrame(f)
      this.currentMs = f.t
      if (f.kind !== "message") this.fire(this.stateChangeHandlers, this.state)
    } catch (e) {
      // A decoder/render callback fires synchronously inside serializer.setState/patch, so a throwing
      // callback (or a corrupt / cross-version frame) escapes here. This runs in the playback setTimeout
      // (scheduleNext) and in stepForward — an uncaught throw would kill the timer, never re-reach
      // scheduleNext, and halt playback permanently (ReplayErrorBoundary can't catch a setTimeout throw).
      // Skip the bad frame and keep playing, matching buildReplayIndex's skip-and-continue on the same
      // decode. currentMs still advances so the scrubber doesn't stall on the skipped frame.
      console.error("[replay] frame apply error (skipped)", e)
      this.currentMs = f.t
    }
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
    // Reconnect boundary: a handshake in the queue (segment 1's handshake is applied in the constructor,
    // so any queued handshake is a 2nd one). Don't apply it — re-applying a handshake swaps the decoder
    // and orphans the renderer's callbacks (board freezes). Ask the page to re-attach past it instead;
    // that also collapses the wall-clock outage gap (otherwise this would be one huge setTimeout). With
    // no handler wired (e.g. a unit test), fall through and apply — the old behavior.
    if (next.kind === "handshake" && this.rebindHandlers.size > 0) {
      this.rebindHandlers.forEach((h) => h(this.rebindTargetAt()))
      return
    }
    const dt = Math.max(0, (next.t - this.currentMs) / this.baseSpeed)
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

  /** Frame-step forward one visible update while paused: apply frames until one state/patch lands
   * (consuming any cosmetic messages in between), so combat/board can be inspected tick by tick.
   * Backward stepping is a reboot-seek (the decoder is forward-only) handled in replay.tsx. */
  stepForward(): boolean {
    if (this.ended) return false
    this.pause()
    let advanced = false
    while (this.idx < this.queue.length) {
      const kind = this.queue[this.idx].kind
      if (kind === "handshake" && this.rebindHandlers.size > 0) {
        this.rebindHandlers.forEach((h) => h(this.rebindTargetAt())) // reconnect boundary → re-attach
        break
      }
      if (!this.applyNext()) break
      advanced = true
      if (kind !== "message") break // stop after one real state update
    }
    return advanced
  }

  /** The seek target for a reconnect boundary: the t of the reconnect's full-state frame (right after
   * the 2nd handshake), so a re-attach fast-forwards THROUGH handshake₂+state₂ (rebuilding the decoder
   * with no renderer attached) and resumes just after it. */
  private rebindTargetAt(): number {
    for (let j = this.idx; j < this.queue.length; j++) {
      if (this.queue[j].kind === "state") return this.queue[j].t
    }
    return this.queue[this.idx]?.t ?? this.currentMs
  }

  /** Register a reconnect-boundary handler (replay.tsx wires it to a seek). Returns an unsubscribe. */
  onRebindNeeded(cb: (ms: number) => void) {
    this.rebindHandlers.add(cb)
    return () => this.rebindHandlers.delete(cb)
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
    if (!this.messageHandlers.has(type))
      this.messageHandlers.set(type, new Set())
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
