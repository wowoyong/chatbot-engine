## RAG Implementation

The Retrieval-Augmented Generation (RAG) system in the chatbot-engine enhances the chatbot's ability to provide accurate and contextually relevant responses by integrating with external data sources. Key components include:

### Chunking
- **Chunker**: Divides documents into manageable chunks for processing and indexing.
- **Cosine Similarity**: Calculates similarity between query vectors and document vectors to find relevant chunks.

### Indexing
- **Indexer**: Builds indexes for chunks to enable efficient retrieval.
- **VectorIndex**: Stores vector representations of chunks for quick similarity searches.

### Retrieval
- **Retriever**: Fetches relevant chunks based on the user's query using similarity scores.
- **Integration with LLM**: Combines retrieved information with LLM-generated responses for comprehensive answers.

### Key Files
- **src/rag/chunker.ts**: Implements document chunking.
- **src/rag/cosine.ts**: Contains cosine similarity calculations.
- **src/rag/indexer.ts**: Builds indexes for chunks.
- **src/rag/retriever.ts**: Handles retrieval of relevant chunks.
- **src/rag/vector-index.ts**: Manages vector storage and retrieval.
- **src/llm/ollama-embedder.ts**: Integrates with Ollama for embedding generation.

This RAG implementation ensures the chatbot can leverage external knowledge sources for more accurate and informed responses.