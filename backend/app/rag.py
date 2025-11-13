from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import Iterable, List, Sequence

import numpy as np

from .config import get_settings
from .models import CommitDocument, Source
from .storage import load_documents, save_documents
from .vector_store import cosine_similarity, embed_text, embed_texts, top_k_indices


SETTINGS = get_settings()


def strip_xssi_preamble(raw: str) -> str:
    # Chromium responses start with )]}'
    preamble = ")]}'"
    stripped = raw.lstrip()
    if stripped.startswith(preamble):
        stripped = stripped[len(preamble):]
    return stripped.lstrip()


def parse_changelog(raw: str, source_path: Path) -> List[CommitDocument]:
    try:
        payload = json.loads(strip_xssi_preamble(raw))
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid Chromium changelog JSON.") from exc
    documents: List[CommitDocument] = []
    for entry in payload.get("log", []):
        commit = entry.get("commit")
        message = entry.get("message", "")
        subject = message.splitlines()[0] if message else "(no subject)"
        author_info = entry.get("author") or {}
        author = author_info.get("name", "Unknown")
        email = author_info.get("email")
        if email:
            author = f"{author} <{email}>"
        authored_time = author_info.get("time", "")
        doc = CommitDocument(
            commit=commit,
            subject=subject,
            message=message,
            author=author,
            authored_time=authored_time,
            commit_url=f"https://chromium.googlesource.com/chromium/src/+/{commit}",
            source_path=source_path,
        )
        documents.append(doc)
    return documents


def build_embeddings(chat_id: str, documents: Sequence[CommitDocument]) -> np.ndarray:
    inputs = [render_document_for_embedding(doc) for doc in documents]
    embeddings = embed_texts(inputs)
    save_documents(chat_id, documents, embeddings)
    return embeddings


def render_document_for_embedding(doc: CommitDocument) -> str:
    return textwrap.dedent(
        f"""
        Commit: {doc.commit}
        Subject: {doc.subject}
        Author: {doc.author}
        Authored-Time: {doc.authored_time}
        Commit-URL: {doc.commit_url}
        Message:
        {doc.message}
        """
    ).strip()


def retrieve_context(chat_id: str, question: str) -> list[CommitDocument]:
    documents, embeddings = load_documents(chat_id)
    query_embedding = embed_text(question)
    scores = cosine_similarity(query_embedding, embeddings)
    top_indices = top_k_indices(scores, SETTINGS.max_context_commits)
    ranked = sorted(((idx, scores[idx]) for idx in top_indices), key=lambda x: x[1], reverse=True)
    return [documents[idx] for idx, _ in ranked]


def render_context_snippet(documents: Iterable[CommitDocument]) -> str:
    snippets = []
    for doc in documents:
        snippet = textwrap.dedent(
            f"""
            Commit: {doc.commit}
            Subject: {doc.subject}
            Author: {doc.author}
            Authored-Time: {doc.authored_time}
            Commit-URL: {doc.commit_url}
            Message:
            {doc.message.strip()}
            """
        ).strip()
        snippets.append(snippet)
    return "\n\n---\n\n".join(snippets)


def build_sources(documents: Iterable[CommitDocument]) -> List[Source]:
    return [
        Source(commit=doc.commit, subject=doc.subject, commit_url=doc.commit_url)
        for doc in documents
    ]


