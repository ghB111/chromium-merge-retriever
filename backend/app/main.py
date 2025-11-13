from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .deps import get_openai_client
from .models import ChatRequest, ChatResponse, UploadResponse
from .rag import build_embeddings, build_sources, parse_changelog, render_context_snippet, retrieve_context
from .storage import load_conversation, save_conversation, save_raw_json


settings = get_settings()
app = FastAPI(title="Chromium Changelog Chat")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend not found")
    return HTMLResponse(index_path.read_text(encoding="utf-8"))


@app.post("/api/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)) -> UploadResponse:
    if not file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Only JSON files are supported.")

    raw_bytes = await file.read()
    try:
        raw_text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded JSON.") from exc

    chat_id = uuid.uuid4().hex
    source_path = save_raw_json(chat_id, raw_text)

    try:
        documents = parse_changelog(raw_text, source_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not documents:
        raise HTTPException(status_code=400, detail="No commits found in changelog JSON.")

    build_embeddings(chat_id, documents)

    return UploadResponse(chat_id=chat_id, commit_count=len(documents))


@app.post("/api/chat/{chat_id}/question", response_model=ChatResponse)
async def ask_question(chat_id: str, payload: ChatRequest) -> ChatResponse:
    question = payload.message.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question must not be empty.")

    try:
        context_documents = retrieve_context(chat_id, question)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Chat session not found.") from exc

    if not context_documents:
        raise HTTPException(status_code=404, detail="No context available for this chat.")

    context_snippet = render_context_snippet(context_documents)

    history = load_conversation(chat_id)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(history)
    messages.append(
        {
            "role": "user",
            "content": (
                "Use the provided Chromium changelog context to answer the question. "
                "Always mention commit IDs and commit URLs that support your answer. "
                f"\n\nContext:\n{context_snippet}\n\nQuestion: {question}"
            ),
        }
    )

    client = get_openai_client()
    try:
        response = client.chat.completions.create(
            model=settings.openai_completion_model,
            messages=messages,
            temperature=0.2,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"LLM request failed: {exc}") from exc

    if not response.choices:
        raise HTTPException(status_code=500, detail="No response from language model.")

    answer = (response.choices[0].message.content or "").strip()
    if not answer:
        raise HTTPException(status_code=500, detail="Empty response from language model.")

    history.append({"role": "user", "content": question})
    history.append({"role": "assistant", "content": answer})
    save_conversation(chat_id, history)

    sources = build_sources(context_documents)
    return ChatResponse(answer=answer, sources=sources)


SYSTEM_PROMPT = (
    "You are an expert assistant who helps summarize and interpret Chromium changelog entries. "
    "Consult the provided context only, and when answering always quote commit IDs and include the "
    "full commit URLs so users can inspect the changes. If the question cannot be answered from the "
    "context, say so explicitly."
)
