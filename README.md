# Chromium Agentic Search Service

A cloud-deployable chat service that answers questions about changes in Chromium by performing agentic retrieval over a specified commit range.

## Features

- 🔍 **Commit Range Analysis**: Parse Gitiles log URLs and analyze changes within a specific commit range
- 🤖 **Agentic Retrieval**: Intelligent retrieval and ranking of relevant commits, diffs, and files
- 📊 **Evidence-Based Answers**: Grounded answers with commit SHAs, file paths, and diff excerpts
- ⚡ **Optimized Performance**: Handles 2,000-7,000 commits with intelligent caching
- 🐳 **Docker Ready**: Full Docker Compose setup for local development and cloud deployment

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- OpenAI API key (optional, for LLM-enhanced features)

### Local Development

1. **Clone and install dependencies**:
   ```bash
   npm install
   ```

2. **Set up environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Start infrastructure** (PostgreSQL and Redis):
   ```bash
   docker-compose -f infra/docker/docker-compose.dev.yml up -d
   ```

4. **Run database migrations**:
   ```bash
   npm run db:migrate -w apps/api
   ```

5. **Start the development server**:
   ```bash
   npm run dev
   ```

The API will be available at `http://localhost:3000`.

### Docker Deployment

1. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

2. **Build and start**:
   ```bash
   docker-compose -f infra/docker/docker-compose.yml up --build -d
   ```

## API Usage

### Create a Session

```bash
curl -X POST http://localhost:3000/v1/sessions
```

Response:
```json
{
  "sessionId": "sess_abc123...",
  "scope": {
    "rangeEnabled": true,
    "range": null,
    "pathScope": []
  }
}
```

### Set Commit Range from Gitiles URL

```bash
curl -X POST http://localhost:3000/v1/sessions/{sessionId}/scope \
  -H "Content-Type: application/json" \
  -d '{
    "rangeUrl": "https://chromium.googlesource.com/chromium/src/+log/abc123..def456"
  }'
```

### Send a Chat Message

```bash
curl -X POST http://localhost:3000/v1/sessions/{sessionId}/messages \
  -H "Content-Type: application/json" \
  -d '{
    "text": "What changes were made to the network stack?"
  }'
```

Response:
```json
{
  "answer": "## Answer\n\nSeveral changes were made to the network stack...",
  "evidence": [
    {
      "type": "commit",
      "sha": "abc123...",
      "url": "https://chromium.googlesource.com/chromium/src/+/abc123...",
      "whyRelevant": "Modifies net/http/..."
    }
  ],
  "debug": {
    "runId": "run_xyz...",
    "toolCalls": [...],
    "rankedCandidates": [...]
  }
}
```

## Project Structure

```
.
├── apps/
│   └── api/                 # Express API server
│       ├── src/
│       │   ├── routes/      # API route handlers
│       │   ├── services/    # Business logic
│       │   └── middleware/  # Express middleware
│       └── prisma/          # Database schema
├── packages/
│   ├── shared/              # Shared types, config, utilities
│   ├── tools/               # Gitiles client and tools
│   └── agent/               # Agent orchestrator
├── infra/
│   └── docker/              # Docker configuration
├── evals/                   # Evaluation harness
└── README.md
```

## Configuration

All configuration is via environment variables. See `.env.example` for all options.

### Key Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key for LLM features | - |
| `OPENAI_BASE_URL` | Custom base URL for OpenAI-compatible APIs (Azure, Ollama, vLLM, etc.) | - |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/chromium_search` |
| `MAX_TOOL_CALLS_PER_RUN` | Budget for tool calls | `12` |
| `RUN_TIMEOUT_MS` | Timeout for agent runs | `110000` (110s) |
| `MAX_COMMITS_DEFAULT` | Max commits to fetch | `7000` |

### Using Custom LLM Providers

The service supports any OpenAI-compatible API by setting `OPENAI_BASE_URL`:

```bash
# Azure OpenAI
OPENAI_BASE_URL=https://your-resource.openai.azure.com

# Local Ollama
OPENAI_BASE_URL=http://localhost:11434/v1

# vLLM
OPENAI_BASE_URL=http://localhost:8000/v1
```

## How It Works

### 1. URL Parsing

The service parses Gitiles log URLs to extract commit ranges:
```
https://chromium.googlesource.com/chromium/src/+log/<A>..<B>?pretty=fuller
```

### 2. Commit Retrieval

Commits are fetched via Gitiles JSON API with pagination support and caching.

### 3. Ranking

Commits are ranked using:
- Lexical matching on titles and messages
- Path scope filtering
- Optional LLM-based reranking

### 4. Deep Dive

Top candidates are analyzed with:
- Full commit details
- Diff excerpts
- File content at specific revisions

### 5. Answer Synthesis

The final answer includes:
- Direct answer to the question
- Change summary bullets
- Evidence with links and excerpts

## Testing

```bash
# Run unit tests
npm test

# Run integration tests (requires network)
RUN_INTEGRATION_TESTS=true npm run test:integration -w packages/tools
```

## Evaluation

Run the evaluation harness:

```bash
# Quick evaluation (fast cases only)
npm run eval:quick -w evals

# Full evaluation
npm run eval -w evals
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        API Server                            │
│  ┌─────────┐  ┌───────────┐  ┌──────────────────────────┐   │
│  │ Routes  │──│ Services  │──│ Agent Orchestrator       │   │
│  └─────────┘  └───────────┘  │  ┌────────────────────┐  │   │
│                              │  │ Query Analysis     │  │   │
│                              │  │ Commit Retrieval   │  │   │
│                              │  │ Ranking            │  │   │
│                              │  │ Deep Dive          │  │   │
│                              │  │ Answer Synthesis   │  │   │
│                              │  └────────────────────┘  │   │
│                              └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
    ┌───────────┐      ┌───────────┐       ┌───────────┐
    │ Gitiles   │      │ PostgreSQL│       │   Redis   │
    │ (HTTP)    │      │ (Sessions)│       │  (Cache)  │
    └───────────┘      └───────────┘       └───────────┘
```

## API Reference

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/sessions` | Create a new session |
| `GET` | `/v1/sessions/:id` | Get session details |
| `POST` | `/v1/sessions/:id/scope` | Update session scope |
| `DELETE` | `/v1/sessions/:id` | Delete a session |
| `POST` | `/v1/sessions/:id/messages` | Send a chat message |
| `GET` | `/v1/sessions/:id/history` | Get chat history |
| `GET` | `/health` | Health check |
| `GET` | `/health/ready` | Readiness check |

### Request Headers

| Header | Description |
|--------|-------------|
| `X-Include-Debug: true` | Include debug info in response |

## Development

### Building

```bash
npm run build
```

### Linting

```bash
npm run lint
npm run lint:fix
```

### Type Checking

```bash
npm run typecheck
```

## License

MIT
