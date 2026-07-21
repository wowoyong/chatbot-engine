## Core Engine Phases

The development of the chatbot-engine is divided into several phases, each focusing on specific functionalities and improvements. Here's an overview of the key phases:

### Phase 0: Project Setup
- **Initial Setup**: Created the project structure with TypeScript, ESM, and Vitest.
- **Dependencies**: Configured necessary dependencies and set up the development environment.

### Phase 1: Core Functionality
- **LLM Client Interface**: Implemented the LLMClient interface and OllamaClient for interacting with LLMs.
- **ChatSession**: Introduced multi-turn chat sessions and CLI REPL for user interaction.

### Phase 2: Advanced Features
- **Memory Management**: Enhanced session management with JSON auto-save/load and CLI integration.
- **Context Manager**: Added context handling with summarization and token estimation.

### Phase 3: Future Enhancements
- **RAG Integration**: Planned and implemented RAG features for enhanced response generation.
- **Testing and CI/CD**: Set up GitHub Actions for automated testing and documentation updates.

### Key Files
- **src/chat/session.ts**: Manages chat sessions and multi-turn interactions.
- **src/context/context-manager.ts**: Handles context management and summarization.
- **src/llm/ollama-client.ts**: Integrates with Ollama for LLM interactions.
- **.github/workflows/openwiki-update.yml**: Automates OpenWiki documentation updates.

These phases ensure the chatbot-engine evolves with robust features and maintainability.
