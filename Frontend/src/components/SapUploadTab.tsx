import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { DASH, formatDateTime, formatNumber } from '../lib/format';

/**
 * SAP Data Upload — the manual fallback for when the share-folder sync is not
 * running (user request 6 Aug 2026).
 *
 * The server endpoint already existed (POST /api/v1/ingest/upload): files are
 * spooled under random names, validated, transformed and published through the
 * SAME pipeline as the automatic sync, so a manual batch can never produce
 * figures the scheduled path would not. This page just exposes it.
 */

type Finding = {
  ruleId: string;
  severity: 'BLOCKER' | 'CAVEAT' | 'WARNING' | 'INFO';
  feed: string | null;
  message: string;
  affectedRows: number | null;
};

type UploadResult =
  | { outcome: 'published'; batchId: number; datasetVersionId: number; findings: Finding[] }
  | { outcome: 'ready'; batchId: number; datasetVersionId: number; findings: Finding[] }
  | { outcome: 'failed'; batchId: number; reason: string; findings: Finding[] }
  | { outcome: 'noop_unchanged'; batchId: number | null }
  | { outcome: 'incomplete_bundle'; missing: string[] }
  | { outcome: 'source_unavailable'; path: string };

/** What a complete bundle looks like, in the order SAP exports them. */
const EXPECTED = [
  { feed: 'pr', label: 'PR Report', hint: 'ME5A requisition export' },
  { feed: 'po', label: 'PO Report', hint: 'ME2N purchase-order export' },
  { feed: 'gr', label: 'GR List', hint: 'MB51 goods-receipt export' },
  { feed: 'prel', label: 'PR Release', hint: 'requisition release/approval steps' },
  { feed: 'por', label: 'PO Release', hint: 'purchase-order release steps' },
  { feed: 'fx', label: 'Rate Conversion', hint: 'monthly FX rate table' },
  // Reference data — optional. Listed so an operator can see and schedule them,
  // but a bundle without them publishes normally.
  { feed: 'pgrp', label: 'Purchasing Groups', hint: 'P Grp — buyer desk master', optional: true },
  { feed: 'porg', label: 'Purchasing Orgs', hint: 'P Org — purchasing org master', optional: true },
  { feed: 'matm', label: 'Material Master', hint: 'Mat group — material code, description, SAP category', optional: true },
  { feed: 'zuser', label: 'SAP Users', hint: 'zuser — user id to name', optional: true },
];

const SEV_PILL: Record<Finding['severity'], string> = {
  BLOCKER: 'spdel', CAVEAT: 'sn', WARNING: 'sa', INFO: 'sl',
};

interface FeedCfg {
  feed: string;
  path: string;
  pattern: string;
  slots: [string, string, string];
}

interface StorageInfo {
  mode: 'explicit_path' | 'synology_composed' | 'legacy_share_path';
  type: string;
  basePath: string;
  synologyRoot: string | null;
  deployment: string | null;
  projectSlug: string | null;
  expectsNas: boolean;
  optionsConflict: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  error: string | null;
  separateDevice: boolean | null;
  mountWarning: string | null;
}

interface ArchiveCfg {
  enabled: boolean;
  succeedDir: string;
  failedDir: string;
}

interface ArchiveReport {
  attempted: number;
  moved: number;
  failed: number;
  skipped?: string;
  files: { displayName: string; to: 'succeed' | 'failed'; moved: boolean; error?: string }[];
}

interface SyncCfg {
  enabled: boolean;
  timezone: string;
  settleSeconds: number;
  feeds: FeedCfg[];
  archive: ArchiveCfg;
  envPath: string;
  storage: StorageInfo;
  nowInZone: string;
  lastResult: { at: string; outcome: string; detail?: string; slots?: string } | null;
  lastArchive: ArchiveReport | null;
  recentRuns: { feed: string; slot: number; ranOn: string; ranAt: string; outcome: string | null; detail: string | null }[];
}

interface FeedScan {
  feed: string;
  label: string;
  path: string;
  pattern: string;
  readable: boolean;
  error?: string;
  chosen: { name: string; byteSize: number; mtime: string } | null;
  others: { name: string; byteSize: number; mtime: string; reason: string }[];
}

const FEED_LABEL: Record<string, string> = {
  pr: 'PR Report', po: 'PO Report', gr: 'GR List',
  prel: 'PR Release', por: 'PO Release', fx: 'Rate Conversion',
  pgrp: 'Purchasing Groups', porg: 'Purchasing Orgs',
  matm: 'Material Master', zuser: 'SAP Users',
};

/**
 * SAP Data Sync — per-feed folders, name patterns and up to three daily pickup
 * times in Asia/Jakarta.
 *
 * The scheduler behind this panel is new: SHARE_POLL_CRON_MINUTES and
 * INGEST_AUTOPOLL_ENABLED sat unused in the environment, so the share ingest
 * only ever ran when someone pressed Sync.
 *
 * What a per-feed slot means, stated plainly because the pipeline is strict: a
 * dataset is published complete or not at all, so a slot decides when THAT
 * FEED'S FOLDER IS READ AGAIN. When one fires, the newest matching file from
 * every feed's own folder is assembled into one bundle and ingested; if nothing
 * changed the result is "unchanged" and no new version appears.
 */
/**
 * Where the six exports are read from — the shared Synology NAS when
 * STORAGE_* is configured (Docs/SYNOLOGY-INTEGRATION.md), otherwise the plain
 * SHARE_PATH folder.
 *
 * This block exists for one specific failure: when the bind mount is missing,
 * Docker creates an empty folder inside the container, so the path looks
 * correct and the pickup simply reports "no files found". The server compares
 * the folder's filesystem against the container root, which tells the two
 * apart — so this can say "that is not the NAS" instead of leaving someone to
 * guess why an export that is definitely in File Station was never picked up.
 */
function StorageBlock({ s }: { s: StorageInfo }) {
  const composed = s.mode === 'synology_composed';
  const ok = s.exists && s.readable && !s.mountWarning;

  return (
    <>
      <h3 className="pr-tbl-h">
        {composed ? '🗄 Synology NAS' : '🗄 Source folder'}{' '}
        <span className="muted">— environment configuration, read-only here</span>
      </h3>

      {s.mountWarning && (
        <p className="note">
          <span className="bs spdel">mount problem</span> <strong>{s.mountWarning}</strong>
        </p>
      )}
      {s.optionsConflict && (
        <p className="note">
          <span className="bs sa">overridden</span> <code>STORAGE_LOCAL_PATH</code> is set as well
          as the composed Synology path, and takes precedence. Unset it to use the NAS folder.
        </p>
      )}

      <div className="table-wrap">
        <table className="data dd-tbl">
          <tbody>
            <tr className="re">
              <td>Status</td>
              <td>
                {ok
                  ? <span className="bs sd">{composed ? 'NAS folder mounted and readable' : 'folder readable'}</span>
                  : !s.exists ? <span className="bs spdel">not present in the container</span>
                    : !s.readable ? <span className="bs spdel">present but not readable</span>
                      : <span className="bs sa">see the warning above</span>}
                {s.error && <span className="muted"> {s.error}</span>}
              </td>
            </tr>
            <tr>
              <td>Resolved folder</td>
              <td><code>{s.basePath}</code></td>
            </tr>
            {composed ? (
              <>
                <tr className="re">
                  <td>NAS root <span className="muted">(host mount)</span></td>
                  <td><code>{s.synologyRoot}</code></td>
                </tr>
                <tr>
                  <td>Deployment</td>
                  <td>
                    <code>{s.deployment}</code>{' '}
                    <span className="muted">
                      {s.deployment === 'prod' ? '(production folder)' : '(development folder)'}
                    </span>
                  </td>
                </tr>
                <tr className="re">
                  <td>Project folder</td>
                  <td>
                    <code>{s.projectSlug}</code>{' '}
                    <span className="muted">
                      — File Station: APPs → {s.deployment} → {s.projectSlug}
                    </span>
                  </td>
                </tr>
              </>
            ) : (
              <tr className="re">
                <td>Mode</td>
                <td>
                  <span className="muted">
                    {s.mode === 'explicit_path'
                      ? 'one explicit folder (STORAGE_LOCAL_PATH) — not composed from the NAS layout'
                      : 'plain share folder (SHARE_PATH) — no Synology variables are set'}
                  </span>
                </td>
              </tr>
            )}
            <tr>
              <td>Write access</td>
              <td>
                {s.writable
                  ? <span className="muted">writable — this app still only ever reads from it</span>
                  : <span className="muted">read-only, as intended — an ingest can never alter a source export</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="note">
        Set by the backend environment (<code>STORAGE_SYNOLOGY_ROOT</code>,{' '}
        <code>STORAGE_DEPLOYMENT</code>, <code>STORAGE_PROJECT_SLUG</code>, or{' '}
        <code>STORAGE_LOCAL_PATH</code>) and shown here because a mount cannot be arranged from a
        web form. The folders below default to this one; point a file at a sub-folder of it if the
        exports are separated per file.
      </p>
    </>
  );
}

function SapSyncSection({ canEdit, isAdmin }: { canEdit: boolean; isAdmin: boolean }) {
  const [cfg, setCfg] = useState<SyncCfg | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [feeds, setFeeds] = useState<FeedCfg[]>([]);
  const [archive, setArchive] = useState<ArchiveCfg>({ enabled: false, succeedDir: '', failedDir: '' });
  const [scan, setScan] = useState<{ feeds: FeedScan[]; complete: boolean } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<SyncCfg>('/api/v1/admin/ingest/config')
      .then((x) => {
        setCfg(x);
        setEnabled(x.enabled);
        setFeeds(x.feeds.map((f) => ({ ...f, slots: [...f.slots] as [string, string, string] })));
        setArchive({ ...x.archive });
      })
      .catch((e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);

  const setFeedField = (feed: string, field: 'path' | 'pattern', value: string) => {
    setFeeds((list) => list.map((f) => (f.feed === feed ? { ...f, [field]: value } : f)));
  };
  const setSlot = (feed: string, idx: number, value: string) => {
    setFeeds((list) => list.map((f) => {
      if (f.feed !== feed) return f;
      const slots = [...f.slots] as [string, string, string];
      slots[idx] = value;
      return { ...f, slots };
    }));
  };
  /** Copy the first feed's folder to the rest — the common case is one folder. */
  const applyPathToAll = () => {
    const first = feeds[0]?.path ?? '';
    setFeeds((list) => list.map((f) => ({ ...f, path: first })));
  };
  const applySlotsToAll = () => {
    const first = feeds[0]?.slots ?? ['', '', ''];
    setFeeds((list) => list.map((f) => ({ ...f, slots: [...first] as [string, string, string] })));
  };
  /**
   * Move every file onto the resolved storage folder. This is the migration
   * step when an installation is pointed at the NAS: folders saved earlier in
   * this panel are explicit user intent and are NOT silently rewritten by the
   * server, so without this the top of the page would report a healthy NAS
   * mount while the rows below kept reading the old folder.
   */
  const applyStorageToAll = () => {
    const base = cfg?.storage.basePath;
    if (base) setFeeds((list) => list.map((f) => ({ ...f, path: base })));
  };

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const out = await api.put<SyncCfg>('/api/v1/admin/ingest/config', { enabled, feeds, archive });
      // Deliberately NOT setCfg(out): load() re-reads the full payload below.
      // Adopting a response as component state couples the panel to that
      // response carrying every field the render needs, which is exactly how
      // Save came to blank the page.
      const times = out.feeds.flatMap((f) => f.slots.filter(Boolean)).length;
      const arch = out.archive.enabled ? ' Files will be moved aside after each run.' : '';
      setMsg((out.enabled
        ? `Saved — ${times} pickup time(s) armed, all times ${out.timezone}.`
        : 'Saved — scheduled sync is off; use Sync now or a manual upload.') + arch);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    } finally { setBusy(null); }
  };

  const doScan = async () => {
    setBusy('scan'); setMsg(null); setScan(null);
    try {
      setScan(await api.post('/api/v1/admin/ingest/scan', { feeds }));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'scan failed');
    } finally { setBusy(null); }
  };

  const syncNow = async () => {
    setBusy('sync'); setMsg('Reading the folders and ingesting…');
    try {
      const out = await api.post<Record<string, any>>('/api/v1/ingest/sync', {});
      setMsg(
        out.outcome === 'published' ? `Published dataset version ${out.datasetVersionId}.`
        : out.outcome === 'noop_unchanged' ? 'The folders hold the same files already published — nothing to do.'
        : out.outcome === 'incomplete_bundle' ? `Incomplete: missing ${(out.missing ?? []).join(', ')}.`
        : out.outcome === 'source_unavailable' ? `Not readable: ${out.path}`
        : `Outcome: ${out.outcome}`,
      );
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'sync failed');
    } finally { setBusy(null); }
  };

  if (!cfg) {
    return <div className="panel"><h2>🔁 SAP Data Sync</h2><div className="spinner" /></div>;
  }

  const scanOf = (feed: string) => scan?.feeds.find((f) => f.feed === feed);

  // Folders that sit outside the resolved storage root. Not an error — exports
  // may legitimately live elsewhere on the same mount — but when the NAS has
  // just been configured these are the rows still reading the old location.
  const base = cfg.storage.basePath;
  const strayPaths = feeds.filter((f) => f.path !== base && !f.path.startsWith(`${base}/`));

  return (
    <div className="panel">
      <h2>
        🔁 SAP Data Sync{' '}
        <span className="muted">— per file: folder, name pattern, 3 pickup times ({cfg.timezone})</span>
      </h2>
      <p className="note" style={{ marginTop: 0 }}>
        Every time is <strong>{cfg.timezone}</strong> (server clock now reads{' '}
        <strong>{cfg.nowInZone}</strong>). Each folder must be <strong>mounted into the API
        container</strong> — this one resolved <code>{cfg.envPath}</code>, so paths outside that
        mount are not readable no matter what is typed here.
      </p>

      <StorageBlock s={cfg.storage} />
      <p className="note">
        A dataset is published complete or not at all, so a pickup time decides <em>when that
        file&apos;s folder is read again</em>. When one fires, the newest matching file from every
        folder is assembled into one bundle and ingested — if nothing changed the run reports
        &quot;unchanged&quot; and no new version appears.
      </p>

      {/*
        After-run filing. Kept next to the schedule because it is part of the
        same cycle: pick up, ingest, file away.

        The writability warning is the important part of this block. The share is
        mounted READ-ONLY by design, so switching this on without changing the
        mount produces a run that publishes correctly and then cannot move a
        single file — a failure mode that is invisible unless something says so
        up front.
      */}
      <h3 className="pr-tbl-h">
        📁 After a run <span className="muted">— move the files aside</span>
      </h3>
      <p className="note">
        With this on, the files a run consumed are moved out of the pickup folder: into{' '}
        <strong>succeeded</strong> when a dataset was published, into <strong>failed</strong> when
        the run failed. Each run gets its own dated subfolder (<code>2026-08-20_batch61</code>)
        because these filenames repeat — a flat folder would overwrite yesterday&apos;s export with
        today&apos;s. A file the pipeline could not recognise goes to <strong>failed</strong> even
        when the run itself succeeded. An <em>incomplete</em> bundle is left alone, so the rest of
        the day&apos;s exports can still arrive.
      </p>
      {archive.enabled && cfg.storage.writable === false && (
        <p className="note">
          <span className="bs spdel">cannot write</span> The source folder is{' '}
          <strong>not writable</strong> by this server, so no file can be moved. The share is
          mounted read-only on purpose; it must be remounted read-write, and the folders below must
          exist, before this can work. Runs will still publish normally — only the filing fails.
        </p>
      )}
      <div className="table-wrap">
        <table className="data dd-tbl">
          <tbody>
            <tr className="re">
              <td>Move files after a run</td>
              <td>
                <label className="dt-check">
                  <input
                    type="checkbox"
                    checked={archive.enabled}
                    disabled={!isAdmin}
                    onChange={(e) => setArchive((a) => ({ ...a, enabled: e.target.checked }))}
                  />
                  {archive.enabled ? 'on' : 'off'}
                </label>
              </td>
            </tr>
            <tr>
              <td>Succeeded folder</td>
              <td>
                <input
                  className="in"
                  style={{ width: '100%' }}
                  value={archive.succeedDir}
                  disabled={!isAdmin}
                  placeholder={`${cfg.storage.basePath}/succeed`}
                  onChange={(e) => setArchive((a) => ({ ...a, succeedDir: e.target.value }))}
                />
              </td>
            </tr>
            <tr className="re">
              <td>Failed folder</td>
              <td>
                <input
                  className="in"
                  style={{ width: '100%' }}
                  value={archive.failedDir}
                  disabled={!isAdmin}
                  placeholder={`${cfg.storage.basePath}/failed`}
                  onChange={(e) => setArchive((a) => ({ ...a, failedDir: e.target.value }))}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {cfg.lastArchive && (
        <p className="note">
          {cfg.lastArchive.skipped
            ? <>Last run: nothing filed — {cfg.lastArchive.skipped}.</>
            : (
              <>
                Last run filed <strong>{cfg.lastArchive.moved}</strong> of{' '}
                {cfg.lastArchive.attempted} file(s)
                {cfg.lastArchive.failed > 0 && (
                  <>
                    {' '}— <span className="bs spdel">{cfg.lastArchive.failed} could not be moved</span>:{' '}
                    {cfg.lastArchive.files.filter((f) => !f.moved)
                      .map((f) => `${f.displayName} (${f.error ?? 'unknown error'})`).join('; ')}
                  </>
                )}
                .
              </>
            )}
        </p>
      )}

      <div className="dt-toolbar" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="dt-check">
          <input type="checkbox" checked={enabled} disabled={!isAdmin}
            onChange={(e) => setEnabled(e.target.checked)} />
          Scheduled sync
        </label>
        {isAdmin && (
          <>
            <button className="btn" style={{ width: 'auto' }} disabled={busy !== null} onClick={() => void save()}>
              {busy === 'save' ? 'Saving…' : 'Save schedule'}
            </button>
            <button className="dt-btn" disabled={busy !== null} onClick={applyPathToAll}
              title="Copy the first row's folder into every row">
              Same folder for all
            </button>
            <button className="dt-btn" disabled={busy !== null} onClick={applySlotsToAll}
              title="Copy the first row's times into every row">
              Same times for all
            </button>
            {strayPaths.length > 0 && (
              <button className="dt-btn" disabled={busy !== null} onClick={applyStorageToAll}
                title={`Point every file at ${cfg.storage.basePath}`}>
                Use {cfg.storage.mode === 'synology_composed' ? 'the NAS folder' : 'the resolved folder'} for all
              </button>
            )}
          </>
        )}
        <button className="dt-btn" disabled={busy !== null} onClick={() => void doScan()}>
          {busy === 'scan' ? 'Scanning…' : 'Test / preview folders'}
        </button>
        {canEdit && (
          <button className="dt-btn" disabled={busy !== null} onClick={() => void syncNow()}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>

      {msg && <p className="note"><strong>{msg}</strong></p>}

      <div className="table-wrap dt-scroll" style={{ marginTop: '.5rem' }}>
        <table className="data dd-tbl">
          <thead>
            <tr>
              <th>File</th>
              <th>Share folder</th>
              <th>Name pattern</th>
              <th className="num">Time 1</th>
              <th className="num">Time 2</th>
              <th className="num">Time 3</th>
              <th>Folder check</th>
            </tr>
          </thead>
          <tbody>
            {feeds.map((f, i) => {
              const sc = scanOf(f.feed);
              return (
                <tr key={f.feed} className={i % 2 ? '' : 're'}>
                  <td>
                    <strong>{FEED_LABEL[f.feed] ?? f.feed}</strong>{' '}
                    <code className="muted">{f.feed}</code>
                  </td>
                  <td>
                    <input
                      value={f.path}
                      disabled={!isAdmin}
                      onChange={(e) => setFeedField(f.feed, 'path', e.target.value)}
                      style={{ width: 210, fontSize: '.72rem' }}
                      placeholder="/mnt/sap_exports"
                    />
                  </td>
                  <td>
                    <input
                      value={f.pattern}
                      disabled={!isAdmin}
                      onChange={(e) => setFeedField(f.feed, 'pattern', e.target.value)}
                      style={{ width: 170, fontSize: '.72rem' }}
                      placeholder="PR Report*.XLSX"
                    />
                  </td>
                  {[0, 1, 2].map((idx) => (
                    <td key={idx} className="num">
                      <input
                        type="time"
                        value={f.slots[idx] ?? ''}
                        disabled={!isAdmin}
                        onChange={(e) => setSlot(f.feed, idx, e.target.value)}
                        style={{ width: 92, fontSize: '.72rem' }}
                      />
                    </td>
                  ))}
                  <td>
                    {!sc ? <span className="muted">{DASH}</span>
                      : !sc.readable ? <span className="bs spdel" title={sc.error}>unreadable</span>
                      : sc.chosen ? (
                        <span className="bs sd" title={`${sc.chosen.name} · ${formatDateTime(sc.chosen.mtime)}`}>
                          {sc.chosen.name.length > 26 ? `${sc.chosen.name.slice(0, 26)}…` : sc.chosen.name}
                        </span>
                      ) : <span className="bs sa">no match</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">
        Patterns support <code>*</code> and <code>?</code>; the <strong>newest</strong> matching file
        in a folder wins. Leave a pattern empty to accept any <code>.xlsx</code> there. Patterns only
        decide which files are considered — which feed a file actually is comes from its own column
        headers, so a renamed export is still classified correctly and a mislabelled one is not
        mistaken for another feed. Leave a time blank to use fewer than three pickups.
        {cfg.settleSeconds > 0 && (
          <> Files modified in the last {cfg.settleSeconds}s are skipped until the next pickup, so a
          half-written export is never read.</>
        )}
      </p>

      {strayPaths.length > 0 && (
        <p className="note">
          <span className="bs sa">outside the storage folder</span>{' '}
          {strayPaths.length} of {feeds.length} file(s) point somewhere other than{' '}
          <code>{base}</code> — {strayPaths.map((f) => FEED_LABEL[f.feed] ?? f.feed).join(', ')}.
          {cfg.storage.mode === 'synology_composed'
            ? ' Those are read from their own folder, not from the NAS. Use the button above to move them.'
            : ' That is fine if the exports really live there; the folder check column confirms each one.'}
        </p>
      )}

      {scan && (
        <p className="note">
          {scan.complete
            ? '✓ All six files found — a scheduled pickup would produce a complete bundle.'
            : '⚠ Not all six files were found; the pipeline publishes a complete bundle or nothing.'}
        </p>
      )}

      {scan?.feeds.some((f) => f.others.length > 0 || !f.readable) && (
        <>
          <h3 className="pr-tbl-h">Files that would not be used</h3>
          <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead>
                <tr><th>File</th><th>Folder</th><th className="num">Size</th><th>Modified</th><th>Why not</th></tr>
              </thead>
              <tbody>
                {scan.feeds.flatMap((f, fi) =>
                  (!f.readable
                    ? [(
                      <tr key={`${f.feed}-err`} className={fi % 2 ? '' : 're'}>
                        <td colSpan={4} className="muted">{FEED_LABEL[f.feed] ?? f.feed}: {f.path}</td>
                        <td><span className="bs spdel">{f.error}</span></td>
                      </tr>
                    )]
                    : f.others.map((o) => (
                      <tr key={`${f.feed}-${o.name}`} className={fi % 2 ? '' : 're'}>
                        <td>{o.name}</td>
                        <td className="muted">{f.path}</td>
                        <td className="num">{(o.byteSize / 1024 / 1024).toFixed(1)} MB</td>
                        <td>{o.mtime ? formatDateTime(o.mtime) : DASH}</td>
                        <td className="muted">{o.reason}</td>
                      </tr>
                    ))),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {cfg.lastResult && (
        <p className="note">
          Last scheduled run: <strong>{cfg.lastResult.outcome}</strong>
          {cfg.lastResult.detail ? ` (${cfg.lastResult.detail})` : ''} at{' '}
          {formatDateTime(cfg.lastResult.at)}
          {cfg.lastResult.slots ? ` — fired for ${cfg.lastResult.slots}` : ''}.
        </p>
      )}
      {!cfg.enabled && (
        <p className="note">
          Scheduled sync is currently <strong>off</strong> — data only arrives when someone presses
          Sync now, or via a manual upload below.
        </p>
      )}

      {cfg.recentRuns.length > 0 && (
        <>
          <h3 className="pr-tbl-h">Recent pickups</h3>
          <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead>
                <tr><th>File</th><th className="num">Slot</th><th>Jakarta date</th><th>Ran at</th><th>Outcome</th></tr>
              </thead>
              <tbody>
                {cfg.recentRuns.map((r, i) => (
                  <tr key={`${r.feed}-${r.slot}-${r.ranOn}`} className={i % 2 ? '' : 're'}>
                    <td>{FEED_LABEL[r.feed] ?? r.feed}</td>
                    <td className="num">{r.slot}</td>
                    <td>{r.ranOn}</td>
                    <td>{formatDateTime(r.ranAt)}</td>
                    <td>
                      <span className={`bs ${r.outcome === 'published' ? 'sd' : r.outcome === 'error' || r.outcome === 'failed' ? 'spdel' : 'sl'}`}>
                        {r.outcome ?? DASH}
                      </span>
                      {r.detail ? <span className="muted"> {r.detail}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function SapUploadTab({ canUpload, isAdmin }: { canUpload: boolean; isAdmin: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [dataset, setDataset] = useState<Record<string, any> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadDataset = useCallback(() => {
    api.get<Record<string, any>>('/api/v1/dataset/current')
      .then(setDataset)
      .catch(() => setDataset(null));
  }, []);
  useEffect(loadDataset, [loadDataset]);

  const pick = (list: FileList | null) => {
    if (!list) return;
    setResult(null);
    setErr(null);
    // Six is the server's hard limit (multer files: 6).
    setFiles(Array.from(list).slice(0, 6));
  };

  const submit = async () => {
    if (files.length === 0) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      // FormData must NOT go through the JSON helper: the browser has to set
      // its own multipart boundary.
      const res = await fetch(`/api/v1/ingest/upload?publish=${publish ? 'true' : 'false'}`, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      });
      if (!res.ok) {
        let title = res.statusText;
        try {
          const p = (await res.json()) as { title?: string; detail?: string };
          title = p.detail ? `${p.title}: ${p.detail}` : p.title ?? title;
        } catch { /* non-JSON body */ }
        throw new Error(title);
      }
      setResult((await res.json()) as UploadResult);
      setFiles([]);
      if (inputRef.current) inputRef.current.value = '';
      loadDataset();
    } catch (e) {
      setErr(e instanceof ApiError ? e.problem.title : e instanceof Error ? e.message : 'upload failed');
    } finally {
      setBusy(false);
    }
  };

  const totalMb = files.reduce((a, f) => a + f.size, 0) / 1024 / 1024;

  return (
    <>
    <SapSyncSection canEdit={canUpload} isAdmin={isAdmin} />

    <div className="panel">
      <h2>⬆️ SAP Data Upload</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Manual fallback for when the share-folder sync is not running. Uploaded files go through the
        <strong> same pipeline</strong> as the automatic sync — same validations, same transform,
        same immutable dataset version — so a manual batch cannot produce figures the scheduled path
        would not. Source files are never modified; the spooled copies are deleted once the batch
        reaches a terminal state.
      </p>

      {dataset && (
        <p className="note">
          Currently published: <strong>{dataset.asOfDate ?? DASH}</strong>
          {dataset.sourceLabel ? ` · ${dataset.sourceLabel}` : ''}
          {dataset.publishedAt ? ` · loaded ${formatDateTime(dataset.publishedAt)}` : ''}
          {dataset.datasetVersionId != null ? ` · version ${dataset.datasetVersionId}` : ''}
        </p>
      )}

      {!canUpload ? (
        <p className="note">
          You need the <strong>steward</strong> capability (Section Head and above) to upload data.
        </p>
      ) : (
        <>
          <h3 className="pr-tbl-h">1. Choose the six SAP exports</h3>
          <div className="table-wrap" style={{ marginBottom: '.6rem' }}>
            <table className="data dd-tbl">
              <thead>
                <tr><th>Feed</th><th>Export</th><th>Source</th><th>Selected file</th></tr>
              </thead>
              <tbody>
                {EXPECTED.map((e, i) => {
                  // Feeds are detected server-side from the file's own headers,
                  // never from its name — this is a hint, not a requirement.
                  const guess = files.find((f) =>
                    f.name.toLowerCase().includes(e.label.split(' ')[0]!.toLowerCase()));
                  return (
                    <tr key={e.feed} className={i % 2 ? '' : 're'}>
                      <td><code>{e.feed}</code></td>
                      <td>
                        {e.label}{' '}
                        {'optional' in e && e.optional && (
                          // Stated on the row so nobody concludes a bundle now
                          // needs ten files: the six transactional exports are
                          // still all-or-nothing, these four are not.
                          <span className="bs sl">optional</span>
                        )}
                      </td>
                      <td className="muted">{e.hint}</td>
                      <td>
                        {guess
                          ? <span className="bs sd">{guess.name}</span>
                          : <span className="muted">{DASH}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="dt-toolbar" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".xlsx,.XLSX,.xls,.XLS,.csv,.CSV"
              onChange={(e) => pick(e.target.files)}
              aria-label="SAP export files"
            />
            <label className="dt-check">
              <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
              Publish immediately
            </label>
            <button className="btn" style={{ width: 'auto' }} disabled={busy || files.length === 0}
              onClick={() => void submit()}>
              {busy ? 'Uploading and validating…' : `Upload ${files.length || ''} file(s)`}
            </button>
            {files.length > 0 && (
              <span className="count">{files.length} file(s) · {totalMb.toFixed(1)} MB</span>
            )}
          </div>
          <p className="note">
            All six feeds are required for a complete bundle — an incomplete set is rejected rather
            than published half-loaded. Leave <em>Publish immediately</em> unticked to validate and
            stage only, then publish from the dataset history. Ingest can take a minute or two; the
            page waits for the result.
          </p>
        </>
      )}

      {err && <p className="err">{err}</p>}

      {result && (
        <>
          <h3 className="pr-tbl-h">Result</h3>
          {result.outcome === 'published' && (
            <p className="note">
              <span className="bs sd">published</span>{' '}
              Dataset version <strong>{result.datasetVersionId}</strong> is live (batch{' '}
              {result.batchId}). Every page now reads these figures.
            </p>
          )}
          {result.outcome === 'ready' && (
            <p className="note">
              <span className="bs su">staged</span>{' '}
              Version <strong>{result.datasetVersionId}</strong> validated and ready (batch{' '}
              {result.batchId}) — publish it from the dataset history when you are satisfied.
            </p>
          )}
          {result.outcome === 'failed' && (
            <p className="err">
              <span className="bs spdel">failed</span> Batch {result.batchId}: {result.reason}
            </p>
          )}
          {result.outcome === 'noop_unchanged' && (
            <p className="note">
              <span className="bs sl">unchanged</span>{' '}
              These files are byte-identical to the published set — nothing to do. (Use the Admin
              recompute if you need to rebuild figures from the same data.)
            </p>
          )}
          {result.outcome === 'incomplete_bundle' && (
            <p className="err">
              <span className="bs sa">incomplete</span> Missing feed(s):{' '}
              <strong>{result.missing.join(', ')}</strong>. Add the missing export(s) and upload the
              full set again.
            </p>
          )}
          {result.outcome === 'source_unavailable' && (
            <p className="err">
              <span className="bs spdel">source unavailable</span> {result.path}
            </p>
          )}

          {'findings' in result && result.findings.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
              <table className="data dd-tbl">
                <thead>
                  <tr><th>Rule</th><th>Severity</th><th>Feed</th><th className="num">Rows</th><th>Message</th></tr>
                </thead>
                <tbody>
                  {result.findings.map((f, i) => (
                    <tr key={`${f.ruleId}-${i}`} className={i % 2 ? '' : 're'}>
                      <td><code>{f.ruleId}</code></td>
                      <td><span className={`bs ${SEV_PILL[f.severity]}`}>{f.severity}</span></td>
                      <td>{f.feed ?? DASH}</td>
                      <td className="num">{f.affectedRows === null ? DASH : formatNumber(f.affectedRows)}</td>
                      <td style={{ whiteSpace: 'normal' }}>{f.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="note">
            WARNING and CAVEAT findings are known characteristics of the SAP export, not upload
            errors — the publish already succeeded. Only BLOCKER stops a batch.
          </p>
        </>
      )}
    </div>
    </>
  );
}
