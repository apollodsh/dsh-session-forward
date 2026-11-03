#!/usr/bin/env node
/**
 * dsh-session-forward · 分享服务器（lib/share.js）的离线测试
 *
 * 全部用真实 TCP/HTTP 跑：起一个只 listen 127.0.0.1 的服务，用 node:http 发真请求，
 * 不 mock、不写死端口（port: 0 让 OS 分配后读 server.address().port）。
 * 特别地：macOS 上 listen 0.0.0.0 可能弹防火墙提示，所以这里只测 127.0.0.1，
 * 「bindHost 可配」本身就是被测行为之一。
 *
 * 运行（本机没有 node 在 PATH，借 Electron 的 node）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/share-server.mjs
 */

import http from 'node:http'
import net from 'node:net'

import { createShareStore, pickLanAddresses, startShareServer } from '../lib/share.js'

/* ---------- 断言与计数 ---------- */

let passed = 0
let failed = 0
const failures = []

function ok(condition, label, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? label : `${label}（${detail}）`)
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

/** 静音 logger：正常路径不该有 warn，测试输出保持干净 */
const quietLogger = { warn() {} }

/* ---------- 真实 HTTP 客户端 ---------- */

/**
 * 向 127.0.0.1:<port> 发一个真实 HTTP 请求。
 * @param {number} port
 * @param {{ method?: string, path?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, headers: Record<string, any>, body: string }>}
 */
function request(port, { method = 'GET', path = '/', headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(5000, () => req.destroy(new Error(`请求超时：${method} ${path}`)))
    req.on('error', reject)
    req.end()
  })
}

/**
 * 直接往 socket 写原始字节，用来验证畸形请求不会把服务搞崩。
 * @param {number} port
 * @param {string} payload
 * @returns {Promise<string>} 服务端回写的原始文本（连接被直接断开时为空串）
 */
function rawExchange(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const chunks = []
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      socket.destroy()
      settle(reject, new Error('raw 请求超时'))
    }, 5000)
    socket.on('connect', () => socket.write(payload))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')))
    socket.on('close', () => settle(resolve, Buffer.concat(chunks).toString('utf8')))
    socket.on('error', (error) => settle(reject, error))
  })
}

/* ---------- 1. 存储：纯逻辑，注入假时钟 ---------- */

const html5 = '<!doctype html><html><body><h1>你好</h1></body></html>'

{
  let now = 1_700_000_000_000
  const store = createShareStore({ ttlMs: 60_000, maxEntries: 3, now: () => now })

  const first = store.put(html5, { title: '测试', fileName: 'a.html' })
  ok(typeof first.token === 'string' && first.token.length === 22, 'token 是 16 字节 base64url（22 字符）', String(first.token))
  ok(/^[A-Za-z0-9_-]+$/.test(first.token), 'token 只含 base64url 字符（URL 里不用转义）')
  eq(first.expiresAt, now + 60_000, 'expiresAt = 创建时间 + ttlMs')

  const got = store.get(first.token)
  ok(got !== undefined && got.html === html5, 'get 取回完整 HTML')
  eq(got?.meta?.title, '测试', 'get 取回 meta')
  eq(got?.createdAt, now, 'get 带回 createdAt')
  eq(store.size, 1, 'size 反映条目数')

  ok(store.get('nope') === undefined, '未知 token 返回 undefined')
  ok(store.get('') === undefined, '空 token 返回 undefined')
  ok(store.get(undefined) === undefined, 'undefined token 返回 undefined')
  ok(store.get(12345) === undefined, '非字符串 token 返回 undefined')

  const second = store.put('<p>2</p>')
  ok(second.token !== first.token, '每次 put 生成不同 token')
  eq(store.size, 2, '两次 put 后 size 为 2')

  // meta 默认值
  const noMeta = store.put('<p>3</p>')
  ok(store.get(noMeta.token)?.meta !== null, '不传 meta 时也有 meta 对象')

  let threw = null
  try {
    store.put(42)
  } catch (error) {
    threw = error
  }
  ok(threw instanceof TypeError, 'put 非字符串抛 TypeError（早失败，不静默存坏数据）')
}

// 到期即失效 + get 顺手删
{
  let now = 1_000_000
  const store = createShareStore({ ttlMs: 1000, now: () => now })
  const entry = store.put('<p>x</p>')

  now += 999
  ok(store.get(entry.token) !== undefined, '未到期时 get 仍有值')
  now += 1
  ok(store.get(entry.token) === undefined, '恰好到期时 get 返回 undefined')
  eq(store.size, 0, 'get 遇到过期条目顺手删掉')
}

// sweep 统计
{
  let now = 0
  const store = createShareStore({ ttlMs: 5000, maxEntries: 10, now: () => now })
  store.put('a')
  now += 3000
  const alive = store.put('b')
  now += 3000 // a 到期（expiresAt 5000 <= now 6000），b 还剩 2000

  eq(store.size, 2, 'sweep 前 size 为 2')
  eq(store.sweep(), 1, 'sweep 删除 1 条过期条目')
  eq(store.sweep(), 0, '没有过期条目时 sweep 返回 0')
  eq(store.size, 1, 'sweep 后只剩未过期条目')
  ok(store.get(alive.token) !== undefined, '未过期条目仍在')
}

// maxEntries 淘汰最早过期的
{
  let now = 1000
  const store = createShareStore({ ttlMs: 100_000, maxEntries: 2, now: () => now })
  const a = store.put('a')
  now += 10
  const b = store.put('b')
  now += 10
  const c = store.put('c')
  now += 10

  eq(store.size, 2, 'maxEntries=2 时最多 2 条')
  ok(store.get(a.token) === undefined, '最早的条目被淘汰')
  ok(store.get(b.token) !== undefined, '次早的条目保留')
  ok(store.get(c.token) !== undefined, '最新条目保留')
}

// 过期条目不该占 maxEntries 名额
{
  let now = 0
  const store = createShareStore({ ttlMs: 1000, maxEntries: 1, now: () => now })
  const stale = store.put('过期')
  now += 1001
  const fresh = store.put('新的')
  eq(store.size, 1, '先清过期再生新条目，不会误淘汰有效条目')
  ok(store.get(fresh.token) !== undefined, '新条目在 maxEntries=1 时仍能取到')
  ok(store.get(stale.token) === undefined, '被清掉的过期条目取不到')
  eq(store.sweep(), 0, '此时没有可清条目')
}

/* ---------- 2. pickLanAddresses：注入假网卡表 ---------- */

{
  const fake = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: '192.168.1.23', family: 'IPv4', internal: false },
      { address: 'fe80::1c2b:3dff:fe4e:5f60', family: 'IPv6', internal: false },
    ],
    en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    en2: [{ address: '192.168.1.23', family: 'IPv4', internal: false }], // 与 en0 同地址
    en5: [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
    utun3: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
    bridge0: [{ address: '10.0.0.9', family: 'IPv4', internal: false }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    awdl0: [{ address: '10.1.2.3', family: 'IPv4', internal: false }],
    anpi0: [{ address: '10.1.2.4', family: 'IPv4', internal: false }],
    veth2: [{ address: '192.168.99.2', family: 'IPv4', internal: false }],
    ap1: [{ address: '172.20.10.1', family: 'IPv4', internal: false }],
    llw0: [{ address: '10.1.2.5', family: 'IPv4', internal: false }],
  }

  const lan = pickLanAddresses(fake)
  eq(lan.length, 2, '只保留真实局域网的 2 个 IPv4', JSON.stringify(lan))
  eq(lan[0]?.address, '192.168.1.23', 'en0 的 192.168 地址排第一')
  eq(lan[0]?.name, 'en0', '排第一的网卡是 en0（同名地址保留更高分的那张卡）')
  eq(lan[1]?.address, '10.0.0.5', '次选 en1 的 10/8 地址')
  ok(lan.every((item) => typeof item.address === 'string' && typeof item.name === 'string'), '每项形状是 { address, name }')
  eq(lan.filter((item) => item.address === '192.168.1.23').length, 1, '同一 IPv4 只出现一次')

  const excluded = [
    ['127.0.0.1', 'internal 回环地址'],
    ['169.254.10.2', '169.254 链路本地地址'],
    ['10.8.0.2', 'utun VPN 地址'],
    ['10.0.0.9', 'bridge 地址'],
    ['172.17.0.1', 'docker0 地址'],
    ['10.1.2.3', 'awdl0 地址'],
    ['10.1.2.4', 'anpi0 地址'],
    ['192.168.99.2', 'veth 地址'],
    ['172.20.10.1', 'ap1 热点地址'],
    ['10.1.2.5', 'llw0 地址'],
  ]
  for (const [address, label] of excluded) {
    ok(!lan.some((item) => item.address === address), `${label} 被排除`)
  }

  eq(pickLanAddresses({}).length, 0, '空网卡表返回空数组')
  eq(pickLanAddresses({ en0: [] }).length, 0, '网卡没有地址时返回空数组')
  eq(pickLanAddresses({ en0: undefined }).length, 0, '网卡值为空时返回空数组')

  const loOnly = pickLanAddresses({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })
  eq(loOnly.length, 0, '只有回环时返回空数组')

  const numericFamily = pickLanAddresses({ en0: [{ address: '192.168.0.9', family: 4, internal: false }] })
  eq(numericFamily.length, 1, 'family 为数字 4 的老格式也能识别')
  eq(numericFamily[0]?.address, '192.168.0.9', '数字 family 的地址正确')

  const publicOnEth = pickLanAddresses({ eth0: [{ address: '203.0.113.7', family: 'IPv4', internal: false }] })
  eq(publicOnEth.length, 1, '公网地址也能作为兜底返回')

  const badAddresses = pickLanAddresses({ en0: [{ address: '999.1.1.1', family: 'IPv4', internal: false }] })
  eq(badAddresses.length, 0, '非法 IPv4 字面量被丢弃')
}

// 用本机真实网卡表跑一遍：只验形状与过滤，不断言具体地址（换台机器也能过）
{
  const real = pickLanAddresses()
  ok(Array.isArray(real), '默认参数可用（读本机真实网卡表）')
  ok(real.every((item) => typeof item.address === 'string' && typeof item.name === 'string'), '真实网卡结果形状正确')
  ok(real.every((item) => !item.address.startsWith('169.254.')), '真实网卡结果里没有 169.254.*')
  ok(real.every((item) => !item.address.startsWith('127.')), '真实网卡结果里没有回环')
  ok(new Set(real.map((item) => item.address)).size === real.length, '真实网卡结果里没有重复 IPv4')
  ok(!real.some((item) => /^(?:utun|tun|tap|bridge|docker|veth|vmnet|awdl|llw|anpi|ap\d)/i.test(item.name)), '真实网卡结果里没有虚拟网卡')
}

/* ---------- 3. HTTP 服务：真实请求 127.0.0.1 ---------- */

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"

const pageHtml =
  '<!doctype html>\n<html><head><meta charset="utf-8"><title>分享 · 会话</title>' +
  '<style>body{font-family:system-ui}</style></head>' +
  '<body><h1>你好，世界</h1><p>中文 + emoji 🎉</p></body></html>'
const pageBytes = Buffer.byteLength(pageHtml, 'utf8')

const serverStore = createShareStore({ ttlMs: 60 * 60 * 1000, maxEntries: 10 })
const { token } = serverStore.put(pageHtml, { title: '分享 · 会话' })
const share = await startShareServer({ store: serverStore, bindHost: '127.0.0.1', port: 0, logger: quietLogger })

try {
  ok(Number.isInteger(share.port) && share.port > 0, '端口由 OS 分配且 > 0', String(share.port))
  ok(share.port !== 0, '返回的是真实端口而不是 0')
  ok(share.server.listening === true, '服务处于 listening 状态')
  eq(typeof share.close, 'function', '返回 close 函数')

  // --- 正常 GET ---
  const got = await request(share.port, { path: `/s/${token}` })
  eq(got.status, 200, 'GET /s/<token> 返回 200')
  eq(got.body, pageHtml, 'GET 返回完整 HTML（一字不差）')
  eq(got.headers['content-type'], 'text/html; charset=utf-8', 'Content-Type: text/html; charset=utf-8')
  eq(got.headers['cache-control'], 'no-store', 'Cache-Control: no-store')
  eq(got.headers['x-content-type-options'], 'nosniff', 'X-Content-Type-Options: nosniff')
  eq(got.headers['referrer-policy'], 'no-referrer', 'Referrer-Policy: no-referrer')
  eq(got.headers['x-robots-tag'], 'noindex, nofollow', 'X-Robots-Tag: noindex, nofollow')
  eq(got.headers['content-security-policy'], CSP, 'CSP 与约定逐字一致')
  eq(got.headers['content-length'], String(pageBytes), 'Content-Length 按 UTF-8 字节数')
  ok(!('set-cookie' in got.headers), '不下发任何 Cookie')

  // --- HEAD ---
  const head = await request(share.port, { method: 'HEAD', path: `/s/${token}` })
  eq(head.status, 200, 'HEAD /s/<token> 返回 200')
  eq(head.body, '', 'HEAD 不返回 body')
  eq(head.headers['content-type'], 'text/html; charset=utf-8', 'HEAD 也带正确 Content-Type')
  eq(head.headers['content-length'], String(pageBytes), 'HEAD 的 Content-Length 与 GET 一致')
  eq(head.headers['content-security-policy'], CSP, 'HEAD 也带完整 CSP')

  // --- 带 query 也能打开 ---
  const withQuery = await request(share.port, { path: `/s/${token}?from=wechat&utm=1` })
  eq(withQuery.status, 200, '带 query 的链接也能打开（query 被忽略）')
  eq(withQuery.body, pageHtml, '带 query 时内容不变')

  // --- 404 家族 ---
  const notFoundPaths = [
    ['/s/AAAAAAAAAAAAAAAAAAAAAA', '格式合法但不存在的 token'],
    ['/s/', '空 token'],
    ['/s', '缺少 token 段'],
    ['/', '根路径'],
    ['/api/x', '其它路径'],
    ['/s/..', 'token 为 ..'],
    ['/s/../etc/passwd', '路径穿越'],
    ['/s/a/b', 'token 里带斜杠'],
    ['/s/%2e%2e', '百分号编码的 ..'],
    [`/s/${'a'.repeat(200)}`, '超长 token'],
    [`/s/${token}/extra`, 'token 后面多一段'],
  ]
  for (const [path, label] of notFoundPaths) {
    const res = await request(share.port, { path })
    eq(res.status, 404, `${label} → 404`)
    ok(String(res.headers['content-type'] ?? '').startsWith('text/plain'), `${label} 的 404 是纯文本`, String(res.headers['content-type']))
    ok(res.body.length <= 32, `${label} 的 404 body 很短（不泄露信息）`, res.body)
  }

  const notFound = await request(share.port, { path: '/s/AAAAAAAAAAAAAAAAAAAAAA' })
  eq(notFound.body, 'Not Found\n', '404 文案固定')
  ok(!notFound.body.includes('AAAAAAAA'), '404 回显里不带 token')

  const head404 = await request(share.port, { method: 'HEAD', path: '/s/AAAAAAAAAAAAAAAAAAAAAA' })
  eq(head404.status, 404, 'HEAD 未知 token → 404')
  eq(head404.body, '', '404 的 HEAD 也没有 body')

  // --- 405 家族 ---
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const res = await request(share.port, { method, path: `/s/${token}` })
    eq(res.status, 405, `${method} /s/<token> → 405`)
    eq(res.headers['allow'], 'GET, HEAD', `${method} 的 405 带 Allow: GET, HEAD`)
    ok(String(res.headers['content-type'] ?? '').startsWith('text/plain'), `${method} 的 405 是纯文本`)
  }

  const postRoot = await request(share.port, { method: 'POST', path: '/' })
  eq(postRoot.status, 405, 'POST / 也是 405（先看方法再看路径）')

  // --- 畸形请求不崩 ---
  const raw = await rawExchange(share.port, 'GARBAGE\r\n\r\n')
  ok(raw === '' || raw.startsWith('HTTP/1.1 400'), '畸形请求被拒（400 或直接断开）', JSON.stringify(raw.slice(0, 40)))

  const stillAlive = await request(share.port, { path: `/s/${token}` })
  eq(stillAlive.status, 200, '畸形请求之后服务仍然正常')

  // --- 过期后 404（真实 HTTP + 注入假时钟） ---
  let liveNow = 5_000_000
  const expiringStore = createShareStore({ ttlMs: 1000, maxEntries: 10, now: () => liveNow })
  const expiring = expiringStore.put('<p>一次性链接</p>')
  const expiringServer = await startShareServer({
    store: expiringStore,
    bindHost: '127.0.0.1',
    port: 0,
    logger: quietLogger,
  })
  try {
    const before = await request(expiringServer.port, { path: `/s/${expiring.token}` })
    eq(before.status, 200, '未过期时通过 HTTP 能打开')
    eq(before.body, '<p>一次性链接</p>', '过期前 body 正确')

    liveNow += 1001
    const after = await request(expiringServer.port, { path: `/s/${expiring.token}` })
    eq(after.status, 404, '过期后同一链接变 404')
    eq(expiringStore.size, 0, '过期条目在 get 时被清掉')
  } finally {
    await expiringServer.close()
  }
  ok(expiringServer.server.listening === false, '过期测试的服务已关闭')

  // --- 缺少 store 早失败 ---
  let missingStore = null
  try {
    await startShareServer({ logger: quietLogger })
  } catch (error) {
    missingStore = error
  }
  ok(missingStore instanceof TypeError, '缺少 store 时抛 TypeError（不静默起一个空服务）')
} finally {
  // --- close 幂等（无论上面断言是否失败都要关掉） ---
  const closeA = share.close()
  const closeB = share.close()
  ok(closeA === closeB, 'close 重复调用返回同一个 Promise（幂等）')
  await closeA
  await closeB
  ok(share.server.listening === false, 'close 后 server.listening 为 false')

  let refused = null
  try {
    await request(share.port, { path: `/s/${token}` })
  } catch (error) {
    refused = error
  }
  ok(refused !== null, 'close 后端口不再接受请求')
  ok(refused?.code === 'ECONNREFUSED' || refused?.code === 'ECONNRESET', 'close 后连接被拒（ECONNREFUSED/ECONNRESET）', String(refused?.code))

  let thirdClose = false
  try {
    await share.close()
    thirdClose = true
  } catch {
    thirdClose = false
  }
  ok(thirdClose, 'close 第三次调用也不抛错')
}

/* ---------- 汇总 ---------- */

console.log(`PASS ${passed}  FAIL ${failed}`)
if (failed > 0) {
  console.log('\n失败明细:')
  for (const item of failures) console.log(`  ✗ ${item}`)
  process.exit(1)
}
