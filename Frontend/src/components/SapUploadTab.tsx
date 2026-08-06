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

interface SyncCfg {
  enabled: boolean;
  timezone: string;
  settleSeconds: number;
  feeds: FeedCfg[];
  envPath: string;
  nowInZone: string;
  lastResult: { at: string; outcome: string; detail?: string; slots?: string } | null;
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
function SapSyncSection({ canEdit, isAdmin }: { canEdit: boolean; isAdmin: boolean }) {
  const [cfg, setCfg] = useState<SyncCfg | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [feeds, setFeeds] = useState<FeedCfg[]>([]);
  const [scan, setScan] = useState<{ feeds: FeedScan[]; complete: boolean } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<SyncCfg>('/api/v1/admin/ingest/config')
      .then((x) => {
        setCfg(x);
        setEnabled(x.enabled);
        setFeeds(x.feeds.map((f) => ({ ...f, slots: [...f.slots] as [string, string, string] })));
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

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const out = await api.put<SyncCfg>('/api/v1/admin/ingest/config', { enabled, feeds });
      setCfg(out);
      const times = out.feeds.flatMap((f) => f.slots.filter(Boolean)).length;
      setMsg(out.enabled
        ? `Saved — ${times} pickup time(s) armed, all times ${out.timezone}.`
        : 'Saved — scheduled sync is off; use Sync now or a manual upload.');
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

  return (
    <div className="panel">
      <h2>
        🔁 SAP Data Sync{' '}
        <span className="muted">— per file: folder, name pattern, 3 pickup times ({cfg.timezone})</span>
      </h2>
      <p className="note" style={{ marginTop: 0 }}>
        Every time is <strong>{cfg.timezone}</strong> (server clock now reads{' '}
        <strong>{cfg.nowInZone}</strong>). Each folder must be <strong>mounted into the API
        container</strong> — this one was started with <code>{cfg.envPath}</code>, so paths outside
        that mount are not readable no matter what is typed here.
      </p>
      <p className="note">
        A dataset is published complete or not at all, so a pickup time decides <em>when that
        file&apos;s folder is read again</em>. When one fires, the newest matching file from every
        folder is assembled into one bundle and ingested — if nothing changed the run reports
        &quot;unchanged&quot; and no new version appears.
      </p>

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
                      <td>{e.label}</td>
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
              accept=".xlsx,.XLSX,.xls,.XLS"
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
