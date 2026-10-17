// Entry point. Runs a requested rebuild before anything opens the database, then starts the server.
//
// REBUILD=<token>: rebuild from the raw archive on startup, once per token. The last successful rebuild
// is recorded in DATA_DIR/.rebuild-done, so leaving the variable set doesn't repeat it; change the
// value to rebuild again. REBUILD_FORCE=true skips the rebuild's archive-coverage checks.
//
// RESET_DATA=<token>: delete all collected history (database, CSV archive, raw snapshots, rebuild
// backups) on startup, once per token (recorded in DATA_DIR/.reset-done), and start fresh. Runs
// before any rebuild. Only ALNinja's own files are removed; the data directory itself is kept.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const version = (process.env.ALNINJA_VERSION || "dev").slice(0, 7);
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const marker = path.join(dataDir, ".rebuild-done");
const token = process.env.REBUILD?.trim();

interface RebuildRecord {
  token: string;
  at?: string;
  summary?: string;
}

/** The last completed rebuild. Older versions wrote just the token as plain text. */
function lastRebuild(): RebuildRecord | null {
  if (!fs.existsSync(marker)) return null;
  const text = fs.readFileSync(marker, "utf8").trim();
  try {
    return JSON.parse(text);
  } catch {
    return { token: text };
  }
}

console.log(`[startup] ALNinja ${version}`);

const resetToken = process.env.RESET_DATA?.trim();
if (resetToken) {
  const resetMarker = path.join(dataDir, ".reset-done");
  const done = fs.existsSync(resetMarker) ? JSON.parse(fs.readFileSync(resetMarker, "utf8")) : null;
  if (done?.token === resetToken) {
    console.log(`[startup] reset: RESET_DATA=${resetToken} already done on ${done.at}; change the value to reset again`);
  } else {
    resetData(resetToken, resetMarker);
  }
}

/** Deletes everything ALNinja has collected in dataDir. Game-data cache and markers stay. */
function resetData(token: string, resetMarker: string) {
  const size = (p: string): { files: number; bytes: number } => {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return { files: 1, bytes: st.size };
    return fs.readdirSync(p).map((n) => size(path.join(p, n)))
      .reduce((a, b) => ({ files: a.files + b.files, bytes: a.bytes + b.bytes }), { files: 0, bytes: 0 });
  };
  const groups: Record<string, RegExp> = {
    database: /^alninja\.sqlite/, // live database, its WAL files, *.bak-* backups and an unfinished .rebuild
    "CSV archive": /^archive($|\.)/, // archive/, archive.bak-*, archive.rebuild
    "raw snapshots": /^raw$/,
  };
  const parts: string[] = [];
  for (const [label, pattern] of Object.entries(groups)) {
    let total = { files: 0, bytes: 0 };
    for (const name of fs.readdirSync(dataDir).filter((n) => pattern.test(n))) {
      const p = path.join(dataDir, name);
      const s = size(p);
      total = { files: total.files + s.files, bytes: total.bytes + s.bytes };
      fs.rmSync(p, { recursive: true, force: true });
    }
    parts.push(`${label} (${total.files} files, ${(total.bytes / 1e6).toFixed(1)} MB)`);
  }
  // The old rebuild record describes data that's gone. If REBUILD is still set, mark it done so it
  // doesn't try to rebuild from the now-empty raw archive.
  fs.rmSync(marker, { force: true });
  if (token && process.env.REBUILD?.trim()) {
    fs.writeFileSync(marker, JSON.stringify({ token: process.env.REBUILD.trim(), summary: "skipped: data was reset" }) + "\n");
  }
  const at = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  fs.writeFileSync(resetMarker, JSON.stringify({ token, at }) + "\n");
  console.log(`[startup] reset: RESET_DATA=${token} ✔ deleted all history: ${parts.join(", ")}. Starting fresh.`);
}

const last = lastRebuild();
const lastText = last ? `last rebuild: REBUILD=${last.token}${last.at ? ` on ${last.at}` : ""}` : "never rebuilt";

if (!token) {
  console.log(`[startup] rebuild: not requested (set REBUILD to rebuild from the raw archive; ${lastText})`);
} else if (last?.token === token) {
  console.log(`[startup] rebuild: REBUILD=${token} already done${last.at ? ` on ${last.at}` : ""}; ` +
    "change the value to rebuild again");
  if (last.summary) console.log(`[startup]   ${last.summary}`);
} else {
  console.log(`[startup] rebuild: REBUILD=${token} requested; rebuilding before the server starts`);
  const args = [path.join(import.meta.dirname, "rebuild.ts"), "--startup"];
  if (process.env.REBUILD_FORCE === "true") args.push("--force");
  // rebuild.ts records itself in .rebuild-done on success, using this token.
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, REBUILD_TOKEN: token } });
  if (result.status === 0) {
    console.log(`[startup] rebuild: REBUILD=${token} complete; starting the server on the rebuilt database`);
  } else {
    console.error(`[startup] rebuild: REBUILD=${token} FAILED or refused (see above); ` +
      "starting with the existing database. It will be retried on the next start.");
  }
}

await import("./server.ts");
