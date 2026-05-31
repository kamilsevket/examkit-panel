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
for (const d of [PACKS, META]) { if (!existsSync(d)) await mkdir(d, { recursive: true }) }

// ---- storage helpers ----
const packPath = (id) => path.join(PACKS, `${id}.json`)
const metaPath = (id) => path.join(META, `${id}.json`)
const safeId = (id) => /^[a-zA-Z0-9._-]{1,64}$/.test(id)

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

// ---- admin api ----
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
