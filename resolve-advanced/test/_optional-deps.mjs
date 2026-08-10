/**
 * Availability probes for the optional native dependencies.
 *
 * `better-sqlite3` is an optionalDependency (see package.json) and the README
 * documents it as optional: the Project.db / lineage / conform paths need it,
 * the .drp-zip paths do not. But the tests covering those paths called straight
 * into `loadSqlite()` and *failed* when it was absent, rather than skipping.
 *
 * That is the same defect the Python CI already documents for ffmpeg -- tests
 * that "fail outright rather than skipping" turn a missing optional tool into a
 * red suite, which trains everyone to ignore red. A skip says "not measured
 * here"; a failure says "this is broken". Only one of those is true when an
 * optional native module is simply not installed.
 *
 * Probing with require() rather than require.resolve() on purpose: a native
 * module can resolve on disk and still fail to load (wrong ABI after a Node
 * upgrade is the usual way). The load is what the code under test does, so the
 * load is what gets probed.
 *
 * Usage mirrors the existing python3 gate in aaf-sequences.test.mjs:
 *
 *   test('needs a database', { skip: SQLITE_MISSING }, () => { ... })
 *
 * The exported value is `false` when the dependency is present, so node:test
 * runs the test normally, and a human-readable reason string when it is not.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function probe(name, install) {
  try {
    require(name);
    return false;
  } catch {
    return `${name} not installed (optional dependency -- ${install})`;
  }
}

export const SQLITE_MISSING = probe('better-sqlite3', 'npm i better-sqlite3');
