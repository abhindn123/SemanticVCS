"""
SemanticVCS Backend Configuration.

Loads all environment variables via Pydantic Settings.
All cloud service credentials are loaded from .env file or environment variables.
"""

from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # --- API Server ---
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8000
    API_VERSION: str = "v1"
    DEBUG: bool = False

    # --- Authentication ---
    JWT_SECRET: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRY_HOURS: int = 72
    API_KEY_PREFIX: str = "svcs_"

    # --- Qdrant Cloud (Vector Database) ---
    QDRANT_URL: str = "http://localhost:6333"
    QDRANT_API_KEY: str = ""
    QDRANT_COLLECTION: str = "code_embeddings"
    QDRANT_VECTOR_SIZE: int = 768

    # --- Supabase (PostgreSQL) ---
    SUPABASE_URL: str = ""
    SUPABASE_KEY: str = ""

    # --- Upstash (Redis) ---
    UPSTASH_REDIS_URL: str = "redis://localhost:6379"

    # --- Gemini API ---
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-2.0-flash"

    # --- ML Model ---
    MODEL_PATH: str = "model/unixcoder-base.onnx"
    TOKENIZER_NAME: str = "microsoft/unixcoder-base"
    MAX_TOKEN_LENGTH: int = 512

    # --- Similarity ---
    SIMILARITY_THRESHOLD: float = 0.80
    MAX_SEARCH_RESULTS: int = 10

    # --- Rate Limiting ---
    RATE_LIMIT_PER_MINUTE: int = 200

    # --- Neo4j (Knowledge Graph) ---
    NEO4J_URI: str = ""
    NEO4J_USER: str = "neo4j"
    NEO4J_PASSWORD: str = ""

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
