import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { app, db, HOUR, listingsOf, merchant, salesOf, T0 } from "./helpers.ts";

const { ingest } = app.collector;
const { addCorrection } = app.corrections;

const post = (body: unknown, token = "test-token") =>
  app.v1.request("/corrections", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe("corrections", () => {
  const keep = { trade1: { name: "t_keep_c", price: 1 } };

  test("removes sales already recorded in the stretch, and the listing becomes withdrawn", () => {
    ingest([merchant("Fixed", T0, { ...keep, trade2: { name: "t_fix", price: 100 }, trade3: { name: "t_fix2", price: 100 } })], T0);
    ingest([merchant("Fixed", T0 + HOUR, keep)], T0 + HOUR);
    ingest([merchant("Fixed", T0 + 4 * HOUR, keep)], T0 + 4 * HOUR);
    assert.equal(salesOf("Fixed").length, 2);
    const r = addCorrection({ merchant: "fixed", item: "t_fix", from: T0 + HOUR - 60_000, to: T0 + HOUR + 60_000 }, "admin");
    assert.equal(r.removedSales, 1);
    assert.deepEqual(salesOf("Fixed").map((s) => s.item), ["t_fix2"], "only the corrected item");
    assert.equal(listingsOf("Fixed").find((l) => l.item === "t_fix").close_reason, "withdrawn");
  });

  test("listings still pending in the stretch never become sales", () => {
    ingest([merchant("FixPend", T0, { ...keep, trade2: { name: "t_fixp", price: 100 } })], T0);
    ingest([merchant("FixPend", T0 + HOUR, keep)], T0 + HOUR);
    addCorrection({ merchant: "FixPend", from: T0, to: T0 + 2 * HOUR }, "admin");
    ingest([merchant("FixPend", T0 + 4 * HOUR, keep)], T0 + 4 * HOUR);
    assert.equal(salesOf("FixPend").length, 0);
    assert.equal(listingsOf("FixPend").find((l) => l.item === "t_fixp").close_reason, "withdrawn");
  });

  test("a reporting key corrects only its own character's stand", async () => {
    app.keys.setKey("SelfFix", "a-long-enough-test-key");
    const token = "SelfFix:a-long-enough-test-key";
    const body = { from: T0, to: T0 + HOUR };
    assert.equal((await post({ ...body, merchant: "Someone" }, token)).status, 400);
    assert.equal((await post({ ...body, merchant: "selffix" }, token)).status, 200);
    assert.equal((await post({ ...body, merchant: "Someone" }, "wrong")).status, 401);
    assert.equal((await post({ ...body, merchant: "Someone" })).status, 200, "the admin token can correct anyone");
    const res = await post({ merchant: "Someone", from: Date.now(), to: Date.now() + HOUR });
    assert.match((await res.json()).error, /future/);
    const listed = (await (await app.v1.request("/corrections")).json()).corrections;
    assert.ok(listed.some((c: any) => c.merchant === "selffix" && c.createdBy === "SelfFix"));
  });
});
