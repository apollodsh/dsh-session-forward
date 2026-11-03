/**
 * dsh-session-forward · 「复制分享链接」的零依赖服务器
 *
 * DSH 是桌面应用，没有公网可上传的地方，所以分享链接只能由本机现起一个临时 HTTP 服务：
 *
 *   1. pickLanAddresses()  找出本机最可能是「真实局域网」的 IPv4（给链接挑 host）
 *   2. createShareStore()  把网页 HTML 放进内存，配一个不可猜测 token + TTL
 *   3. startShareServer()  真起一个 http.Server，只认 GET/HEAD /s/<token>
 *
 * 这个文件刻意不 import 任何 @deepseek-ai 包、也不依赖 DSH 的 ctx，
 * 只 import node 内置模块，因此可以用一条命令单独跑测试（test/share-server.mjs）。
 *
 * 安全模型很简单：token 就是凭据。服务默认 listen 0.0.0.0（局域网可达），
 * token 由 randomBytes(16) 生成且带 TTL，过期即失效；响应一律 no-store + 严格 CSP，
 * 页面本身是自包含 HTML（无外部资源），所以对方点开就能看，不需要装插件。
 */

import { randomBytes } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'

/** 默认分享链接有效期：24 小时 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/** 默认最多同时保留多少个分享页（防止本机内存被刷爆） */
const DEFAULT_MAX_ENTRIES = 50

/** token 熵：16 字节 = 128 位，base64url 后 22 个字符 */
const TOKEN_BYTES = 16

/** token 允许的最大长度；再长一律当作非法（不查内存，直接 404） */
const MAX_TOKEN_LENGTH = 128

/** 分享路径固定为 /s/<token>，且只允许「一段」，任何多出来的斜杠都是 404 */
const SHARE_PATH_RE = /^\/s\/([^/]+)$/

/** token 字符集：base64url。'..'、斜杠、百分号编码、超长都在这里被挡掉 */
const TOKEN_RE = /^[A-Za-z0-9_-]+$/

/** 非 /s/<token> 路径 / 错误的请求头时返回的固定短文案，不携带任何内部信息 */
const TEXT_NOT_FOUND = 'Not Found\n'
const TEXT_BAD_METHOD = 'Method Not Allowed\n'
const TEXT_SERVER_ERROR = 'Internal Server Error\n'

/**
 * 分享页的统一安全响应头。
 * - no-store：不落任何缓存，撤掉 token 就等于撤掉内容
 * - CSP：页面自包含（内联样式/脚本 + data: 图片），其余一律禁止
 * - noindex：不让搜索引擎（如果有）收录
 */
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
}

/** 一眼就该跳过的虚拟网卡（VPN / 容器 / 虚拟化 / 热点 / AirDrop 等），小写比较 */
const VIRTUAL_IFACE_RE =
  /^(?:utun|tun|tap|bridge|docker|veth|vmnet|vboxnet|awdl|llw|gif|anpi|ap\d|stf|ipsec|ppp|ham\d|zt|tailscale|wg\d|virbr|lxc|br-)/

/** 最像「用户真实网卡」的名字 */
const PRIMARY_IFACE_RE = /^(?:en0|en1|en2)$/
const SECONDARY_IFACE_RE = /^en\d+$/
const GENERIC_IFACE_RE = /^(?:eth\d+|wlan\d+|wl\w+|wi-?fi\w*)$/

/**
 * 把点分十进制 IPv4 解析成四段数字；不合法返回 null。
 * @param {string} address
 * @returns {number[] | null}
 */
function parseIPv4(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null
}

/**
 * 是否是 RFC1918 私有地址（192.168/16、10/8、172.16/12）。
 * 私有地址最可能是「同一个局域网里对方也能访问」的地址。
 * @param {string} address
 * @returns {boolean}
 */
function isPrivateIPv4(address) {
  const parts = parseIPv4(address)
  if (!parts) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/**
 * 给一个候选地址打分，分越高越像「用户真实局域网地址」。
 * 排序策略：真实网卡名 > 私有网段 > 192.168（家用最常见）> 其他。
 * @param {string} name 网卡名
 * @param {string} address IPv4 地址
 * @returns {number}
 */
function scoreAddress(name, address) {
  const lower = name.toLowerCase()
  let score = 0
  if (PRIMARY_IFACE_RE.test(lower)) score += 400
  else if (SECONDARY_IFACE_RE.test(lower)) score += 300
  else if (GENERIC_IFACE_RE.test(lower)) score += 250
  else if (/^(?:en|eth|wlan|wl)/.test(lower)) score += 150
  if (isPrivateIPv4(address)) score += 100
  if (address.startsWith('192.168.')) score += 30
  return score
}

/**
 * 找出本机最可能的局域网 IPv4 地址，按「最可能是用户真实网卡」排序。
 *
 * 只返回 IPv4；跳过 internal（回环）、169.254.*（自分配链路本地地址，对方访问不到）、
 * 以及 utun/tun/tap/bridge/docker/veth/vmnet/awdl/ap 之类的虚拟网卡。同一个 IPv4
 * 即使挂在多张网卡上（macOS 常见）也只返回一次，保留得分最高的那张卡名。
 *
 * @param {ReturnType<typeof os.networkInterfaces>} [interfaces] 默认取本机网卡表（测试可注入）
 * @returns {Array<{ address: string, name: string }>} 按可信度从高到低
 */
export function pickLanAddresses(interfaces = os.networkInterfaces()) {
  const best = new Map()

  for (const [name, addresses] of Object.entries(interfaces ?? {})) {
    if (!name || VIRTUAL_IFACE_RE.test(name.toLowerCase())) continue
    if (!Array.isArray(addresses)) continue

    for (const info of addresses) {
      if (!info || info.internal === true) continue
      // node >= 18 用 'IPv4'，老版本用数字 4，两种都认
      if (info.family !== 'IPv4' && info.family !== 4) continue

      const address = String(info.address ?? '')
      if (!parseIPv4(address)) continue
      if (address.startsWith('127.')) continue
      if (address.startsWith('169.254.')) continue
      if (address === '0.0.0.0') continue

      const score = scoreAddress(name, address)
      const existing = best.get(address)
      if (!existing || score > existing.score) best.set(address, { address, name, score })
    }
  }

  return [...best.values()]
    .sort((left, right) => right.score - left.score || left.address.localeCompare(right.address))
    .map(({ address, name }) => ({ address, name }))
}

/**
 * 创建内存分享存储。
 *
 * 只存在内存里：进程退出（或用户关掉分享服务）就全没了。
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs] 每条分享的有效期，默认 24 小时
 * @param {number} [options.maxEntries] 最多保留多少条，超出时淘汰「最早过期」的那条，默认 50
 * @param {() => number} [options.now] 时钟，默认 Date.now（测试可注入假时钟）
 * @returns {{
 *   put: (html: string, meta?: object) => { token: string, expiresAt: number },
 *   get: (token: string) => { html: string, meta: object, createdAt: number, expiresAt: number } | undefined,
 *   sweep: () => number,
 *   readonly size: number,
 * }}
 */
export function createShareStore(options = {}) {
  const {
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = Date.now,
  } = options ?? {}

  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULT_TTL_MS
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES
  const clock = typeof now === 'function' ? now : Date.now

  /** @type {Map<string, { html: string, meta: object, createdAt: number, expiresAt: number }>} */
  const entries = new Map()

  /** 删掉所有已过期条目，返回删除数量 */
  function removeExpired() {
    const current = clock()
    let removed = 0
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= current) {
        entries.delete(token)
        removed += 1
      }
    }
    return removed
  }

  /** 淘汰一条「最早过期」的条目（完全相同时按插入顺序取最早的那条） */
  function evictEarliest() {
    let victim = null
    let victimExpiresAt = Infinity
    for (const [token, entry] of entries) {
      if (entry.expiresAt < victimExpiresAt) {
        victim = token
        victimExpiresAt = entry.expiresAt
      }
    }
    if (victim !== null) entries.delete(victim)
    return victim !== null
  }

  return {
    /**
     * 放入一个分享页，返回它的 token。
     * @param {string} html 完整 HTML 文本
     * @param {object} [meta] 调用方想随手存的元信息（标题、文件名等），原样保存
     * @returns {{ token: string, expiresAt: number }}
     */
    put(html, meta = {}) {
      if (typeof html !== 'string') throw new TypeError('createShareStore.put: html 必须是字符串')

      // 先清理过期条目，避免过期占着 maxEntries 的名额
      removeExpired()
      // 名额满了就淘汰最早过期的那条（连续淘汰，保证 put 之后一定不超限）
      while (entries.size >= limit && evictEarliest()) {
        // 空循环：evictEarliest 返回 false 表示已经空了，防死循环
      }

      const token = randomBytes(TOKEN_BYTES).toString('base64url')
      const createdAt = clock()
      const expiresAt = createdAt + ttl
      entries.set(token, {
        html,
        meta: meta && typeof meta === 'object' ? { ...meta } : {},
        createdAt,
        expiresAt,
      })
      return { token, expiresAt }
    },

    /**
     * 取一个分享页；不存在或已过期返回 undefined（顺手删掉过期条目）。
     * @param {string} token
     * @returns {{ html: string, meta: object, createdAt: number, expiresAt: number } | undefined}
     */
    get(token) {
      if (typeof token !== 'string' || token === '') return undefined
      const entry = entries.get(token)
      if (!entry) return undefined
      if (entry.expiresAt <= clock()) {
        entries.delete(token)
        return undefined
      }
      return { ...entry }
    },

    /**
     * 主动清理所有过期条目（定时器/服务端可以周期性调用）。
     * @returns {number} 删除数量
     */
    sweep() {
      return removeExpired()
    },

    /** 当前内存里的条目数（含尚未 sweep 的过期条目，上限由 maxEntries 兜底） */
    get size() {
      return entries.size
    },
  }
}

/**
 * 起一个只提供分享页的 HTTP 服务。
 *
 * 路由只有一条：GET|HEAD /s/<token>。其余一律 404（路径/方法错误时 405 但同样不含信息）。
 * 服务端任何内部错误只 logger.warn，不让进程崩。
 *
 * @param {object} options
 * @param {ReturnType<typeof createShareStore>} options.store 分享存储（必填）
 * @param {string} [options.bindHost] 监听地址，默认 '0.0.0.0'（局域网可达；测试里用 127.0.0.1）
 * @param {number} [options.port] 端口，默认 0（交给 OS 分配，读返回值里的 port）
 * @param {{ warn?: (...args: any[]) => void }} [options.logger] 日志，默认 console
 * @returns {Promise<{ port: number, server: import('node:http').Server, close: () => Promise<void> }>}
 */
export async function startShareServer(options = {}) {
  const {
    store,
    bindHost = '0.0.0.0',
    port = 0,
    logger = console,
  } = options ?? {}

  if (!store || typeof store.get !== 'function') {
    throw new TypeError('startShareServer: 需要 store（createShareStore 的返回值）')
  }

  /** 只 warn、不抛：分享服务挂了不该把宿主进程带崩 */
  const warn = (message, error) => {
    try {
      logger?.warn?.(`[dsh-session-forward] ${message}`, error)
    } catch {
      // logger 自己被换成了怪东西也不影响主流程
    }
  }

  /**
   * 回一段纯文本（404/405/500 用），HEAD 只回头。
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {string} text
   * @param {Record<string, string>} [extraHeaders]
   * @param {string} [method]
   */
  function sendText(res, status, text, extraHeaders = {}, method = 'GET') {
    const body = Buffer.from(text, 'utf8')
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    })
    if (method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  }

  /**
   * 真正的请求处理：只认 GET|HEAD + /s/<合法 token>。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function handleRequest(req, res) {
    const method = req.method ?? 'GET'

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, TEXT_BAD_METHOD, { Allow: 'GET, HEAD' }, method)
      return
    }

    /** @type {string} */
    let pathname
    try {
      // 只取 pathname，忽略 query/hash；非法 URL 当作不存在
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      sendText(res, 404, TEXT_NOT_FOUND, {}, method)
      return
    }

    const match = SHARE_PATH_RE.exec(pathname)
    const token = match ? match[1] : ''
    // '.', '..'、百分号编码、斜杠、任意非 base64url 字符、超长 token 全在这里被拒
    if (
      token === '' ||
      token.length > MAX_TOKEN_LENGTH ||
      token.includes('..') ||
      !TOKEN_RE.test(token)
    ) {
      sendText(res, 404, TEXT_NOT_FOUND, {}, method)
      return
    }

    const entry = store.get(token)
    if (!entry) {
      sendText(res, 404, TEXT_NOT_FOUND, {}, method)
      return
    }

    const body = Buffer.from(entry.html, 'utf8')
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(body.length),
    })
    // HEAD 只回头，不写 body（Content-Length 仍按 GET 的真实长度给）
    if (method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  }

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res)
    } catch (error) {
      warn('处理分享请求失败', error)
      try {
        if (!res.headersSent) {
          sendText(res, 500, TEXT_SERVER_ERROR, {}, req.method === 'HEAD' ? 'HEAD' : 'GET')
          return
        }
        res.end()
      } catch {
        // 连接可能已经被对端断开，重试也没意义
      }
    }
  })

  // 畸形请求（坏 method、坏 header）不打断服务：回 400 然后关掉这条连接
  server.on('clientError', (error, socket) => {
    warn('收到畸形 HTTP 请求，已回 400', error)
    try {
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      } else {
        socket.destroy()
      }
    } catch {
      try {
        socket.destroy()
      } catch {
        // 已经关了
      }
    }
  })

  await new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onListenError)
      resolve()
    }
    const onListenError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    server.once('listening', onListening)
    server.once('error', onListenError)
    server.listen(port, bindHost)
  }).catch((error) => {
    warn(`分享服务启动失败（${bindHost}:${port}）`, error)
    throw error
  })

  // 起来之后再出错（例如 accept 阶段的临时错误）只记日志，不抛
  server.on('error', (error) => warn('分享服务出错', error))

  const address = server.address()
  const boundPort = address && typeof address === 'object' ? address.port : port

  /** @type {Promise<void> | null} */
  let closing = null

  /**
   * 关闭服务；幂等（重复调用返回同一个 Promise），没监听时就当已关。
   * @returns {Promise<void>}
   */
  const close = () => {
    if (closing) return closing
    closing = new Promise((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
      // keep-alive 会拖住 close，主动断开所有现存连接
      try {
        server.closeAllConnections?.()
      } catch {
        // 老 node 没有 closeAllConnections，退化为等连接自然结束
      }
    }).catch((error) => {
      warn('关闭分享服务失败', error)
    })
    return closing
  }

  return { port: boundPort, server, close }
}
