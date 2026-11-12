import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentClientMessageSchema, AgentMode } from '../gen/agent_v1_pb'
import { appendMessage, closeSession, getOrCreateSession } from '../handlers/agent/session'
import { resolveAppendPayload } from '../services/core/BidiService'

/**
 * BidiAppend 双编码回归 —— Cursor 3.29+ 默认发送 field 4 data_binary。
 *
 * 客户端在一条流开始时按特性开关二选一 (cursor-agent-host 的 daemon.cjs):
 *   dataBinary: AgentClientMessage.toBinary()
 *   data:       Buffer.from(payloadBytes).toString('hex')
 * 两者承载同一份字节。服务端只认 field 1 时会丢弃 3.29 的默认流量, 表现为
 * [SVC] BidiAppend missing fields + RunSSE 等 30s 超时。
 */

const requestIds: string[] = []

function nextRequestId(): string {
  const id = `bidi-append-${requestIds.length}`
  requestIds.push(id)
  return id
}

function runRequestBytes(): Uint8Array {
  const message = create(AgentClientMessageSchema, {
    message: {
      case: 'runRequest',
      value: {
        conversationId: 'conv-bidi',
        action: {
          action: {
            case: 'userMessageAction',
            value: {
              userMessage: {
                text: 'hello binary',
                messageId: 'm1',
                mode: AgentMode.AGENT,
              },
            },
          },
        },
      },
    },
  })
  return toBinary(AgentClientMessageSchema, message)
}

function decodeAsJson(bytes: Uint8Array): Record<string, unknown> {
  return toJson(AgentClientMessageSchema, fromBinary(AgentClientMessageSchema, bytes)) as Record<string, unknown>
}

function userTextOf(message: Record<string, unknown>): string {
  const runRequest = message.runRequest as {
    action: { userMessageAction: { userMessage: { text: string } } }
  }
  return runRequest.action.userMessageAction.userMessage.text
}

afterEach(() => {
  for (const id of requestIds.splice(0))
    closeSession(id)
})

describe('resolveAppendPayload — field 4 与 field 1 等价', () => {
  it('优先使用 data_binary 的原始字节', () => {
    const bytes = runRequestBytes()
    const payload = resolveAppendPayload({ data: '', dataBinary: bytes })

    expect(payload.source).toBe('data_binary')
    expect(Array.from(payload.bytes ?? [])).toEqual(Array.from(bytes))
  })

  it('没有 data_binary 时回退到 hex data', () => {
    const bytes = runRequestBytes()
    const payload = resolveAppendPayload({
      data: Buffer.from(bytes).toString('hex'),
      dataBinary: new Uint8Array(0),
    })

    expect(payload.source).toBe('data_hex')
    expect(Array.from(payload.bytes ?? [])).toEqual(Array.from(bytes))
  })

  it('两个字段同时存在时以 data_binary 为准', () => {
    const bytes = runRequestBytes()
    const payload = resolveAppendPayload({ data: '00ff', dataBinary: bytes })

    expect(payload.source).toBe('data_binary')
    expect(Array.from(payload.bytes ?? [])).toEqual(Array.from(bytes))
  })

  it('非法或奇数长度 hex 不入队', () => {
    expect(resolveAppendPayload({ data: 'zz', dataBinary: new Uint8Array(0) })).toEqual({ source: 'none' })
    expect(resolveAppendPayload({ data: 'abc', dataBinary: new Uint8Array(0) })).toEqual({ source: 'none' })
  })

  it('空 bytes 视为缺省 —— protobuf-es 的空 Uint8Array 是 truthy', () => {
    expect(resolveAppendPayload({ data: '', dataBinary: new Uint8Array(0) })).toEqual({ source: 'none' })
  })
})

describe('appendMessage — 两种编码产出相同 session 消息', () => {
  it('接收 data_binary 的原始字节', () => {
    const bytes = runRequestBytes()
    const requestId = nextRequestId()

    appendMessage(requestId, bytes)

    const messages = getOrCreateSession(requestId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual(decodeAsJson(bytes))
    expect(userTextOf(messages[0])).toBe('hello binary')
  })

  it('接收旧版 hex data', () => {
    const bytes = runRequestBytes()
    const requestId = nextRequestId()

    appendMessage(requestId, Buffer.from(bytes).toString('hex'))

    const messages = getOrCreateSession(requestId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual(decodeAsJson(bytes))
  })

  it('同一 requestId 下 hex 与 bytes 混发保持顺序', () => {
    const first = runRequestBytes()
    const second = runRequestBytes()
    const requestId = nextRequestId()

    appendMessage(requestId, Buffer.from(first).toString('hex'))
    appendMessage(requestId, second)

    const messages = getOrCreateSession(requestId).messages
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual(decodeAsJson(first))
    expect(messages[1]).toEqual(decodeAsJson(second))
  })

  it('空载荷直接丢弃, 不创建空消息', () => {
    const requestId = nextRequestId()

    appendMessage(requestId, new Uint8Array(0))

    expect(getOrCreateSession(requestId).messages).toHaveLength(0)
  })
})
