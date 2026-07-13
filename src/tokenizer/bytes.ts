/** GPT-2 byte→unicode 매핑 (256 바이트 → 유일 유니코드 문자) */
export function bytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let i = 0x21; i <= 0x7e; i += 1) bs.push(i);
  for (let i = 0xa1; i <= 0xac; i += 1) bs.push(i);
  for (let i = 0xae; i <= 0xff; i += 1) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const map = new Map<number, string>();
  for (let i = 0; i < bs.length; i += 1) {
    const byte = bs[i] ?? 0;
    const code = cs[i] ?? 0;
    map.set(byte, String.fromCodePoint(code));
  }
  return map;
}

/** unicode 문자 → byte 역매핑 */
export function unicodeToBytes(): Map<string, number> {
  const rev = new Map<string, number>();
  for (const [byte, ch] of bytesToUnicode()) {
    rev.set(ch, byte);
  }
  return rev;
}
