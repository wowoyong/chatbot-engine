## Architecture Overview

The chatbot-engine is structured into several key components that work together to provide a robust chatbot system. The main components include:

1. **Core Engine**: Handles the fundamental operations of the chatbot, including session management and message processing.
2. **Memory Management**: Ensures efficient handling of chat sessions, context, and token estimation.
3. **RAG (Retrieval-Augmented Generation)**: Enhances the chatbot's responses by integrating with external data sources through chunking, indexing, and retrieval.
4. **LLM Integration**: Interfaces with Large Language Models (LLMs) for generating responses, utilizing clients like Ollama.
5. **CLI and API**: Provides command-line interface and API endpoints for interacting with the chatbot.

### Key Files and Directories
- **src/chat/**: Contains the chat session management and testing files.
- **src/context/**: Manages context handling, token estimation, and trimming.
- **src/rag/**: Implements RAG functionalities, including chunking, cosine similarity, and vector indexing.
- **src/store/**: Handles session storage and data persistence.
- **src/llm/**: Integrates with LLMs and handles embeddings and client interactions.

### Dependencies
- **GitHub Actions**: Automates workflows for documentation updates and testing.
- **Vitest**: Used for testing the chatbot's functionalities.
- **Ollama**: Provides LLM services for the chatbot's responses.

This architecture ensures scalability, maintainability, and efficient integration with various external systems.