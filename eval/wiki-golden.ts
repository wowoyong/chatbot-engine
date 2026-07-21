export interface WikiGoldenQuestion {
  question: string;
  expectedSource: string | null;
}

export const WIKI_GOLDEN_QUESTIONS: readonly WikiGoldenQuestion[] = [
  { question: 'CLI와 HTTP 서버의 진입점은 어디야?', expectedSource: 'interfaces/cli-and-http.md' },
  { question: 'native 추론에서 GGUF를 어떻게 읽어?', expectedSource: 'components/native-inference.md' },
  { question: '하이브리드 검색과 score threshold는 어떻게 동작해?', expectedSource: 'components/rag.md' },
  { question: '대화에서 지식을 추출하고 승인하는 흐름은?', expectedSource: 'components/knowledge-capture.md' },
  { question: '요청이 CLI에서 모델 응답까지 흐르는 과정은?', expectedSource: 'architecture/request-flow.md' },
  { question: 'OpenWiki를 cloud와 local에서 갱신하는 방법은?', expectedSource: 'operations/openwiki-and-deployment.md' },
  { question: '환경 변수와 기본 설정값은?', expectedSource: 'reference/configuration.md' },
  { question: '평가와 테스트를 실행하는 명령은?', expectedSource: 'testing/evaluation.md' },
  { question: '달 표면 배포 리전의 세금 정책은?', expectedSource: null },
  { question: '이 저장소의 모바일 앱 결제 환불 규정은?', expectedSource: null },
  { question: '화성 지사의 2035년 인사 담당자는?', expectedSource: null },
];
