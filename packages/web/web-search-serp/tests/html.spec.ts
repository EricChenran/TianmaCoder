import { describe, expect, it } from 'vitest'
import {
  absoluteHttpUrl,
  attributeOf,
  boundHtml,
  captureGroups,
  decodeEntities,
  firstText,
  looksChallenged,
  textOf,
  urlKey,
} from '../src/html.ts'

describe('decodeEntities', () => {
  it('decodes the named entities engines emit', () => {
    expect(decodeEntities('a&amp;b')).toBe('a&b')
    expect(decodeEntities('&nbsp;x')).toBe(' x')
    expect(decodeEntities('&AMP;')).toBe('&')
    expect(decodeEntities('&hellip;&mdash;')).toBe('…—')
    expect(decodeEntities('&quot;&apos;&lt;&gt;')).toBe('"\'<>')
  })

  it('decodes decimal and hexadecimal code points', () => {
    expect(decodeEntities('&#38;')).toBe('&')
    expect(decodeEntities('&#x26;')).toBe('&')
    expect(decodeEntities('&#X26;')).toBe('&')
    expect(decodeEntities('&#0183;')).toBe('·')
    expect(decodeEntities('&#x4e2d;')).toBe('中')
  })

  it('keeps an unknown name, a non-scalar code point, and a bare ampersand verbatim', () => {
    expect(decodeEntities('&unknown;')).toBe('&unknown;')
    expect(decodeEntities('&#0;')).toBe('&#0;')
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;')
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;')
    expect(decodeEntities('&#xZZ;')).toBe('&#xZZ;')
    expect(decodeEntities('bare & ampersand')).toBe('bare & ampersand')
  })
})

describe('textOf', () => {
  it('removes an inline tag without inserting a gap', () => {
    expect(textOf('<b>deep</b>seek')).toBe('deepseek')
    expect(textOf('www.<em>deepseek</em>.com')).toBe('www.deepseek.com')
  })

  it('reads a block tag boundary as a word gap', () => {
    expect(textOf('<div>a</div><div>b</div>')).toBe('a b')
    expect(textOf('a<br>b')).toBe('a b')
  })

  it('drops script and style bodies, decodes entities, and collapses whitespace', () => {
    expect(textOf('<script>var x = 1</script>visible')).toBe('visible')
    expect(textOf('<style>.a { color: red }</style>visible')).toBe('visible')
    expect(textOf('a&nbsp;&nbsp;b')).toBe('a b')
    expect(textOf('  spaced\n\ttext  ')).toBe('spaced text')
  })

  it('returns an empty string for a fragment with no text', () => {
    expect(textOf('   ')).toBe('')
    expect(textOf('<img src="x">')).toBe('')
  })
})

describe('attributeOf', () => {
  it('reads a double-quoted value', () => {
    expect(attributeOf('<a href="x" class="c">', 'href')).toBe('x')
    expect(attributeOf('<div mu="https://a.test/">', 'mu')).toBe('https://a.test/')
  })

  it('returns undefined for an absent attribute or an unterminated quote', () => {
    expect(attributeOf('<a class="c">', 'href')).toBeUndefined()
    expect(attributeOf('<a href="x', 'href')).toBeUndefined()
    expect(attributeOf('<a href=x>', 'href')).toBeUndefined()
  })
})

describe('captureGroups', () => {
  it('returns one entry per capture group', () => {
    expect(captureGroups(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/, '<a href="u">t</a>')).toEqual(['u', 't'])
  })

  it('returns nothing when the pattern does not match', () => {
    expect(captureGroups(/<h3>([\s\S]*?)<\/h3>/, '<p>x</p>')).toEqual([])
  })
})

describe('firstText', () => {
  it('reads the first group as visible text', () => {
    expect(firstText('<h3>Hi <em>there</em></h3>', /<h3[^>]*>([\s\S]*?)<\/h3>/)).toBe('Hi there')
  })

  it('returns undefined when the pattern misses or the text is blank', () => {
    expect(firstText('<p>x</p>', /<h3[^>]*>([\s\S]*?)<\/h3>/)).toBeUndefined()
    expect(firstText('<h3>   </h3>', /<h3[^>]*>([\s\S]*?)<\/h3>/)).toBeUndefined()
  })
})

describe('absoluteHttpUrl', () => {
  it('keeps an absolute HTTP(S) URL and drops its fragment', () => {
    expect(absoluteHttpUrl('https://a.test/p#frag', 'https://b.test')).toBe('https://a.test/p')
    expect(absoluteHttpUrl('http://a.test/p', 'https://b.test')).toBe('http://a.test/p')
  })

  it('resolves a relative reference and decodes entities in the reference', () => {
    expect(absoluteHttpUrl('/p?q=1', 'https://b.test')).toBe('https://b.test/p?q=1')
    expect(absoluteHttpUrl('https://a.test/?a=1&amp;b=2', 'https://b.test')).toBe('https://a.test/?a=1&b=2')
  })

  it('rejects a non-HTTP scheme and an unparseable reference', () => {
    expect(absoluteHttpUrl('javascript:alert(1)', 'https://b.test')).toBeUndefined()
    expect(absoluteHttpUrl('ftp://a.test/f', 'https://b.test')).toBeUndefined()
    expect(absoluteHttpUrl('http://[bad', 'https://b.test')).toBeUndefined()
  })
})

describe('urlKey', () => {
  it('canonicalizes the fragment, a trailing slash, the host case, and the query', () => {
    expect(urlKey('https://a.test/p/#f')).toBe('https://a.test/p')
    expect(urlKey('https://A.TEST/')).toBe('https://a.test')
    expect(urlKey('https://a.test/p?q=1')).toBe('https://a.test/p?q=1')
  })

  it('returns a non-URL value unchanged', () => {
    expect(urlKey('not a url')).toBe('not a url')
    expect(urlKey('/relative')).toBe('/relative')
  })
})

describe('looksChallenged', () => {
  it('recognizes a challenge page and passes a result page', () => {
    expect(looksChallenged('<title>百度安全验证</title>')).toBe(true)
    expect(looksChallenged('<form action="https://wappass.baidu.com/x">')).toBe(true)
    expect(looksChallenged('<html><body>results</body></html>')).toBe(false)
  })
})

describe('boundHtml', () => {
  it('keeps a document within the bound and cuts a larger one', () => {
    expect(boundHtml('abc', 5)).toBe('abc')
    expect(boundHtml('abcdef', 3)).toBe('abc')
  })
})
