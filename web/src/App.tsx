import { useEffect, useState } from "react";
import { api, type GameMeta, type Status } from "./api";
import { ago } from "./format";
import { ApiDocs } from "./pages/ApiDocs";
import { ItemPage } from "./pages/ItemPage";
import { Movers } from "./pages/Movers";
import { Overview } from "./pages/Overview";

/** Minimal hash router: "#/" overview, "#/movers", "#/api", "#/item/<id>?level=2&variant=shiny". */
function useRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(query) };
}

const REGION_KEY = "alninja.region";

/** Selected server region ("ALL", "US", ...), remembered per browser when storage is available. */
function useRegion() {
  const [region, setRegion] = useState(() => {
    try {
      return localStorage.getItem(REGION_KEY) ?? "ALL";
    } catch {
      return "ALL";
    }
  });
  const choose = (r: string) => {
    setRegion(r);
    try {
      localStorage.setItem(REGION_KEY, r);
    } catch {
      // Storage unavailable (private mode etc.); the choice just won't persist.
    }
  };
  return [region, choose] as const;
}

export function App() {
  const { parts, params } = useRoute();
  const [meta, setMeta] = useState<GameMeta | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [region, setRegion] = useRegion();
  const regions = ["ALL", ...(status?.regions ?? ["US", "EU", "ASIA"])];

  useEffect(() => {
    api.meta().then(setMeta, console.error);
    api.status().then(setStatus, console.error);
  }, []);

  const page = parts[0] === "movers" ? "movers" : parts[0] === "api" ? "api" : parts[0] === "item" ? "item" : "prices";
  const lastPoll = status?.lastSuccessfulPoll;
  const failing = status?.lastPoll?.error;

  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="brand-mark">AL</span>Ninja
        </a>
        <nav className="mainnav" aria-label="Pages">
          <a href="#/" className={page === "prices" ? "active" : ""}>Prices</a>
          <a href="#/movers" className={page === "movers" ? "active" : ""}>Movers</a>
          <a href="#/api" className={page === "api" ? "active" : ""}>API</a>
        </nav>
        <nav className="tabs region" aria-label="Server region">
          {regions.map((r) => (
            <button key={r} type="button" className={r === region ? "active" : ""} onClick={() => setRegion(r)}>
              {r === "ALL" ? "All regions" : r}
            </button>
          ))}
        </nav>
        <span className="poll-status" title={failing ? `Last poll failed: ${failing}` : undefined}>
          {failing && <span className="dot dot-bad" aria-label="error" />}
          {lastPoll
            ? `${lastPoll.merchants} merchants · updated ${ago(lastPoll.fetched_at)}`
            : status
              ? "waiting for first poll"
              : ""}
        </span>
      </header>
      <main>
        {page === "item" && parts[1] ? (
          <ItemPage item={decodeURIComponent(parts[1])} params={params} meta={meta} region={region} />
        ) : page === "movers" ? (
          <Movers meta={meta} region={region} trackingSince={status?.tracking_since ?? null} />
        ) : page === "api" ? (
          <ApiDocs />
        ) : (
          <Overview meta={meta} region={region} />
        )}
      </main>
      <footer>
        Data from player merchants via{" "}
        <a href="https://github.com/earthiverse/ALData" target="_blank" rel="noreferrer">ALData</a>
        {status?.tracking_since && <> · tracking since {new Date(status.tracking_since).toLocaleDateString()}</>}
        {" "}· Not affiliated with Adventure Land
      </footer>
    </>
  );
}
