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
];

const FIELDS: [string, string][] = [
  ["price", "Lower-quartile asking price (each merchant's cheapest offer counted once). Falls back to bestBid for buy-only items."],
  ["lowest / median", "Cheapest and median ask."],
  ["bestBid", "Highest buy-order price."],
  ["sellers / buyers", "Merchants with sell / buy offers seen in the last 48h. Treat prices with fewer than 3 as rough."],
  ["quantity", "Total units for sale."],
  ["change24h / change7d", "Fractional price change (0.1 = +10%); null without enough history or sellers."],
  ["soldPerDay / boughtPerDay", "Estimated units traded per day, 7-day average."],
  ["level / variant", "Upgrade/compound level, and variant such as shiny or a cxjar's contents (\"\" for plain)."],
];

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
        Unix epoch milliseconds. Data refreshes every poll (about every 10 minutes) and responses are cached for 60
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
      <p className="footnote">
        Sales are estimates: a stack shrinking, or a listing disappearing while the rest of the stand stays up, priced
        within 3× of market (buy orders: at least ⅓ of market). Items parked at placeholder prices are ignored.
      </p>
    </section>
  );
}
