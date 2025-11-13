# Chromium Changelog Chat

A containerized FastAPI application that lets you upload Chromium changelog JSON files and chat with an OpenAI-powered assistant about the commits. The assistant performs retrieval-augmented generation (RAG) over the changelog and always cites the relevant commit hashes and source URLs.

## Features

- Upload Chromium changelog JSON (same format as `?format=JSON` responses) to create a dedicated chat session
- Automatic parsing of commit metadata and generation of dense embeddings per commit
- Retrieval of the most relevant commits for each question with enforced commit URL citations
- Lightweight chat UI served from the FastAPI backend
- Container-ready with `.env` configuration for OpenAI-compatible models

## Prerequisites

- Python 3.11+
- An OpenAI API key or compatible endpoint that supports chat completions and embeddings
- Docker (optional, for containerized deployment)

## Environment Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Required variables:

- `OPENAI_API_KEY` – your OpenAI (or compatible) API key
- `OPENAI_BASE_URL` – API base URL; default is `https://api.openai.com/v1`
- `OPENAI_COMPLETION_MODEL` – chat completion model (default `gpt-4o-mini`)
- `OPENAI_EMBEDDING_MODEL` – embedding model (default `text-embedding-3-large`)
- `DATA_DIR` – directory where uploaded files, embeddings, and conversations are stored (`data` by default)
- `MAX_CONTEXT_COMMITS` – how many commits to include in the context window (default `5`)

## Running Locally (without Docker)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 to access the UI.

## Running with Docker

Build and start the container with Docker Compose:

```bash
docker compose up --build
```

The service will be available at http://localhost:8000. Uploaded data and embeddings are stored under `data/`, which is mounted into the container for persistence.

## Project Structure

```
backend/           # FastAPI backend and RAG logic
  app/
    main.py        # API routes and startup
    rag.py         # Changelog parsing, embeddings, retrieval
    storage.py     # Session persistence helpers
    vector_store.py# Embedding helpers
frontend/          # Static assets served by FastAPI
  index.html
  styles.css
  app.js
Dockerfile         # Container image definition
docker-compose.yml # Local orchestration with env + volume
.env.example       # Sample environment configuration
```

## Usage Flow

1. Visit the site and upload a Chromium changelog JSON file (e.g. from the public `+log/... ?format=JSON` endpoint).
2. After ingestion, a chat session is created with embeddings for each commit.
3. Ask freeform questions about the release. Responses cite the commit IDs and `chromium.googlesource.com` URLs used to answer.
4. Upload a different file to begin a new chat session.

## Notes

- The JSON parser automatically strips Chromium's XSSI preamble (`)]}'`).
- Embeddings are stored per chat under `DATA_DIR/<chat_id>/` for reuse within the session.
- If the assistant cannot answer from the available context, it responds explicitly rather than fabricating.

## Troubleshooting

- Ensure your environment variables are set before starting the app; missing credentials will raise a server error.
- If you change the embedding or completion model names, make sure the chosen models are supported by your OpenAI-compatible endpoint.
- Large changelog files may take time to embed; monitor server logs for progress if requests appear slow.
