// Unicode mode로 테스트
const text = 'Ollama의 num_ctx는 4096!';
const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
console.log('Input:', text);
console.log('Output:', matches);

// 문서 테스트
const doc = '양자화는 모델 메모리를 줄인다';
const docMatches = doc.toLowerCase().match(/[\p{L}\p{N}]+/gu);
console.log('\nDoc:', doc);
console.log('Tokens:', docMatches);
