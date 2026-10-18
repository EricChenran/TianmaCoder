/**
 * The file names the node adopts from outside itself: illegal characters out, the
 * wrapping quotes of plan text out, and a stated path still names the file that was
 * written.
 */

import { describe, expect, it } from 'vitest'
import { cleanStatedPath, sanitizeFilename } from '@tianma/dsh-mps-executor'

describe('sanitizeFilename', () => {
  it('keeps the characters every host accepts', () => {
    expect(sanitizeFilename('assistant-intro (v2).md')).toBe('assistant-intro (v2).md')
  })

  it('keeps Chinese in a content file name', () => {
    expect(sanitizeFilename('助手介绍.md')).toBe('助手介绍.md')
  })

  it('drops the characters Windows refuses', () => {
    expect(sanitizeFilename('a<b>c:d|e?f*g"h')).toBe('abcdefgh')
  })

  it('drops control characters and collapses whitespace', () => {
    expect(sanitizeFilename('a\u0000b\u0007c  \t d\n')).toBe('abc d')
  })
})

describe('cleanStatedPath', () => {
  it('strips the wrapping quotes a name picked up from plan text', () => {
    expect(cleanStatedPath('"助手介绍.md"')).toBe('助手介绍.md')
    expect(cleanStatedPath("'助手介绍.md'")).toBe('助手介绍.md')
    expect(cleanStatedPath('`助手介绍.md`')).toBe('助手介绍.md')
  })

  it('keeps a relative path with directories and its separator style', () => {
    expect(cleanStatedPath('docs/助手 介绍（一）.md')).toBe('docs/助手 介绍（一）.md')
    expect(cleanStatedPath('docs\\助手 介绍（一）.md')).toBe('docs\\助手 介绍（一）.md')
  })

  it('drops segments that say nothing', () => {
    expect(cleanStatedPath('./docs//report.md')).toBe('docs/report.md')
    expect(cleanStatedPath('""')).toBe('')
  })
})
