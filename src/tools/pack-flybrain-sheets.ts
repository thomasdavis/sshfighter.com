// Packs Flybrain's generated 4x4 pose sheets into the engine's anchored RGBA
// sprite format. The image generator drew a checkerboard backdrop into the
// sheets, so we flood-fill connected light-neutral pixels from each cell edge
// to recover real transparency without erasing the enclosed white coat.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDir = resolve(root, 'assets/source/flybrain');
const outputDir = resolve(root, 'assets/sprites/FLYBRAIN');

const SHEETS = [
  {
    file: 'pose-sheet-a.png',
    names: [
      'idle_1', 'idle_2', 'walk_1', 'walk_2',
      'crouch', 'jump', 'fall', 'block',
      'crouchblock', 'hit', 'ko', 'punch_1',
      'punch_2', 'kick_1', 'kick_2', 'crouchpunch_1',
    ],
  },
  {
    file: 'pose-sheet-b.png',
    names: [
      'crouchpunch_2', 'crouchkick_1', 'crouchkick_2', 'jumpkick',
      'throw_1', 'throw_2', 'throw_3', 'thrown_1',
      'thrown_2', 'victory_1', 'victory_2', 'victory_3',
      'ideahatch', 'backmind', 'braindrain_1', 'braindrain_2',
    ],
  },
] as const;

interface PackedFrame {
  w: number;
  h: number;
  anchorX: number;
  anchorY: number;
  data: string;
}

function isCheckerPixel(data: Buffer, index: number): boolean {
  const r = data[index]!, g = data[index + 1]!, b = data[index + 2]!;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 14 && (r + g + b) / 3 >= 154;
}

function recoverAlpha(rgb: Buffer, width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  const outside = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;

  const enqueue = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (outside[pixel] || !isCheckerPixel(rgb, pixel * 3)) return;
    outside[pixel] = 1;
    queue[tail++] = pixel;
  };

  for (let x = 0; x < width; x++) { enqueue(x, 0); enqueue(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { enqueue(0, y); enqueue(width - 1, y); }
  while (head < tail) {
    const pixel = queue[head++]!;
    const x = pixel % width, y = Math.floor(pixel / width);
    enqueue(x - 1, y); enqueue(x + 1, y); enqueue(x, y - 1); enqueue(x, y + 1);
  }

  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = pixel * 3, target = pixel * 4;
    rgba[target] = rgb[source]!;
    rgba[target + 1] = rgb[source + 1]!;
    rgba[target + 2] = rgb[source + 2]!;
    rgba[target + 3] = outside[pixel] ? 0 : 255;
  }
  return rgba;
}

function keepLargestComponent(rgba: Buffer, width: number, height: number): void {
  const seen = new Uint8Array(width * height);
  let largest: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || rgba[start * 4 + 3]! < 128) continue;
    const component: number[] = [start];
    seen[start] = 1;
    for (let head = 0; head < component.length; head++) {
      const pixel = component[head]!;
      const x = pixel % width, y = Math.floor(pixel / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (seen[next] || rgba[next * 4 + 3]! < 128) continue;
        seen[next] = 1;
        component.push(next);
      }
    }
    if (component.length > largest.length) largest = component;
  }
  const keep = new Uint8Array(width * height);
  for (const pixel of largest) keep[pixel] = 1;
  for (let pixel = 0; pixel < width * height; pixel++) if (!keep[pixel]) rgba[pixel * 4 + 3] = 0;
}

function packCell(rgba: Buffer, width: number, height: number): PackedFrame {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rgba[(y * width + x) * 4 + 3]! < 128) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error('empty sprite cell');
  const pad = 2;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const cropped = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const start = ((minY + y) * width + minX) * 4;
    rgba.copy(cropped, y * w * 4, start, start + w * 4);
  }

  // Average opaque pixels in the lowest occupied fifth. This follows the same
  // stable feet-anchor convention as the main generated-sprite packer.
  let sumX = 0, count = 0;
  for (let y = Math.floor(h * 0.8); y < h; y++) for (let x = 0; x < w; x++) {
    if (cropped[(y * w + x) * 4 + 3]! >= 128) { sumX += x; count++; }
  }
  return {
    w,
    h,
    anchorX: count ? Math.round(sumX / count) : Math.floor(w / 2),
    anchorY: h - 1,
    data: cropped.toString('base64'),
  };
}

mkdirSync(outputDir, { recursive: true });
for (const sheet of SHEETS) {
  const { data, info } = await sharp(resolve(sourceDir, sheet.file))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let index = 0; index < 16; index++) {
    const col = index % 4, row = Math.floor(index / 4);
    const left = Math.round(col * info.width / 4);
    const right = Math.round((col + 1) * info.width / 4);
    const top = Math.round(row * info.height / 4);
    const bottom = Math.round((row + 1) * info.height / 4);
    const width = right - left, height = bottom - top;
    const cell = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      const start = ((top + y) * info.width + left) * 3;
      data.copy(cell, y * width * 3, start, start + width * 3);
    }
    const rgba = recoverAlpha(cell, width, height);
    keepLargestComponent(rgba, width, height);
    const packed = packCell(rgba, width, height);
    const name = sheet.names[index]!;
    writeFileSync(resolve(outputDir, `${name}.json`), JSON.stringify(packed));
    console.log(`  FLYBRAIN/${name} ${packed.w}x${packed.h}`);
  }
}

// Menus use the same calm guard as the first idle frame.
writeFileSync(resolve(outputDir, 'menu.json'), readFileSync(resolve(outputDir, 'idle_1.json')));
console.log(`packed 33 Flybrain frames -> ${outputDir}`);
