/**
 * look_coverage — the validation-set coverage check. A look judged only on bright frames is
 * untested in the shadows, and the shadows are where a badly-built look actually breaks.
 * Deterministic, no Resolve: synthesize frames at known tonal levels and assert the report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { scopeRead } from '../server/scope-read.mjs';
import { assessLookCoverage } from '../server/look-coverage.mjs';
import { drxTool } from '../server/tools/drx.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

async function solid(file, v, w = 64, h = 64) {
  const buf = Buffer.alloc(w * h * 3, v);
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(file);
}

/** Half at `a`, half at `b` — populates two bands at once. */
async function twoLevel(file, a, b, w = 64, h = 64) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) buf.fill(y < h / 2 ? a : b, y * w * 3, (y + 1) * w * 3);
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(file);
}

async function read(files) {
  const out = [];
  for (const f of files) out.push({ id: path.basename(f), scope: await scopeRead(f) });
  return out;
}

test('a look judged only on bright frames is reported UNTESTED in the shadows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-'));
  const a = path.join(dir, 'hero1.png');
  const b = path.join(dir, 'hero2.png');
  await solid(a, 210); // high band only
  await solid(b, 195);
  const r = assessLookCoverage(await read([a, b]));
  assert.deepEqual(r.untested, ['low', 'mid'], 'both dark bands never populated');
  assert.deepEqual(r.covered, ['high']);
  assert.equal(r.acceptable, false);
  assert.match(r.warnings.join(' '), /shadows UNTESTED/);
});

test('a set spanning all three bands is acceptable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-'));
  const f1 = path.join(dir, 'a.png');
  const f2 = path.join(dir, 'b.png');
  await twoLevel(f1, 40, 128); // low + mid
  await twoLevel(f2, 128, 210); // mid + high
  // two frames each contributing two bands still leaves low/high at one frame apiece
  const thin = assessLookCoverage(await read([f1, f2]));
  assert.deepEqual(thin.untested, [], 'every band was seen at least once');
  assert.deepEqual(thin.thin, ['low', 'high'], 'seen once is not coverage');
  assert.equal(thin.acceptable, false);
  // add a second frame for each end
  const f3 = path.join(dir, 'c.png');
  const f4 = path.join(dir, 'd.png');
  await twoLevel(f3, 30, 200);
  await twoLevel(f4, 50, 220);
  const ok = assessLookCoverage(await read([f1, f2, f3, f4]));
  assert.deepEqual(ok.untested, []);
  assert.deepEqual(ok.thin, []);
  assert.equal(ok.acceptable, true);
});

test('coverage is a statement about the evidence, not approval of the look', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-'));
  const f = path.join(dir, 'x.png');
  await twoLevel(f, 40, 210);
  const r = assessLookCoverage(await read([f]));
  assert.match(r.note, /not a verdict on the look/i);
  assert.equal(r.frameCount, 1);
});

test('an empty set is not accidentally "acceptable"', async () => {
  const r = assessLookCoverage([]);
  assert.equal(r.acceptable, false);
  assert.equal(r.frameCount, 0);
  assert.match(r.warnings.join(' '), /no readable frames/);
});

test('drx look_coverage action reads the frames and reports unreadable ones separately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-'));
  const a = path.join(dir, 'a.png');
  await twoLevel(a, 40, 210);
  const r = await drxTool.handler({ action: 'look_coverage', args: { pngs: [a, path.join(dir, 'missing.png')] } });
  assert.equal(r.frameCount, 1);
  assert.deepEqual(r.unreadable, [path.join(dir, 'missing.png')], 'a frame we cannot read is not coverage');
});

test('an id-less frame keeps the same label in every band it contributes to', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-'));
  const f = path.join(dir, 'x.png');
  await twoLevel(f, 40, 210); // populates low AND high
  const scope = await scopeRead(f);
  const r = assessLookCoverage([{ scope }]); // no id supplied
  assert.deepEqual(r.perBand.low.frameIds, ['frame0']);
  assert.deepEqual(r.perBand.high.frameIds, ['frame0'], 'same frame, same label across bands');
});
