// Focused deterministic checks for Flybrain's three signature mechanics.
import { emptyInputs } from './game/types.js';
import { ATTACKS, BACK_MIND, BRAIN_DRAIN, IDEA_HATCH, makeFighter, makeMatch, stepMatch } from './game/engine.js';
import { CORTEX_PALETTE, RED_PALETTE } from './game/sprites.js';

let failed = false;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`PASS ${label}`);
  else { failed = true; console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`); }
}
const neutral = () => emptyInputs();
const fresh = () => {
  const flybrain = makeFighter('flybrain', 'FLYBRAIN', 'a', CORTEX_PALETTE);
  const rival = makeFighter('rival', 'BYU', 'b', RED_PALETTE);
  const match = makeMatch(flybrain, rival);
  match.phase = 'fight'; match.phaseTimer = 0; match.projectiles = [];
  flybrain.x = 54; rival.x = 186;
  return match;
};

// IDEA HATCH: input plants one harmless egg, then exactly three gnats emerge.
{
  const m = fresh();
  stepMatch(m, { ...neutral(), punch: true, motion: 'DR' }, neutral());
  check('Idea Hatch input resolves', m.a.attack === 'ideahatch');
  for (let i = 0; i < IDEA_HATCH.spawn; i++) stepMatch(m, neutral(), neutral());
  check('Idea Hatch plants one egg', m.projectiles.filter((p) => p.style === 'ideaegg').length === 1);
  for (let i = 0; i < IDEA_HATCH.hatch; i++) stepMatch(m, neutral(), neutral());
  check('egg hatches into three thought-gnats', m.projectiles.filter((p) => p.style === 'gnat').length === 3);
  check('hatch consumes the egg', !m.projectiles.some((p) => p.style === 'ideaegg'));
}

// BACK OF MIND: a valid close strike hits the afterimage, not Flybrain.
{
  const m = fresh();
  m.a.x = 120; m.b.x = 100; m.a.facing = -1; m.b.facing = 1;
  m.a.attack = 'backmind'; m.a.attackFrame = BACK_MIND.startup - 1;
  m.b.attack = 'punch'; m.b.attackFrame = ATTACKS.punch.startup - 1;
  stepMatch(m, neutral(), neutral());
  check('Back of Mind negates melee damage', m.a.hp === 100);
  check('Back of Mind retaliates for 14', m.b.hp === 100 - BACK_MIND.dmg, `hp=${m.b.hp}`);
  check('Back of Mind appears behind the attacker', m.a.x < m.b.x && Number(m.a.facing) === 1, `x=${m.a.x}/${m.b.x}`);
}

// The same counter catches a projectile and punishes its owner across the stage.
{
  const m = fresh();
  m.a.x = 150; m.b.x = 60;
  m.a.attack = 'backmind'; m.a.attackFrame = BACK_MIND.startup - 1;
  m.projectiles.push({ id: m.nextProjectileId++, owner: 'b', x: 140, y: 30, vx: 2, vy: 0,
    active: true, hit: false, frame: 0, facing: 1, style: 'blue', sourceAttack: 'hadouken' });
  stepMatch(m, neutral(), neutral());
  check('Back of Mind destroys the incoming projectile', m.projectiles.length === 0);
  check('projectile counter damages its remote owner', m.b.hp === 100 - BACK_MIND.dmg, `hp=${m.b.hp}`);
}

// BRAIN DRAIN: a clean pulse damages and heals; its remaining pulses are driven
// by the normal hit-reset loop and covered by attack timing invariants.
{
  const m = fresh();
  m.a.x = 80; m.b.x = 140; m.a.facing = 1; m.b.facing = -1;
  m.a.hp = 80; m.a.attack = 'braindrain'; m.a.attackFrame = BRAIN_DRAIN.startup - 1;
  stepMatch(m, neutral(), neutral());
  check('Brain Drain first pulse deals damage', m.b.hp === 100 - BRAIN_DRAIN.dmg, `hp=${m.b.hp}`);
  check('Brain Drain heals only its clean pulse', m.a.hp === 80 + BRAIN_DRAIN.heal, `hp=${m.a.hp}`);
}

if (failed) process.exit(1);
console.log('FLYBRAIN TEST: PASS');
