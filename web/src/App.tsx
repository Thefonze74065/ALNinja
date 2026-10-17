import { useEffect, useState } from "react";
import { api, type GameMeta, type Status } from "./api";
import { ago } from "./format";
import { ItemPage } from "./pages/ItemPage";
import { Overview } from "./pages/Overview";

/** Minimal hash router: "#/" is the overview, "#/item/<id>?level=2&variant=shiny" an item. */
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

export function App() {
  const { parts, params } = useRoute();
  const [meta, setMeta] = useState<GameMeta | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    api.meta().then(setMeta, console.error);
    api.status().then(setStatus, console.error);
  }, []);

  const lastPoll = status?.lastSuccessfulPoll;
  const failing = status?.lastPoll?.error;

  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="brand-mark">AL</span>Ninja
        </a>
        <span className="tagline">Adventure Land market prices</span>
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
        {parts[0] === "item" && parts[1] ? (
          <ItemPage item={decodeURIComponent(parts[1])} params={params} meta={meta} />
        ) : (
          <Overview meta={meta} />
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
