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

const PATTERN_PLACEHOLDER = [
  'PR Report*.XLSX', 'PO Report*.XLSX', 'GR List*.XLSX',
  'PR Release*.XLSX', 'PO Release*.XLSX', 'Rate Conversion*.xlsx',
].join('\n');

const SEV_PILL: Record<Finding['severity'], string> = {
  BLOCKER: 'spdel', CAVEAT: 'sn', WARNING: 'sa', INFO: 'sl',
};

interface SyncCfg {
  enabled: boolean;
  path: string;
  intervalMinutes: number;
  filePatterns: string[];
  settleSeconds: number;
  envPath: string;
  lastResult: { at: string; outcome: string; detail?: string } | null;
}

interface ScanEntry {
  name: string; byteSize: number; mtime: string; matched: boolean; skipReason: string | null;
}

/**
 * SAP Data Sync — the scheduled share-folder ingest.
 *
 * The environment has carried SHARE_POLL_CRON_MINUTES and
 * INGEST_AUTOPOLL_ENABLED since the first build, but nothing read them: the
 * share ingest only ran when someone pressed Sync. The poller behind this
 * panel is that missing scheduler, and its settings live in the rule store so
 * changes apply without a redeploy.
 */
function SapSyncSection({ canEdit, isAdmin }: { canEdit: boolean; isAdmin: boolean }) {
  const [cfg, setCfg] = useState<SyncCfg | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [path, setPath] = useState('');
  const [interval, setIntervalMin] = useState(30);
  const [patterns, setPatterns] = useState('');
  const [scan, setScan] = useState<{ ok: boolean; path: string; error?: string; entries: ScanEntry[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<SyncCfg>('/api/v1/admin/ingest/config')
      .then((x) => {
        setCfg(x);
        setEnabled(x.enabled);
        setPath(x.path);
        setIntervalMin(x.intervalMinutes);
        setPatterns(x.filePatterns.join('\n'));
      })
      .catch((e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);

  const patternList = () => patterns.split('\n').map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const out = await api.put<SyncCfg>('/api/v1/admin/ingest/config', {
        enabled, path, intervalMinutes: interval, filePatterns: patternList(),
      });
      setMsg(out.enabled
        ? `Saved — the folder is checked every ${out.intervalMinutes} minutes.`
        : 'Saved — scheduled sync is off; use Sync now or a manual upload.');
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    } finally { setBusy(null); }
  };

  const doScan = async () => {
    setBusy('scan'); setMsg(null); setScan(null);
    try {
      // Scans the values currently in the form, so a path can be tested
      // before it is saved.
      setScan(await api.post('/api/v1/admin/ingest/scan', { path, filePatterns: patternList() }));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'scan failed');
    } finally { setBusy(null); }
  };

  const syncNow = async () => {
    setBusy('sync'); setMsg('Reading the share folder and ingesting…');
    try {
      const out = await api.post<Record<string, any>>('/api/v1/ingest/sync', {});
      setMsg(
        out.outcome === 'published' ? `Published dataset version ${out.datasetVersionId}.`
        : out.outcome === 'noop_unchanged' ? 'The folder holds the same files already published — nothing to do.'
        : out.outcome === 'incomplete_bundle' ? `Incomplete: missing ${(out.missing ?? []).join(', ')}.`
        : out.outcome === 'source_unavailable' ? `The share folder is not readable: ${out.path}`
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

  const matched = scan?.entries.filter((e) => e.matched).length ?? 0;

  return (
    <div className="panel">
      <h2>🔁 SAP Data Sync</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Reads the six SAP exports from a share folder on a schedule and publishes them through the
        same pipeline as a manual upload. The folder must be <strong>mounted into the API
        container</strong> — this environment was started with <code>{cfg.envPath}</code>. A path
        outside that mount will not be readable no matter what is typed here.
      </p>

      <div className="dt-toolbar" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="dt-check">
          <input type="checkbox" checked={enabled} disabled={!isAdmin}
            onChange={(e) => setEnabled(e.target.checked)} />
          Scheduled sync
        </label>
        <label className="cu-field" style={{ minWidth: 260 }}>Share folder path
          <input value={path} disabled={!isAdmin} onChange={(e) => setPath(e.target.value)}
            placeholder="/mnt/sap_exports" />
        </label>
        <label className="cu-field">Every (minutes, 5–1440)
          <input type="number" min={5} max={1440} value={interval} disabled={!isAdmin}
            onChange={(e) => setIntervalMin(Number(e.target.value))} style={{ width: 110 }} />
        </label>
        {isAdmin && (
          <button className="btn" style={{ width: 'auto' }} disabled={busy !== null} onClick={() => void save()}>
            {busy === 'save' ? 'Saving…' : 'Save schedule'}
          </button>
        )}
        <button className="dt-btn" disabled={busy !== null} onClick={() => void doScan()}>
          {busy === 'scan' ? 'Scanning…' : 'Test / preview folder'}
        </button>
        {canEdit && (
          <button className="dt-btn" disabled={busy !== null} onClick={() => void syncNow()}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>

      <label className="cu-field" style={{ display: 'block', marginTop: '.5rem', maxWidth: 560 }}>
        File name patterns — one per line, <code>*</code> and <code>?</code> wildcards
        <textarea
          rows={4}
          value={patterns}
          disabled={!isAdmin}
          onChange={(e) => setPatterns(e.target.value)}
          placeholder={PATTERN_PLACEHOLDER}
          style={{ width: '100%', fontFamily: 'inherit', fontSize: '.72rem' }}
        />
      </label>
      <p className="note">
        Leave the patterns empty to accept every <code>.xlsx</code> in the folder. Patterns only
        decide which files are <em>considered</em> — which feed a file actually is comes from its own
        column headers, so a renamed export is still classified correctly, and a file named like a PR
        report but holding PO columns is not mistaken for one.
        {cfg.settleSeconds > 0 && (
          <> Files modified within the last {cfg.settleSeconds}s are skipped until the next pass, so a
          half-written export is never read.</>
        )}
      </p>

      {cfg.lastResult && (
        <p className="note">
          Last scheduled run: <strong>{cfg.lastResult.outcome}</strong>
          {cfg.lastResult.detail ? ` (${cfg.lastResult.detail})` : ''} at{' '}
          {formatDateTime(cfg.lastResult.at)}.
        </p>
      )}
      {!cfg.enabled && (
        <p className="note">
          Scheduled sync is currently <strong>off</strong> — data only arrives when someone presses
          Sync now, or via a manual upload below.
        </p>
      )}
      {msg && <p className="note"><strong>{msg}</strong></p>}

      {scan && (
        <>
          <h3 className="pr-tbl-h">Folder preview <span className="muted">— {scan.path}</span></h3>
          {!scan.ok ? (
            <p className="err">Cannot read this path: {scan.error}</p>
          ) : (
            <>
              <p className="note">
                {matched} of {scan.entries.length} entries would be picked up.
                {matched > 0 && matched < 6 ? ' A complete bundle needs all six feeds.' : ''}
              </p>
              <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                <table className="data dd-tbl">
                  <thead>
                    <tr><th>File</th><th className="num">Size</th><th>Modified</th><th>Would use</th></tr>
                  </thead>
                  <tbody>
                    {scan.entries.length === 0 && (
                      <tr><td colSpan={4} className="muted">The folder is empty.</td></tr>
                    )}
                    {scan.entries.map((e, i) => (
                      <tr key={e.name} className={i % 2 ? '' : 're'}>
                        <td>{e.name}</td>
                        <td className="num">{(e.byteSize / 1024 / 1024).toFixed(1)} MB</td>
                        <td>{e.mtime ? formatDateTime(e.mtime) : DASH}</td>
                        <td>
                          {e.matched
                            ? <span className="bs sd">yes</span>
                            : <span className="bs sl" title={e.skipReason ?? ''}>no — {e.skipReason}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
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
