"""
SemanticVCS Backend — FastAPI Application.

Main entry point that initializes all cloud service clients,
loads the ML model, and mounts all API routes.
"""

import logging
import time
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from qdrant_client import AsyncQdrantClient
from supabase import create_client

from app.config import get_settings
from app.services.qdrant_service import QdrantService
from app.services.supabase_service import SupabaseService
from app.services.redis_service import RedisService
from app.services.neo4j_service import Neo4jService

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("semanticvcs")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan — runs on startup and shutdown.

    Startup:
      - Connect to Qdrant Cloud
      - Connect to Supabase (PostgreSQL)
      - Connect to Upstash (Redis)
      - Load UniXCoder ONNX model
      - Ensure Qdrant collection exists

    Shutdown:
      - Close all connections
    """
    settings = get_settings()
    logger.info("🚀 Starting SemanticVCS Backend...")
    app.state.start_time = time.time()

    # === 1. Qdrant Cloud ===
    logger.info(f"Connecting to Qdrant: {settings.QDRANT_URL}")
    qdrant_client = AsyncQdrantClient(
        url=settings.QDRANT_URL,
        api_key=settings.QDRANT_API_KEY if settings.QDRANT_API_KEY else None,
        timeout=30,
    )
    qdrant_service = QdrantService(qdrant_client)
    await qdrant_service.ensure_collection()
    app.state.qdrant_service = qdrant_service
    logger.info("✅ Qdrant connected")

    # === 2. Supabase (PostgreSQL) ===
    logger.info("Connecting to Supabase...")
    supabase_client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
    supabase_service = SupabaseService(supabase_client)
    app.state.supabase_service = supabase_service
    logger.info("✅ Supabase connected")

    # === 3. Upstash (Redis) ===
    logger.info("Connecting to Redis (Upstash)...")
    redis_client = aioredis.from_url(
        settings.UPSTASH_REDIS_URL,
        decode_responses=True,
        socket_timeout=10,
    )
    redis_service = RedisService(redis_client)
    app.state.redis_service = redis_service
    logger.info("✅ Redis connected")

    # === 4. Load UniXCoder Model ===
    try:
        from app.core.embedder import CodeEmbedder
        embedder = CodeEmbedder(settings.TOKENIZER_NAME)
        app.state.embedder = embedder
        logger.info("UniXCoder model loaded successfully")
    except Exception as e:
        logger.warning(f"Could not load UniXCoder model: {e}")
        logger.warning("   The /analyze endpoint will not work until the model is loaded.")
        app.state.embedder = None

    # === 5. Neo4j (Knowledge Graph) ===
    try:
        if settings.NEO4J_URI:
            logger.info("Connecting to Neo4j...")
            neo4j_service = Neo4jService(
                uri=settings.NEO4J_URI,
                user=settings.NEO4J_USER,
                password=settings.NEO4J_PASSWORD,
            )
            await neo4j_service.verify_connectivity()
            await neo4j_service.ensure_indexes()
            app.state.neo4j_service = neo4j_service
        else:
            logger.warning("NEO4J_URI not set — Knowledge Graph disabled")
            app.state.neo4j_service = None
    except Exception as e:
        logger.warning(f"Could not connect to Neo4j (continuing without KG): {e}")
        app.state.neo4j_service = None

    logger.info("🟢 SemanticVCS Backend is ready!")
    logger.info(f"   API docs: http://{settings.API_HOST}:{settings.API_PORT}/docs")

    yield  # Application runs here

    # === Shutdown ===
    logger.info("Shutting down SemanticVCS Backend...")
    await qdrant_client.close()
    await redis_service.close()
    if app.state.neo4j_service:
        await app.state.neo4j_service.close()
    logger.info("👋 Goodbye!")


# === Create FastAPI App ===

app = FastAPI(
    title="SemanticVCS API",
    description=(
        "Semantic memory layer for Git. Embeds function-level code changes, "
        "searches for similar past commits, and warns developers about risky patterns."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# === CORS Middleware ===
# Allow VS Code extension and any frontend to communicate
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # VS Code extension uses vscode-webview:// origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === Mount Routes ===
from app.api.routes.health import router as health_router
from app.api.routes.auth import router as auth_router
from app.api.routes.history import router as history_router

app.include_router(health_router)
app.include_router(auth_router)
app.include_router(history_router)

from app.api.routes.analyze import router as analyze_router
from app.api.routes.backfill import router as backfill_router
from app.api.routes.webhooks import router as webhooks_router
app.include_router(analyze_router)
app.include_router(backfill_router)
app.include_router(webhooks_router)


from fastapi import Request
from fastapi.responses import JSONResponse
import traceback

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Global unhandled exception: {exc}")
    # Return stack trace during development to debug 500 errors
    trace = traceback.format_exc()
    logger.error(trace)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal Server Error", "trace": trace, "error": str(exc)}
    )


@app.get("/", tags=["Root"])
async def root():
    """API root — returns basic info."""
    return {
        "service": "SemanticVCS API",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health",
    }
