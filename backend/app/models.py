from __future__ import annotations

from pathlib import Path
from typing import List

from pydantic import BaseModel


class CommitDocument(BaseModel):
    commit: str
    subject: str
    message: str
    author: str
    authored_time: str
    commit_url: str
    source_path: Path


class UploadResponse(BaseModel):
    chat_id: str
    commit_count: int


class ChatRequest(BaseModel):
    message: str


class Source(BaseModel):
    commit: str
    subject: str
    commit_url: str


class ChatResponse(BaseModel):
    answer: str
    sources: List[Source]
