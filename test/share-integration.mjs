#!/usr/bin/env node
/**
 * dsh-session-forward · 分享链接端到端（Host 侧）测试
 *
 * 用一个假的 ctx 调真正的 apply(ctx)：注册出来的 Fetch 路由是真的，分享服务也是真的
 * http.Server。然后按返回的链接真发一次 HTTP 请求，检查页面、头部、404 与关闭行为。
 *
 * 运行：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/share-integration.mjs
 */

import { apply } from '../lib/index.js'
import { pickLanAddresses } from '../lib/share.js'

let passed = 0
let failed = 0
const failures = []
function ok(condition, label, detail) {
  if (condition) { passed += 1; return }
  failed += 1
  failures.push(detail === undefined ? label : `${label}（${detail}）`)
}
function contains(haystack, needle, label) { ok(String(haystack).includes(needle), label, `缺少 ${needle}`) }

/* ---------- 假的 Host ctx ---------- */

const surfaceEvents = [
  { type: 'user/message', time: 10, data: { role: 'user', content: [{ type: 'text', text: '分享链接能直接发给别人吗？' }], source: { kind: 'user' } } },
  { type: 'assistant/message', time: 20, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '可以，这条链接打开就是一张自包含网页。' }], source: { kind: 'model', provider: 'p1', model: 'm1' } }, stream: [] } },
]

const liveSession = { id: 'session-src', header: { cwd: '/tmp/ws' }, append() {} }
const routes = []
const tools = []
const disposers = []

const ctx = {
  logger: { warn(message) { process.stdout.write(`WARN ${message}\n`) } },
  sessions: {
    get(id) { return id === 'session-src' ? liveSession : undefined },
    flush: async () => true,
  },
  sessionQuery: {
    async readSurface(id) {
      return { session: { id, cwd: '/Users/me/project', createdAt: 1 }, events: surfaceEvents }
    },
    async readTitle() { return { title: '分享链接测试' } },
  },
  sessionController: { async create() { return { sessionId: 'session-new' } } },
  agents: { get: () => undefined },
  get(name) {
    if (name === 'fs') {
      return {
        async resolve(path) { return { targetKey: path, displayPath: path } },
        async stat() { return { type: 'file', size: 10 } },
        async readText() { return '{}' },
        async writeText() { return {} },
      }
    }
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' }) }
    if (name === 'workspaceRegistry') return { get: () => undefined, resolveByPath: async () => undefined, list: () => [] }
    if (name === 'sessionTitle') return { rename: () => ({}) }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p0', model: 'm0' }) }
    if (name === 'workingDirectory') return { defaultDirectory: '/tmp/ws' }
    return undefined
  },
  inject(_deps, callback) {
    callback({
      connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
      tools: { register(definition) { tools.push(definition); return () => {} } },
      effect(fn) {
        const disposer = fn()
        if (typeof disposer === 'function') disposers.push(disposer)
        return disposer
      },
    })
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
}

apply(ctx)

const shareRoute = routes.find((route) => route.path.endsWith('.share'))
const exportRoute = routes.find((route) => route.path.endsWith('.export'))

ok(routes.length === 3, '注册了导出/导入/分享三条路由', String(routes.length))
ok(shareRoute !== undefined && shareRoute.methods.length === 1 && shareRoute.methods[0] === 'POST', '分享路由是 POST')
ok(tools.length === 1 && tools[0].name === 'session_forward', '注册了 session_forward 工具')

/* ---------- 导出路由也带上网页 ---------- */

const exported = await exportRoute.fetch(new Request('http://x/api/session-forward.export?sessionId=session-src'))
const exportBody = await exported.json()
ok(exportBody.ok === true, '导出成功')
ok(typeof exportBody.html === 'string' && exportBody.html.startsWith('<!doctype html>'), '导出结果带自包含网页')
ok(typeof exportBody.htmlFileName === 'string' && exportBody.htmlFileName.endsWith('.dshchat.html'), '导出结果带网页文件名')
contains(exportBody.html, '分享链接能直接发给别人吗？', '网页里有对话正文')

/* ---------- 分享路由 + 真 HTTP ---------- */

const shared = await shareRoute.fetch(new Request('http://x/api/session-forward.share', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-src' }),
}))
const shareBody = await shared.json()

const lanAddresses = pickLanAddresses()
if (shareBody.ok !== true && lanAddresses.length === 0) {
  console.log('SKIP 本机没有可用的局域网 IPv4，分享链接无法生成（其余断言已通过）')
  console.log(`PASS ${passed}  FAIL ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

ok(shareBody.ok === true, '分享成功', JSON.stringify(shareBody).slice(0, 200))
ok(typeof shareBody.url === 'string' && /^http:\/\/[^/]+\/s\/[A-Za-z0-9_-]+$/.test(shareBody.url), '返回 /s/<token> 形式的链接', shareBody.url)
ok(Array.isArray(shareBody.urls) && shareBody.urls.length >= 1, '返回候选地址列表')
ok(typeof shareBody.expiresAt === 'number' && shareBody.expiresAt > Date.now(), '返回未来的过期时间')
ok(shareBody.title === '分享链接测试', '返回标题')
ok(shareBody.messages === 2, '返回消息条数')

const parsed = new URL(shareBody.url)
const port = parsed.port
const token = parsed.pathname.split('/').pop()
const localUrl = `http://127.0.0.1:${port}/s/${token}`

async function fetchText(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, text }
}

const page = await fetchText(localUrl)
ok(page.response.status === 200, '分享页 200')
contains(page.response.headers.get('content-type') ?? '', 'text/html', '内容类型是 HTML')
contains(page.response.headers.get('cache-control') ?? '', 'no-store', '禁止缓存')
contains(page.response.headers.get('content-security-policy') ?? '', "default-src 'none'", '带严格 CSP')
contains(page.response.headers.get('x-content-type-options') ?? '', 'nosniff', 'nosniff')
contains(page.response.headers.get('referrer-policy') ?? '', 'no-referrer', 'no-referrer')
contains(page.text, '分享链接能直接发给别人吗？', '分享页含对话正文')
contains(page.text, 'id="dshsf-copy"', '分享页含复制按钮')
contains(page.text, '有效期至', '分享页标注了有效期')
ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(page.text.replace(/[\s\S]*?<pre[\s\S]*?<\/pre>/, '')), '页面没有引用外部资源')

const head = await fetch(localUrl, { method: 'HEAD' })
ok(head.status === 200, 'HEAD 分享页 200')
ok((await head.text()) === '', 'HEAD 没有响应体')

const wrongToken = await fetch(`http://127.0.0.1:${port}/s/not-a-real-token`)
ok(wrongToken.status === 404, '未知 token 返回 404')

const badToken = await fetch(`http://127.0.0.1:${port}/s/..%2F..%2Fetc%2Fpasswd`)
ok(badToken.status === 404, '可疑 token 返回 404')

const wrongPath = await fetch(`http://127.0.0.1:${port}/other`)
ok(wrongPath.status === 404, '其它路径返回 404')

const wrongMethod = await fetch(`http://127.0.0.1:${port}/s/${token}`, { method: 'DELETE' })
ok(wrongMethod.status === 404 || wrongMethod.status === 405, '不支持的方法被拒绝', String(wrongMethod.status))

/* ---------- 第二次分享：token 不同 ---------- */

const sharedAgain = await shareRoute.fetch(new Request('http://x/api/session-forward.share', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-src' }),
}))
const againBody = await sharedAgain.json()
ok(againBody.ok === true && againBody.url !== shareBody.url, '每次分享生成新链接')

/* ---------- 非法请求 ---------- */

const badBody = await shareRoute.fetch(new Request('http://x/api/session-forward.share', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'not a session id !!' }),
}))
ok(badBody.status === 400, '非法 sessionId 返回 400')

const badType = await shareRoute.fetch(new Request('http://x/api/session-forward.share', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: 'x',
}))
ok(badType.status === 415, '非 JSON content-type 返回 415')

const missing = await shareRoute.fetch(new Request('http://x/api/session-forward.share', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
}))
ok(missing.status === 400, '缺少 sessionId 返回 400')

/* ---------- 工具 action=share ---------- */

const tool = tools[0]
const toolResult = await tool.execute(
  { action: 'share', sessionId: 'session-src' },
  { signal: new AbortController().signal, agent: { id: 'session-src', session: { header: { cwd: '/tmp/ws' } } } },
)
ok(toolResult.ok === true && typeof toolResult.url === 'string', '工具的 share 动作返回链接')
const rendered = tool.output.render({}, toolResult)[0].text
contains(rendered, 'Share link', '工具渲染文案')
contains(rendered, 'http://', '工具文案里有链接')

/* ---------- 关闭 ---------- */

for (const dispose of disposers.slice().reverse()) {
  try { await dispose() } catch { /* ignore */ }
}
let closed = false
try {
  await fetch(`http://127.0.0.1:${port}/s/${token}`)
} catch {
  closed = true
}
ok(closed, '插件卸载后分享服务已关闭')

/* ---------- 汇总 ---------- */

console.log(`PASS ${passed}  FAIL ${failed}`)
if (failed > 0) {
  console.log('\n失败明细:')
  for (const item of failures) console.log(`  ✗ ${item}`)
  process.exit(1)
}
