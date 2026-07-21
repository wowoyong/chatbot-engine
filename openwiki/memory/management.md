## Memory Management

The memory management system in the chatbot-engine is designed to efficiently handle chat sessions, context, and token estimation. Key aspects include:

### Session Management
- **ChatSession**: Manages multi-turn conversations, storing session data and context.
- **SessionStore**: Persists session data to storage, ensuring data is saved and restored automatically.

### Context Handling
- **ContextManager**: Manages the context of conversations, including summarization and token estimation.
- **Summarizer**: Compresses context to maintain efficiency and relevance in long conversations.

### Token Estimation
- **TokenEstimate**: Estimates the number of tokens in a given text to manage costs and efficiency.
- **Trimming**: Implements strategies to trim unnecessary content based on token limits.

### Key Files
- **src/chat/session.ts**: Core logic for managing chat sessions.
- **src/context/context-manager.ts**: Handles context management and summarization.
- **src/store/session-store.ts**: Manages session data persistence.
- **src/context/token-estimate.ts**: Provides token estimation capabilities.
- **src/context/trim.ts**: Implements content trimming based on token constraints.

This system ensures that the chatbot can handle long conversations efficiently while maintaining performance and cost-effectiveness.