const SUBNORMAL_SCALE = Math.pow(2, -24);

/** IEEE754 half(16bit) → f32 number. subnormal/inf/nan 처리 포함 */
export function f16ToF32(half: number): number {
  const sign = (half & 0x8000) !== 0 ? -1 : 1;
  const exp = (half & 0x7c00) >> 10;
  const mant = half & 0x03ff;
  if (exp === 0) {
    return sign * mant * SUBNORMAL_SCALE;
  }
  if (exp === 0x1f) {
    return mant === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
}
