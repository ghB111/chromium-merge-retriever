from __future__ import annotations

from typing import Iterable, Sequence

import numpy as np

from .config import get_settings
from .deps import get_openai_client


def embed_texts(texts: Sequence[str]) -> np.ndarray:
    if not texts:
        return np.empty((0, 0), dtype=np.float32)

    client = get_openai_client()
    settings = get_settings()
    response = client.embeddings.create(model=settings.openai_embedding_model, input=list(texts))
    vectors = [np.array(item.embedding, dtype=np.float32) for item in response.data]
    return np.vstack(vectors)


def embed_text(text: str) -> np.ndarray:
    return embed_texts([text])[0]


def cosine_similarity(query: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    if matrix.size == 0:
        return np.empty((0,), dtype=np.float32)

    query_norm = np.linalg.norm(query)
    if query_norm == 0:
        return np.zeros((matrix.shape[0],), dtype=np.float32)

    matrix_norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    matrix_norms[matrix_norms == 0] = 1e-12

    query_unit = query / query_norm
    matrix_unit = matrix / matrix_norms
    return matrix_unit @ query_unit


def top_k_indices(scores: np.ndarray, k: int) -> np.ndarray:
    if scores.size == 0:
        return np.empty((0,), dtype=int)
    k = min(k, scores.shape[0])
    top_indices = np.argpartition(scores, -k)[-k:]
    return top_indices[np.argsort(scores[top_indices])[::-1]]
