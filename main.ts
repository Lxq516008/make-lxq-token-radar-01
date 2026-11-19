// Token Radar's entrypoint: read the sealed snapshot, rank the pre-token protocols by implied
// value, and write the board, the dashboard data, the dashboard itself, its screenshots and the
// dossier the scorer compares. Node 22, standard library only, no network, no clock: the same
// snapshot always writes the same bytes.
//
//   node main.ts --input /input --output /output
//
// --input is the snapshot file or the directory holding snapshot.json (default /input).
// --output is the directory to write to (default $MAKEFUN_OUTPUT_DIR, else /output).
// dashboard/ and screenshots/ are copied from beside this file, the repository root.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { MODEL, MODEL_VERSION, boardIssue, buildRadar } from './lib/model.ts';
import type { Snapshot } from './lib/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = '/input';
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--input' && argv[i + 1] !== undefined) input = argv[++i]!;
    else if (arg.startsWith('--input=')) input = arg.slice('--input='.length);
    else if (arg === '--output' && argv[i + 1] !== undefined) output = argv[++i]!;
    else if (arg.startsWith('--output=')) output = arg.slice('--output='.length);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node main.ts [--input <snapshot.json or dir>] [--output <dir>]\n');
      process.exit(0);
    } else {
      throw new Error(`main.ts: unknown argument ${arg}`);
    }
  }
  return { input, output };
}

function readSnapshot(input: string): Snapshot {
  const path = statSync(input).isDirectory() ? join(input, 'snapshot.json') : input;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`main.ts: ${path} is not a snapshot object`);
  const snap = parsed as Snapshot;
  if (!Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist) || typeof snap.as_of !== 'string') {
    throw new Error(`main.ts: ${path} is missing protocols, watchlist or as_of`);
  }
  return snap;
}

function copyTree(srcDir: string, dstDir: string): void {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(join(srcDir, entry.name), join(dstDir, entry.name));
  }
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const out = resolve(output);
  const snapshot = readSnapshot(input);
  const radar = buildRadar(snapshot);
  const issue = boardIssue(radar.rows, snapshot.watchlist);
  if (issue !== null) throw new Error(`main.ts: ${issue}`);

  mkdirSync(out, { recursive: true });

  // The board the scorer reads: one object, its rows in rank order.
  writeFileSync(join(out, 'board.json'), JSON.stringify({ rows: radar.rows }, null, 2) + '\n', 'utf8');

  // The data the dashboard reads: the same rows, the live-token list set aside, the model and
  // the multiples it was calibrated on, so the page can show its working and recompute any row.
  const data = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    global_multiple: radar.globalMultiple,
    multiples: Object.fromEntries(radar.multiples.entries()),
    multiple_samples: Object.fromEntries(radar.multipleSamples.entries()),
    watchlist_size: radar.watchlistSize,
    early_size: radar.earlySize,
    board_size: radar.boardSize,
    live_size: radar.liveSize,
    rows: radar.rows,
    live: radar.live.map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains ?? [],
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
    })),
  };
  writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(data)};\n`, 'utf8');

  // The dashboard and its screenshots, copied from the repository root beside this file.
  copyTree(join(HERE, 'dashboard'), join(out, 'dashboard'));
  // The dossier's text cap is 65,536 bytes: the dashboard source must fit whole, or the judge
  // would read a cut copy. Fail loudly here instead of shipping a truncated source.
  const dashBytes = readdirSync(join(out, 'dashboard'), { withFileTypes: true })
    .filter((e) => e.isFile())
    .reduce((n, e) => n + statSync(join(out, 'dashboard', e.name)).size, 0);
  if (dashBytes > 60000) {
    throw new Error(`main.ts: dashboard/ is ${dashBytes} bytes, past the 60,000 it must stay under`);
  }
  const shotsDir = join(HERE, 'screenshots');
  const shots = existsSync(shotsDir)
    ? readdirSync(shotsDir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.'))
    : [];
  if (shots.length < 3) {
    throw new Error(`main.ts: screenshots/ holds ${shots.length} images, not the 3 it must`);
  }
  copyTree(shotsDir, join(out, 'screenshots'));

  // The dossier: byte-for-byte what the scorer rebuilds from the same directory.
  writeFileSync(
    join(out, 'dossier.json'),
    buildDossier(out, {
      text_max_bytes: 65536,
      screenshots: { max: 4, max_bytes: 524288 },
      dashboard: { max_files: 400, max_bytes: 4194304 },
    }),
    'utf8',
  );

  process.stdout.write(
    `Token Radar ${MODEL_VERSION}: ${radar.boardSize} rows (${radar.watchlistSize} watchlist + ${radar.earlySize} early), ` +
      `${radar.liveSize} live-token protocols set aside, ${shots.length} screenshots, wrote ${out}\n`,
  );
}

main();
