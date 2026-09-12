# Flybrain source art

Generated with the built-in image-generation tool in `stylized-concept` mode.

## Master prompt

Create one original male-coded mutant neurologist fighter named Flybrain: a lean,
long-limbed human/fly hybrid in strict side view facing right. Give him an
oversized transparent amber cranial dome containing a readable coral-pink brain
with cyan synapses, dark-teal compound eyes, an insect respirator, four
iridescent wings, torn white lab-coat tails, a charcoal combat suit, segmented
teal guards, and acid-lime wraps and boots. Use bright hand-painted 1990s arcade
fighter art, bold black outlines, flat cel shading, a readable silhouette, full
body with clear margins, and a genuinely transparent background. No text, UI,
logo, ground, cast shadow, extra characters, or cropped anatomy.

## Pose-sheet prompt

Using `master-reference.png` as the immutable identity and costume reference,
redraw the exact same character as two transparent 4x4 sheets. Keep strict
right-facing side view, consistent anatomy and scale, one full figure per equal
cell, no labels, borders, grid lines, ground, shadows, or overlapping cells.

`pose-sheet-a.png`, left-to-right by row:

1. idle 1, idle 2, walk 1, walk 2
2. crouch, jump, fall, block
3. crouch block, hit, knockout, punch wind-up
4. extended punch, kick wind-up, extended high kick, crouch-punch wind-up

`pose-sheet-b.png`, left-to-right by row:

1. crouch punch, crouch-kick wind-up, sweep kick, flying kick
2. throw wind-up, throw lift, throw recovery, thrown upward
3. thrown downward, one-fist victory, two-fist victory, relaxed victory
4. Idea Hatch with brain-egg, Back of Mind afterimage counter, Brain Drain cast,
   Brain Drain siphon pulse

The two generated sheets arrived with a rendered checkerboard. Running
`npm run pack:flybrain` uses the project-local packer to recover transparency,
discard cross-cell fragments, crop each figure, calculate its feet anchor, and
write the runtime JSON sprites.
