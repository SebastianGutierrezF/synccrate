import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AccountStatus,
  AppConfig,
  Candidate,
  DetectedFile,
  LocalTrack,
  MatchRow,
  MixKind,
  LicenceStatus,
  PlatformOption,
  PlaylistInfo,
  PushResult,
  UpdateStatus,
} from "./types";

const DERIVATIVE: MixKind[] = ["Remix", "Rework", "Edit", "Vip"];

/** Which version's update banner has been waved away. Per-version, so
 *  dismissing 0.1.5 does not also hide 0.1.6 — "not now" is about this
 *  release, not about ever being told again. */
const DISMISSED_UPDATE = "djls.dismissedUpdate";

const SECTIONS = [
  {
    verdict: "auto",
    title: "Ready",
    hint: "Confident matches. Nothing here needs a decision.",
  },
  {
    verdict: "review",
    title: "Needs a look",
    hint: "Close enough to be worth checking, not close enough to assume. Expand a row to see the alternatives.",
  },
  {
    verdict: "no_match",
    title: "Not found",
    hint: "Nothing convincing in the catalogue. Expand a row in case one of the near misses is right after all.",
  },
] as const;

function descriptorLabel(track: LocalTrack): string {
  const { kind, remixer } = track.parsed;
  if (remixer && DERIVATIVE.includes(kind)) return `${remixer} ${kind.toLowerCase()}`;
  if (kind === "None") return "—";
  return kind.toLowerCase();
}

function duration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function defaultPlaylistName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `New Downloads ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [clientIdDraft, setClientIdDraft] = useState("");
  const [redirect, setRedirect] = useState<string>("");
  const [platforms, setPlatforms] = useState<PlatformOption[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  /** The services screen was a dead end: it only rendered when nothing was
   *  connected, so once Spotify was set up there was no way back to it to add
   *  or change anything. It is a mode now, reachable from the header. */
  const [showServices, setShowServices] = useState(false);
  /** Null until the user opens or closes it themselves; see `licenceOpen`. */
  const [licenceOpenPref, setLicenceOpenPref] = useState<boolean | null>(null);
  const [copiedSupport, setCopiedSupport] = useState(false);
  /**
   * Which service the sync path talks to. Spotify unless Apple Music is fully
   * connected, because Apple needs both a licence and a Music User Token and
   * defaulting to it would fail on first use for everyone else.
   */
  const [target, setTarget] = useState<string>("spotify");
  const [licence, setLicence] = useState<LicenceStatus | null>(null);
  const [licenceDraft, setLicenceDraft] = useState("");
  const [licenceBusy, setLicenceBusy] = useState(false);
  const [licenceError, setLicenceError] = useState<string | null>(null);

  /**
   * A metered licence with nothing left. A trial counts: it is an ordinary
   * licence that happens to have been free.
   *
   * This is an allowance, not a state of the licence. It refills; the licence
   * does not need renewing, reactivating, or anything else.
   */
  const outOfCredits =
    !!licence?.active && !licence.unlimited && (licence.credits ?? 0) <= 0;

  /**
   * Whether to offer the key field.
   *
   * Only when there is a key to be entered: nobody yet, or a trial that could
   * be replaced by a purchase. Explicitly *not* when a purchased licence has
   * run out of tracks — that licence is fine, and asking someone to activate
   * it again says their allowance and their licence are the same thing when
   * one is monthly and the other is not.
   */
  const canEnterLicence = !licence?.active || !licence.has_key;

  /**
   * Collapsed by default once there is a working licence, because then there
   * is nothing to do and the header already says how many tracks are left.
   * Open when something needs attention — no licence, or none left — which is
   * exactly when someone arriving here is looking for the controls.
   */
  const licenceOpen = licenceOpenPref ?? (!licence?.active || outOfCredits);

  const SUPPORT_EMAIL = "help@synccrate.io";
  const copySupport = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL);
      setCopiedSupport(true);
      setTimeout(() => setCopiedSupport(false), 1800);
    } catch {
      // Some webviews refuse the clipboard. The address is on screen and
      // selectable, so this is a missing convenience rather than a dead end.
      setCopiedSupport(false);
    }
  };

  /** The key field, wherever it is offered. One definition, so the two places
   *  that show it cannot drift apart. */
  const keyField = (prompt: string) => (
    <>
      <p className="dim small">{prompt}</p>
      <div className="row">
        <input
          value={licenceDraft}
          onChange={(e) => setLicenceDraft(e.target.value)}
          placeholder="DJLS-XXXX-XXXX-XXXX-XXXX"
          spellCheck={false}
        />
        <button
          onClick={() =>
            licenceAction(() =>
              invoke<LicenceStatus>("activate_licence", { key: licenceDraft }),
            )
          }
          disabled={licenceBusy || !licenceDraft.trim()}
        >
          Activate
        </button>
      </div>
    </>
  );
  /** Files the watcher has seen land since the last match. */
  const [pending, setPending] = useState<string[]>([]);

  const [rows, setRows] = useState<MatchRow[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);
  /**
   * The service the rows on screen were matched against.
   *
   * Not derivable from `target`, which is the service currently *selected* —
   * and the two disagreeing is exactly the bug this exists to catch. A stale
   * closure once let a match run against one service while the screen named
   * another, and nothing in the rows looked wrong, because `chosen` is keyed
   * by the local track id and that is identical everywhere.
   */
  const [rowsPlatform, setRowsPlatform] = useState<string | null>(null);
  const [playlistName, setPlaylistName] = useState("");
  const [result, setResult] = useState<PushResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshAccount = useCallback(async () => {
    setAccount(await invoke<AccountStatus>("account_status"));
    setPlatforms(await invoke<PlatformOption[]>("available_platforms"));
  }, []);

  /**
   * Split by verdict so each can be acted on alone: push the confident ones
   * now, come back to the rest. Ready is open by default because it is the
   * one that usually needs no decision.
   */
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(["auto"]));

  /** Rows whose search errored, which is not the same as finding nothing. */
  const searchFailures = useMemo(() => rows.filter((r) => r.error).length, [rows]);

  /** Platforms actually usable right now — the only ones worth offering. */
  const connectedTargets = useMemo(
    () => platforms.filter((p) => p.available && p.connected),
    [platforms],
  );

  const refreshLicence = useCallback(async () => {
    try {
      setLicence(await invoke<LicenceStatus>("licence_status"));
    } catch (err) {
      // Never fatal: the whole free tier works without a licence.
      setLicenceError(String(err));
    }
  }, []);

  /** Run a licence action, surfacing its error without taking the app down. */
  const licenceAction = useCallback(
    async (run: () => Promise<LicenceStatus>) => {
      setLicenceBusy(true);
      setLicenceError(null);
      try {
        setLicence(await run());
        await refreshAccount();
      } catch (err) {
        setLicenceError(String(err));
      } finally {
        setLicenceBusy(false);
      }
    },
    [refreshAccount],
  );

  // Keep the target on something that works. If the current one is
  // disconnected — a licence cleared, Apple signed out — fall back rather than
  // leaving the app pointed at a service it cannot reach.
  useEffect(() => {
    if (connectedTargets.length === 0) return;
    if (!connectedTargets.some((p) => p.id === target)) {
      setTarget(connectedTargets[0].id);
    }
  }, [connectedTargets, target]);

  // Everything on screen belongs to one service: matches, the chosen URI for
  // each row, the playlists, the last push result.
  //
  // This clears on the change rather than at the places that cause it, because
  // there are two and only one of them remembered. The fallback above moves the
  // target on its own when a service disconnects — a licence lapsing, an Apple
  // session expiring — and left one service's URIs on screen under another
  // service's name. `chosen` is keyed by local track id, which is identical
  // across platforms, so nothing about the stale rows looked stale; the push
  // was refused by the guard that checks a URI against the platform, which is
  // the last line of defence and not where this should have been caught.
  //
  // Rows only ever arrive from `runMatch`, which the user starts, so there is
  // no load for this to race.
  useEffect(() => {
    setRows([]);
    setSelected(new Set());
    setChosen({});
    setPlaylists([]);
    setResult(null);
    setRowsPlatform(null);
  }, [target]);

  const [bootError, setBootError] = useState<string | null>(null);

  // A newer build, when there is one. Checked once at startup: releases are
  // not frequent enough to be worth polling, and nothing here blocks on it.
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISSED_UPDATE);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    (async () => {
      try {
        const cfg = await invoke<AppConfig>("load_config");
        setConfig(cfg);
        setPlaylistName(cfg.last_playlist ?? defaultPlaylistName());
        try {
          setRedirect(await invoke<string>("redirect_uri"));
        } catch {
          /* no client id yet */
        }
        await refreshAccount();
        // Deliberately after refreshAccount and not awaited into the same
        // failure path: the token service being unreachable must not stop the
        // free Spotify tier from starting.
        void refreshLicence();
        // Same reasoning: never on the path that can set bootError. Being
        // unable to ask about releases is not a reason to refuse to start.
        void invoke<UpdateStatus>("check_for_update").then(setUpdate, () => {});
      } catch (err) {
        // Without this the window sits on "Loading…" forever with no clue why.
        setBootError(String(err));
      }
    })();

    const unlistenProgress = listen<{ done: number; total: number }>("match-progress", (e) =>
      setProgress(e.payload)
    );

    // The watcher is the whole point of the app: downloads should show up
    // without anyone opening anything. The backend emits one of these per file
    // once it has stopped growing.
    const unlistenDetected = listen<DetectedFile>("track-detected", (e) => {
      const name = e.payload.track?.file_name ?? e.payload.path;
      setPending((prev) => (prev.includes(name) ? prev : [...prev, name]));
    });

    return () => {
      void unlistenProgress.then((fn) => fn());
      void unlistenDetected.then((fn) => fn());
    };
  }, [refreshAccount, refreshLicence]);

  const persist = useCallback(async (next: AppConfig) => {
    setConfig(next);
    await invoke("save_config", { config: next });
  }, []);

  const saveClientId = useCallback(async () => {
    if (!config || !clientIdDraft.trim()) return;
    await persist({ ...config, spotify_client_id: clientIdDraft.trim() });
    try {
      setRedirect(await invoke<string>("redirect_uri"));
    } catch {
      /* ignore */
    }
    await refreshAccount();
  }, [config, clientIdDraft, persist, refreshAccount]);

  const signIn = useCallback(async () => {
    setBusy("Waiting for Spotify in your browser…");
    setError(null);
    try {
      await invoke("spotify_login");
      await refreshAccount();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }, [refreshAccount]);

  const chooseFolder = useCallback(async () => {
    if (!config) return;
    const picked = await open({ directory: true, multiple: false, title: "Pick your music folder" });
    if (typeof picked !== "string") return;
    await persist({ ...config, watch_folder: picked });
    await invoke("start_watching", { path: picked }).catch(() => undefined);
  }, [config, persist]);

  const runMatch = useCallback(
    async (rescan: boolean) => {
      if (!config?.watch_folder) return;
      setBusy(rescan ? "Re-checking everything…" : "Matching…");
      setError(null);

      // Cleared before the run, not after it. All of these are keyed by the
      // local track id, which is identical on every platform, so results that
      // survived a failed run looked current and could be pushed to a service
      // they were never matched against.
      setRows([]);
      setSelected(new Set());
      setChosen({});
      setResult(null);

      try {
        // Read once, so the rows and the record of what produced them cannot
        // disagree even if the selection changes while this is in flight.
        const platform = target;
        const found = await invoke<MatchRow[]>("match_folder", {
          platform,
          path: config.watch_folder,
          acceptShorter: config.accept_shorter,
          rescan,
        });
        setRows(found);
        setRowsPlatform(platform);
        setPending([]);
        // Confident matches are pre-selected; everything else waits for a
        // decision, which is the entire point of the verdict split.
        setSelected(new Set(found.filter((r) => r.verdict === "auto").map((r) => r.track_id)));
        // A cached row has no candidates but does carry its stored match, and
        // that is the whole point of it: the second run should be able to push
        // what the first one found.
        setChosen(
          Object.fromEntries(
            found.flatMap((r) => {
              const uri = r.candidates[0]?.track.uri ?? r.stored?.uri;
              return uri ? [[r.track_id, uri]] : [];
            })
          )
        );
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(null);
        setProgress(null);
      }
    },
    // `target` is not optional here. Without it this closes over whatever the
    // selection was when `config` last changed — in practice the initial
    // "spotify" — so every match ran against Spotify however the dropdown
    // read, wrote Spotify rows, and was then refused at the push because the
    // push does depend on `target`.
    [config, target],
  );

  const loadPlaylists = useCallback(async () => {
    try {
      setPlaylists(await invoke<PlaylistInfo[]>("list_playlists", { platform: target }));
    } catch (err) {
      setError(String(err));
    }
    // Same omission as runMatch: this listed one service's playlists while
    // another was selected.
  }, [target]);

  /**
   * The rows that can actually be sent: selected, with a choice resolvable
   * against this row's own candidates or its stored match.
   */
  const buildItems = useCallback(
    (subset: MatchRow[]) =>
      subset
        .filter((r) => selected.has(r.track_id))
        .flatMap((r) => {
          const uri = chosen[r.track_id];
          if (!uri) return [];

          // Resolve against this row's own candidates, or its stored match
          // when it came from the cache. A URI matching neither belongs to an
          // earlier run: sending it pushed a stale id with blank metadata,
          // which also defeats the duplicate check on the way in.
          const c = r.candidates.find((x) => x.track.uri === uri);
          const choice = c
            ? {
                // Sent so the backend can spot the same recording under a
                // different id, not just an identical one.
                name: c.track.name,
                artists: c.track.artists.join(", "),
                duration_ms: c.track.duration_ms,
              }
            : r.stored?.uri === uri
            ? {
                name: r.stored.name,
                artists: r.stored.artists,
                duration_ms: r.stored.duration_ms,
              }
            : null;

          return choice ? [{ track_id: r.track_id, uri, ...choice }] : [];
        }),
    [selected, chosen],
  );

  const push = useCallback(
    async (subset: MatchRow[]) => {
      const items = buildItems(subset);
      if (items.length === 0 || !config) return;

      // The rows and the selection must be the same service. The backend
      // refuses a mismatch too, by inspecting each URI, but that is a last
      // resort that reports a confusing thing about one track rather than the
      // plain fact that the screen is stale.
      if (rowsPlatform && rowsPlatform !== target) {
        setError(
          `These matches are for ${rowsPlatform}, not ${target}. Match again before pushing.`,
        );
        return;
      }

      setBusy(`Adding ${items.length} track(s)…`);
      setError(null);
      try {
        const res = await invoke<PushResult>("push_tracks", {
          playlistName,
          platform: target,
          items,
        });
        // The balance moved if this was a metered platform.
        void refreshLicence();
        setResult(res);
        await persist({ ...config, last_playlist: playlistName });
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(null);
      }
    },
    [buildItems, playlistName, config, persist, target, rowsPlatform, refreshLicence],
  );

  const stats = useMemo(() => {
    const by = (v: string) => rows.filter((r) => r.verdict === v).length;
    return { total: rows.length, auto: by("auto"), review: by("review"), missing: by("no_match") };
  }, [rows]);

  /** The service being pushed to, for labels that used to say "Spotify". */
  const targetName =
    connectedTargets.find((p) => p.id === target)?.display_name ?? "your library";

  if (bootError) {
    return (
      <div className="app">
        <h1>DJ Library Sync</h1>
        <div className="banner error">Could not start: {bootError}</div>
        <p className="dim">
          This build talks to a Tauri backend. Opening the dev server directly in
          a browser shows the interface but cannot reach it.
        </p>
      </div>
    );
  }

  if (!config) return <div className="app"><p className="dim">Loading…</p></div>;

  // --- Connect a service --------------------------------------------------
  // Forced when *nothing* is connected, not when Spotify specifically is not.
  // Checking Spotify would strand someone who signed out of it while Apple
  // Music was working: the app has a usable target, but no way off this screen.
  const mustConnect = connectedTargets.length === 0;

  if (showServices || mustConnect) {
    const leaveServices = async () => {
      setConnecting(null);
      setShowServices(false);
      await refreshAccount();
      void refreshLicence();
    };

    return (
      <div className="app">
        <header className="services-head">
          <div>
            <h1>Services</h1>
            <p className="dim intro">
              {mustConnect
                ? "Pick where your new tracks should end up."
                : "Connect another service, or change how one is set up."}
            </p>
          </div>
          {!mustConnect && (
            <button className="ghost" onClick={leaveServices}>
              Done
            </button>
          )}
        </header>

        {error && <div className="banner error">{error}</div>}

        {/* The licence is not an Apple Music setting — it belongs to the
            person, and it governs any metered service. It lived inside
            Apple's setup panel, which made a monthly allowance look like a
            property of one connection. */}
        <div className="service licence-card">
          <div className="service-head">
            <button
              className="group-toggle"
              aria-expanded={licenceOpen}
              onClick={() => setLicenceOpenPref(!licenceOpen)}
            >
              <span className="chevron" aria-hidden="true">
                {licenceOpen ? "▾" : "▸"}
              </span>
              <span className="group-title">Licence</span>
              <span className="dim small">
                {!licence?.active
                  ? "Not activated"
                  : licence.unlimited
                    ? "Unlimited plan"
                    : `${licence.plan ?? "Licence"} plan`}
              </span>
            </button>
            {/* Outside the toggle, so the number stays readable while collapsed
                — which is the whole reason this block exists. */}
            {licence?.active &&
              (licence.unlimited ? (
                <span className="pill good">unlimited</span>
              ) : (
                <span className={outOfCredits ? "pill warn" : "pill"}>
                  {licence.credits ?? 0} tracks left
                </span>
              ))}
          </div>

          <div className="setup" hidden={!licenceOpen}>
            {licenceError && <p className="warn small">{licenceError}</p>}

            {!licence?.active ? (
              <>
                <p className="dim">
                  Metered services need a licence. Start with 25 free tracks — no
                  card, no account.
                </p>
                <div className="row">
                  <button
                    onClick={() => licenceAction(() => invoke<LicenceStatus>("start_trial"))}
                    disabled={licenceBusy}
                  >
                    {licenceBusy ? "Working…" : "Start free trial"}
                  </button>
                  <button className="ghost" onClick={() => void invoke("open_purchase")}>
                    Buy a licence
                  </button>
                </div>
                {keyField("Already bought one?")}
              </>
            ) : (
              <>
                {outOfCredits ? (
                  <p className="warn">
                    No tracks left this period. Your licence is still active — this
                    is a monthly allowance, not an expiry.
                  </p>
                ) : (
                  <p className="dim">
                    {licence.unlimited
                      ? "No track limit."
                      : `${licence.credits} track${
                          licence.credits === 1 ? "" : "s"
                        } left this period.`}
                  </p>
                )}

                <div className="row">
                  {/* Only a trial has something to buy. A purchased plan that
                      has run out needs a different plan, not another licence. */}
                  {!licence.has_key && (
                    <button onClick={() => void invoke("open_purchase")}>
                      Buy a licence
                    </button>
                  )}
                </div>

                <p className="dim small">
                  Changing plan, upgrading, or anything else — email{" "}
                  <span className="mono">{SUPPORT_EMAIL}</span>
                </p>
                <div className="row">
                  <button className="ghost" onClick={copySupport}>
                    {copiedSupport ? "Copied" : "Copy address"}
                  </button>
                </div>

                {canEnterLicence && keyField("Bought a licence? Paste the key.")}
              </>
            )}
          </div>
        </div>

        <div className="services">
          {platforms.map((p) => (
            <div key={p.id} className={`service ${p.available ? "" : "soon"}`}>
              <div className="service-head">
                <div>
                  <h2>{p.display_name}</h2>
                  <p className="dim small">
                    {!p.available
                      ? "Coming soon"
                      : p.credentials === "user_provided"
                      ? "Free — uses your own developer app"
                      : "One-click sign in"}
                  </p>
                </div>
                {p.available ? (
                  <div className="service-actions">
                    {p.connected && <span className="pill good">connected</span>}
                    {/* Connected is not the end of the story: a client ID can
                        be wrong, an account can be the wrong one. Always leave
                        a way back into the setup. */}
                    <button
                      className={p.connected ? "ghost" : ""}
                      onClick={() => setConnecting(connecting === p.id ? null : p.id)}
                    >
                      {connecting === p.id ? "Close" : p.connected ? "Manage" : "Connect"}
                    </button>
                  </div>
                ) : (
                  <span className="pill">{p.metered ? "paid" : "free"}</span>
                )}
              </div>

              {connecting === p.id && p.credentials === "user_provided" && (
                <div className="setup">
                  <p className="dim">
                    Spotify only lets a developer app serve five people, so this one
                    runs on an app you own. It takes about two minutes and it is free.
                  </p>
                  <ol className="dim">
                    <li>
                      Open <code>developer.spotify.com/dashboard</code> and create an app
                    </li>
                    <li>
                      Add <code>{redirect || "http://127.0.0.1:8888/callback"}</code> as a
                      Redirect URI — it must be the <code>127.0.0.1</code> form,
                      Spotify rejects <code>localhost</code>
                    </li>
                    <li>Under Settings → User Management, add your own Spotify account</li>
                    <li>Copy the Client ID and paste it below</li>
                  </ol>
                  <p className="dim small">
                    Only the Client ID — never the secret. This uses PKCE, which is
                    designed so desktop apps do not need one.
                  </p>
                  <div className="row">
                    <input
                      value={clientIdDraft}
                      onChange={(e) => setClientIdDraft(e.target.value)}
                      placeholder="Client ID"
                      spellCheck={false}
                    />
                    <button
                      onClick={account?.configured ? signIn : saveClientId}
                      disabled={!account?.configured && !clientIdDraft.trim()}
                    >
                      {account?.configured ? "Sign in" : "Save"}
                    </button>
                  </div>

                  {p.connected && (
                    <div className="row">
                      <button
                        className="ghost"
                        onClick={async () => {
                          setBusy("Signing out…");
                          try {
                            await invoke("spotify_logout");
                            await refreshAccount();
                          } catch (err) {
                            setError(String(err));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Sign out of Spotify
                      </button>
                      <span className="dim small">
                        Leaves your Client ID in place; only the account changes.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {connecting === p.id && p.credentials === "hosted" && (
                <div className="setup">
                  {!licence?.active ? (
                    <>
                      <p className="dim">
                        Apple Music needs a developer token signed with a key that
                        cannot ship inside an open-source app, so this one runs
                        through our service. Start with 25 free tracks — no card,
                        no account.
                      </p>
                      <p className="dim small">
                        Start a trial or enter a key in the Licence block above,
                        then sign in here.
                      </p>
                    </>
                  ) : (
                    <>

                      {!licence.apple_connected ? (
                        <>
                          <p className="dim small">
                            Signing in opens Apple's page in your browser. Apple only
                            issues the token needed here through a web page, so there
                            is no way to do it inside the app.
                          </p>
                          <div className="row">
                            <button
                              onClick={() =>
                                licenceAction(() => invoke<LicenceStatus>("apple_login"))
                              }
                              disabled={licenceBusy}
                            >
                              {licenceBusy ? "Waiting for Apple…" : "Sign in to Apple Music"}
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="row">
                          <span className="pill good">Apple Music connected</span>
                          <button
                            className="ghost"
                            onClick={async () => {
                              await invoke("apple_logout");
                              await refreshLicence();
                              await refreshAccount();
                            }}
                          >
                            Disconnect
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {licenceError && <p className="dim small warn">{licenceError}</p>}
                  {licence?.error && !licenceError && (
                    <p className="dim small warn">{licence.error}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // The services gate no longer implies a loaded account, so say so once here
  // rather than defending against null at every use below.
  if (!account) return <div className="app"><p className="dim">Loading…</p></div>;

  return (
    <div className="app">
      <header>
        <div>
          <h1>DJ Library Sync</h1>
          <p className="folder">{config.watch_folder ?? "No folder selected"}</p>
        </div>
        <div className="actions">
          {connectedTargets.length > 1 && (
            <select
              value={target}
              // Clearing is handled by the effect on `target`, so that it
              // happens however the target changes and not only here.
              onChange={(e) => setTarget(e.target.value)}
              aria-label="Sync to"
            >
              {connectedTargets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          )}
          {target === "apple_music" && licence && !licence.unlimited && (
            // At zero this stops being a readout and becomes the way to the
            // Licence block, which is where the options are. It does not say
            // "add a licence": there may well already be one, and the
            // allowance running out says nothing about it.
            outOfCredits ? (
              <button className="pill warn" onClick={() => setShowServices(true)}>
                Out of tracks — see options
              </button>
            ) : (
              <span className="pill">{licence.credits} left</span>
            )
          )}
          {account.signed_in && (
            <span className="who">{account.display_name ?? account.user_id}</span>
          )}
          <button className="ghost" onClick={() => setShowServices(true)}>
            Services
          </button>
          <button className="ghost" onClick={chooseFolder}>
            {config.watch_folder ? "Change folder" : "Choose folder"}
          </button>
        </div>
      </header>

      {update?.updateAvailable && update.latest !== updateDismissed && (
        <div className="banner update">
          <span>
            Version {update.latest} is out
            <span className="dim small"> — you have {update.current}</span>
          </span>
          <span className="update-actions">
            <button
              onClick={async () => {
                try {
                  await invoke("open_download");
                } catch (url) {
                  // open_download hands back the address when it could not
                  // launch a browser, so there is still a way through.
                  setError(`Could not open the browser. Download it from ${url}`);
                }
              }}
            >
              Get it
            </button>
            <button
              className="ghost"
              onClick={() => {
                const version = update.latest;
                setUpdateDismissed(version);
                try {
                  if (version) localStorage.setItem(DISMISSED_UPDATE, version);
                } catch {
                  // A browser that will not remember the dismissal just means
                  // the banner returns next launch. Not worth saying anything.
                }
              }}
            >
              Not now
            </button>
          </span>
        </div>
      )}

      {busy && <div className="banner">{busy}{progress ? ` ${progress.done}/${progress.total}` : ""}</div>}

      {!busy && pending.length > 0 && (
        <div className="banner good arrivals">
          <span>
            {pending.length} new {pending.length === 1 ? "track" : "tracks"} landed
            <span className="dim small"> — {pending.slice(-3).join(", ")}</span>
          </span>
          <button onClick={() => runMatch(false)}>Match them</button>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {searchFailures > 0 && (
        <div className="banner error">
          {searchFailures} of {rows.length} searches failed, so those rows say nothing
          about whether the tracks exist on {targetName}.
          Nothing was saved for them — fix the cause and run it again.
        </div>
      )}
      {result && (
        <div className="banner good">
          Added {result.added} to “{result.playlist_name}”
          {result.skipped > 0 && ` · ${result.skipped} already there`}
        </div>
      )}
      {result?.warning && <div className="banner warn">{result.warning}</div>}

      {account.signed_in && config.watch_folder && (
        <>
          <div className="stats">
            <Stat label="tracks" value={stats.total} />
            <Stat label="ready" value={stats.auto} tone="good" />
            <Stat label="needs a look" value={stats.review} />
            <Stat label="not found" value={stats.missing} tone="muted" />
          </div>

          <div className="toolbar">
            <button onClick={() => runMatch(false)} disabled={!!busy}>Match new tracks</button>
            <button className="ghost" onClick={() => runMatch(true)} disabled={!!busy}>
              Re-check everything
            </button>
            <label className="check">
              <input
                type="checkbox"
                checked={config.accept_shorter}
                onChange={(e) => persist({ ...config, accept_shorter: e.target.checked })}
              />
              Accept the shorter cut when the extended mix isn’t available
            </label>
          </div>
        </>
      )}

      {rows.length > 0 && (
        <>
          <div className="pushbar">
            <input
              list="playlists"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              onFocus={loadPlaylists}
              placeholder="Playlist name"
            />
            <datalist id="playlists">
              {playlists.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
            <span className="dim small">{targetName}</span>
          </div>

          {SECTIONS.map((section) => {
            const sectionRows = rows.filter((r) => r.verdict === section.verdict);
            if (sectionRows.length === 0) return null;

            const open = openSections.has(section.verdict);
            const ready = buildItems(sectionRows).length;
            // Only rows with a resolvable choice can be selected usefully.
            const selectable = sectionRows.filter(
              (r) => r.candidates.length > 0 || r.stored,
            );
            const allSelected =
              selectable.length > 0 && selectable.every((r) => selected.has(r.track_id));

            return (
              <section key={section.verdict} className={`group ${section.verdict}`}>
                <header className="group-head">
                  <button
                    className="group-toggle"
                    aria-expanded={open}
                    onClick={() =>
                      setOpenSections((prev) => {
                        const next = new Set(prev);
                        next.has(section.verdict)
                          ? next.delete(section.verdict)
                          : next.add(section.verdict);
                        return next;
                      })
                    }
                  >
                    <span className="chevron" aria-hidden="true">
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="group-title">{section.title}</span>
                    <span className="pill">{sectionRows.length}</span>
                  </button>

                  <div className="group-actions">
                    {selectable.length > 0 && (
                      <button
                        className="ghost"
                        onClick={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            for (const r of selectable) {
                              allSelected ? next.delete(r.track_id) : next.add(r.track_id);
                            }
                            return next;
                          })
                        }
                      >
                        {allSelected ? "Deselect all" : "Select all"}
                      </button>
                    )}
                    <button
                      onClick={() => push(sectionRows)}
                      disabled={!!busy || ready === 0 || !playlistName.trim()}
                    >
                      Add {ready}
                    </button>
                  </div>
                </header>

                <p className="group-hint dim small">{section.hint}</p>

                {open && (
                  <table>
                    <thead>
                      <tr>
                        <th className="tick"></th>
                        <th>Track</th>
                        <th>Version</th>
                        <th>Match</th>
                        <th className="num">Conf.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sectionRows.map((row) => (
                        <RowView
                          key={row.track_id}
                          row={row}
                          checked={selected.has(row.track_id)}
                          chosenUri={chosen[row.track_id]}
                          onToggle={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              next.has(row.track_id)
                                ? next.delete(row.track_id)
                                : next.add(row.track_id);
                              return next;
                            })
                          }
                          onChoose={(uri) =>
                            setChosen((prev) => ({ ...prev, [row.track_id]: uri }))
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function RowView({
  row,
  checked,
  chosenUri,
  onToggle,
  onChoose,
}: {
  row: MatchRow;
  checked: boolean;
  chosenUri?: string;
  onToggle: () => void;
  onChoose: (uri: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const best = row.candidates.find((c) => c.track.uri === chosenUri) ?? row.candidates[0];
  const alternatives = row.candidates.length > 1;

  return (
    <>
      <tr className={row.verdict}>
        <td className="tick">
          <input type="checkbox" checked={checked} onChange={onToggle} disabled={!chosenUri} />
        </td>
        <td>
          <div>{row.track.artist || <span className="dim">untagged</span>}</div>
          <div className="dim small">{row.track.parsed.base}</div>
        </td>
        <td className={row.track.parsed.kind === "None" ? "dim" : "version"}>
          {descriptorLabel(row.track)}
          <div className="dim small">{duration(row.track.duration_ms)}</div>
        </td>
        <td>
          {best ? (
            <>
              <div>{best.track.name}</div>
              <div className="dim small">
                {best.track.artists.join(", ")} · {duration(best.track.duration_ms)}
                {best.score.duration_delta_ms > 20000 && (
                  <span className="warn"> · {Math.round(best.score.duration_delta_ms / 1000)}s shorter</span>
                )}
              </div>
            </>
          ) : (
            <span className={row.error ? "warn" : "dim"}>
              {row.error
                ? `Search failed — ${row.error}`
                : row.cached
                ? "cached — re-check to see options"
                : row.reason}
            </span>
          )}
          {alternatives && (
            <button className="link" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "hide" : `${row.candidates.length - 1} other option${row.candidates.length > 2 ? "s" : ""}`}
            </button>
          )}
        </td>
        <td className="num">
          <span className={`badge ${row.verdict}`}>{Math.round(row.confidence * 100)}%</span>
        </td>
      </tr>
      {expanded &&
        row.candidates.map((c: Candidate) => (
          <tr key={c.track.uri} className="alt">
            <td></td>
            <td colSpan={4}>
              <label>
                <input
                  type="radio"
                  name={`c-${row.track_id}`}
                  checked={c.track.uri === chosenUri}
                  onChange={() => onChoose(c.track.uri)}
                />{" "}
                {c.track.name} <span className="dim">— {c.track.artists.join(", ")} · {duration(c.track.duration_ms)} · {Math.round(c.score.total * 100)}%</span>
              </label>
            </td>
          </tr>
        ))}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "muted" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </div>
  );
}
