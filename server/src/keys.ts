// Public reporting keys. A player picks a key and mails it in game to KEY_MAIL_CHARACTER (subject
// "alninja_auth"), as with ALData; the in-game mail fee keeps it from being spammed. The key then
// authorizes "Authorization: Bearer <Character>:<key>". Only an unsalted SHA-256 of the key is stored:
// keys are long random strings chosen by players, not passwords.
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { db } from "./db.ts";

export const KEY_SUBJECT = "alninja_auth";
const MIN_KEY = 16;
const MAX_KEY = 200;

const stmts = {
  get: db.prepare("SELECT character, key_hash, created_at, updated_at FROM reporter_keys WHERE character = ?"),
  upsert: db.prepare(`
    INSERT INTO reporter_keys (character, key_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (character) DO UPDATE SET key_hash = excluded.key_hash, updated_at = excluded.updated_at`),
};

const sha256 = (v: string) => createHash("sha256").update(v).digest();

/** Why a key is unacceptable, or null if fine. */
export function keyProblem(key: string): string | null {
  if (key.length < MIN_KEY) return `at least ${MIN_KEY} characters`;
  if (key.length > MAX_KEY) return `at most ${MAX_KEY} characters`;
  if (!/^[\x21-\x7e]+$/.test(key)) return "printable characters only, no spaces";
  if (key.includes(":")) return "no colons";
  return null;
}

export function setKey(character: string, key: string, at = Date.now()) {
  stmts.upsert.run(character, sha256(key).toString("hex"), at, at);
}

export const isRevoked = (character: string) => config.revokedReporters.has(character.toLowerCase());

/**
 * Resolves an Authorization header to who vouches for the report: "admin" for REPORT_TOKEN, or the
 * character whose mailed key matches. Null if neither (or the character is revoked).
 */
export function keyOwner(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (config.reportToken && timingSafeEqual(sha256(token), sha256(config.reportToken))) return "admin";
  const sep = token.indexOf(":");
  if (sep <= 0) return null;
  const character = token.slice(0, sep);
  const row = stmts.get.get(character) as { character: string; key_hash: string } | undefined;
  if (!row || isRevoked(row.character)) return null;
  return timingSafeEqual(sha256(token.slice(sep + 1)), Buffer.from(row.key_hash, "hex")) ? row.character : null;
}

/** Public status of a character's key (never the key itself). */
export function keyStatus(character: string) {
  const row = stmts.get.get(character) as { character: string; created_at: number; updated_at: number } | undefined;
  return {
    character: row?.character ?? character,
    registered: Boolean(row),
    revoked: isRevoked(character),
    since: row?.created_at ?? null,
    updated: row?.updated_at ?? null,
  };
}
