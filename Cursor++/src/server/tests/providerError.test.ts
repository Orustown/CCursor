import { Code } from '@connectrpc/connect'
import { describe, expect, it } from 'vitest'
import { ErrorDetailsSchema } from '../gen/aiserver_v1_shared_pb'
import { makeProviderError } from '../handlers/errors'

/**
 * 上游反爬挑战页的可读化 / 可重试回归。
 *
 * 实测 (2026-11-12): Magpie → Vercel 返回 403 + 21004 字符的
 * "Vercel Security Checkpoint" HTML。旧逻辑把整页混淆脚本塞进
 * ErrorDetails.detail, 客户端会把它渲染成一屏乱码; 而且 403 被判定为
 * 永久错, "Try again" 按钮也不出现。
 */

const CHALLENGE_HTML = [
  'Failed to create stream: inference request failed: failed to generate stream from Vercel: ',
  'failed to invoke model \'vmc/cw-deepseek-v41-flash-1017-fallbacks\' with streaming: ',
  'request failed with status 403: ',
  '<!DOCTYPE html><html lang="en"><head><title>Vercel Security Checkpoint</title>',
  `<style>${'[data-astro-cid-x]{box-sizing:border-box}'.repeat(200)}</style></head><body>`,
  `<script>${'var n=function(t){return t+1};document.cookie="cf_clearance=1";'.repeat(200)}</script>`,
  '</body></html>',
].join('')

function errorDetailsOf(cause: unknown) {
  const err = makeProviderError(cause)
  const details = err.findDetails(ErrorDetailsSchema)[0]
  if (!details)
    throw new Error('ErrorDetails missing')
  return { err, details, custom: details.details }
}

describe('makeProviderError — 反爬挑战页', () => {
  it('把 20KB HTML 压成摘要, 并允许重试', () => {
    expect(CHALLENGE_HTML.length).toBeGreaterThan(20_000)

    const { err, details, custom } = errorDetailsOf(new Error(CHALLENGE_HTML))

    expect(err.code).toBe(Code.Unavailable)
    expect(details.isExpected).toBe(false)
    expect(custom?.isRetryable).toBe(true)
    expect(custom?.title).toBe('Upstream gateway security check')
    expect(custom?.detail).toContain('HTTP 403')
    expect(custom?.detail).toContain('Vercel Security Checkpoint')
    expect(custom?.detail).toContain('vmc/cw-deepseek-v41-flash-1017-fallbacks')
    expect(custom?.detail).not.toContain('<script')
    expect(custom?.detail).not.toContain('document.cookie')
    expect(custom?.detail?.length).toBeLessThan(800)
  })

  it('普通 403 仍然不可重试', () => {
    const { err, custom } = errorDetailsOf(new Error('request failed with status 403: forbidden'))

    expect(err.code).toBe(Code.FailedPrecondition)
    expect(custom?.isRetryable).toBe(false)
    expect(custom?.title).toBe('BYOK request rejected')
  })

  it('普通 5xx 仍按可重试处理, 且不改写文案', () => {
    const { custom } = errorDetailsOf(new Error('upstream request failed with status 502'))

    expect(custom?.isRetryable).toBe(true)
    expect(custom?.title).toBe('LLM provider error')
    expect(custom?.detail).toBe('upstream request failed with status 502')
  })

  it('非挑战类 HTML 错误页也会被压缩, 但不误判成反爬', () => {
    const { custom } = errorDetailsOf(new Error(
      'request failed with status 502: <!DOCTYPE html><html><head><title>Bad Gateway</title></head><body>oops</body></html>',
    ))

    expect(custom?.isRetryable).toBe(true)
    expect(custom?.title).toBe('LLM provider error')
    expect(custom?.detail).toContain('HTTP 502')
    expect(custom?.detail).toContain('Bad Gateway')
    expect(custom?.detail).not.toContain('<html')
  })
})
