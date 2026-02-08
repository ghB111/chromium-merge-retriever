# Chromium Agentic Search Service

A cloud-deployable chat service that answers questions about changes in Chromium by performing agentic retrieval over a specified commit range.

## Features

- 🔍 **Commit Range Analysis**: Parse Gitiles log URLs and analyze changes within a specific commit range
- 🤖 **Agentic Retrieval**: Intelligent retrieval and ranking of relevant commits, diffs, and files
- 📊 **Evidence-Based Answers**: Grounded answers with commit SHAs, file paths, and diff excerpts
- 💬 **Observability out of the box**: See detailed logs of all llm queries in the web interface
- 🐳 **Docker Ready**: Full Docker Compose setup for local development and cloud deployment

![Web Interface](docs/screenshot.png)

## Quick Start

### Docker Deployment

1. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

2. **Build all packages**:
   ```bash
   npm install
   npm run build
   ```

3. **Start with Docker Compose**:
   ```bash
   docker-compose -f infra/docker/docker-compose.yml up --build -d
   ```

- **Web UI**: http://localhost:8080
- **API**: http://localhost:3000


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

5. **Start the development servers**:
   ```bash
   # Start API server (terminal 1)
   npm run dev

   # Start web UI (terminal 2)
   npm run dev:web
   ```

- **Web UI**: http://localhost:5173
- **API**: http://localhost:3000

### Usage

1. **Set a commit range**: Paste a Gitiles log URL (e.g., `https://chromium.googlesource.com/chromium/src/+log/abc123..def456`)
2. **Optional: Add path scope**: Limit search to specific directories (e.g., `net/`, `base/`)
3. **Ask questions**: Type your question about the changes in the range

### Example Questions

- "What changes were made to the network stack?"
- "What are new-coming AI features integrated to chromium?"
- "Why was GetBrowsersList() method deleted and what should we use now instead?"
- "Show me changes to class HttpStreamFactory"
- "Summarize all changes made to the autofill component"

## Configuration

All configuration is via environment variables. See `.env.example` for all options.

## How It Works

### 1. URL Parsing

The service parses Gitiles log URLs to extract commit ranges:
```
https://chromium.googlesource.com/chromium/src/+log/<A>..<B>?pretty=fuller
```

### 2. Commit Retrieval

Depending on a configuration parameter, the actual commit storage used for queries is either a local 
git checkout mounted into the backend container, or a remote gitiles server. The preferred way is a local checkout which works faster due
to chromium gitiles having large timeouts. Keep in mind though that a full local chromium checkout will take up >100gb of disk storage.

### 3. Agent loop && tools

In order to synthesize an answer, the agent is given several tools to investigate the commit history and source files.
For example, the bot can query commit history by keywords, then analyze the commit messages, the diffs and other files at that point in
history. The tool set is extensible so quality of answer synthesis can be enhanced. Tool calls and marking of relevant commits is done by a faster model.

### 4. Answer Synthesis

After finding the relevant commits and changes, the agent pefrorms answer synthesis.
The final answer includes:
- Direct answer to the question
- Change summary bullets
- Evidence with commit links and excerpts

Answer synthesis is performed by smarter model then the one calling tools.

## Testing

```bash
# Run unit tests
npm test

# Run integration tests (requires network)
RUN_INTEGRATION_TESTS=true npm run test:integration -w packages/tools
```

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
