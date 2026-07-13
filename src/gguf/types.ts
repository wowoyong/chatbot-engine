export enum GgufValueType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

/** GGML 텐서 데이터 타입 (본 로더는 F32/F16만 지원) */
export enum GgmlType {
  F32 = 0,
  F16 = 1,
}

export interface TensorInfo {
  name: string;
  /** 차원 (GGUF는 역순 저장 — 파서가 그대로 보존) */
  dims: number[];
  type: GgmlType;
  /** 텐서 데이터 영역 시작(dataStart) 기준 상대 오프셋 */
  offset: number;
}

export interface GgufFile {
  version: number;
  metadata: Map<string, unknown>;
  tensors: Map<string, TensorInfo>;
  /** 텐서 데이터 영역의 파일 절대 오프셋 (alignment 정렬됨) */
  dataStart: number;
}
