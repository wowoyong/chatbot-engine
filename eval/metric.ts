/** 순위 결과(source 배열, 0=최상위)에 expectedSource가 topK 안에 있으면 1 */
export function recallAtK(
  rankedSources: readonly string[],
  expectedSource: string,
  k: number,
): number {
  return rankedSources.slice(0, k).includes(expectedSource) ? 1 : 0;
}

/** expectedSource가 처음 등장하는 순위의 역수 (없으면 0) */
export function reciprocalRank(
  rankedSources: readonly string[],
  expectedSource: string,
): number {
  const idx = rankedSources.indexOf(expectedSource);
  return idx < 0 ? 0 : 1 / (idx + 1);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total / values.length;
}

/** Mean Reciprocal Rank: reciprocalRank의 평균 */
export function meanReciprocalRank(
  rankedSourcesList: readonly (readonly string[])[],
  expectedSourcesList: readonly string[],
): number {
  const rrs = rankedSourcesList.map((ranked, idx) => {
    const expected = expectedSourcesList.at(idx);
    return expected ? reciprocalRank(ranked, expected) : 0;
  });
  return mean(rrs);
}

export interface EvalSummary {
  count: number;
  recallAt1: number;
  recallAt4: number;
  mrr: number;
}

/** 질문별 순위 결과 목록 → 집계 지표 */
export function summarize(
  perQuestion: readonly { ranked: string[]; expected: string }[],
): EvalSummary {
  return {
    count: perQuestion.length,
    recallAt1: mean(perQuestion.map((q) => recallAtK(q.ranked, q.expected, 1))),
    recallAt4: mean(perQuestion.map((q) => recallAtK(q.ranked, q.expected, 4))),
    mrr: mean(perQuestion.map((q) => reciprocalRank(q.ranked, q.expected))),
  };
}
