import { useEffect, useState } from "react";

const ENDPOINTS = [
  {
    path: "/api/v1/prices",
    params: "region, items=a,b, min_sellers",
    desc: "Current price of every item, level and variant. Filter with items= for just the ones you care about.",
    example: "/api/v1/prices?items=ringsj,seashell",
  },
  {
    path: "/api/v1/prices/:item",
    params: "region",
    desc: "Current price of each level/variant of one item.",
    example: "/api/v1/prices/ringsj",
  },
  {
    path: "/api/v1/history/:item",
    params: "region, days=7 (max 365), level, variant",
    desc: "Hourly price history.",
    example: "/api/v1/history/ringsj?level=2&days=7",
  },
  {
    path: "/api/v1/listings/:item",
    params: "region, side=sell|buy",
    desc: "Open merchant listings with server, map and coordinates, so a bot can go buy or sell.",
    example: "/api/v1/listings/ringsj?side=sell",
  },
  {
    path: "/api/v1/sales",
    params: "region, item, hours=24 (max 720), limit=500 (max 2000)",
    desc: "Recent estimated sales, newest first.",
    example: "/api/v1/sales?item=seashell&hours=24",
  },
  {
    path: "/api/v1/movers",
    params: "region, window=24h|7d, min_sellers=3, limit=20",
    desc: "Biggest risers and fallers, plus the most traded items.",
    example: "/api/v1/movers?window=24h",
  },
  {
    path: "/api/v1/deals",
    params: "region, kind=npc,underpriced,flip, min_discount=0.2, min_sellers=3, min_profit=1, sort=profit|discount, limit=100",
    desc: "Listings worth buying now: NPC pays more, another merchant bids more, or well under the next seller.",
    example: "/api/v1/deals?kind=npc",
  },
  {
    path: "/api/v1/accuracy",
    params: "days=7 (max 90)",
    desc: "How estimated sales compare with trades reporting characters witnessed: recall, precision, misses.",
    example: "/api/v1/accuracy?days=7",
  },
  {
    path: "/api/v1/archive",
    params: "",
    desc: "Daily gzipped CSVs of every hourly price row and every sale, for bulk analysis. Each file links to its download.",
    example: "/api/v1/archive",
  },
];

const FIELDS: [string, string][] = [
  ["price", "Lower-quartile asking price (each merchant's cheapest offer counted once), capped at npcPrice. Falls back to npcPrice, then bestBid, when nobody is selling."],
  ["npcPrice", "What an NPC shop sells one unit for (plain +0 items only), or null. Nobody pays players more, so price never exceeds it."],
  ["npcValue", "What an NPC pays when you sell them one unit at this level."],
  ["lowest / median", "Cheapest and median player ask (not capped)."],
  ["bestBid", "Highest buy-order price."],
  ["sellers / buyers", "Merchants with sell / buy offers seen in the last 48h. Treat prices with fewer than 3 as rough."],
  ["quantity", "Total units for sale."],
  ["change24h / change7d", "Fractional price change (0.1 = +10%); null without enough history or sellers."],
  ["soldPerDay / boughtPerDay", "Estimated units traded per day, 7-day average."],
  ["level / variant", "Upgrade/compound level, and variant such as shiny or a cxjar's contents (\"\" for plain)."],
];

interface ArchiveFile {
  kind: "prices" | "sales" | "observed";
  date: string;
  bytes: number;
  url: string;
}

function Reporting({ base }: { base: string }) {
  const [auth, setAuth] = useState<{ enabled: boolean; mailTo: string | null; subject: string } | null>(null);
  useEffect(() => {
    fetch("/api/v1/auth").then((r) => r.json()).then(setAuth, () => setAuth(null));
  }, []);
  const mailTo = auth?.mailTo ?? "<mail character>";
  const subject = auth?.subject ?? "alninja_auth";

  const snippet = `// ALNinja trade reporter. Reports stand trades this character witnesses ("+$$", shown to characters
// that can see the merchant) and its own trades (the game's trade history), to make prices more accurate.
const ALNINJA_URL = "${base}";
const ALNINJA_KEY = "YourCharacter:your-key"; // the character that mailed the key, a colon, then the key

const alninja = { sales: [], history: [], last: null };

// Trades at stands this character can see.
alninja.onUi = (data) => {
  if (data.type !== "+$$" || !data.item) return;
  alninja.sales.push({
    at: Date.now(), seller: data.seller, buyer: data.buyer, slot: data.slot,
    filledBuyOrder: data.snum !== undefined, // a buy order was filled, rather than a stand purchase
    item: data.item,
  });
};
parent.socket.on("ui", alninja.onUi);

// This character's own trades, including at its own stand: report entries added since the last read.
// The game merges a repeat of the last trade into it, so a grown last entry counts its extra units.
alninja.newTrades = (prev, next) => {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2].name === b[2].name && a[2].level === b[2].level;
  for (let s = 0; s <= prev.length; s++) {
    const p = prev.slice(s);
    if (next.length < p.length) continue;
    const last = p.length - 1;
    if (!p.every((e, i) => same(e, next[i]) && (i === last || ((e[2].q || 1) === (next[i][2].q || 1) && e[3] === next[i][3])))) continue;
    const out = [];
    if (p.length) {
      const grown = (next[last][2].q || 1) - (p[last][2].q || 1);
      if (grown > 0) out.push([next[last][0], next[last][1], { ...next[last][2], q: grown }, next[last][3] - p[last][3]]);
    }
    return out.concat(next.slice(p.length));
  }
  return next;
};
alninja.onHistory = (list) => {
  if (!Array.isArray(list)) return;
  const prev = alninja.last;
  alninja.last = list;
  if (!prev) return; // the first read is the starting point, not new trades
  for (const [event, counterparty, item, total] of alninja.newTrades(prev, list)) {
    alninja.history.push({ at: Date.now(), event, counterparty, item, total });
  }
};
parent.socket.on("trade_history", alninja.onHistory);

alninja.flush = async () => {
  parent.socket.emit("trade_history"); // the answer arrives via onHistory, sent with the next flush
  const sales = alninja.sales.splice(0, 500);
  const history = alninja.history.splice(0, 100);
  const inView = Object.values(parent.entities).filter((e) => e.player && e.stand).map((e) => e.name);
  try {
    const res = await fetch(\`\${ALNINJA_URL}/api/v1/observations\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ALNINJA_KEY}\` },
      body: JSON.stringify({
        reporter: character.name, sentAt: Date.now(), region: server.region, server: server.id,
        map: character.map, inView, sales, history,
      }),
    });
    if (!res.ok) game_log(\`ALNinja: \${(await res.json()).error ?? res.status}\`);
  } catch (e) {
    alninja.sales.unshift(...sales); // offline: keep them for the next try
    alninja.history.unshift(...history);
  }
};
alninja.timer = setInterval(alninja.flush, 30_000);
alninja.flush();

// Stop cleanly when the code stops (keeping the game's own cleanup).
const alninjaDestroy = on_destroy;
on_destroy = () => {
  parent.socket.off("ui", alninja.onUi);
  parent.socket.off("trade_history", alninja.onHistory);
  clearInterval(alninja.timer);
  alninja.flush();
  alninjaDestroy();
};`;

  return (
    <div className="panel">
      <h2>Report trades from your characters</h2>
      <p className="small">
        Stand snapshots can't tell a sale from a merchant taking stock down, but the game itself tells characters
        about real trades: every stand trade they can see (the floating "+$$"), and their own trades. Anyone can
        help: characters running the snippet below report those, sales they report show as{" "}
        <span className="badge">Seen</span>, and the <a href="#/accuracy">accuracy page</a> measures the estimates
        against them. Reports only count when they match a listing ALNinja saw, so made-up trades don't.
      </p>
      {auth?.enabled === false ? (
        <p className="callout small">Public reporting keys aren't enabled on this instance.</p>
      ) : (
        <ol className="small steps">
          <li>
            Pick a key: a long random string (16+ characters, no spaces or colons). Treat it like a password.
          </li>
          <li>
            In game, mail <strong>{mailTo}</strong> with subject <code>{subject}</code> and your key as the message,
            from the mail window or with code:
            <pre><code>{`send_mail("${mailTo}", "${subject}", "your-key")`}</code></pre>
            It costs the game's usual 48,000 gold mail fee. Your key is picked up within a minute; check at{" "}
            <code>/api/v1/auth/YourCharacter</code>. Mail again any time to change it.
          </li>
          <li>
            Paste the snippet into your code with <code>ALNINJA_KEY</code> set to{" "}
            <code>YourCharacter:your-key</code> (the character that sent the mail). One key works for all your
            characters. Characters in town see the most trades.
          </li>
        </ol>
      )}
      <pre><code>{snippet}</code></pre>
      <h3>Correcting your stand</h3>
      <p className="small">
        Took stock down while the snippet wasn't running, and it shows as sold? Mark that stretch as not sold
        (times in epoch ms, up to 30 days back; leave out <code>item</code> for everything). A key can correct
        its own character's stand; corrections are public at <code>GET /api/v1/corrections</code>.
      </p>
      <pre><code>{`fetch(\`\${ALNINJA_URL}/api/v1/corrections\`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ALNINJA_KEY}\` },
  body: JSON.stringify({
    merchant: "YourCharacter", item: "hpbelt", note: "pulled, not sold",
    from: Date.parse("2026-10-18T08:00Z"), to: Date.parse("2026-10-18T09:00Z"),
  }),
}).then((r) => r.json()).then(show_json);`}</code></pre>
    </div>
  );
}

function BulkData() {
  const [files, setFiles] = useState<ArchiveFile[] | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/v1/archive")
      .then((r) => r.json())
      .then((d) => {
        setFiles(d.files);
        setRetention(d.hourlyRetentionDays);
      }, () => setFiles([]));
  }, []);
  const prices = (files ?? []).filter((f) => f.kind === "prices").reverse();
  const salesByDate = new Map((files ?? []).filter((f) => f.kind === "sales").map((f) => [f.date, f]));
  const observedByDate = new Map((files ?? []).filter((f) => f.kind === "observed").map((f) => [f.date, f]));
  const total = (files ?? []).reduce((a, f) => a + f.bytes, 0);
  const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

  return (
    <div className="panel">
      <h2>Bulk data</h2>
      <p className="small">
        Every completed UTC day is saved as two gzipped CSVs: <code>prices</code> (every hourly price row for every
        item, level, variant and region) and <code>sales</code> (every estimated sale). They're kept permanently.
        The live database keeps hourly rows for {retention ?? 90} days, so use these for longer-term analysis.
      </p>
      {files == null ? (
        <p className="muted">Loading…</p>
      ) : prices.length === 0 ? (
        <p className="muted">No completed days yet. The first files appear shortly after midnight UTC.</p>
      ) : (
        <>
          <p className="muted small">
            {prices.length} day(s), {size(total)} total. Script it with <code>GET /api/v1/archive</code>.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day (UTC)</th>
                  <th>Prices</th>
                  <th>Sales</th>
                  <th>Seen trades</th>
                </tr>
              </thead>
              <tbody>
                {prices.slice(0, 14).map((f) => {
                  const sale = salesByDate.get(f.date);
                  return (
                    <tr key={f.date}>
                      <td>{f.date}</td>
                      <td><a href={f.url}>prices</a> <span className="muted">{size(f.bytes)}</span></td>
                      <td>{sale && <><a href={sale.url}>sales</a> <span className="muted">{size(sale.bytes)}</span></>}</td>
                      <td>
                        {observedByDate.get(f.date) && (
                          <>
                            <a href={observedByDate.get(f.date)!.url}>seen</a>{" "}
                            <span className="muted">{size(observedByDate.get(f.date)!.bytes)}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {prices.length > 14 && <p className="muted small">Showing the latest 14 days; the API lists all.</p>}
        </>
      )}
    </div>
  );
}

export function ApiDocs() {
  const base = location.origin;
  const secure = location.protocol === "https:";

  const inGame = `// Runs in the Adventure Land code editor.
const ALNINJA = "${base}";

async function marketPrice(item, level = 0) {
  const res = await fetch(\`\${ALNINJA}/api/v1/prices/\${item}?region=\${server.region}\`);
  const { prices } = await res.json();
  return prices.find((p) => p.level === level && p.variant === "") ?? null;
}

// Buy a +2 Ring of Small Joys when it's 20% under market.
const ring = await marketPrice("ringsj", 2);
if (ring && ring.sellers >= 3) {
  const res = await fetch(\`\${ALNINJA}/api/v1/listings/ringsj?side=sell&region=\${server.region}\`);
  const { listings } = await res.json();
  const deal = listings
    .filter((l) => l.level === 2 && l.price <= ring.price * 0.8)
    .sort((a, b) => a.price - b.price)[0];
  if (deal) game_log(\`Deal: \${deal.merchant} on \${deal.region} \${deal.server} (\${deal.map} \${deal.x},\${deal.y}) for \${deal.price}\`);
}`;

  const node = `// Node 18+ / ALClient bots
const res = await fetch("${base}/api/v1/prices?items=seashell,leather&min_sellers=3");
const { updated, prices } = await res.json();
for (const p of prices) console.log(p.item, p.level, p.price, p.soldPerDay);`;

  return (
    <section className="docs">
      <h1 className="page-title">API</h1>
      <p>
        ALNinja's data is open to scripts. All endpoints are <code>GET</code>, return JSON, allow any origin (CORS),
        and accept <code>region=ALL|US|EU|ASIA</code> (default <code>ALL</code>). Prices are gold per unit; times are
        Unix epoch milliseconds. Data refreshes every poll (about every minute) and responses are cached for 60
        seconds, so there's no benefit to calling more than once a minute. Each IP gets 120 requests per minute.
      </p>
      {!secure && (
        <p className="callout">
          <strong>In-game code needs HTTPS.</strong> Adventure Land runs on https://adventure.land, so browsers block
          its code from calling a plain-http address like this one (mixed content, and private-network rules for{" "}
          <code>.local</code> hosts). Node bots can use this address directly. For in-game use, put ALNinja behind
          HTTPS, e.g. a Cloudflare Tunnel or a reverse proxy with a certificate.
        </p>
      )}

      <div className="panel">
        <h2>Endpoints</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Parameters</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map((e) => (
                <tr key={e.path}>
                  <td>
                    <a href={e.example} target="_blank" rel="noreferrer"><code>{e.path}</code></a>
                  </td>
                  <td className="wrap muted">{e.params}</td>
                  <td className="wrap">{e.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          <a href="/api/v1" target="_blank" rel="noreferrer"><code>/api/v1</code></a> lists these endpoints as JSON.
          Endpoint names link to an example request.
        </p>
      </div>

      <div className="panel">
        <h2>Price fields</h2>
        <dl className="fields">
          {FIELDS.map(([k, v]) => (
            <div key={k}>
              <dt><code>{k}</code></dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="panel">
        <h2>In-game example</h2>
        <pre><code>{inGame}</code></pre>
      </div>
      <div className="panel">
        <h2>Node example</h2>
        <pre><code>{node}</code></pre>
      </div>
      <Reporting base={base} />
      <BulkData />
      <p className="footnote">
        Sales are estimates: a stack shrinking, or a listing disappearing while the rest of the stand stays up (and not
        put back within 2 hours, so sales are reported with that delay, dated when the listing vanished), priced
        within 3× of market (buy orders: at least ⅓ of market). Items parked at placeholder prices are ignored.
      </p>
    </section>
  );
}
