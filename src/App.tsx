import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  QORECHAIN_REST_ENDPOINTS,
  evmWindowStatus,
  qorechainTestnet,
  type EvmWindowRejection,
} from "@qorechain/evm";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";

const EXPLORER = "https://explore.qore.network";
const TESTNET_QUERY = "?network=testnet";

type Severity = "info" | "warning" | "critical";

interface Watch {
  id: number;
  address: string;
  evmAddress: string;
  label: string;
  createdAt: string;
  explorerUrl: string;
}

interface AlertEvent {
  id: number;
  watchId: number;
  address: string;
  label: string;
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  txHash: string | null;
  blockHeight: number | null;
  createdAt: string;
}

interface Health {
  ok: boolean;
  network: string;
  chainId: number;
  watches: number;
  events: number;
  telegram: boolean;
}

interface RegistrationInfo {
  address: string;
  watched: boolean;
  memo: string;
  amount: string;
  instruction: string;
}

const REMEDY: Record<EvmWindowRejection, string> = {
  "no-pqc-key": "No ML-DSA-87 key is registered for this account.",
  "no-window": "No EVM authorisation window is open.",
  exhausted: "The EVM window is exhausted. Open a new one.",
  invalid: "The chain refused the window parameters.",
};

function short(value: string, front = 8, back = 6): string {
  if (value.length <= front + back + 1) return value;
  return `${value.slice(0, front)}…${value.slice(-back)}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed: HTTP ${response.status}`);
  return payload as T;
}

function WindowStatus({ address }: { address: `0x${string}` }) {
  const rest = QORECHAIN_REST_ENDPOINTS[qorechainTestnet.id] ? "/lcd-testnet" : undefined;
  const { data, error, isLoading } = useQuery({
    queryKey: ["evm-window", address],
    queryFn: () => evmWindowStatus({ rest: rest!, address }),
    enabled: Boolean(rest),
    refetchInterval: 15_000,
  });

  if (!rest) return <p className="muted">Unknown network.</p>;
  if (isLoading) return <p className="muted">Reading the EVM window…</p>;
  if (error) return <p className="muted">Could not read the window: {error.message}</p>;
  if (!data?.found) {
    return <p className="muted">EVM window: none. Open one on the native lane before an EVM write.</p>;
  }
  return (
    <p className="muted">
      EVM window: {data.live ? "live" : "not usable"} · {data.remainingBlocks.toString()} blocks ·{" "}
      {data.remainingTxs.toString()} txs left
    </p>
  );
}

function SeverityDot({ severity }: { severity: Severity }) {
  return <span className={`dot ${severity}`} aria-label={severity} />;
}

function timeAgo(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function App() {
  const { address, isConnected } = useAccount();
  const [health, setHealth] = useState<Health | null>(null);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [form, setForm] = useState({ address: "", label: "" });
  const [txHash, setTxHash] = useState("");
  const [registration, setRegistration] = useState<RegistrationInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connected = address as `0x${string}` | undefined;

  async function reload() {
    try {
      const [nextHealth, nextWatches, nextEvents] = await Promise.all([
        api<Health>("/api/health"),
        api<Watch[]>("/api/watches"),
        api<AlertEvent[]>("/api/events?limit=40"),
      ]);
      setHealth(nextHealth);
      setWatches(nextWatches);
      setEvents(nextEvents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const stream = new EventSource("/api/events/stream");
    stream.addEventListener("alert", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as AlertEvent;
        setEvents((current) => [parsed, ...current.filter((item) => item.id !== parsed.id)].slice(0, 60));
        setHealth((current) => (current ? { ...current, events: current.events + 1 } : current));
      } catch {
        // Ignore malformed events; the next reload will reconcile.
      }
    });
    return () => stream.close();
  }, []);

  useEffect(() => {
    if (!connected) {
      setRegistration(null);
      return;
    }
    let cancelled = false;
    void api<RegistrationInfo>(`/api/registration/${connected}`)
      .then((info) => {
        if (!cancelled) {
          setRegistration(info);
          setForm((current) => (current.address ? current : { ...current, address: connected }));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connected]);

  const watchCount = watches.length;
  const criticalCount = useMemo(
    () => events.filter((event) => event.severity === "critical").length,
    [events],
  );

  async function addWatch(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const watch = await api<Watch>("/api/watches", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setNotice(`Watching ${watch.label || short(watch.address)}.`);
      setForm((current) => ({ ...current, label: "" }));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeWatch(watch: Watch) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/watches/${encodeURIComponent(watch.address)}`, { method: "DELETE" });
      setNotice(`Removed ${watch.label || short(watch.address)}.`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifyRegistration(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ verified: boolean; txUrl: string; watch: Watch }>(
        "/api/registrations/verify",
        {
          method: "POST",
          body: JSON.stringify({ txHash }),
        },
      );
      setNotice(`Registration verified. ${result.txUrl}`);
      setTxHash("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyMemo() {
    if (!registration?.memo) return;
    try {
      await navigator.clipboard.writeText(registration.memo);
      setNotice("Memo copied. Paste it into the QoreX send form.");
    } catch {
      setNotice(registration.memo);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">QA</span>
          <span>
            Qore<span className="brand-accent">Alert</span>
          </span>
        </a>
        <nav className="nav">
          <a href="#watches">Watches</a>
          <a href="#events">Alerts</a>
          <a href="#register">Register</a>
        </nav>
        <div className="connect">
          <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="eyebrow">QoreChain · Diana testnet</div>
          <h1>
            Your wallet changes.
            <br />
            <span className="accent">You hear about it.</span>
          </h1>
          <p className="lede">
            QoreAlert watches both QoreChain lanes for transfers, EVM windows, PQC key changes, and
            approval exposure. Alerts land in Telegram; the timeline stays here.
          </p>
          <div className="hero-actions">
            <a className="button primary" href="#add">
              Add a watch
            </a>
            <a className="button ghost" href="#register">
              Prove with QoreX
            </a>
          </div>
          <div className="status-row">
            <span className={`pill ${health?.ok ? "good" : "bad"}`}>
              <span className="dot info" /> {health?.ok ? "API online" : "API offline"}
            </span>
            <span className="pill">{health?.network ?? "qorechain-diana"}</span>
            <span className="pill">{watchCount} watched</span>
            <span className="pill">{criticalCount} critical</span>
            <span className="pill">{health?.telegram ? "Telegram on" : "Telegram off"}</span>
          </div>
        </section>

        {error && <div className="banner error">{error}</div>}
        {notice && <div className="banner notice">{notice}</div>}

        <section className="two-col">
          <div className="panel" id="add">
            <div className="panel-head">
              <div>
                <div className="eyebrow">Watchlist</div>
                <h2>Add an address</h2>
              </div>
              <span className="panel-tag">read-only</span>
            </div>
            <p className="muted">
              Paste a <code>qor1…</code> or <code>0x…</code> address. QoreAlert stores only public
              chain data and the label you give it.
            </p>
            <form onSubmit={addWatch} className="form">
              <label>
                Address
                <input
                  value={form.address}
                  onChange={(event) => setForm({ ...form, address: event.target.value })}
                  placeholder="qor1… or 0x…"
                  spellCheck={false}
                />
              </label>
              <label>
                Label <span className="optional">(optional)</span>
                <input
                  value={form.label}
                  onChange={(event) => setForm({ ...form, label: event.target.value })}
                  placeholder="Treasury, demo wallet, …"
                  maxLength={80}
                />
              </label>
              <div className="form-actions">
                <button className="button primary" disabled={busy || !form.address.trim()}>
                  {busy ? "Working…" : "Start watching"}
                </button>
                {connected && (
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => setForm((current) => ({ ...current, address: connected }))}
                  >
                    Use connected address
                  </button>
                )}
              </div>
            </form>
            {isConnected && connected && (
              <div className="connected-card">
                <div className="eyebrow">Connected wallet</div>
                <code>{connected}</code>
                <WindowStatus address={connected} />
              </div>
            )}
          </div>

          <div className="panel" id="register">
            <div className="panel-head">
              <div>
                <div className="eyebrow">Hybrid proof</div>
                <h2>Register with QoreX</h2>
              </div>
              <span className="panel-tag">1 µQOR</span>
            </div>
            <p className="muted">
              A watch can be anchored by a hybrid-signed self-send. The memo names the address; the
              indexer verifies the transaction and adds it.
            </p>
            {registration ? (
              <>
                <div className="memo-box">
                  <span className="memo-label">Memo</span>
                  <code>{registration.memo}</code>
                  <button type="button" className="button ghost small" onClick={copyMemo}>
                    Copy
                  </button>
                </div>
                <ol className="steps">
                  <li>Open QoreX and switch to Testnet.</li>
                  <li>
                    Send exactly <strong>{registration.amount}</strong> QOR to your own address.
                  </li>
                  <li>Paste the memo above, sign, and send.</li>
                  <li>Paste the transaction hash below to verify.</li>
                </ol>
              </>
            ) : (
              <p className="muted">Connect QoreX to generate the memo for your address.</p>
            )}
            <form onSubmit={verifyRegistration} className="form">
              <label>
                Transaction hash
                <input
                  value={txHash}
                  onChange={(event) => setTxHash(event.target.value.trim())}
                  placeholder="64-character hex hash"
                  spellCheck={false}
                />
              </label>
              <button className="button primary" disabled={busy || txHash.length !== 64}>
                {busy ? "Verifying…" : "Verify registration"}
              </button>
            </form>
          </div>
        </section>

        <section className="section" id="watches">
          <div className="section-head">
            <div>
              <div className="eyebrow">Coverage</div>
              <h2>Watched accounts</h2>
            </div>
            <span className="muted">{watchCount} total</span>
          </div>
          {watches.length === 0 ? (
            <div className="empty">
              <strong>No watches yet.</strong>
              <p>Add an address above, or register one with a hybrid-signed QoreX self-send.</p>
            </div>
          ) : (
            <div className="watch-grid">
              {watches.map((watch) => (
                <article className="watch-card" key={watch.id}>
                  <div className="watch-head">
                    <div>
                      <h3>{watch.label || "Unlabelled watch"}</h3>
                      <span className="muted">{timeAgo(watch.createdAt)}</span>
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void removeWatch(watch)}
                      aria-label={`Remove ${watch.label || watch.address}`}
                    >
                      ×
                    </button>
                  </div>
                  <code className="address">{watch.address}</code>
                  <code className="address subtle">{watch.evmAddress}</code>
                  <a
                    className="text-link"
                    href={`${EXPLORER}/address/${watch.address}${TESTNET_QUERY}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open explorer ↗
                  </a>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="section" id="events">
          <div className="section-head">
            <div>
              <div className="eyebrow">Timeline</div>
              <h2>Recent alerts</h2>
            </div>
            <span className="muted">live via SSE</span>
          </div>
          {events.length === 0 ? (
            <div className="empty">
              <strong>No alerts yet.</strong>
              <p>The indexer will show new native and EVM activity here.</p>
            </div>
          ) : (
            <div className="event-list">
              {events.map((event) => (
                <article className={`event ${event.severity}`} key={event.id}>
                  <div className="event-rail">
                    <SeverityDot severity={event.severity} />
                  </div>
                  <div className="event-body">
                    <div className="event-meta">
                      <span className={`badge ${event.severity}`}>{event.severity}</span>
                      <span>{event.kind}</span>
                      <span>{timeAgo(event.createdAt)}</span>
                    </div>
                    <h3>{event.title}</h3>
                    <p>{event.detail}</p>
                    <div className="event-links">
                      <code>{short(event.address, 10, 8)}</code>
                      {event.txHash && (
                        <a
                          href={`${EXPLORER}/tx/${event.txHash}${TESTNET_QUERY}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {short(event.txHash, 10, 8)} ↗
                        </a>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer>
        <span>QoreAlert · testnet only · no custody</span>
        <span>
          Built for <a href="https://build.qorechain.io">Build Before Q-Day</a>
        </span>
      </footer>
    </div>
  );
}
