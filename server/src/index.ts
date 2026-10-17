// Entry point. Runs a requested rebuild before anything opens the database, then starts the server.
//
// REBUILD=<token>: rebuild from the raw archive on startup, once per token. The token of the last
// successful rebuild is kept in DATA_DIR/.rebuild-done, so leaving the variable set doesn't repeat it;
// change the value to rebuild again. REBUILD_FORCE=true skips the rebuild's archive-coverage checks.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const token = process.env.REBUILD?.trim();
if (token) {
  const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
  const marker = path.join(dataDir, ".rebuild-done");
  const done = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : null;
  if (done === token) {
    console.log(`[rebuild] REBUILD=${token} already done; change the value to rebuild again`);
  } else {
    console.log(`[rebuild] REBUILD=${token} requested; rebuilding before the server starts`);
    const args = [path.join(import.meta.dirname, "rebuild.ts"), "--startup"];
    if (process.env.REBUILD_FORCE === "true") args.push("--force");
    const result = spawnSync(process.execPath, args, { stdio: "inherit" });
    if (result.status === 0) {
      fs.writeFileSync(marker, `${token}\n`);
    } else {
      console.error("[rebuild] failed or refused (see above); starting with the existing database");
    }
  }
}

await import("./server.ts");
