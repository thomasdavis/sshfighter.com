// Pool of render workers. Sessions are stuck to a worker for their lifetime so
// each worker keeps that session's cell buffers. A dead OR wedged worker is
// recycled and its in-flight renders are FAILED (rejected), so the owning session
// drops that one frame and re-keyframes — it is never left awaiting a promise that
// can never settle (which would wedge `renderInFlight` and freeze its fight).
import { Worker } from 'worker_threads';
import { availableParallelism } from 'os';
import type { Match } from '../game/types.js';
import type { RenderMode } from './frame.js';
import type { KeyBindings } from '../input/bindings.js';

const WORKER_URL = new URL('./render-worker.ts', import.meta.url);
// Liveness watchdog: a worker that has pending jobs but emits NO message for this
// long is treated as wedged (its jobs are failed and it is respawned). This is a
// gap-between-messages bound, NOT a per-job deadline — a worker chewing through a
// deep backlog keeps emitting results, so it is never falsely recycled. A single
// fight render is a few ms; this only fires on a genuinely stuck thread.
const STALL_MS = Math.max(500, parseInt(process.env.SF_RENDER_STALL_MS ?? '2000', 10) || 2000);

interface Job {
  widx: number;                          // worker index this job was sent to
  resolve: (bytes: string) => void;
  reject: (err: Error) => void;
}

export class RenderPool {
  private workers: Worker[] = [];
  private pending = new Map<number, Job>();
  private watchdog: (NodeJS.Timeout | null)[] = [];
  private assign = new Map<number, number>();  // sid -> worker index
  private seq = 0;
  private rr = 0;

  constructor(public readonly size: number) {
    for (let i = 0; i < size; i++) this.spawn(i);
  }

  private spawn(i: number): void {
    const w = new Worker(WORKER_URL);
    this.workers[i] = w;
    w.on('message', (m: { seq: number; bytes: string }) => {
      const job = this.pending.get(m.seq);
      if (job) { this.pending.delete(m.seq); job.resolve(m.bytes); }
      this.progress(i);   // any message = proof of liveness → reset the watchdog
    });
    w.on('error', () => this.recycle(i, w, new Error('render worker error')));
    w.on('exit', (code) => { if (code !== 0) this.recycle(i, w, new Error(`render worker exited (${code})`)); });
  }

  /** Tear down a dead/wedged worker at index `i`, fail everything it owed, respawn.
   *  Identity-guarded so a doubled signal (error THEN exit, or watchdog THEN exit)
   *  never recycles the healthy replacement. */
  private recycle(i: number, w: Worker | undefined, err: Error): void {
    if (!w || this.workers[i] !== w) return;
    const t = this.watchdog[i]; if (t) clearTimeout(t); this.watchdog[i] = null;
    try { w.terminate(); } catch { /* */ }
    this.failJobsFor(i, err);
    this.spawn(i);
  }

  /** Reject every in-flight job sent to a (now gone) worker index. The owning
   *  session's .catch clears renderInFlight and forces a full redraw, so the fresh
   *  worker rebuilds that session's baseline from scratch. */
  private failJobsFor(widx: number, err: Error): void {
    for (const [seq, job] of this.pending) {
      if (job.widx !== widx) continue;
      this.pending.delete(seq);
      job.reject(err);
    }
  }

  private hasPendingFor(widx: number): boolean {
    for (const job of this.pending.values()) if (job.widx === widx) return true;
    return false;
  }

  /** Ensure a watchdog is running for worker `widx` (does NOT extend a running one,
   *  so a steady stream of new jobs can't mask a wedged worker). */
  private arm(widx: number): void {
    if (this.watchdog[widx] || !this.hasPendingFor(widx)) return;
    const w = this.workers[widx];
    const t = setTimeout(() => this.recycle(widx, w, new Error('render worker stalled')), STALL_MS);
    if (typeof t.unref === 'function') t.unref();   // a watchdog must not hold the process open
    this.watchdog[widx] = t;
  }

  /** A worker produced a message: reset its watchdog, then re-arm if work remains. */
  private progress(widx: number): void {
    const t = this.watchdog[widx]; if (t) clearTimeout(t);
    this.watchdog[widx] = null;
    this.arm(widx);
  }

  private workerFor(sid: number): { w: Worker; idx: number } {
    let idx = this.assign.get(sid);
    if (idx === undefined || !this.workers[idx]) { idx = this.rr++ % this.workers.length; this.assign.set(sid, idx); }
    return { w: this.workers[idx]!, idx };
  }

  /** Render one fight frame for a session; resolves with the diff bytes to write. */
  render(sid: number, match: Match, cols: number, rows: number, mode: RenderMode, practice: boolean, bindings: KeyBindings, full: boolean): Promise<string> {
    const seq = ++this.seq;
    const { w, idx } = this.workerFor(sid);
    return new Promise<string>((resolve, reject) => {
      this.pending.set(seq, { widx: idx, resolve, reject });
      try {
        w.postMessage({ type: 'render', sid, seq, match, cols, rows, mode, practice, bindings, full });
        this.arm(idx);
      } catch (e) {
        this.pending.delete(seq);
        reject(e as Error);
      }
    });
  }

  /** Release a session's buffers on disconnect. */
  free(sid: number): void {
    const idx = this.assign.get(sid);
    if (idx !== undefined && this.workers[idx]) { try { this.workers[idx]!.postMessage({ type: 'free', sid }); } catch { /* */ } }
    this.assign.delete(sid);
  }
}

/** Build the pool from SF_RENDER_WORKERS (0/unset = disabled → inline rendering).
 *  A value of "auto" uses cores-2 (leaving headroom for the main loop + libuv). */
export function makeRenderPool(): RenderPool | null {
  const raw = (process.env.SF_RENDER_WORKERS ?? '').trim();
  if (!raw || raw === '0') return null;
  const n = raw === 'auto' ? Math.max(1, availableParallelism() - 2) : Math.max(0, parseInt(raw, 10) || 0);
  return n > 0 ? new RenderPool(n) : null;
}
