/**
 * 可选工具：从本机一条真实 DSH 会话日志里抽几条事件当测试夹具。
 *
 * 会话日志是「多个 zstd 帧首尾拼接 + 每帧解压后是 JSONL」的格式，
 * 这里按帧 magic（28 b5 2f fd）切分后用 Electron 内置 node 的 zlib 解压。
 * 只在需要重新生成 fixtures/real-events.json 时手动跑：
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/fixtures/extract-real.mjs [session.v4.jsonl.zstd]
 *
 * 注意：仓里只放几条裁剪过的样本（< 40 KiB），不要把整条会话日志复制进来。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_LOG = '/Users/zhengyang/.dsh/sessions/--Users-zhengyang-DSH--/session-84e82984-1579-40f7-805b-561306d3f9b6/session.v4.jsonl.zstd'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const target = process.argv[2] ?? DEFAULT_LOG
const here = path.dirname(fileURLToPath(import.meta.url))

function readFrames(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  for (let at = buf.indexOf(MAGIC); at >= 0; at = buf.indexOf(MAGIC, at + 4)) starts.push(at)
  const chunks = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    chunks.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8'))
  }
  return chunks.join('')
}

/** 裁剪文本块，夹具只保留「形状」。 */
function trimEvent(event, { textLimit = 120, reasoningLimit = 80 } = {}) {
  const copy = structuredClone(event)
  const blocks = copy.type === 'user/message'
    ? copy.data?.content
    : copy.data?.message?.content
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (typeof block.text !== 'string') continue
      const limit = block.type === 'reasoning' ? reasoningLimit : textLimit
      if (block.text.length > limit) block.text = `${block.text.slice(0, limit)}…[trimmed]`
    }
  }
  if (Array.isArray(copy.data?.stream)) copy.data.stream = copy.data.stream.slice(0, 2)
  // 注入上下文的 source 里带着整份技能目录 / 上下文段落，夹具只留形状
  const source = copy.data?.source
  if (Array.isArray(source?.entries)) source.entries = source.entries.slice(0, 1)
  if (Array.isArray(source?.sections)) {
    source.sections = source.sections.slice(0, 2).map((section) => ({
      ...section,
      ...(typeof section.text === 'string' && section.text.length > 80
        ? { text: `${section.text.slice(0, 80)}…[trimmed]` }
        : {}),
    }))
  }
  return copy
}

const text = readFrames(target)
const events = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))

const taken = []
const take = (name, predicate, notes) => {
  const found = events.find((event) => predicate(event) && !taken.some((item) => item.event === event))
  if (found === undefined) {
    console.warn(`skip ${name}: not found`)
    return
  }
  taken.push({ name, notes, event: trimEvent(found) })
}

const userMessages = events.filter((event) => event.type === 'user/message')
take('human-user-message', (event) => event.type === 'user/message' && event.data?.source?.kind === 'user',
  '真人输入；source.kind === "user"，必须保留')
for (const kind of ['runtime-context', 'skill-catalog', 'time-context', 'dsh-mnemon']) {
  take(`injected-${kind}`, (event) => event.type === 'user/message' && event.data?.source?.kind === kind,
    `注入上下文（source.kind === "${kind}"），必须排除`)
}
take('assistant-reasoning-tool-call', (event) => event.type === 'assistant/message'
  && event.data?.message?.content?.some((block) => block.type === 'reasoning')
  && event.data?.message?.content?.some((block) => block.type === 'tool-call')
  && !event.data?.message?.content?.some((block) => block.type === 'text'),
  '真实助手消息：reasoning + tool-call，没有 text —— 抽取后应被丢弃但计入统计')
take('turn-start', (event) => event.type === 'turn/start', '')
take('step-start', (event) => event.type === 'step/start', '')
take('tool-result', (event) => event.type === 'tool/result', 'tool/result 只用于统计，不进对话')
take('session-title', (event) => event.type === 'session/title', '会话标题事件')

if (userMessages.length === 0) console.warn('no user/message in log')

const out = {
  meta: {
    note: '从本机真实会话日志裁剪的事件样本；只保留结构形状，文本已截断',
    source: path.basename(target),

    eventTypeCount: new Set(events.map((event) => event.type)).size,
  },
  samples: taken,
}
fs.writeFileSync(path.join(here, 'real-events.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log(`wrote fixtures/real-events.json (${taken.length} samples)`)
