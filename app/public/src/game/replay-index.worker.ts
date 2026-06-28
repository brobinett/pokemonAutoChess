// Off-main-thread index builder. buildReplayIndex walks the whole transcript (the combat status/stat
// state-diff scan dominates — multiple seconds on a long capture), so running it inline froze the replay
// load. This worker runs it on a background thread and posts the finished index back; playback starts
// immediately and the controls/event log light up when the index arrives (it's enhancement-only).
//
// A classic (iife) worker matching recorder.worker.ts — built to the stable /replay-index.worker.js by
// esbuild and spawned with `new Worker("/replay-index.worker.js")`. Self-contained (esbuild bundles
// replay-index + @colyseus/sdk + the game enums); no DOM is used (atob, available in workers, only for
// the legacy v0 base64 path — v1 frames carry raw bytes).
import { buildReplayIndex } from "./replay-index"
import type { ReplayFrame } from "./replay-room"

type BuildRequest = { id: number; frames: ReplayFrame[]; viewerUid?: string }

const ctx = self as unknown as Worker

ctx.onmessage = (e: MessageEvent<BuildRequest>) => {
  const { id, frames, viewerUid } = e.data
  try {
    const index = buildReplayIndex(frames, viewerUid)
    ctx.postMessage({ id, index })
  } catch (err) {
    // The caller falls back to a synchronous build, so a worker failure degrades to the old behaviour
    // (a slower load) rather than losing the index entirely.
    ctx.postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
