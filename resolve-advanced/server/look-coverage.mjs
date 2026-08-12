/**
 * look_coverage — is a look actually VALIDATED, or only validated where it was built?
 *
 * The failure mode this exists for: a look is developed and judged on a bright, mid-key
 * hero frame, ships, and then falls apart on the first dark interior — a hard cast appears
 * in the shadows, skin goes cyan in the low end. The look was never wrong on the hero; it
 * was never TESTED below the hero's black point. A look is a macro transform applied to
 * every shot, so the tonal regions its validation set never populated are regions where its
 * behaviour is simply unknown.
 *
 * Given the scope_read results for the frames a look was judged on, this reports which
 * tonal bands the SET covers and names the ones left untested. It is a coverage check on
 * the evidence, not a judgement of the look: it cannot tell you the look is good in a
 * covered band, only that an uncovered band was never looked at.
 *
 * PURE + deterministic: consumes scope_read results, emits a report. No frames, no Resolve,
 * no LLM. `sparse` per frame comes from scope-read's own BAND_MIN_FRAC threshold.
 */

const BANDS = ['low', 'mid', 'high'];
const HUMAN = { low: 'shadows', mid: 'midtones', high: 'highlights' };

// A band counts as covered by the SET when at least this many frames populate it. One frame
// is a data point, not coverage — a look that met the shadows once has met one shadow.
const MIN_FRAMES_PER_BAND = 2;

/**
 * @param {Array<{id?:string, scope:object}>} frames scope_read results for the validation set
 * @param {{minFramesPerBand?:number}} [opts]
 * @returns {{covered:string[], untested:string[], thin:string[], perBand:object, frameCount:number, acceptable:boolean, warnings:string[]}}
 */
export function assessLookCoverage(frames = [], opts = {}) {
  const minPer = opts.minFramesPerBand ?? MIN_FRAMES_PER_BAND;
  // Label frames by their position in the SET, so an id-less frame keeps the same name in
  // every band it contributes to (indexing per band would rename it band to band).
  const usable = (frames || [])
    .map((f, i) => ({ frame: f, label: f?.id ?? `frame${i}` }))
    .filter(({ frame }) => frame && frame.scope && frame.scope.paradeBands);
  const perBand = {};
  for (const b of BANDS) {
    const contributors = usable.filter(({ frame }) => !frame.scope.paradeBands[b]?.sparse);
    perBand[b] = {
      frames: contributors.length,
      frameIds: contributors.map(({ label }) => label),
      // How much of the band the best-populated frame actually held — a band met only by a
      // frame that barely reaches into it is weaker evidence than one met head-on.
      maxFrac: contributors.reduce((m, { frame }) => Math.max(m, frame.scope.paradeBands[b].frac || 0), 0),
      covered: contributors.length >= minPer,
    };
  }
  const covered = BANDS.filter((b) => perBand[b].covered);
  const untested = BANDS.filter((b) => perBand[b].frames === 0);
  const thin = BANDS.filter((b) => perBand[b].frames > 0 && !perBand[b].covered);

  const warnings = [];
  if (!usable.length) {
    warnings.push('no readable frames with a band-limited parade — run scope_read on the validation set first');
  }
  for (const b of untested) {
    warnings.push(
      `${HUMAN[b]} UNTESTED: no frame in this set populates the ${b} band, so the look's behaviour there is unknown. ` +
        `Add a frame that lives in the ${HUMAN[b]} before shipping — this is where a look built on a hero frame breaks.`
    );
  }
  for (const b of thin) {
    warnings.push(`${HUMAN[b]} thin: only ${perBand[b].frames} frame(s) populate the ${b} band (want ${minPer}+).`);
  }
  return {
    frameCount: usable.length,
    covered,
    untested,
    thin,
    perBand,
    // Coverage of the evidence, NOT approval of the look. A look can cover all three bands
    // and still be ugly; that judgement needs eyes on the render.
    acceptable: untested.length === 0 && thin.length === 0 && usable.length > 0,
    warnings,
    note: 'Coverage of the VALIDATION SET, not a verdict on the look. Full bands mean the look was seen everywhere it will be used — not that it was good there.',
  };
}
