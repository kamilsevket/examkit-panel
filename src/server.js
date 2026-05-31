import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || '/data'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''
const PORT = Number(process.env.PORT || 3000)

const PACKS = path.join(DATA_DIR, 'packs')
const META = path.join(DATA_DIR, 'meta')
const LEGAL = path.join(DATA_DIR, 'legal')
for (const d of [PACKS, META, LEGAL]) { if (!existsSync(d)) await mkdir(d, { recursive: true }) }

// ---- storage helpers ----
const packPath = (id) => path.join(PACKS, `${id}.json`)
const metaPath = (id) => path.join(META, `${id}.json`)
const legalPath = (slug, key) => path.join(LEGAL, `${slug}.${key}.html`)
const safeId = (id) => /^[a-zA-Z0-9._-]{1,64}$/.test(id)
const LEGAL_KEYS = new Set(['privacy', 'terms'])

async function readJSON(p, fallback = null) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return fallback }
}
async function listIDs() {
  if (!existsSync(PACKS)) return []
  return (await readdir(PACKS)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
}
async function getMeta(id) {
  return (await readJSON(metaPath(id))) || { published: false, paywall: defaultPaywall(), updatedAt: null }
}
function defaultPaywall() {
  return { priceLabel: '', lockedModes: ['mockExam', 'dueForReview'], freeTopicIDs: [] }
}

// ---- pack validation (mirrors validate_pack.py) ----
function validatePack(p) {
  const errs = []
  for (const k of ['id', 'title', 'locale', 'passPercent', 'mockQuestionCount', 'topics', 'questions', 'version'])
    if (!(k in p)) errs.push(`missing key: ${k}`)
  if (errs.length) return errs
  const topicIDs = new Set(p.topics.map(t => t.id))
  const qids = new Set()
  for (const q of p.questions) {
    if (qids.has(q.id)) errs.push(`duplicate question id: ${q.id}`)
    qids.add(q.id)
    if (!['single', 'multiple', 'trueFalse'].includes(q.kind)) errs.push(`${q.id}: bad kind`)
    const cids = (q.choices || []).map(c => c.id)
    if (cids.length < 2) errs.push(`${q.id}: needs >=2 choices`)
    if (!(q.correctChoiceIDs || []).length) errs.push(`${q.id}: no correct answer`)
    for (const c of q.correctChoiceIDs || []) if (!cids.includes(c)) errs.push(`${q.id}: correct ${c} not in choices`)
    if (q.kind === 'single' && (q.correctChoiceIDs || []).length !== 1) errs.push(`${q.id}: single needs exactly 1 correct`)
    if (q.topicID && !topicIDs.has(q.topicID)) errs.push(`${q.id}: unknown topicID ${q.topicID}`)
  }
  if (p.mockQuestionCount > p.questions.length) errs.push('mockQuestionCount exceeds questions')
  return errs
}

const app = new Hono()
app.use('*', cors())

// ---- auth (admin /api/* only) ----
app.use('/api/*', async (c, next) => {
  if (!ADMIN_TOKEN) return c.json({ error: 'admin disabled: set ADMIN_TOKEN' }, 503)
  const auth = c.req.header('Authorization') || ''
  if (auth !== `Bearer ${ADMIN_TOKEN}`) return c.json({ error: 'unauthorized' }, 401)
  await next()
})

// ---- health ----
app.get('/health', (c) => c.json({ ok: true, service: 'examkit-panel' }))

// ---- public (what apps fetch) ----
app.get('/public/exams', async (c) => {
  const out = []
  for (const id of await listIDs()) {
    const meta = await getMeta(id)
    if (!meta.published) continue
    const pack = await readJSON(packPath(id))
    if (pack) out.push({ id, title: pack.title, locale: pack.locale, version: pack.version })
  }
  return c.json({ exams: out })
})
app.get('/public/exam/:id', async (c) => {
  const id = c.req.param('id')
  const meta = await getMeta(id)
  if (!meta.published) return c.json({ error: 'not_found' }, 404)
  const pack = await readJSON(packPath(id))
  return pack ? c.json(pack) : c.json({ error: 'not_found' }, 404)
})
app.get('/public/config/:id', async (c) => {
  const id = c.req.param('id')
  const meta = await getMeta(id)
  if (!meta.published) return c.json({ error: 'not_found' }, 404)
  const pack = await readJSON(packPath(id))
  return c.json({ published: true, version: pack?.version ?? 0, paywall: meta.paywall })
})

// ---- public legal pages (served to App Store + in-app links) ----
function legalShell(title, bodyHTML) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    max-width: 720px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; color: #1c1c22; }
  @media (prefers-color-scheme: dark){ body{ background:#0e0f13; color:#e7e8ee; } a{ color:#7aa2ff; } }
  h1 { font-size: 1.7rem; } h2 { font-size: 1.2rem; margin-top: 2rem; }
  .meta { color: #8a8d98; font-size: .9rem; margin-bottom: 2rem; }
</style></head><body>${bodyHTML}</body></html>`
}

app.get('/public/legal/:slug/:key', async (c) => {
  const { slug, key } = c.req.param()
  if (!safeId(slug) || !LEGAL_KEYS.has(key)) return c.text('Not found', 404)
  let html
  try { html = await readFile(legalPath(slug, key), 'utf8') } catch { return c.text('Not found', 404) }
  const title = key === 'privacy' ? 'Privacy Policy' : 'Terms of Use'
  return c.html(legalShell(title, html))
})

// ---- admin api ----
app.put('/api/legal/:slug/:key', async (c) => {
  const { slug, key } = c.req.param()
  if (!safeId(slug) || !LEGAL_KEYS.has(key)) return c.json({ error: 'bad slug/key' }, 400)
  const body = await c.req.text()
  if (!body || body.length < 20) return c.json({ error: 'empty body' }, 422)
  await writeFile(legalPath(slug, key), body)
  return c.json({ ok: true, slug, key, bytes: body.length })
})

app.get('/api/exams', async (c) => {
  const out = []
  for (const id of await listIDs()) {
    const pack = await readJSON(packPath(id))
    const meta = await getMeta(id)
    out.push({ id, title: pack?.title, locale: pack?.locale, version: pack?.version,
               questionCount: pack?.questions?.length ?? 0, topicCount: pack?.topics?.length ?? 0,
               published: meta.published, paywall: meta.paywall, updatedAt: meta.updatedAt })
  }
  return c.json({ exams: out })
})
app.get('/api/exam/:id', async (c) => {
  const pack = await readJSON(packPath(c.req.param('id')))
  return pack ? c.json(pack) : c.json({ error: 'not_found' }, 404)
})
app.put('/api/exam/:id', async (c) => {
  const id = c.req.param('id')
  if (!safeId(id)) return c.json({ error: 'bad id' }, 400)
  let pack
  try { pack = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
  const errs = validatePack(pack)
  if (errs.length) return c.json({ error: 'validation', details: errs.slice(0, 30) }, 422)
  await writeFile(packPath(id), JSON.stringify(pack, null, 2))
  const meta = await getMeta(id)
  meta.updatedAt = new Date().toISOString()
  await writeFile(metaPath(id), JSON.stringify(meta, null, 2))
  return c.json({ ok: true, id, questions: pack.questions.length })
})
app.patch('/api/meta/:id', async (c) => {
  const id = c.req.param('id')
  if (!existsSync(packPath(id))) return c.json({ error: 'not_found' }, 404)
  const patch = await c.req.json().catch(() => ({}))
  const meta = await getMeta(id)
  if ('published' in patch) meta.published = !!patch.published
  if (patch.paywall) meta.paywall = { ...meta.paywall, ...patch.paywall }
  meta.updatedAt = new Date().toISOString()
  await writeFile(metaPath(id), JSON.stringify(meta, null, 2))
  return c.json({ ok: true, meta })
})
app.delete('/api/exam/:id', async (c) => {
  const id = c.req.param('id')
  await rm(packPath(id), { force: true })
  await rm(metaPath(id), { force: true })
  return c.json({ ok: true })
})

// ---- admin UI ----
app.get('/', async (c) => c.html(await readFile(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8')))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`examkit-panel on :${info.port}  data=${DATA_DIR}  admin=${ADMIN_TOKEN ? 'on' : 'OFF'}`)
})
