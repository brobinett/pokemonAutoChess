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
  private queue: ReplayFrame[] = []
  private idx = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private speed: number
  private startMs: number
  private started = false
  private revealed = false
  private revealScheduled = false
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

  constructor(manifest: ReplayManifest, opts: { speed?: number; startMs?: number } = {}) {
    this.manifest = manifest
    this.speed = opts.speed && opts.speed > 0 ? opts.speed : 1
    this.startMs = opts.startMs && opts.startMs > 0 ? opts.startMs : 0
    this.totalMs = manifest.frames.length ? manifest.frames[manifest.frames.length - 1].t : 0

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
    if (this.startMs > 0) this.fastForwardTo(this.startMs) // renderer is attached → sprites stay correct
    else this.skipLoadingPhase() // don't replay the pre-game loading wait; start at game start
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
    const dt = Math.max(0, (next.t - this.currentMs) / this.speed)
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

  /** Apply frames with no delay up to (and including) the given time. Renderer must be attached. */
  private fastForwardTo(ms: number) {
    while (this.idx < this.queue.length && this.queue[this.idx].t <= ms) {
      if (!this.applyNext()) break
    }
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
    if (speed > 0) this.speed = speed
    if (!this.paused && !this.ended) this.scheduleNext() // reschedule with the new cadence
  }

  getSpeed() {
    return this.speed
  }

  /** Seek to a time. Forward seeks fast-apply in-page; backward seeks need a fresh decoder, so the
   * caller (replay.tsx) reloads with ?startMs= — `seek` returns "reload" to request that. */
  seek(ms: number): "ok" | "reload" {
    const target = Math.max(0, Math.min(ms, this.totalMs))
    if (target < this.currentMs) return "reload"
    this.fastForwardTo(target)
    if (this.idx >= this.queue.length) this.finish()
    else if (!this.paused) this.scheduleNext()
    return "ok"
  }

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

  /** Inbound player commands are meaningless in a replay — swallow them. */
  send(_type: string | number, _message?: unknown) {}
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
