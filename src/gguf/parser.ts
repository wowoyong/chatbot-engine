import { ByteReader } from './reader.js';
import { GgmlType, GgufValueType } from './types.js';
import type { GgufFile, TensorInfo } from './types.js';

const GGUF_MAGIC = 'GGUF';
const SUPPORTED_VERSION = 3;
const DEFAULT_ALIGNMENT = 32;

/** GGUF 값 하나를 타입에 따라 읽는다 (array는 재귀) */
function readValue(reader: ByteReader, type: number): unknown {
  switch (type) {
    case GgufValueType.UINT8:
      return reader.u8();
    case GgufValueType.INT8:
      return reader.i8();
    case GgufValueType.UINT16:
      return reader.u16();
    case GgufValueType.INT16:
      return reader.i16();
    case GgufValueType.UINT32:
      return reader.u32();
    case GgufValueType.INT32:
      return reader.i32();
    case GgufValueType.FLOAT32:
      return reader.f32();
    case GgufValueType.BOOL:
      return reader.bool();
    case GgufValueType.STRING:
      return reader.str();
    case GgufValueType.UINT64:
      return reader.u64();
    case GgufValueType.INT64:
      return reader.i64();
    case GgufValueType.FLOAT64:
      return reader.f64();
    case GgufValueType.ARRAY: {
      const elemType = reader.u32();
      const count = reader.u64();
      const arr: unknown[] = [];
      for (let i = 0; i < count; i += 1) {
        arr.push(readValue(reader, elemType));
      }
      return arr;
    }
    default:
      throw new Error(`알 수 없는 GGUF 값 타입: ${type}`);
  }
}

/** 다음 alignment 배수로 올림 */
function alignUp(offset: number, alignment: number): number {
  const rem = offset % alignment;
  return rem === 0 ? offset : offset + (alignment - rem);
}

/** GGUF v3 버퍼를 파싱해 메타데이터 + 텐서 info를 반환 */
export function parseGguf(buffer: Buffer): GgufFile {
  const reader = new ByteReader(buffer);
  const magic = reader.ascii(4);
  if (magic !== GGUF_MAGIC) {
    throw new Error(`GGUF magic 불일치: "${magic}"`);
  }
  const version = reader.u32();
  if (version !== SUPPORTED_VERSION) {
    throw new Error(`지원하지 않는 GGUF 버전: ${version} (지원: ${SUPPORTED_VERSION})`);
  }
  const tensorCount = reader.u64();
  const kvCount = reader.u64();

  const metadata = new Map<string, unknown>();
  for (let i = 0; i < kvCount; i += 1) {
    const key = reader.str();
    const valueType = reader.u32();
    metadata.set(key, readValue(reader, valueType));
  }

  const tensors = new Map<string, TensorInfo>();
  for (let i = 0; i < tensorCount; i += 1) {
    const name = reader.str();
    const nDims = reader.u32();
    const dims: number[] = [];
    for (let d = 0; d < nDims; d += 1) {
      dims.push(reader.u64());
    }
    const type = reader.u32();
    if (type !== GgmlType.F32 && type !== GgmlType.F16) {
      throw new Error(
        `지원하지 않는 텐서 타입: ${type} (텐서 "${name}", 지원: F32/F16만)`,
      );
    }
    const offset = reader.u64();
    tensors.set(name, { name, dims, type, offset });
  }

  const alignmentRaw = metadata.get('general.alignment');
  const alignment =
    typeof alignmentRaw === 'number' && alignmentRaw > 0
      ? alignmentRaw
      : DEFAULT_ALIGNMENT;
  const dataStart = alignUp(reader.offset, alignment);

  return { version, metadata, tensors, dataStart };
}
