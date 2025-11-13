from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, List, MutableSequence

import numpy as np

from .config import get_settings
from .models import CommitDocument


SETTINGS = get_settings()


def _chat_dir(chat_id: str) -> Path:
    path = SETTINGS.data_dir / chat_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_raw_json(chat_id: str, content: str) -> Path:
    path = _chat_dir(chat_id) / "source.json"
    path.write_text(content, encoding="utf-8")
    return path


def save_documents(chat_id: str, documents: Iterable[CommitDocument], embeddings: np.ndarray) -> None:
    docs = []
    for doc in documents:
        data = doc.model_dump()
        data["source_path"] = str(doc.source_path)
        docs.append(data)

    docs_path = _chat_dir(chat_id) / "documents.json"
    docs_path.write_text(json.dumps(docs, indent=2), encoding="utf-8")

    embedding_path = _chat_dir(chat_id) / "embeddings.npy"
    np.save(embedding_path, embeddings.astype(np.float32))


def load_documents(chat_id: str) -> tuple[List[CommitDocument], np.ndarray]:
    docs_path = _chat_dir(chat_id) / "documents.json"
    embedding_path = _chat_dir(chat_id) / "embeddings.npy"

    if not docs_path.exists() or not embedding_path.exists():
        raise FileNotFoundError(f"Embeddings for chat {chat_id} not found")

    docs_raw = json.loads(docs_path.read_text(encoding="utf-8"))
    documents = [
        CommitDocument(**{**item, "source_path": Path(item["source_path"])}) for item in docs_raw
    ]
    embeddings = np.load(embedding_path)
    return documents, embeddings


def load_conversation(chat_id: str) -> List[dict]:
    path = _chat_dir(chat_id) / "conversation.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_conversation(chat_id: str, conversation: MutableSequence[dict]) -> None:
    path = _chat_dir(chat_id) / "conversation.json"
    path.write_text(json.dumps(list(conversation), indent=2), encoding="utf-8")
