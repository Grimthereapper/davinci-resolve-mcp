/**
 * scope_read (Layer-3 substrate) — deterministic, no Resolve. Synthesizes frames with
 * known stats and asserts channel percentiles, colorist readouts (parade delta, skin-line,
 * black-balance, %clip/%crush) and the deterministic intent signals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { scopeRead } from '../server/scope-read.mjs';
import { drxTool } from '../server/tools/drx.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const SKIN = { r: 200, g: 140, b: 110 };
const BLUE = { r: 20, g: 40, b: 160 };

async function solid(file, { r, g, b }, w = 64, h = 64) {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(file);
}

/** Top `skinRows` skin, rest bg. */
async function splitFrame(file, { w = 64, h = 64, skinRows = 32, skin = SKIN, bg = BLUE }) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const c = y < skinRows ? skin : bg;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = c.r;
      buf[i + 1] = c.g;
      buf[i + 2] = c.b;
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(file);
}

test('scope_read reports per-channel means and a neutral parade on gray', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const f = path.join(dir, 'gray.png');
  await solid(f, { r: 128, g: 128, b: 128 });
  const s = await scopeRead(f);
  assert.equal(s.channels.r.mean, 128);
  assert.equal(s.channels.g.p50, 128);
  assert.equal(s.parade.spread, 0, 'gray is balanced');
  assert.equal(s.blackBalance.castSpread, 0);
  assert.equal(s.meanSat, 0, 'gray has zero saturation');
});

test('scope_read flags clip/crush at the extremes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const white = path.join(dir, 'white.png');
  const black = path.join(dir, 'black.png');
  await solid(white, { r: 255, g: 255, b: 255 });
  await solid(black, { r: 0, g: 0, b: 0 });
  const sw = await scopeRead(white);
  const sb = await scopeRead(black);
  assert.equal(sw.clipPct, 100);
  assert.equal(sb.crushPct, 100);
});

test('scope_read parade delta detects a warm cast', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const f = path.join(dir, 'warm.png');
  await solid(f, { r: 180, g: 120, b: 90 });
  const s = await scopeRead(f);
  assert.ok(s.parade.rb > 0, 'red above blue (warm)');
  assert.ok(s.parade.spread > 50);
});

/** Half shadow-band pixels, half highlight-band pixels, each with its own cast. */
async function twoBandFrame(file, shadow, highlight, w = 64, h = 64) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const c = y < h / 2 ? shadow : highlight;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = c.r;
      buf[i + 1] = c.g;
      buf[i + 2] = c.b;
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(file);
}

test('scope_read splits the parade into shadow/mid/highlight bands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const f = path.join(dir, 'bands.png');
  // neutral shadows (luma ~40) + neutral highlights (luma ~200): both bands populated, no cast
  await twoBandFrame(f, { r: 40, g: 40, b: 40 }, { r: 200, g: 200, b: 200 });
  const s = await scopeRead(f);
  assert.ok(Math.abs(s.paradeBands.low.frac - 0.5) < 0.05, `low frac ${s.paradeBands.low.frac}`);
  assert.ok(Math.abs(s.paradeBands.high.frac - 0.5) < 0.05, `high frac ${s.paradeBands.high.frac}`);
  assert.equal(s.paradeBands.mid.sparse, true, 'nothing in the midtones');
  assert.equal(s.paradeBands.low.wheel, 'lift');
  assert.equal(s.paradeBands.mid.wheel, 'gamma');
  assert.equal(s.paradeBands.high.wheel, 'gain');
  assert.equal(s.paradeBands.low.spread, 0, 'neutral shadows');
  assert.equal(s.bandDiagnosis.castLocus, null, 'a balanced frame gets no wheel to reach for');
  assert.equal(s.bandDiagnosis.wheel, null);
  assert.equal(s.bandDiagnosis.castShape, 'uniform');
});

test('scope_read locates a shadows-only cast and names the wheel that fixes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const f = path.join(dir, 'coolshadows.png');
  // blue-lifted shadows, neutral highlights — the classic black-balance problem
  await twoBandFrame(f, { r: 30, g: 40, b: 70 }, { r: 200, g: 200, b: 200 });
  const s = await scopeRead(f);
  assert.ok(s.paradeBands.low.rb < -30, `low R−B ${s.paradeBands.low.rb}`);
  assert.equal(s.paradeBands.high.rb, 0, 'highlights are clean');
  assert.equal(s.bandDiagnosis.castLocus, 'low');
  assert.equal(s.bandDiagnosis.castShape, 'shadows_only');
  assert.equal(s.bandDiagnosis.wheel, 'lift', 'a shadow cast is a lift/offset move, not a gain move');
});

test('scope_read distinguishes a highlight cast from a split-toned frame', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const warmHi = path.join(dir, 'warmhi.png');
  const split = path.join(dir, 'split.png');
  // cast grows with brightness → white-balance/gain problem
  await twoBandFrame(warmHi, { r: 40, g: 40, b: 40 }, { r: 230, g: 195, b: 160 });
  // cool shadows against warm highlights → deliberate split tone, NOT one cast to neutralize
  await twoBandFrame(split, { r: 25, g: 38, b: 65 }, { r: 230, g: 195, b: 160 });
  const sw = await scopeRead(warmHi);
  const ss = await scopeRead(split);
  assert.equal(sw.bandDiagnosis.castLocus, 'high');
  assert.equal(sw.bandDiagnosis.castShape, 'grows_with_luma');
  assert.equal(sw.bandDiagnosis.wheel, 'gain');
  assert.equal(ss.bandDiagnosis.castShape, 'split_toned', 'opposite casts at the two ends');
});

test('scope_read marks an empty band sparse rather than inventing a cast for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const f = path.join(dir, 'night.png');
  await solid(f, { r: 18, g: 20, b: 30 }); // low-key: no mids, no highlights at all
  const s = await scopeRead(f);
  assert.equal(s.paradeBands.high.sparse, true);
  assert.equal(s.paradeBands.high.frac, 0);
  assert.equal(s.paradeBands.high.rb, null, 'no pixels → no number to act on');
  assert.equal(s.bandDiagnosis.castLocus, 'low', 'only the populated band can carry the cast');
  assert.equal(s.bandDiagnosis.castShape, null, 'shape is unknowable with one end empty');
});

test('scope_read measures the vectorscope skin-line only over skin pixels', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const f = path.join(dir, 'skin.png');
  await splitFrame(f, { skinRows: 32 });
  const s = await scopeRead(f);
  assert.ok(s.skinLine, 'skin-line present');
  assert.ok(s.skinLine.skinFrac > 0.4 && s.skinLine.skinFrac < 0.6);
  assert.ok(s.skinLine.distance > 0, 'skin sits off the neutral axis');
  assert.equal(typeof s.skinLine.angleDeg, 'number');
});

test('scope_read has no skin-line on a non-skin frame', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const f = path.join(dir, 'blue.png');
  await solid(f, BLUE);
  const s = await scopeRead(f);
  assert.equal(s.skinLine, null);
});

test('scope_read intent signals detect low-key and monochromatic frames', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const dark = path.join(dir, 'dark.png');
  const teal = path.join(dir, 'teal.png');
  await solid(dark, { r: 18, g: 20, b: 24 });
  await solid(teal, { r: 20, g: 130, b: 130 });
  const sd = await scopeRead(dark);
  const st = await scopeRead(teal);
  assert.equal(sd.signals.lowKey, true, 'dark frame is low-key');
  assert.equal(st.signals.monochromatic, true, 'single-hue teal is monochromatic');
  assert.ok(st.signals.dominantHueDeg >= 150 && st.signals.dominantHueDeg <= 210, `hue ${st.signals.dominantHueDeg}`);
});

test('scope_read rect restricts measurement to a region', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const f = path.join(dir, 'split.png');
  await splitFrame(f, { skinRows: 32 }); // top skin, bottom blue
  const top = await scopeRead(f, { rect: { x: 0, y: 0, w: 1, h: 0.4 } });
  assert.ok(Math.abs(top.channels.r.mean - SKIN.r) < 3, `top r ${top.channels.r.mean}`);
});

test('drx scope_read action returns the readout and throws on unreadable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const f = path.join(dir, 'gray.png');
  await solid(f, { r: 100, g: 100, b: 100 });
  const r = await drxTool.handler({ action: 'scope_read', args: { png: f } });
  assert.equal(r.channels.r.mean, 100);
  await assert.rejects(() => drxTool.handler({ action: 'scope_read', args: { png: path.join(dir, 'nope.png') } }), /unreadable/);
});
