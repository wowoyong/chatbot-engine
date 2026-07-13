/** 리틀엔디언 순차 리더 — 매 읽기마다 경계 검사 */
export class ByteReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  get offset(): number {
    return this.pos;
  }

  set offset(value: number) {
    this.ensure(0, value);
    this.pos = value;
  }

  private ensure(bytes: number, at: number = this.pos): void {
    if (at < 0 || at + bytes > this.buf.length) {
      throw new Error(
        `버퍼 경계 초과: offset ${at} + ${bytes}바이트 > 길이 ${this.buf.length}`,
      );
    }
  }

  u8(): number {
    this.ensure(1);
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  i8(): number {
    this.ensure(1);
    const v = this.buf.readInt8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.ensure(2);
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.ensure(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  /** u64 → Number (GGUF 오프셋/길이는 2^53 미만이므로 안전) */
  u64(): number {
    this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }

  i64(): number {
    this.ensure(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }

  f32(): number {
    this.ensure(4);
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.ensure(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  /** GGUF string: u64 길이 + UTF-8 바이트 */
  str(): string {
    const n = this.u64();
    this.ensure(n);
    const s = this.buf.toString('utf8', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  /** magic 등 고정 ASCII 태그 */
  ascii(n: number): string {
    this.ensure(n);
    const s = this.buf.toString('ascii', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
}
