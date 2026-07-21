# chatbot-engine Wiki Generation Contract

Generate an OKF v0.1 knowledge bundle for this repository. Write generated documentation in Korean, while preserving code symbols, environment variables, commands, and file paths exactly.

## Required paths

- `index.md`
- `quickstart.md`
- `architecture/overview.md`
- `architecture/request-flow.md`
- `components/native-inference.md`
- `components/rag.md`
- `components/knowledge-capture.md`
- `interfaces/cli-and-http.md`
- `operations/openwiki-and-deployment.md`
- `testing/evaluation.md`
- `reference/configuration.md`
- `source-map.md`
- `log.md`

## Required coverage

- Explain the complete `ChatSession.send()` request flow from retrieval to SSE/CLI rendering.
- Document Ollama and native GGUF inference as separate `LlmClient` implementations.
- Document vector + BM25 + RRF hybrid retrieval, index persistence, and `/index`.
- Document conversation knowledge extraction, novelty detection, capture storage, and approval lifecycle.
- Document CLI commands, HTTP routes, SSE event shapes, and every supported environment variable.
- Document deterministic unit tests separately from Ollama/GGUF-gated integration tests.
- Include a source map from every documented component to concrete files under `src/`, `eval/`, `.github/`, and `scripts/`.

## Accuracy rules

- Read `package.json` before documenting commands. Do not invent `npm start`.
- Read current TypeScript before stating behavior or test counts.
- Mark generated concept pages with OKF frontmatter. `type` is required; include optional `title`, `description`, `tags`, `resource`, and `timestamp` when the source supports them.
- Use standard Markdown links between related concepts.
- Treat `INSTRUCTIONS.md` as author-owned configuration; do not list it as a concept.
- Do not copy secrets, `.chatbot/` contents, model weights, or generated `dist/` output.
