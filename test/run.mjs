/**
 * dsh-session-forward · 纯逻辑单元测试
 *
 * 跑法（本机没有 node in PATH，用 DSH 自带的 Electron 内置 node v24）：
 *
 *   cd dsh-session-forward
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/run.mjs
 *
 * 覆盖 lib/transcript.js 的 6 组纯函数，外加：
 *   - 真实会话日志里裁下来的事件夹具（test/fixtures/real-events.json）
 *   - 用宿主真实的 @deepseek-ai/dsh-session 校验合成事件（拿不到宿主时跳过）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness } from './harness.mjs'
import * as T from '../lib/transcript.js'
import { contractAvailable, contractEntryPath, loadSessionContract, makeHeader, toEnvelope } from './contract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'real-events.json'), 'utf8'))
const h = createHarness()

/** 取一条真实事件夹具（深拷贝，避免测试改到夹具本体）。 */
function sample(name) {
  const found = fixtures.samples.find((item) => item.name === name)
  if (found === undefined) throw new Error(`夹具缺失：${name}`)
  return structuredClone(found.event)
}

const NOW = 1_730_000_000_000

const EMPTY_STATS = {
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  toolResults: 0,
  reasoning: 0,
  images: 0,
  files: 0,
  truncated: 0,
}

const human = (text, extra = {}) => ({
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: `u-${text.slice(0, 4)}`, ...extra },
})
const injected = (kind, text = 'injected') => ({
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind }, id: `i-${kind}` },
})
const assistant = (blocks, extra = {}) => ({
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' }, id: 'a-1' },
    stream: [],
    ...extra,
  },
})
const textBlock = (text) => ({ type: 'text', text })

// ---------------------------------------------------------------------------
// 1. extractTranscript
// ---------------------------------------------------------------------------
h.group('1. extractTranscript')

{
  const empty = T.extractTranscript([])
  h.deepEq(empty, { messages: [], stats: EMPTY_STATS, skipped: 0 }, 'extractTranscript([]) 返回空对话与零统计')
}

for (const bad of [undefined, null, {}, 'events', 42, true]) {
  const result = h.noThrow(() => T.extractTranscript(bad), `extractTranscript(${String(bad)}) 不抛错`)
  h.deepEq(result, { messages: [], stats: EMPTY_STATS, skipped: 0 }, `extractTranscript(${String(bad)}) 退化为空结果`)
}

{
  const result = h.noThrow(
    () => T.extractTranscript([null, 42, 'x', {}, { type: null }, { type: 'user/message' }, { type: 'assistant/message' }, { type: 'user/message', data: null }]),
    'extractTranscript 对 null/原始值/缺 data 的事件不抛错',
  )
  h.eq(result?.messages.length, 0, '脏事件全部被跳过，不产生消息')
  h.eq(result?.stats.toolResults, 0, '脏事件不影响统计')
}

{
  // 真人消息保留；注入上下文 / 技能目录 / 时间上下文 / mnemon 记忆一律排除
  const events = [
    sample('human-user-message'),
    sample('injected-runtime-context'),
    sample('injected-skill-catalog'),
    sample('injected-time-context'),
    sample('injected-dsh-mnemon'),
  ]
  const result = T.extractTranscript(events)
  h.eq(result.messages.length, 1, '真实夹具：5 条 user/message 里只保留 1 条真人输入')
  h.eq(result.messages[0]?.role, 'user', '保留下来的是 user 角色')
  h.match(result.messages[0]?.text, /^做一个插件/, '保留下来的文本是真人原话')
  h.eq(result.skipped, 4, '4 条注入上下文计入 skipped')
  h.eq(result.stats.userMessages, 1, 'userMessages 只统计真人消息')
}

{
  const result = T.extractTranscript([
    human('@lead 你好'),
    injected('compact-checkpoint', '压缩检查点'),
    injected('skill-catalog', '技能目录'),
    { type: 'user/message', data: { role: 'user', content: [textBlock('没有 source')] } },
    { type: 'user/message', data: { role: 'user', content: [textBlock('source 是别的类型')], source: { kind: 'assistant' } } },
  ])
  h.eq(result.messages.length, 1, 'compact-checkpoint / 缺 source / 非 user kind 全部排除')
  h.eq(result.skipped, 4, '被排除的 4 条 user/message 都计入 skipped')
}

{
  const result = T.extractTranscript([
    { type: 'user/message', data: { role: 'user', content: '不是数组', source: { kind: 'user' } } },
    { type: 'user/message', data: { role: 'user', content: [textBlock('   ')], source: { kind: 'user' } } },
    { type: 'user/message', data: { role: 'user', content: [textBlock('')], source: { kind: 'user' } } },
  ])
  h.eq(result.messages.length, 0, '空文本 / 纯空白 / 非数组 content 都不产生消息')
  h.eq(result.skipped, 0, '这类丢弃不计入 skipped（skipped 只表示「不是人发的」）')
}

{
  const result = T.extractTranscript([
    assistant([
      { type: 'reasoning', text: '先想一下' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
      textBlock('这是答案'),
      { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
    ]),
  ])
  h.eq(result.messages.length, 1, 'reasoning + tool-call + text 混合时保留一条助手消息')
  h.eq(result.messages[0]?.text, '这是答案', '只保留 text 块，reasoning/tool-call 不拼进正文')
  h.eq(result.stats.reasoning, 1, 'reasoning 块计入 omitted 统计')
  h.eq(result.stats.toolCalls, 2, '两个 tool-call 块计入 omitted 统计')
  h.eq(result.stats.assistantMessages, 1, 'assistantMessages 统计正确')
}

{
  // 真实会话日志里的助手消息：只有 reasoning + tool-call，没有 text
  const result = T.extractTranscript([sample('assistant-reasoning-tool-call')])
  h.eq(result.messages.length, 0, '真实夹具：只有 reasoning/tool-call 的助手消息不产生正文')
  h.eq(result.stats.reasoning, 1, '仍然统计到 1 个 reasoning 块')
  h.eq(result.stats.toolCalls, 2, '仍然统计到 2 个 tool-call 块')
  h.eq(result.stats.assistantMessages, 0, '没有 text 就不算一条助手消息')
}

{
  const result = T.extractTranscript([
    assistant([
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
      { type: 'file', attachment: { attachmentId: 'f1', name: 'x.pdf', bytes: 10 } },
      textBlock('看了图片'),
    ]),
  ])
  h.eq(result.stats.images, 1, 'image 块计入 omitted')
  h.eq(result.stats.files, 1, 'file 块计入 omitted')
  h.eq(result.messages[0]?.text, '看了图片', '图片/文件不影响正文')
}

{
  const result = T.extractTranscript([assistant([textBlock('第一段'), textBlock('第二段')])])
  h.eq(result.messages[0]?.text, '第一段\n第二段', '多个 text 块用换行拼接')
}

{
  const result = T.extractTranscript([
    sample('tool-result'),
    sample('tool-result'),
    human('问题'),
  ])
  h.eq(result.messages.length, 1, 'tool/result 不进对话')
  h.eq(result.stats.toolResults, 2, 'tool/result 计入 toolResults 统计')
}

{
  const result = T.extractTranscript([
    { ...human('带时间'), time: 1730000000123 },
    { ...human('没时间') },
    { ...human('时间是字符串'), time: '123' },
    { ...human('时间是 NaN'), time: Number.NaN },
    { ...human('时间是 Infinity'), time: Number.POSITIVE_INFINITY },
    { ...human('时间是 null'), time: null },
  ])
  h.eq(result.messages[0]?.time, 1730000000123, 'event.time 为有限数字时透传')
  h.eq(result.messages[1]?.time, 0, '缺 time 时补 0')
  h.eq(result.messages[2]?.time, 0, 'time 不是数字时补 0')
  h.eq(result.messages[3]?.time, 0, 'time 是 NaN 时补 0（Number.isFinite 判定）')
  h.eq(result.messages[4]?.time, 0, 'time 是 Infinity 时补 0')
  h.eq(result.messages[5]?.time, 0, 'time 是 null 时补 0')
}

{
  const long = 'a'.repeat(T.MAX_MESSAGE_CHARS + 1)
  const result = T.extractTranscript([human(long)])
  h.eq(result.messages[0]?.text.length, T.MAX_MESSAGE_CHARS, `超过 ${T.MAX_MESSAGE_CHARS} 字符被截断到上限`)
  h.eq(result.stats.truncated, 1, '截断计入 stats.truncated')

  const exact = T.extractTranscript([human('b'.repeat(T.MAX_MESSAGE_CHARS))])
  h.eq(exact.stats.truncated, 0, '刚好等于上限不标记截断')
  h.eq(exact.messages[0]?.text.length, T.MAX_MESSAGE_CHARS, '刚好等于上限时长度不变')
}

{
  const result = T.extractTranscript([human('第一句'), assistant([textBlock('回答')]), human('第二句')])
  h.deepEq(result.messages.map((message) => message.role), ['user', 'assistant', 'user'], '多轮对话顺序与角色正确')
}

{
  const many = Array.from({ length: T.MAX_MESSAGES + 2 }, (_value, index) => human(`m${index}`))
  const result = T.extractTranscript(many)
  h.eq(result.messages.length, T.MAX_MESSAGES, `消息条数正好截断在 MAX_MESSAGES=${T.MAX_MESSAGES}`)
  h.eq(result.messages.at(-1)?.text, `m${T.MAX_MESSAGES - 1}`, '保留的是前 N 条，按原顺序')

  // 导出的上限必须和导出的校验上限一致，否则「导出→导入」会在自己手里失败
  const bundle = T.buildBundle({ messages: result.messages, stats: result.stats, now: NOW })
  h.eq(bundle.messages.length, T.MAX_MESSAGES, 'buildBundle 也不超过 MAX_MESSAGES')
  const roundTrip = T.validateBundle(JSON.parse(JSON.stringify(bundle)))
  h.eq(roundTrip.ok, true, `导出的 ${T.MAX_MESSAGES} 条消息能被 validateBundle 接受（上限一致）`)
}

// ---------------------------------------------------------------------------
// 2. buildBundle
// ---------------------------------------------------------------------------
h.group('2. buildBundle')

{
  const bundle = T.buildBundle({
    messages: [
      { role: 'user', text: '你好', time: 1 },
      { role: 'assistant', text: '在的', time: 2 },
    ],
    stats: { toolCalls: 3, toolResults: 2, reasoning: 4, images: 5, files: 6, truncated: 1 },
    session: { id: 'sid-1', title: '手写标题', cwd: '/Users/x/proj', createdAt: 123, provider: 'magpie', model: 'volcengine/x' },
    app: { version: '0.4.2' },
    now: NOW,
  })
  h.eq(bundle.format, T.BUNDLE_FORMAT, 'format 使用 BUNDLE_FORMAT')
  h.eq(bundle.version, T.BUNDLE_VERSION, 'version 使用 BUNDLE_VERSION')
  h.eq(bundle.exportedAt, NOW, 'exportedAt 使用传入的 now')
  h.eq(bundle.exportedAtIso, new Date(NOW).toISOString(), 'exportedAtIso 由 now 派生')
  h.eq(bundle.app?.name, 'DeepSeek Harness', 'app.name 固定为 DeepSeek Harness')
  h.eq(bundle.app?.version, '0.4.2', 'app.version 透传')
  h.eq(bundle.session?.id, 'sid-1', 'session.id 透传')
  h.eq(bundle.session?.title, '手写标题', 'session.title 透传')
  h.eq(bundle.session?.cwd, '/Users/x/proj', 'session.cwd 透传')
  h.eq(bundle.session?.createdAt, 123, 'session.createdAt 透传')
  h.eq(bundle.session?.provider, 'magpie', 'session.provider 透传')
  h.eq(bundle.session?.model, 'volcengine/x', 'session.model 透传')
  h.eq(bundle.session?.messageCount, 2, 'messageCount 等于消息条数')
  h.eq(bundle.session?.userMessages, 1, 'userMessages 按角色统计')
  h.eq(bundle.session?.assistantMessages, 1, 'assistantMessages 按角色统计')
  h.deepEq(bundle.session?.omitted, { toolCalls: 3, toolResults: 2, reasoning: 4, images: 5, files: 6, truncated: 1 }, 'omitted 统计原样写入')
  h.eq(bundle.messages.length, 2, 'messages 原样带上')
}

{
  const bundle = T.buildBundle({ messages: [{ role: 'user', text: '第一句用户提问内容会比较长需要被截断成四十个字符以内吧', time: 0 }], now: NOW })
  h.match(bundle.session?.title, /^第一句用户提问内容/, '没有标题时用第一条用户消息当标题')
  h.ok((bundle.session?.title?.length ?? 0) <= 41, '自动标题不超过 41 个字符（40 + 省略号）')
  h.eq(bundle.session?.id, undefined, '没有 session.id 时字段为 undefined（JSON 序列化后消失）')
  h.eq(bundle.session?.provider, undefined, '没有 provider 时字段为 undefined')
  h.eq(bundle.session?.model, undefined, '没有 model 时字段为 undefined')
  h.eq(bundle.session?.createdAt, undefined, '没有 createdAt 时字段为 undefined')
  h.deepEq(bundle.session?.omitted, { toolCalls: 0, toolResults: 0, reasoning: 0, images: 0, files: 0, truncated: 0 }, '缺 stats 时 omitted 全 0')
}

{
  const bundle = T.buildBundle({ messages: [{ role: 'assistant', text: '只有助手' }], now: NOW })
  h.eq(bundle.session?.title, '转发的会话', '没有用户消息时用兜底标题')
}

{
  const bundle = T.buildBundle({ messages: [{ role: 'user', text: 'a\n\n   b' }], session: { title: '   ' }, now: NOW })
  h.eq(bundle.session?.title, 'a b', '标题为纯空白时回退到首条用户消息，并压缩空白')
}

{
  const bundle = T.buildBundle({ messages: 'not-an-array', now: NOW })
  h.deepEq(bundle.messages, [], 'messages 不是数组时退化为空数组')
  h.eq(bundle.session?.messageCount, 0, '退化后 messageCount 为 0')
}

{
  // 防御性入口：脏数组不能把 buildBundle 弄崩
  const dirty = h.noThrow(
    () => T.buildBundle({
      messages: [null, 42, 'x', { role: 'system', text: 'x' }, { role: 'user' }, { role: 'user', text: '   ' },
        { role: 'user', text: '好问题' }, { role: 'assistant', text: '好回答' }],
      now: NOW,
    }),
    'buildBundle 收到含 null / 非法 role / 非字符串 text 的脏数组时不抛错',
  )
  h.eq(dirty?.messages.length, 2, '脏数组里只有形状正确的两条消息被保留')
  h.deepEq(dirty?.messages.map((message) => message.role), ['user', 'assistant'], '保留的消息角色正确')
  h.eq(dirty?.session?.messageCount, 2, 'messageCount 只统计保留下来的消息')

  const long = T.buildBundle({ messages: [{ role: 'user', text: 'a'.repeat(T.MAX_MESSAGE_CHARS + 5) }], now: NOW })
  h.eq(long.messages[0]?.text.length, T.MAX_MESSAGE_CHARS, 'buildBundle 也把超长文本截断到上限')
  h.eq(long.messages[0]?.truncated, true, 'buildBundle 截断时打上 truncated 标记')

  const huge = T.buildBundle({
    messages: Array.from({ length: T.MAX_MESSAGES + 10 }, (_value, index) => ({ role: 'user', text: `m${index}` })),
    now: NOW,
  })
  h.eq(huge.messages.length, T.MAX_MESSAGES, 'buildBundle 把消息条数截断在 MAX_MESSAGES')

  const droppedInterrupted = T.buildBundle({ messages: [{ role: 'assistant', text: 'x', interrupted: true }], now: NOW })
  h.eq(droppedInterrupted.messages[0]?.interrupted, undefined, 'buildBundle 规范化时丢掉 unknown 字段（如 interrupted）')
}

// ---------------------------------------------------------------------------
// 3. bundleToMarkdown
// ---------------------------------------------------------------------------
h.group('3. bundleToMarkdown')

{
  const bundle = T.buildBundle({
    messages: [
      { role: 'user', text: '你好', time: 1 },
      { role: 'assistant', text: '在的', time: 2 },
    ],
    session: { title: '一次对话', cwd: '/Users/x/proj' },
    now: NOW,
  })
  const markdown = T.bundleToMarkdown(bundle)
  h.match(markdown, /^# 一次对话\n/, 'Markdown 以一级标题开头')
  h.match(markdown, /> 转发自 DSH · 20\d\d-\d\d-\d\d \d\d:\d\d/, '包含「转发自 DSH + 时间」的引用行')
  h.match(markdown, /\/Users\/x\/proj/, '引用行带上工作目录')
  h.match(markdown, /\*\*我\*\*\n\n你好/, '用户消息用「我」标注')
  h.match(markdown, /\*\*助手\*\*\n\n在的/, '助手消息用「助手」标注')
  h.ok(markdown.indexOf('你好') < markdown.indexOf('在的'), '消息按原顺序输出')
}

{
  const markdown = h.noThrow(() => T.bundleToMarkdown({}), 'bundleToMarkdown({}) 不抛错')
  h.match(markdown, /^# 转发的会话/, '缺标题时用兜底标题')
  h.eq(typeof markdown, 'string', '始终返回字符串')
}

{
  const markdown = T.bundleToMarkdown({
    exportedAt: NOW,
    session: { title: '无 ISO 时间' },
    messages: [{ role: 'user', text: 'x' }],
  })
  h.match(markdown, new RegExp(new Date(NOW).toISOString().slice(0, 10)), '缺 exportedAtIso 时由 exportedAt 回退生成时间')
}

// ---------------------------------------------------------------------------
// 4. suggestFileName
// ---------------------------------------------------------------------------
h.group('4. suggestFileName')

{
  h.eq(T.suggestFileName('我的会话'), '我的会话.dshchat.json', '中文标题原样保留')
  h.eq(T.suggestFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j.dshchat.json', '路径分隔符与 Windows 非法字符换成空格')
  h.eq(T.suggestFileName('换行\n标题\r带\t制表'), '换行 标题 带 制表.dshchat.json', '换行/回车/制表符换成空格')
  h.eq(T.suggestFileName('控制\u0000字符\u001f'), '控制 字符.dshchat.json', 'C0 控制字符被清掉')
  h.eq(T.suggestFileName(''), 'dsh-session.dshchat.json', '空标题用兜底文件名')
  h.eq(T.suggestFileName('   '), 'dsh-session.dshchat.json', '纯空白标题用兜底文件名')
  h.eq(T.suggestFileName(null), 'dsh-session.dshchat.json', 'null 标题用兜底文件名')
  h.eq(T.suggestFileName(undefined), 'dsh-session.dshchat.json', 'undefined 标题用兜底文件名')
  h.eq(T.suggestFileName(42), 'dsh-session.dshchat.json', '非字符串标题用兜底文件名')
  h.eq(T.suggestFileName('...'), 'dsh-session.dshchat.json', '纯点号标题回退成兜底文件名（结尾的点会被 Windows 吃掉）')
  h.eq(T.suggestFileName('..'), 'dsh-session.dshchat.json', '两个点（上级目录）回退成兜底文件名')
  h.eq(T.suggestFileName('a. . .'), 'a.dshchat.json', '标题结尾的点与空格被剥掉')
}

{
  const name = T.suggestFileName('很长的标题'.repeat(30))
  const base = name.slice(0, -'.dshchat.json'.length)
  h.ok(base.length <= 60, `超长标题被截到 60 字符以内（实际 ${base.length}）`)
  h.ok(name.endsWith('.dshchat.json'), '始终以 .dshchat.json 结尾')
  h.ok(!/[\\/:*?"<>|]/.test(name), '结果里没有非法字符')
}

{
  // 60 字符截断之后再剥掉结尾的点/空格，避免出现「空格紧贴扩展名」的文件名
  const tricky = `${'a'.repeat(59)} ${'b'.repeat(10)}`
  const name = T.suggestFileName(tricky)
  h.ok(name.endsWith('.dshchat.json'), '边界标题仍然得到正确扩展名')
  h.ok(name === `${'a'.repeat(59)}.dshchat.json`, '截断后结尾的空格被剥掉', name)
  h.ok(!/ \.dshchat\.json$/.test(name), '文件名不会以空格紧贴扩展名')
}

// ---------------------------------------------------------------------------
// 5. validateBundle
// ---------------------------------------------------------------------------
h.group('5. validateBundle')

const goodBundle = T.buildBundle({
  messages: [
    { role: 'user', text: '你好', time: 1 },
    { role: 'assistant', text: '在的', time: 2 },
  ],
  session: { id: 'sid', title: '标题', cwd: '/tmp', createdAt: 5, provider: 'p', model: 'm' },
  now: NOW,
})

function failCase(label, value, pattern) {
  const result = h.noThrow(() => T.validateBundle(value), `validateBundle 收到${label}时不抛错`)
  h.eq(result?.ok, false, `validateBundle 拒绝${label}`)
  h.eq(typeof result?.error, 'string', `拒绝${label}时给出可读错误字符串`)
  h.ok((result?.error?.length ?? 0) > 0, `拒绝${label}时错误信息非空`)
  if (pattern !== undefined) h.match(result?.error, pattern, `拒绝${label}时的错误信息可读`)
  h.eq(result?.bundle, undefined, `拒绝${label}时不返回 bundle`)
  return result
}

{
  const result = h.noThrow(() => T.validateBundle(goodBundle), 'validateBundle 接受合法 bundle 不抛错')
  h.eq(result?.ok, true, '合法 bundle 通过校验')
  h.eq(result?.bundle?.format, T.BUNDLE_FORMAT, '规范化后 format 正确')
  h.eq(result?.bundle?.version, T.BUNDLE_VERSION, '规范化后 version 正确')
  h.eq(result?.bundle?.messages.length, 2, '规范化后保留两条消息')
  h.eq(result?.bundle?.session?.messageCount, 2, '规范化后 messageCount 重新计算')
  h.deepEq(result?.bundle?.messages?.[0], { role: 'user', text: '你好', time: 1 }, '消息被规范化成 {role,text,time}')
}

{
  const tripped = JSON.parse(JSON.stringify(goodBundle))
  const result = h.noThrow(() => T.validateBundle(tripped), 'validateBundle 处理 JSON 往返后的 bundle 不抛错')
  h.eq(result?.ok, true, 'JSON.parse(JSON.stringify(bundle)) 往返后仍然通过校验')
  h.eq(result?.bundle?.session?.messageCount, 2, '往返后 messageCount 仍然正确')
  h.eq(result?.bundle?.exportedAt, NOW, '往返后 exportedAt 仍然正确')
  h.deepEq(result?.bundle?.messages, tripped.messages, '往返后消息内容不变')
}

failCase('null', null, /不是一个转发对象/)
failCase('undefined', undefined, /不是一个转发对象/)
failCase('数组', [], /不是一个转发对象/)
failCase('字符串', 'bundle', /不是一个转发对象/)
failCase('数字', 42, /不是一个转发对象/)
failCase('缺 format', { version: 1, messages: [] }, /不是 DSH 会话转发文件/)
failCase('format 错误', { format: 'other', version: 1, messages: [] }, /不是 DSH 会话转发文件/)
failCase('缺 version', { format: T.BUNDLE_FORMAT, messages: [] }, /文件版本号非法/)
failCase('version=0', { format: T.BUNDLE_FORMAT, version: 0, messages: [] }, /文件版本号非法/)
failCase('version=-1', { format: T.BUNDLE_FORMAT, version: -1, messages: [] }, /文件版本号非法/)
failCase('version=1.5', { format: T.BUNDLE_FORMAT, version: 1.5, messages: [] }, /文件版本号非法/)
failCase('version="1"', { format: T.BUNDLE_FORMAT, version: '1', messages: [] }, /文件版本号非法/)
failCase('未来版本', { format: T.BUNDLE_FORMAT, version: T.BUNDLE_VERSION + 1, messages: [{ role: 'user', text: 'x' }] }, /更新，请升级插件/)
failCase('缺 messages', { format: T.BUNDLE_FORMAT, version: 1 }, /缺少 messages 数组/)
failCase('messages 非数组', { format: T.BUNDLE_FORMAT, version: 1, messages: {} }, /缺少 messages 数组/)
failCase('messages 为空', { format: T.BUNDLE_FORMAT, version: 1, messages: [] }, /没有任何消息/)
failCase('消息不是对象', { format: T.BUNDLE_FORMAT, version: 1, messages: [null] }, /第 1 条消息格式非法/)
failCase('角色非法', { format: T.BUNDLE_FORMAT, version: 1, messages: [{ role: 'system', text: 'x' }] }, /第 1 条消息角色非法/)
failCase('角色缺失', { format: T.BUNDLE_FORMAT, version: 1, messages: [{ text: 'x' }] }, /第 1 条消息角色非法/)
failCase('文本非字符串', { format: T.BUNDLE_FORMAT, version: 1, messages: [{ role: 'user', text: 42 }] }, /第 1 条消息缺少文本/)
failCase('全是空文本', { format: T.BUNDLE_FORMAT, version: 1, messages: [{ role: 'user', text: '  ' }, { role: 'assistant', text: '' }] }, /所有消息都是空的/)

{
  const tooMany = {
    format: T.BUNDLE_FORMAT,
    version: 1,
    messages: Array.from({ length: T.MAX_MESSAGES + 1 }, () => ({ role: 'user', text: 'x' })),
  }
  failCase('消息条数超上限', tooMany, /超过上限/)
}

{
  const result = T.validateBundle({
    format: T.BUNDLE_FORMAT,
    version: 1,
    messages: [{ role: 'user', text: '  ' }, { role: 'user', text: '有效' }, { role: 'assistant', text: '回复' }],
    session: { messageCount: 99, provider: '', model: 'm' },
    exportedAt: 'not-a-number',
  })
  h.eq(result?.ok, true, '部分空文本的 bundle 仍然通过')
  h.eq(result?.bundle?.messages.length, 2, '空文本消息被跳过')
  h.eq(result?.bundle?.session?.messageCount, 2, 'messageCount 重新计算，不信任输入值')
  h.eq(result?.bundle?.session?.provider, undefined, '空字符串 provider 规范化为 undefined')
  h.eq(result?.bundle?.session?.model, 'm', 'model 保留')
  h.ok(Number.isFinite(result?.bundle?.exportedAt), 'exportedAt 非数字时补一个有限数')
  h.match(result?.bundle?.exportedAtIso, /^\d{4}-\d{2}-\d{2}T/, 'exportedAtIso 被规范成 ISO 字符串')
}

{
  const long = { format: T.BUNDLE_FORMAT, version: 1, messages: [{ role: 'user', text: 'z'.repeat(T.MAX_MESSAGE_CHARS + 10) }] }
  const result = T.validateBundle(long)
  h.eq(result?.bundle?.messages[0]?.text.length, T.MAX_MESSAGE_CHARS, '导入时同样截断超长消息')
  h.eq(result?.bundle?.messages[0]?.truncated, true, '截断的导入消息打上 truncated 标记')
  h.eq(result?.bundle?.messages[0]?.time, 0, '缺 time 时补 0')
}

{
  const result = T.validateBundle({
    format: T.BUNDLE_FORMAT,
    version: 1,
    messages: [{ role: 'assistant', text: '被中断的回复', interrupted: true }],
  })
  h.eq(result?.ok, true, '带 interrupted 标记的消息仍然通过校验')
  h.eq(result?.bundle?.messages?.[0]?.interrupted, undefined, 'validateBundle 规范化时丢掉 unknown 字段（interrupted 由 buildSessionEvents 不再支持）')
}

// ---------------------------------------------------------------------------
// 6. buildSessionEvents
// ---------------------------------------------------------------------------
h.group('6. buildSessionEvents')

const KNOWN_EVENT_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message',
  'tool/result', 'system/message', 'developer/message', 'request/header', 'request/context',
])

function counterIds() {
  let n = 0
  const factory = (prefix) => {
    n += 1
    return `${prefix}-${n}`
  }
  factory.count = () => n
  return factory
}

{
  const bundle = T.validateBundle(goodBundle).bundle
  const ids = counterIds()
  const events = T.buildSessionEvents(bundle, { idFactory: ids })
  h.deepEq(
    events.map((event) => event.type),
    ['turn/start', 'step/start', 'user/message', 'step/end', 'step/start', 'assistant/message', 'step/end', 'turn/end'],
    '一问一答的事件序列完全符合预期',
  )
  h.eq(events[0]?.data?.turn, 1, 'turn 从 1 开始')
  h.eq(events[1]?.data?.step, 1, 'step 从 1 开始')
  h.eq(events[1]?.data?.turn, 1, 'step/start 带 turn')
  h.eq(events[3]?.data?.step, 1, 'step/end 与 step/start 的 step 一致')
  h.eq(events[4]?.data?.step, 2, '同一 turn 内下一个 step 递增')
  h.eq(events.at(-1)?.data?.reason?.kind, 'completed', 'turn/end 的 reason 是 completed')
  h.eq(events.filter((event) => event.type === 'turn/start').length, 1, '只有一个 turn/start')
  h.eq(events.filter((event) => event.type === 'turn/end').length, 1, '只有一个 turn/end')
}

{
  const bundle = T.validateBundle(goodBundle).bundle
  const events = T.buildSessionEvents(bundle, { idFactory: counterIds() })
  const surfaceTypes = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'])
  for (const event of events) {
    if (surfaceTypes.has(event.type)) h.eq(event.surfaceOp, 'append', `${event.type} 必须带 surfaceOp:'append'`)
    else h.eq(Object.hasOwn(event, 'surfaceOp'), false, `${event.type} 不能带 surfaceOp`)
  }
  const userEvent = events.find((event) => event.type === 'user/message')
  h.eq(userEvent?.data?.role, 'user', 'user/message 的 role 是 user')
  h.deepEq(userEvent?.data?.source, { kind: 'user' }, 'user/message 的 source.kind 是 user')
  h.eq(typeof userEvent?.data?.id, 'string', 'user/message 有字符串 id')
  h.ok(userEvent?.data?.id !== '', 'user/message 的 id 非空')
  h.deepEq(userEvent?.data?.content, [{ type: 'text', text: '你好' }], 'user/message 的正文是单个 text 块')

  const assistantEvent = events.find((event) => event.type === 'assistant/message')
  h.eq(assistantEvent?.data?.turn, 1, 'assistant/message 带 turn')
  h.eq(assistantEvent?.data?.step, 2, 'assistant/message 的 step 与所在 step 一致')
  h.eq(assistantEvent?.data?.message?.role, 'assistant', 'assistant message 的 role 是 assistant')
  h.deepEq(assistantEvent?.data?.message?.content, [{ type: 'text', text: '在的' }], 'assistant message 的正文是单个 text 块')
  h.eq(assistantEvent?.data?.message?.source?.kind, 'model', 'assistant message 的 source.kind 是 model')
  h.eq(typeof assistantEvent?.data?.message?.source?.provider, 'string', 'assistant message 带 provider')
  h.eq(typeof assistantEvent?.data?.message?.source?.model, 'string', 'assistant message 带 model')
  h.eq(typeof assistantEvent?.data?.message?.id, 'string', 'assistant message 带 id')
  h.ok(Array.isArray(assistantEvent?.data?.stream), 'assistant/message 的 stream 是数组')
}

{
  const bundle = T.validateBundle(goodBundle).bundle
  const ids = counterIds()
  const events = T.buildSessionEvents(bundle, { idFactory: ids })
  const allIds = events
    .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    .map((event) => (event.type === 'user/message' ? event.data.id : event.data.message.id))
  h.eq(allIds.length, 2, '两条消息各有一个 id')
  h.eq(new Set(allIds).size, allIds.length, 'id 互不相同')
  h.eq(ids.count(), 2, 'idFactory 只对消息调用')
  h.ok(allIds.every((id) => /^message-\d+$/.test(id ?? '')), 'idFactory 收到的前缀是 message')
}

{
  const bundle = T.validateBundle(goodBundle).bundle
  const events = T.buildSessionEvents(bundle)
  const allIds = events
    .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    .map((event) => (event.type === 'user/message' ? event.data.id : event.data.message.id))
  h.ok(allIds.every((id) => typeof id === 'string' && id.length > 0), '默认 idFactory 产出非空字符串')
  h.eq(new Set(allIds).size, allIds.length, '默认 idFactory 产出唯一 id')
}

{
  // 连续两条 user 消息 → 两个 turn；第一个 turn 没有 assistant
  const bundle = { version: 1, session: {}, messages: [
    { role: 'user', text: '第一问' },
    { role: 'user', text: '第二问' },
  ] }
  const events = T.buildSessionEvents(bundle, { idFactory: counterIds() })
  const turnStarts = events.filter((event) => event.type === 'turn/start')
  h.eq(turnStarts.length, 2, '连续两条 user 消息产生两个 turn/start')
  h.deepEq(turnStarts.map((event) => event.data.turn), [1, 2], 'turn 序号从 1 递增到 2')
  h.eq(events.filter((event) => event.type === 'user/message').length, 2, '两条 user 消息都写进事件流')
  h.eq(events.filter((event) => event.type === 'assistant/message').length, 0, '没有 assistant 消息')
  // 每个 turn 都以 turn/end 收尾
  const firstEnd = events.findIndex((event) => event.type === 'turn/end')
  h.ok(firstEnd > 0 && events[firstEnd]?.data?.turn === 1, '第一个 turn 在第二条 user 消息之前结束')
  h.eq(events.at(-1)?.type, 'turn/end', '事件流以 turn/end 结束')
}

{
  // 首条就是 assistant → 仍然生成合法 turn，没有 user 步骤
  const bundle = { version: 1, session: {}, messages: [
    { role: 'assistant', text: '我先说' },
    { role: 'user', text: '然后你说' },
  ] }
  const events = T.buildSessionEvents(bundle, { idFactory: counterIds() })
  h.eq(events[0]?.type, 'turn/start', '首条 assistant 也先开 turn')
  h.eq(events[0]?.data?.turn, 1, '首条 assistant 落在 turn 1')
  h.eq(events.filter((event) => event.type === 'user/message').length, 1, '只有一个 user/message')
  const firstAssistantIndex = events.findIndex((event) => event.type === 'assistant/message')
  const firstUserIndex = events.findIndex((event) => event.type === 'user/message')
  h.ok(firstAssistantIndex >= 0 && firstAssistantIndex < firstUserIndex, '首条 assistant 消息出现在 first turn 里')
  h.eq(events.findIndex((event) => event.type === 'step/start'), firstAssistantIndex - 1, 'assistant 前面紧跟 step/start')
  h.eq(events[firstAssistantIndex]?.data?.step, 1, '没有 user 步骤时 assistant 从 step 1 开始')
  h.eq(events.filter((event) => event.type === 'turn/start').length, 2, '后面的 user 消息另开一个 turn')
}

{
  // 同一 turn 内多段 assistant → step 递增
  const bundle = { version: 1, session: {}, messages: [
    { role: 'user', text: '问' },
    { role: 'assistant', text: '答一' },
    { role: 'assistant', text: '答二' },
    { role: 'assistant', text: '答三' },
  ] }
  const events = T.buildSessionEvents(bundle, { idFactory: counterIds() })
  const steps = events.filter((event) => event.type === 'step/start').map((event) => event.data.step)
  h.deepEq(steps, [1, 2, 3, 4], '同一个 turn 内 step 依次递增（user 占 1，assistant 从 2 开始）')
  const assistantSteps = events.filter((event) => event.type === 'assistant/message').map((event) => event.data.step)
  h.deepEq(assistantSteps, [2, 3, 4], '三段 assistant 分别落在 step 2/3/4')
  h.eq(events.filter((event) => event.type === 'turn/start').length, 1, '同一 turn 内不会重复开 turn')
  const stepEnds = events.filter((event) => event.type === 'step/end').map((event) => event.data.step)
  h.deepEq(stepEnds, steps, 'step/end 与 step/start 一一对应')
}

{
  // 没有会话级模型信息时用 fallbackModel
  const bundle = { version: 1, session: {}, messages: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }] }
  const events = T.buildSessionEvents(bundle, { fallbackModel: { provider: 'my-provider', model: 'my-model' }, idFactory: counterIds() })
  const source = events.find((event) => event.type === 'assistant/message')?.data?.message?.source
  h.deepEq(source, { kind: 'model', provider: 'my-provider', model: 'my-model' }, 'bundle 缺模型时使用 fallbackModel')
}

{
  // bundle 自带模型优先于 fallbackModel
  const bundle = { version: 1, session: { provider: 'p', model: 'm' }, messages: [{ role: 'assistant', text: 'y' }] }
  const events = T.buildSessionEvents(bundle, { fallbackModel: { provider: 'fp', model: 'fm' }, idFactory: counterIds() })
  const source = events.find((event) => event.type === 'assistant/message')?.data?.message?.source
  h.eq(source?.provider, 'p', 'bundle 的 provider 优先于 fallbackModel')
  h.eq(source?.model, 'm', 'bundle 的 model 优先于 fallbackModel')
}

{
  // 连 fallbackModel 都是空串 → 仍然给出合法 provider/model（否则会话反序列化会炸）
  const bundle = { version: 1, session: {}, messages: [{ role: 'assistant', text: 'y' }] }
  const events = T.buildSessionEvents(bundle, { fallbackModel: { provider: '', model: '' }, idFactory: counterIds() })
  const source = events.find((event) => event.type === 'assistant/message')?.data?.message?.source
  h.eq(source?.provider, 'dsh', 'provider 为空时回退到 dsh')
  h.eq(source?.model, 'forwarded', 'model 为空时回退到 forwarded')
}

{
  const bundle = { version: 1, session: {}, messages: [{ role: 'assistant', text: '被打断' }] }
  const events = T.buildSessionEvents(bundle, { idFactory: counterIds() })
  const assistantEvent = events.find((event) => event.type === 'assistant/message')
  h.eq(Object.hasOwn(assistantEvent.data, 'interrupted'), false, '普通消息不带 interrupted')
}

{
  // 即使 bundle 里手塞了 interrupted（绕过 validateBundle），合成事件也不再带这个字段：
  // validateBundle 会规范化掉它，导出端也从不写它，保留分支只会制造假承诺。
  const bundle = { version: 1, session: {}, messages: [{ role: 'assistant', text: '被打断', interrupted: true }] }
  const events = T.buildSessionEvents(bundle, { idFactory: counterIds() })
  const assistantEvent = events.find((event) => event.type === 'assistant/message')
  h.eq(Object.hasOwn(assistantEvent?.data ?? {}, 'interrupted'), false, '未校验的 interrupted 标记不会写进事件')
}

{
  const events = T.buildSessionEvents({ version: 1, session: {}, messages: [] }, { idFactory: counterIds() })
  h.deepEq(events, [], '空消息产生空事件流')
  const events2 = h.noThrow(() => T.buildSessionEvents({ version: 1, session: {} }), '缺 messages 字段时不抛错')
  h.deepEq(events2, [], '缺 messages 字段时产生空事件流')
}

{
  const bundle = T.validateBundle(goodBundle).bundle
  const events = T.buildSessionEvents(bundle, { idFactory: counterIds() })
  const usedTypes = new Set(events.map((event) => event.type))
  for (const type of usedTypes) h.ok(KNOWN_EVENT_TYPES.has(type), `事件类型 ${type} 在宿主的事件词汇表里`)
  const everyTurnStarts = events.every((event, index) => {
    if (event.type === 'turn/start') return true
    return true
  })
  h.ok(everyTurnStarts, '占位断言：事件流可遍历')
  // 每个 turn 的 start 必须在它自己的事件之前、end 在最后一条自身事件之后
  const turnOrder = []
  let openTurns = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurns += 1
      turnOrder.push(['start', event.data.turn])
    }
    if (event.type === 'turn/end') {
      openTurns -= 1
      turnOrder.push(['end', event.data.turn])
    }
  }
  h.eq(openTurns, 0, '所有 turn 都被 turn/end 关闭')
  h.deepEq(turnOrder, [['start', 1], ['end', 1]], '单个 turn 的开关顺序正确')
}

// ---------------------------------------------------------------------------
// 7. 与宿主真实 session 实现的契约（拿不到宿主时跳过）
// ---------------------------------------------------------------------------
h.group('7. 宿主契约（真实 dsh-session）')

const contract = await loadSessionContract()
if (contract === null) {
  h.warn(`跳过宿主契约测试：读不到 ${contractEntryPath()}（换机器/换安装路径时属正常）`)
} else {
  const { Session, adoptSessionEvent, foldSurface, SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } = contract

  const bundle = T.validateBundle(goodBundle).bundle
  const events = T.buildSessionEvents(bundle, { idFactory: counterIds() })
  const envelope = toEnvelope(events)

  h.ok(contractAvailable(), '能读到宿主安装里的 dsh-session')
  for (const type of new Set(events.map((event) => event.type))) {
    h.ok(KNOWN_SESSION_EVENT_TYPES.has(type), `宿主 KNOWN_SESSION_EVENT_TYPES 包含 ${type}`)
  }

  {
    let failure
    for (const event of envelope) {
      try {
        adoptSessionEvent(structuredClone(event))
      } catch (error) {
        failure = `${event.type}: ${error instanceof Error ? error.message : String(error)}`
        break
      }
    }
    h.eq(failure, undefined, '每条合成事件都能被宿主的 adoptSessionEvent 接受', failure)
  }

  {
    const folded = h.noThrow(() => foldSurface(envelope, []), 'foldSurface 能折叠合成事件')
    h.eq(folded?.nodes?.length, 2, 'surface 上正好两个可见节点（user + assistant）')
    h.eq(folded?.replacements?.length, 0, '没有替换操作')
  }

  {
    const session = h.noThrow(
      () => Session.create('session-contract-test', envelope, makeHeader(SESSION_FORMAT_VERSION, 'session-contract-test'), 0, []),
      'Session.create 能用合成事件开始一条会话',
    )
    const messages = h.noThrow(() => session.deriveMessages(), 'deriveMessages() 能派生模型看到的对话')
    h.eq(messages?.length, 2, '派生出的消息条数等于 bundle 的消息条数')
    h.deepEq(messages?.map((message) => message.role), ['user', 'assistant'], '派生出的角色顺序正确')
    h.eq(messages?.[0]?.content?.[0]?.text, '你好', '用户消息正文一致')
    h.eq(messages?.[1]?.content?.[0]?.text, '在的', '助手消息正文一致')
    h.eq(messages?.[1]?.source?.kind, 'model', '助手消息的 source.kind 是 model（会话反序列化要求）')
    h.ok(typeof messages?.[1]?.source?.provider === 'string' && messages[1].source.provider !== '', '助手消息带非空 provider')
    h.ok(typeof messages?.[1]?.source?.model === 'string' && messages[1].source.model !== '', '助手消息带非空 model')
    h.eq(session?.requestHeader(), undefined, '导入的会话没有 request/header（续聊时需要 agent loop 重新写一份）')
  }

  {
    // 多 turn：三个 turn 全部落到同一条会话里
    const multi = {
      version: 1,
      session: { provider: 'p', model: 'm' },
      messages: [
        { role: 'user', text: 'q1' },
        { role: 'assistant', text: 'a1' },
        { role: 'user', text: 'q2' },
        { role: 'assistant', text: 'a2' },
        { role: 'user', text: 'q3' },
      ],
    }
    const multiEvents = T.buildSessionEvents(multi, { idFactory: counterIds() })
    const session = h.noThrow(
      () => Session.create('session-contract-multi', toEnvelope(multiEvents), makeHeader(SESSION_FORMAT_VERSION, 'session-contract-multi'), 0, []),
      '多轮内容也能开始一条会话',
    )
    const messages = session?.deriveMessages?.() ?? []
    h.eq(messages.length, 5, '多轮会话派生出的消息条数正确')
    h.deepEq(messages.map((message) => message.content?.[0]?.text), ['q1', 'a1', 'q2', 'a2', 'q3'], '多轮正文顺序与内容完全一致')
  }

  {
    // 反向验证：缺 surfaceOp / 缺 provider 时宿主确实会拒绝，说明这些字段不是可选项
    const brokenNoSurfaceOp = envelope.filter((event) => event.type !== 'user/message')
    h.throws(
      () => Session.create('session-contract-bad', brokenNoSurfaceOp, makeHeader(SESSION_FORMAT_VERSION, 'session-contract-bad'), 0, []),
      'user/message 丢掉 surfaceOp 时宿主拒绝（证明 surfaceOp 是必需字段）',
      undefined,
    )
    const noProvider = envelope.map((event) => {
      if (event.type !== 'assistant/message') return event
      return {
        ...event,
        data: {
          ...event.data,
          message: { ...event.data.message, source: { kind: 'model' } },
        },
      }
    })
    h.throws(
      () => adoptSessionEvent(structuredClone(noProvider.find((event) => event.type === 'assistant/message'))),
      '助手消息缺 provider/model 时宿主拒绝（证明 fallbackModel 兜底是必需的）',
      /model source|provider/,
    )
  }

  {
    // 导出 → 导入 → 再导出：transcript 必须等价
    const reExtracted = T.extractTranscript(envelope)
    h.eq(reExtracted.messages.length, bundle.messages.length, '把导入的事件再抽一遍，消息条数不变')
    h.deepEq(
      reExtracted.messages.map((message) => [message.role, message.text]),
      bundle.messages.map((message) => [message.role, message.text]),
      '往返一次后对话内容完全一致',
    )
  }
}

// ---------------------------------------------------------------------------
// 8. 端到端：真实会话事件 → bundle → 事件 → 会话
// ---------------------------------------------------------------------------
h.group('8. 端到端（真实夹具）')

{
  const realEvents = [
    sample('turn-start'),
    sample('step-start'),
    sample('human-user-message'),
    sample('injected-runtime-context'),
    sample('injected-skill-catalog'),
    sample('injected-time-context'),
    sample('injected-dsh-mnemon'),
    sample('assistant-reasoning-tool-call'),
    sample('tool-result'),
    sample('session-title'),
  ]
  const transcript = T.extractTranscript(realEvents)
  h.eq(transcript.messages.length, 1, '真实会话里只有 1 条空旷可见的用户消息')
  h.eq(transcript.stats.toolCalls, 2, '真实会话的工具调用计入 omitted')
  h.eq(transcript.stats.toolResults, 1, '真实会话的 tool/result 计入 omitted')

  const bundle = T.buildBundle({
    messages: transcript.messages,
    stats: transcript.stats,
    session: { title: '真实会话样本', cwd: '/Users/zhengyang/DSH' },
    app: { version: '0.0.0-test' },
    now: NOW,
  })
  h.eq(bundle.session?.messageCount, 1, 'bundle 记录 1 条消息')

  const imported = T.validateBundle(JSON.parse(JSON.stringify(bundle)))
  h.eq(imported.ok, true, '导出物经过 JSON 往返后仍能通过导入校验')
  h.eq(imported.bundle?.messages.length, 1, '导入后消息条数不变')

  const events = T.buildSessionEvents(imported.bundle, { fallbackModel: { provider: 'magpie', model: 'volcengine/deepseek-v4.1-flash' } })
  h.eq(events.filter((event) => event.type === 'turn/start').length, 1, '生成 1 个 turn')
  h.eq(events.filter((event) => event.type === 'user/message').length, 1, '生成 1 条用户消息')
  h.eq(events.filter((event) => event.type === 'assistant/message').length, 0, '没有可见助手正文时不硬造 assistant 消息')

  if (contract !== null) {
    const { Session, SESSION_FORMAT_VERSION } = contract
    const session = h.noThrow(
      () => Session.create('session-contract-real', toEnvelope(events), makeHeader(SESSION_FORMAT_VERSION, 'session-contract-real'), 0, []),
      '真实夹具生成的会话能被宿主接受',
    )
    const messages = session?.deriveMessages?.() ?? []
    h.eq(messages.length, 1, '真实夹具导入后派生 1 条消息')
    h.eq(messages[0]?.role, 'user', '派生出来的是用户消息')
    h.match(messages[0]?.content?.[0]?.text, /^做一个插件/, '派生出的正文是真人原话')
  } else {
    h.warn('跳过真实夹具的宿主会话断言：拿不到 dsh-session')
  }
}

// ---------------------------------------------------------------------------
// 9. 审查补充：不变量与防御性边界（结论见 REVIEW.md）
// ---------------------------------------------------------------------------
h.group('9. 审查补充')

{
  // 全是非法字符的标题，清洗后为空 → 必须回退
  h.eq(T.suggestFileName('///'), 'dsh-session.dshchat.json', '全非法字符的标题回退成兜底文件名')
  h.eq(T.suggestFileName('\u0000\u0001'), 'dsh-session.dshchat.json', '全是控制字符的标题回退成兜底文件名')
}

{
  // validateBundle 只校验自身协议；exportedAtIso / app 是「信任转发」的直通字段，
  // 它们不会参与会话事件构造，但会原样进 markdown（见 REVIEW 低危条目）
  const result = T.validateBundle({
    format: T.BUNDLE_FORMAT,
    version: 1,
    messages: [{ role: 'user', text: 'x' }],
    exportedAtIso: 'not-a-date',
    app: 'not-an-object',
    session: 'not-an-object',
  })
  h.eq(result?.ok, true, 'session/app/exportedAtIso 形状奇怪时仍然接受（它们不参与事件构造）')
  h.eq(result?.bundle?.exportedAtIso, 'not-a-date', 'exportedAtIso 未做 ISO 校验，原样保留')
  h.eq(result?.bundle?.app, 'not-an-object', 'app 未做形状校验，原样保留')
  h.eq(result?.bundle?.session?.messageCount, 1, 'session 不是对象时仍能规范化出 session 对象')
  h.match(T.bundleToMarkdown(result.bundle), /^# 转发的会话/m, '标题缺失时不崩，用兜底标题')
}

{
  // JSON.parse 出来的 __proto__ 是自有属性；规范化后不能把它带进事件或污染原型
  const raw = JSON.parse('{"format":"dsh-session-forward","version":1,"messages":[{"role":"user","text":"x","__proto__":{"polluted":"yes"}}]}')
  const result = T.validateBundle(raw)
  h.eq(result?.ok, true, '带 __proto__ 键的 bundle 仍能通过校验')
  h.deepEq(Object.keys(result?.bundle?.messages?.[0] ?? {}).sort(), ['role', 'text', 'time'], '规范化只保留 role/text/time，不透传 __proto__')
  h.eq({}.polluted, undefined, '规范化过程没有污染 Object.prototype')

  const events = T.buildSessionEvents(result.bundle)
  const serialized = JSON.stringify(events)
  h.ok(!serialized.includes('polluted'), '合成事件里没有任何原型污染残留')
}

{
  // buildSessionEvents 假设入参已经过 validateBundle：空文本不会被它再过滤一次
  const events = T.buildSessionEvents({ version: 1, session: {}, messages: [{ role: 'assistant', text: '   ' }] })
  const assistantEvent = events.find((event) => event.type === 'assistant/message')
  h.eq(assistantEvent?.data?.message?.content?.[0]?.text, '   ', 'buildSessionEvents 不重复校验文本（信任 validateBundle 的过滤）')
}

{
  // 同一条消息文本重复出现时，id 仍然互不相同
  const events = T.buildSessionEvents(
    { version: 1, session: {}, messages: [
      { role: 'user', text: '重复' },
      { role: 'assistant', text: '同一句' },
      { role: 'assistant', text: '同一句' },
    ] },
    { idFactory: counterIds() },
  )
  const ids = events
    .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    .map((event) => (event.type === 'user/message' ? event.data.id : event.data.message.id))
  h.eq(new Set(ids).size, 3, '重复文本的消息也拿到互不相同的 id')
}

{
  // markdown 不做转义：标题里的换行会破坏一级标题（低危，REVIEW 记录）
  const markdown = T.bundleToMarkdown({ exportedAt: NOW, session: { title: '第一行\n第二行' }, messages: [] })
  h.ok(markdown.startsWith('# 第一行\n第二行\n'), '标题里的换行原样进入 markdown（未转义）')
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const result = h.report({
  title: `环境: node ${process.versions.node}（${process.execPath.split('/').pop()}）；夹具 ${fixtures.samples.length} 条（来自 ${fixtures.meta?.source ?? 'unknown'}）`,
  verbose: true,
})
process.exit(result.fail === 0 ? 0 : 1)
