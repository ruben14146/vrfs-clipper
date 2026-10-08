// 3D clip render machine for Match Stats highlights.
//   node render.js --shard "<game>/<key>@<stamp>"     render one waiting clip (GitHub Actions: one machine per clip)
//   node render.js --watch                            keep polling the site and render whatever is waiting (run on a PC with a GPU: ~2 s per clip)
// env: KEY = the site's admin key, SITE (default https://matchstats.rubenplayz.com), CHROME = path to Chrome, GPU=1 to use the real GPU (default: software WebGL)
const puppeteer = require('puppeteer-core');
const SITE = process.env.SITE || 'https://matchstats.rubenplayz.com', KEY = process.env.KEY || '';
const GPU = process.env.GPU === '1';
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] || true : null; };
const api = (p, o = {}) => fetch(SITE + p, { ...o, headers: { 'x-admin-key': KEY, ...(o.headers || {}) } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function login() {
  const r = await fetch(SITE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY }) });
  if (!r.ok) throw new Error('login failed: ' + r.status);
  const c = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(x => x.split(';')[0]).find(x => x.startsWith('adm='));
  if (!c) throw new Error('no admin cookie'); return c.slice(4);
}
async function open() {
  const cookie = await login();
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
  if (!GPU) args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args, defaultViewport: { width: 1280, height: 720 }, protocolTimeout: 30 * 60 * 1000 });
  const page = await browser.newPage();
  await page.setCookie({ name: 'adm', value: cookie, domain: new URL(SITE).hostname, path: '/', secure: SITE.startsWith('https'), httpOnly: true });
  page.on('pageerror', e => log('[page error]', String(e).slice(0, 300)));
  page.on('console', m => { const t = m.text(); if (/error|failed/i.test(t) && !/Failed to load resource/.test(t)) log('[page]', t.slice(0, 300)); });
  await page.goto(SITE + '/render.html', { waitUntil: 'load' });
  await page.waitForFunction('window.r3dReady === true', { timeout: 60000 });
  return { browser, page };
}
async function renderOne(page, shard) {
  const r = await api('/api/clips/claim?shard=' + encodeURIComponent(shard)); if (!r.ok) { log('skip', shard, r.status); return false; }
  const job = await r.json(); log('rendering', job.game, job.key, job.scorer || '');
  try {
    await page.exposeFunction('nodeLog', m => log(' ', m)).catch(() => {});
    await page.evaluate((g, k) => window.renderShard(g, k, m => window.nodeLog(m)), job.game, job.key);
    log('done', job.game, job.key); return true;
  } catch (e) {
    log('FAILED', job.game, job.key, String(e.message || e).slice(0, 400));
    // the clip stays queued; it is retried by the next run after a while
    return false;
  }
}
(async () => {
  if (!KEY) throw new Error('KEY (the admin key) is not set');
  const shard = arg('--shard');
  if (shard && shard !== true) {
    const { browser, page } = await open();
    const ok = await renderOne(page, shard); await browser.close(); process.exit(ok ? 0 : 1);
  }
  if (arg('--watch')) {
    log('watching', SITE, GPU ? '(GPU)' : '(software)');
    let session = null;
    for (;;) {
      try {
        const shards = await (await api('/api/clips/plan?machines=' + (GPU ? 3 : 1))).json();
        if (Array.isArray(shards) && shards.length) {
          session = session || await open();
          for (const s of shards) await renderOne(session.page, s);
        }
      } catch (e) { log('error', String(e.message || e).slice(0, 300)); if (session) { try { await session.browser.close(); } catch {} session = null; } }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log('usage: node render.js --shard "<game>/<key>@<stamp>"   |   node render.js --watch'); process.exit(2);
})().catch(e => { console.error(e); process.exit(1); });
