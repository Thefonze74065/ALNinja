// Entry point. Runs a requested rebuild before anything opens the database, then starts the server.
//
// REBUILD=<token>: rebuild from the raw archive on startup, once per token. The last successful rebuild
// is recorded in DATA_DIR/.rebuild-done, so leaving the variable set doesn't repeat it; change the
// value to rebuild again. REBUILD_FORCE=true skips the rebuild's archive-coverage checks.
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
