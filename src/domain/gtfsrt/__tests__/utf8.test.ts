import { decodeUtf8, REPLACEMENT_CHARACTER } from '../utf8';

/** The platform's (WHATWG) encoder: an oracle independent of the decoder under test. */
function encode(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  expect(bytes.length).toBeGreaterThanOrEqual(text.length);
  expect(bytes).toBeInstanceOf(Uint8Array);
  return bytes;
}

const FFFD = String.fromCharCode(REPLACEMENT_CHARACTER);

describe('decodeUtf8: round trips', () => {
  it('round-trips "Gov’t Center" (U+2019 is three bytes: E2 80 99)', () => {
    const bytes = Uint8Array.of(0x47, 0x6f, 0x76, 0xe2, 0x80, 0x99, 0x74, 0x20, 0x43, 0x65, 0x6e, 0x74, 0x65, 0x72);
    expect(encode('Gov’t Center')).toEqual(bytes);
    expect(decodeUtf8(bytes)).toBe('Gov’t Center');
  });

  it('round-trips "Ñ" (two bytes: C3 91)', () => {
    expect(encode('Ñ')).toEqual(Uint8Array.of(0xc3, 0x91));
    expect(decodeUtf8(Uint8Array.of(0xc3, 0x91))).toBe('Ñ');
  });

  it('round-trips "🚆" (four bytes, one surrogate pair)', () => {
    const bytes = Uint8Array.of(0xf0, 0x9f, 0x9a, 0x86);
    expect(encode('🚆')).toEqual(bytes);
    expect(decodeUtf8(bytes)).toBe('🚆');
    expect(decodeUtf8(bytes)).toHaveLength(2);
  });

  it('round-trips "abc" (ASCII is one byte per character)', () => {
    expect(decodeUtf8(Uint8Array.of(0x61, 0x62, 0x63))).toBe('abc');
    expect(decodeUtf8(encode('abc'))).toBe('abc');
  });

  it('decodes a window of a larger buffer and the empty string', () => {
    const bytes = encode('[Ñ🚆]');
    expect(decodeUtf8(bytes, 1, bytes.length - 1)).toBe('Ñ🚆');
    expect(decodeUtf8(new Uint8Array(0))).toBe('');
  });

  it('decodes strings longer than one String.fromCharCode chunk', () => {
    const long = 'Gov’t Center 🚆 '.repeat(800);
    expect(long.length).toBeGreaterThan(0x1000);
    expect(decodeUtf8(encode(long))).toBe(long);
  });
});

describe('decodeUtf8: invalid input becomes U+FFFD', () => {
  it('replaces an invalid byte (FF) with U+FFFD and keeps going', () => {
    expect(decodeUtf8(Uint8Array.of(0x61, 0xff, 0x62))).toBe(`a${FFFD}b`);
    expect(decodeUtf8(Uint8Array.of(0x80))).toBe(FFFD);
  });

  it('emits U+FFFD exactly where TextDecoder does (overlong, surrogate, > U+10FFFF, truncated)', () => {
    const malformed = [
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf5, 0x80],
      [0xe2, 0x82],
      [0xe2, 0x41],
      [0xf0, 0x9f, 0x9a],
      [0x61, 0xe2, 0x82, 0xac, 0xe2, 0x82],
    ];
    const reference = new TextDecoder('utf-8', { fatal: false });
    for (const sequence of malformed) {
      const bytes = Uint8Array.from(sequence);
      expect(decodeUtf8(bytes)).toBe(reference.decode(bytes));
    }
    expect(decodeUtf8(Uint8Array.of(0xe2, 0x41))).toBe(`${FFFD}A`);
  });
});
