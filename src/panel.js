/** Self-contained console page. No external resources, no build step. */

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE[ch]);

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.55 ui-sans-serif,-apple-system,Segoe UI,sans-serif;background:#f6f7f9;color:#1f2328}
main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}
p.note{margin:0 0 18px;color:#57606a}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:18px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:10px;padding:12px 14px}
.card b{display:block;font-size:22px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d0d7de;border-radius:10px;overflow:hidden;margin-bottom:18px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eaeef2;vertical-align:top}
th{background:#f6f8fa;font-weight:600;font-size:12px;color:#57606a}
tr:last-child td{border-bottom:0}
code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#eff2f5;border-radius:5px;padding:1px 5px}
button{font:inherit;padding:3px 10px;border-radius:6px;border:1px solid #d0d7de;background:#f6f8fa;cursor:pointer}
button:hover{background:#eaeef2}
.ok{color:#1a7f37}.err{color:#cf222e}.warn{color:#9a6700}
@media (prefers-color-scheme:dark){
 body{background:#0d1117;color:#e6edf3}
 .card,table{background:#161b22;border-color:#30363d}
 th{background:#21262d;color:#8b949e}
 td{border-color:#21262d}
 code{background:#21262d}
 button{background:#21262d;border-color:#30363d;color:#e6edf3}
 p.note{color:#8b949e}
}`;

function tone(status) {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'err';
  return 'warn';
}

export function renderPanel(snapshot = {}) {
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  const counters = snapshot.counters ?? {};
  const sourceRows = sources.map((source) => `
    <tr>
      <td><code>${esc(source.id)}</code></td>
      <td>${esc(source.kind)}${source.schedule ? ` · <code>${esc(source.schedule)}</code>` : ''}</td>
      <td>${source.enabled ? 'enabled' : '<span class="warn">disabled</span>'}</td>
      <td>${source.last ? `${esc(source.last.status)} · ${esc(source.last.at)}` : 'never'}</td>
      <td><button data-run="${esc(source.id)}">Run now</button></td>
    </tr>`).join('');
  const runRows = runs.slice(0, 50).map((run) => `
    <tr>
      <td><code>${esc(run.sourceId)}</code></td>
      <td>${esc(run.kind)}</td>
      <td class="${tone(run.status)}">${esc(run.status)}</td>
      <td>${esc(run.at)}</td>
      <td>${esc(run.detail || run.sessionId || '')}</td>
    </tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Trigger Hub</title><style>${STYLE}</style></head>
<body><main>
<h1>Trigger Hub</h1>
<p class="note">Schedules, webhooks and file watchers that start or wake agent sessions. Refresh every 5s.</p>
<div class="cards">
  <div class="card">Sources<b>${sources.length}</b></div>
  <div class="card">Fired<b>${Number(counters.fired ?? 0)}</b></div>
  <div class="card">Failed<b>${Number(counters.failed ?? 0)}</b></div>
  <div class="card">Deduped<b>${Number(counters.deduped ?? 0)}</b></div>
  <div class="card">Concurrency<b>${Number(snapshot.concurrency ?? 0)}</b></div>
</div>
<table><thead><tr><th>Source</th><th>Kind</th><th>State</th><th>Last run</th><th></th></tr></thead>
<tbody>${sourceRows || '<tr><td colspan="5">No sources configured.</td></tr>'}</tbody></table>
<table><thead><tr><th>Source</th><th>Kind</th><th>Status</th><th>At</th><th>Detail</th></tr></thead>
<tbody>${runRows || '<tr><td colspan="5">No runs yet.</td></tr>'}</tbody></table>
<p class="note" id="status">connected</p>
<script>
const status = document.getElementById('status');
async function refresh() {
  try {
    const response = await fetch('/dsh-trigger-hub/state', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    status.textContent = data.ok === false ? 'error' : 'connected';
    status.className = 'ok';
    if (JSON.stringify(data.snapshot ?? {}) !== window.__last) {
      window.__last = JSON.stringify(data.snapshot ?? {});
      location.reload();
    }
  } catch (error) {
    status.textContent = 'disconnected: ' + error.message;
    status.className = 'err';
  }
}
document.addEventListener('click', async (event) => {
  const id = event.target?.dataset?.run;
  if (!id) return;
  event.target.disabled = true;
  try {
    await fetch('/dsh-trigger-hub/run/' + encodeURIComponent(id), { method: 'POST' });
  } finally {
    event.target.disabled = false;
    refresh();
  }
});
setInterval(refresh, 5000);
</script>
</main></body></html>`;
}
