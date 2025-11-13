from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, field_validator


load_dotenv()


class Settings(BaseModel):
    openai_api_key: str | None = os.getenv("OPENAI_API_KEY")
    openai_base_url: str | None = os.getenv("OPENAI_BASE_URL")
    openai_completion_model: str = os.getenv("OPENAI_COMPLETION_MODEL", "gpt-4o-mini")
    openai_embedding_model: str = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
    data_dir: Path = Path(os.getenv("DATA_DIR", "data"))
    max_context_commits: int = int(os.getenv("MAX_CONTEXT_COMMITS", "5"))

    @field_validator("data_dir", mode="before")
    @classmethod
    def _ensure_path(cls, value: str | Path) -> Path:
        return Path(value)

    model_config = {"arbitrary_types_allowed": True}


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return settings
