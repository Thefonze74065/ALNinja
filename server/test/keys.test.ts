import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { app, db, merchant } from "./helpers.ts";

const { keyProblem, keyOwner, keyStatus, setKey } = app.keys;
const { AdventureLandApi, processKeyMail } = app.mail;
const { ingest } = app.collector;
const { recentSales } = app.market;
const now = Date.now();
const KEY = "a-long-random-key-123";

/** A fake adventure.land API: paged mail, login, a session that can expire. */
function fakeAdventureLand(mail: any[], { pageSize = 2, expireFirst = false } = {}) {
  const calls: string[] = [];
  const deleted: string[] = [];
  let expired = expireFirst;
  const fetchImpl = (async (url: string, init: any) => {
    const method = url.split("/api/")[1];
    const body = JSON.parse(init.body);
    calls.push(method);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (method === "signup_or_login") {
      expired = false;
      return json(body.password === "pw" ? { success: true, user: "42", auth: "tok" } : { success: false, reason: "bad" });
    }
    if (expired || init.headers.cookie !== "auth=42-tok") return json({ error: "not logged in" }, 401);
    if (method === "pull_mail") {
      const start = body.cursor ? Number(body.cursor) : 0;
      const page = mail.filter((m) => !deleted.includes(m.id)).slice(start, start + pageSize);
      return json({ infs: [{ type: "mail", mail: page, more: start + pageSize < mail.length, cursor: String(start + pageSize) }] });
    }
    if (method === "delete_mail") {
      deleted.push(body.mid);
      return json({ infs: [{ type: "message", message: "Mail deleted." }] });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchImpl, calls, deleted };
}
const mail = (id: string, fro: string, subject: string, message: string, extra = {}) =>
  ({ id, fro, to: "KeyBot", sent: new Date(now - Number(id) * 1000).toISOString(), subject, message, ...extra });

describe("reporting keys by mail", () => {
  test("key rules", () => {
    assert.equal(keyProblem(KEY), null);
    assert.match(keyProblem("short")!, /at least/);
    assert.match(keyProblem("has a space in it.....")!, /printable/);
    assert.match(keyProblem("has:a:colon-in-it-yes")!, /colon/);
  });

  test("registers keys from alninja_auth mail; leaves everything else alone", async () => {
    // pull_mail returns newest first.
    const inbox = [
      mail("1", "PlayerC", "alninja_auth", "newer-key-for-player-c"),
      mail("2", "PlayerC", "alninja_auth", "older-key-for-player-c"),
      mail("3", "PlayerA", "ALNINJA_AUTH ", `  ${KEY}  `),
      mail("4", "PlayerB", "alninja_auth", "short"),
      mail("5", "Friend", "hello", "not for us"),
      mail("6", "PlayerD", "alninja_auth", "key-sent-to-someone-else", { to: "SomeoneElse" }),
      mail("7", "PlayerE", "alninja_auth", "key-with-an-item-attached", { item: '{"name":"hpot0"}' }),
    ];
    const al = fakeAdventureLand(inbox, { expireFirst: true });
    const api = new AdventureLandApi({ url: "https://al.test", email: "me@x", password: "pw", auth: "42-old" }, al.fetchImpl);
    const logs: string[] = [];
    assert.equal(await processKeyMail(api, "KeyBot", (m) => logs.push(m)), 3);

    assert.ok(al.calls.includes("signup_or_login"), "re-logged in after the session expired");
    assert.deepEqual(al.deleted.sort(), ["1", "2", "3", "4"], "only our key mail is deleted (incl. rejected keys)");
    assert.equal(keyOwner(`Bearer PlayerA:${KEY}`), "PlayerA");
    assert.equal(keyOwner("Bearer playera:" + KEY), "PlayerA", "character names match case-insensitively");
    assert.equal(keyOwner("Bearer PlayerC:newer-key-for-player-c"), "PlayerC", "the newest mail wins");
    assert.equal(keyOwner("Bearer PlayerC:older-key-for-player-c"), null);
    assert.equal(keyStatus("PlayerB").registered, false);
    assert.ok(logs.some((l) => /ignored key from PlayerB/.test(l)));
    assert.ok(logs.some((l) => /PlayerE attached an item/.test(l)));
  });

  test("a rejected AL_AUTH with no login to fall back on says how to fix it", async () => {
    const al = fakeAdventureLand([], { expireFirst: true });
    const api = new AdventureLandApi({ url: "https://al.test", email: null, password: null, auth: "42-tok" }, al.fetchImpl);
    await assert.rejects(processKeyMail(api, "KeyBot", () => {}), /AL_AUTH was rejected; copy a fresh session token/);
  });

  test("Authorization forms", () => {
    setKey("Revoked1", KEY);
    assert.equal(keyOwner(`Bearer PlayerA:wrong-key-wrong-key`), null);
    assert.equal(keyOwner(`Bearer Nobody:${KEY}`), null);
    assert.equal(keyOwner("Bearer test-token"), "admin");
    assert.equal(keyOwner(`Bearer Revoked1:${KEY}`), null, "revoked characters' keys stop working");
    assert.equal(keyOwner(undefined), null);
  });
});

describe("public reporting", () => {
  const post = (body: unknown, auth: string) =>
    app.v1.request("/observations", {
      method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body),
    });

  test("GET /auth explains how to get a key; /auth/:character reports status and validity", async () => {
    const info = await (await app.v1.request("/auth")).json();
    assert.equal(info.mailTo, "KeyBot");
    assert.equal(info.subject, "alninja_auth");
    const st = await (await app.v1.request("/auth/PlayerA", { headers: { authorization: `Bearer PlayerA:${KEY}` } })).json();
    assert.deepEqual([st.registered, st.valid], [true, true]);
    const bad = await (await app.v1.request("/auth/PlayerA", { headers: { authorization: "Bearer PlayerA:nope-nope-nope-nope" } })).json();
    assert.equal(bad.valid, false);
  });

  test("player keys can report; revoked reporting characters can't", async () => {
    const res = await post({ reporter: "AnyAlt", sentAt: now, sales: [] }, `Bearer PlayerA:${KEY}`);
    assert.equal(res.status, 200);
    assert.equal((await post({ reporter: "Revoked1", sentAt: now }, `Bearer PlayerA:${KEY}`)).status, 403);
  });

  test("each key has a report budget", async () => {
    setKey("Spammer", KEY);
    const codes = [];
    for (let i = 0; i < 14; i++) codes.push((await post({ reporter: "Spammer", sentAt: now }, `Bearer Spammer:${KEY}`)).status);
    assert.deepEqual(codes.slice(-2), [429, 429]);
  });

  test("own trade history resolves whose stand it was from seen listings", () => {
    ingest([
      merchant("HistM", now, { trade1: { name: "t_hist", price: 250, q: 10 } }),
      merchant("BidM", now, { trade1: { name: "t_hbid", price: 90, b: true, q: 10 } }),
    ], now);
    const r = app.observed.recordReport({
      reporter: "Buyer1", sentAt: now,
      history: [
        { at: now, event: "buy", counterparty: "HistM", item: { name: "t_hist", q: 2 }, total: 500 }, // bought from HistM's stand
        { at: now, event: "sell", counterparty: "BidM", item: { name: "t_hbid", q: 2 }, total: 180 }, // filled BidM's buy order
        { at: now, event: "buy", counterparty: "HistM", item: { name: "t_hist", q: 1 }, total: 999 }, // no such listing
      ],
    }, now, "PlayerA");
    assert.deepEqual([r.stored, r.unresolved], [2, 1]);
    const own = app.observed.recordReport({
      reporter: "HistM", sentAt: now,
      history: [{ at: now + 1000, event: "sell", counterparty: "Walker", item: { name: "t_hist", q: 1 }, total: 250 }], // own stand sold
    }, now, "HistM");
    assert.equal(own.stored, 1);
    const rows = db.prepare("SELECT merchant, side, counterparty, quantity, price, key_owner FROM observed_sales WHERE item IN ('t_hist','t_hbid') ORDER BY id").all();
    assert.deepEqual(rows.map((r: any) => [r.merchant, r.side, r.counterparty, r.quantity, r.price, r.key_owner]), [
      ["HistM", "sell", "Buyer1", 2, 250, "PlayerA"],
      ["BidM", "buy", "Buyer1", 2, 90, "PlayerA"],
      ["HistM", "sell", "Walker", 1, 250, "HistM"],
    ]);
  });

  test("only reports that match a seen listing show as Seen", () => {
    app.observed.recordReport({
      reporter: "Liar", sentAt: now,
      sales: [
        { at: now, seller: "HistM", buyer: "X1", item: { name: "t_hist", price: 250, q: 1 } },
        { at: now, seller: "HistM", buyer: "X2", item: { name: "t_hist", price: 1, q: 1 } }, // never offered at 1
      ],
    }, now, "PlayerA");
    const seen = recentSales("t_hist", "ALL", now - 60_000, 50).filter((s) => s.source === "observed");
    assert.ok(seen.some((s) => s.counterparty === "X1"));
    assert.ok(!seen.some((s) => s.counterparty === "X2"));
  });
});
