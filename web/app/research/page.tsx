import { readFileSync } from 'fs';
import { join } from 'path';
import { Footer, SiteNav } from '@/components/ui';

export const metadata = {
  title: 'Renderer audit & fixes',
  description:
    'An engineering audit of an "ultra-performance" plan for the SSH Fighter renderer: which claims were fabricated, which were real, the three defects fixed, and the test evidence.',
};

// Read the verbatim patch at build time (it contains backticks, so it lives as
// data next to this page rather than inline in source).
const DIFF = (() => {
  try {
    return readFileSync(join(process.cwd(), 'app/research/changes.diff'), 'utf8');
  } catch {
    return '';
  }
})();

const audit: [string, 'fabricated' | 'real' | 'partly', string][] = [
  [
    'A 900×360 cell ceiling (324k cells, 2.59M subpixels); "cap at 384×128" is the breakthrough',
    'fabricated',
    'The real ceiling is MAX_COLS=300, MAX_ROWS=120 (src/net/session.ts:41), unchanged since the launch commit. That is already smaller than 384×128 in both axes, so the proposed cap is a no-op or a fidelity increase. The largest real scene is 600×480 subpixels — ~9× smaller than claimed.',
  ],
  [
    'Every MiB/GB figure (115 MiB stages, 9.1 GB RSS, "under 3 GiB target", 6.59× amplification)',
    'fabricated',
    'All derive from the non-existent 900×360 / 1800×1200 dimensions. There is no 1800×1200 stage anywhere; the largest a stage is resized to is ≈600×400 px.',
  ],
  [
    'Unbounded / entry-count cache accumulation; workers retain 0.8–1.9 GB',
    'fabricated',
    'Every renderer cache is bounded: stage cache is an 8-entry LRU, sprite cache a 128-entry LRU, scene cache a WeakMap<Match> (GC-collected per match). No leak, no unbounded growth.',
  ],
  [
    'Clustered fights render at 30 Hz, bypassing the adaptive 8–15 Hz scheduler',
    'real',
    'The remoteVersus branch rendered every tick (TICK_HZ=30) and returned before reaching the renderAccum scheduler — 2× overspend on a normal terminal, up to 3.75× on a large one, per online player. Fixed.',
  ],
  [
    'The render pool leaks in-flight jobs when a worker dies → session freezes',
    'real',
    'The pool stored only a resolver with no worker ownership and no reject path. A dead worker respawned but its owed promises never settled, wedging the session’s renderInFlight latch true forever. Fixed.',
  ],
  [
    'A dropped async write corrupts the worker’s diff baseline',
    'real',
    'The worker advances its previous-frame baseline before the main thread confirms delivery, and Terminal.write silently drops while the stream is blocked, with no keyframe recovery. Narrow trigger, cheap fix. Fixed.',
  ],
  [
    'Object-per-pixel data plane should be packed into Uint32 framebuffers',
    'partly',
    'PixelGrid is (RGB|null)[][] — one heap object per opaque pixel — so a packed representation would genuinely shrink the bounded caches. But the magnitudes cited are fabricated, and it is a large, invasive rewrite that should follow a real profile, not invented numbers. Not done in this pass.',
  ],
  [
    'Terminal Scene Compiler / Kitty placement fast-path / edge-rollback netcode',
    'partly',
    'Architecture proposals, not defects. Each is weeks of regression risk on a live game and is motivated by the fabricated crisis. Deferred to a measured roadmap.',
  ],
];

const badge: Record<string, { label: string; cls: string }> = {
  fabricated: { label: 'Fabricated', cls: 'negative' },
  real: { label: 'Real · fixed', cls: 'positive' },
  partly: { label: 'Partly real · deferred', cls: 'neutral' },
};

const fixes: [string, string, string][] = [
  [
    '01 · Adaptive render for clustered fights',
    'src/net/session.ts',
    'The remoteVersus branch no longer renders-and-returns. Input send and local prediction still run every tick (unchanged 30 Hz responsiveness); only the visual refresh falls through to the shared adaptive scheduler every other session uses — 30→15 renders/sec on a typical terminal, 30→8 on a large one. Prediction, reconciliation and input latency are untouched.',
  ],
  [
    '02 · Keyframe recovery on a dropped frame',
    'src/net/terminal.ts · src/net/session.ts',
    'write()/paint()/paintBytes() now report whether the bytes reached the stream. When a pooled frame cannot be delivered (the SSH stream went blocked mid-render), the session forces a full keyframe next frame, re-syncing the worker’s baseline with the real screen instead of silently diffing against a frame the terminal never saw.',
  ],
  [
    '03 · Fail jobs on worker death + liveness watchdog',
    'src/render/render-pool.ts',
    'Pending jobs now carry their owning worker index and a reject function. A dead or non-zero-exit worker fails every job it owed and respawns, so the session’s .catch clears renderInFlight and re-keyframes. A per-worker liveness watchdog (reset on every message, not a per-job deadline) covers the rarer silently-wedged-thread case without ever falsely recycling a worker that is just chewing through a deep queue.',
  ],
];

const impact: [string, string, string, string][] = [
  ['Adaptive render for remoteVersus', 'performance', '2×–3.75× fewer renders + streamed bytes per online player', 'low — repaint cadence only; matches local fights'],
  ['Keyframe on dropped write', 'correctness', 'eliminates persistent diff corruption after a blocked-stream frame drop', 'low — one extra full redraw on a rare event'],
  ['Fail jobs on worker death + watchdog', 'correctness', 'eliminates permanent per-session fight freeze after a worker dies or wedges', 'low — happy path byte-identical (verified)'],
];

const testLog = `render-pool-test  (SF_RENDER_WORKERS=2)
  PASS  pool output is byte-identical to inline        60 frames
  PASS  full=true redraws whole frame (>> incremental) full=134938 incr=7058
  throughput 960 renders: inline=3998ms pool(4)=2073ms speedup=1.93x (463 renders/s)
  RENDER POOL TEST: PASS

pool-death-check  (new — crash a worker mid-render)
  PASS  crashed-worker render settles (does not hang)  render worker error
  PASS  pool recovers after a worker death             bytes=126917
  POOL DEATH CHECK: PASS

full suite (each PASS): engine · renderer · hud · caps · input · version · newwave ·
  diff-verify (192,000 cells / 40 frames, 0 mismatches) · matchmaking · coordinator ·
  recorder · telemetry · navigation · practice · ssh (full flow + live fight frames) ·
  social · prediction (max drift 0.00000, bounded non-growing lead)`;

const before = `// remoteVersus branch — BEFORE
if (this.remoteVersus) {
  ...predictLocal(this.match, this.role, inp);
  if (this.alive && !this.terminal.blocked) this.renderCurrent();
  return; // rendered every tick = 30 Hz, skipping the 8-15 Hz scheduler
}`;

const after = `// remoteVersus branch — AFTER
if (this.remoteVersus) {
  ...predictLocal(this.match, this.role, inp);
  // input + prediction stay at TICK_HZ; the repaint falls through to the
  // shared adaptive scheduler below (same 8-15 Hz as every other session).
}`;

function DiffBlock({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre className="rx-code rx-diff" aria-label="Unified diff of the three changed files">
      {lines.map((ln, i) => {
        let color = 'var(--ink-dim, #9aa)';
        if (ln.startsWith('+') && !ln.startsWith('+++')) color = '#7fe0a8';
        else if (ln.startsWith('-') && !ln.startsWith('---')) color = '#ff8f9e';
        else if (ln.startsWith('@@')) color = '#7ab8ff';
        else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('+++') || ln.startsWith('---')) color = '#c9a2ff';
        return (
          <span key={i} style={{ display: 'block', color, whiteSpace: 'pre' }}>
            {ln || ' '}
          </span>
        );
      })}
    </pre>
  );
}

export default function ResearchPage() {
  return (
    <div className="rs report">
      <SiteNav />
      <main className="rs-wrap report__wrap">
        <header className="report-hero">
          <div>
            <p className="report-kicker">Engineering report · 26 August 2026 · renderer</p>
            <h1>RENDER<span>·PATH</span></h1>
            <p className="report-deck">
              A performance-and-correctness audit of the SSH Fighter renderer — verifying an
              &ldquo;ultra-performance&rdquo; plan against the real source, separating fabricated claims from
              genuine defects, and fixing the three that were real.
            </p>
          </div>
          <div className="report-status" aria-label="Status">
            <span className="report-status__light" />
            <div>
              <b>3 defects fixed</b>
              <small>all test suites green · +109 / &minus;25 lines</small>
            </div>
          </div>
        </header>

        <section className="report-metrics" aria-label="Headline numbers">
          <article><span>Online render load</span><b>2&ndash;3.75&times;</b><small>fewer renders per player</small></article>
          <article><span>Test suites</span><b>12 / 12</b><small>+ 2 new worker-death checks</small></article>
          <article><span>Files changed</span><b>3</b><small>session · terminal · render-pool</small></article>
          <article><span>Byte-identical</span><b>0 / 192k</b><small>diff-verify mismatches</small></article>
        </section>

        <section className="report-section report-abstract">
          <div className="report-index">00 / ABSTRACT</div>
          <div>
            <h2>Verify first, then fix</h2>
            <p>
              <b>Question.</b> A pasted &ldquo;Ultra Performance Verdict&rdquo; claimed the renderer was in a memory
              crisis (~9.1 GB RSS) driven by an uncapped 900&times;360 render surface, and proposed a large rewrite.
              Is any of it true for this codebase?
            </p>
            <p>
              <b>Finding.</b> The headline is fabricated — it is written against a version of SSH Fighter that does
              not exist here. The real render ceiling is <code>MAX_COLS=300, MAX_ROWS=120</code>, already smaller than
              the &ldquo;cap&rdquo; the plan recommends. Every MiB/GB figure and the &ldquo;unbounded cache&rdquo;
              framing follow from those non-existent dimensions. But three genuine defects were buried under the noise.
            </p>
            <p>
              <b>Result.</b> The three real defects were fixed and proven with tests; the fabricated and speculative-rewrite
              parts were deliberately not implemented. Net change: three files, <code>+109 / &minus;25</code> lines, no new
              runtime dependencies.
            </p>
            <p className="report-caveat">
              <b>Stance.</b> The most-emphasised recommendation in the source plan (&ldquo;cap useful fidelity at
              384&times;128&rdquo;) is not a downgrade here — it is a no-op or an <i>increase</i> over the current
              300&times;120 cap. Implementing it verbatim would have added work while claiming to remove it.
            </p>
          </div>
        </section>

        <section className="report-section">
          <div className="report-index">01 / AUDIT</div>
          <div>
            <h2>Every claim, checked against source</h2>
            <div className="report-table-wrap">
              <table className="report-table">
                <thead>
                  <tr><th>Claim in the source plan</th><th>Verdict</th><th>Evidence</th></tr>
                </thead>
                <tbody>
                  {audit.map(([claim, status, evidence]) => (
                    <tr key={claim}>
                      <td>{claim}</td>
                      <td className={badge[status].cls}>{badge[status].label}</td>
                      <td>{evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="report-note">
              &ldquo;Real&rdquo; means verified in the current source and fixed in this change. &ldquo;Fabricated&rdquo;
              means it does not correspond to anything in this repository. &ldquo;Partly real&rdquo; means the direction
              has merit but the justification was invented, so it is deferred to a measured roadmap (&sect;05).
            </p>
          </div>
        </section>

        <section className="report-section">
          <div className="report-index">02 / FIXES</div>
          <div>
            <h2>The three defects that were real</h2>
            <div className="report-mechanisms">
              {fixes.map(([title, file, body], i) => (
                <article key={title}>
                  <i>{String(i + 1).padStart(2, '0')}</i>
                  <h3>{title}</h3>
                  <p>{body}</p>
                  <p className="report-note" style={{ marginTop: '.5rem' }}><code>{file}</code></p>
                </article>
              ))}
            </div>
            <h3 className="report-subhead">Fix 01 · before / after</h3>
            <div className="rx-twocol">
              <pre className="rx-code">{before}</pre>
              <pre className="rx-code">{after}</pre>
            </div>
          </div>
        </section>

        <section className="report-section">
          <div className="report-index">03 / EVIDENCE</div>
          <div>
            <h2>Test output</h2>
            <p>
              Run directly via <code>tsx</code> on Node v22 (the <code>pnpm test</code> wrapper tries an offline
              workspace install first; the tests themselves are unaffected). Typecheck is clean on all changed files.
            </p>
            <pre className="rx-code rx-log">{testLog}</pre>
            <p className="report-caveat">
              A design note worth recording: the first attempt at the worker-death fix used a naive per-<i>job</i> 2 s
              timeout. It was wrong — the throughput test floods 960 jobs onto 2 workers, so tail jobs legitimately wait
              behind the queue and were spuriously rejected. The shipped fix is a per-<i>worker</i> liveness watchdog that
              resets on every message, so a busy worker is never falsely recycled — only a genuinely silent thread is.
            </p>
          </div>
        </section>

        <section className="report-section">
          <div className="report-index">04 / IMPACT</div>
          <div>
            <h2>What changed, and the risk</h2>
            <div className="report-table-wrap">
              <table className="report-table report-table--results">
                <thead>
                  <tr><th>Change</th><th>Kind</th><th>Effect</th><th>Risk</th></tr>
                </thead>
                <tbody>
                  {impact.map(([change, kind, effect, risk]) => (
                    <tr key={change}>
                      <td>{change}</td>
                      <td className={kind === 'performance' ? 'positive' : 'neutral'}>{kind}</td>
                      <td>{effect}</td>
                      <td>{risk}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="report-note">
              No behavioural change to input latency, prediction, matchmaking, non-fight screens, or byte-level render
              output on the happy path.
            </p>
          </div>
        </section>

        <section className="report-section">
          <div className="report-index">05 / ROADMAP</div>
          <div>
            <h2>What is actually worth doing next</h2>
            <dl className="report-methods">
              <div>
                <dt>1 · Ship &amp; measure</dt>
                <dd>Land these three fixes (done) and add lightweight renderer metrics — renders/sec, bytes/sec, dropped-frame count, worker recycles — so any further work is driven by data, not guesses.</dd>
              </div>
              <div>
                <dt>2 · Packed framebuffer (only if a profile shows pressure)</dt>
                <dd>Prototype a <code>Uint32Array</code> framebuffer behind the existing <code>PixelGrid</code> seam and measure it, with the byte-identical differ tests as the guardrail. This is the legitimate core of the plan&rsquo;s &ldquo;packed data plane&rdquo;, minus the fabricated urgency.</dd>
              </div>
              <div>
                <dt>3 · Idle static-screen skip</dt>
                <dd>Menus and the lounge still recompose + diff ~15&times;/sec even when nothing changed (CPU only — the diff emits no bytes). A cheap dirty flag on input/resize/focus/state change zeroes that out.</dd>
              </div>
              <div>
                <dt>4 · Do not pursue on this document</dt>
                <dd>The 384&times;128 cap, Scene Compiler, Kitty placements and edge-rollback netcode should be re-evaluated only against measured production data — not the source plan.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="report-section">
          <div className="report-index">06 / PATCH</div>
          <div>
            <h2>Complete diff</h2>
            <p>
              The full unified diff of the three changed files, verbatim.{' '}
              <a href="https://github.com/thomasdavis/sshfighter.com" target="_blank" rel="noreferrer">Source on GitHub &#8599;</a>
            </p>
            {DIFF ? <DiffBlock text={DIFF} /> : <p className="report-caveat">Diff unavailable in this build.</p>}
          </div>
        </section>
      </main>
      <Footer />

      <style>{`
        .rx-code{background:#12101a;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px 16px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55;color:#cfd6e6;margin:0}
        .rx-log{white-space:pre;color:#bfe6c8}
        .rx-diff{max-height:640px;overflow:auto}
        .rx-twocol{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:.75rem}
        @media (max-width:760px){.rx-twocol{grid-template-columns:1fr}}
      `}</style>
    </div>
  );
}
