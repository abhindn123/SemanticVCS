# ============================================
# SemanticVCS Backend — Production Dockerfile
# ============================================
# Multi-stage build:
#   Stage 1: Download UniXCoder ONNX model
#   Stage 2: Production Python image
# ============================================

# Stage 1: Download model from HuggingFace
FROM python:3.11-slim AS model-downloader
RUN pip install --no-cache-dir huggingface-hub
RUN python -c "\
from huggingface_hub import hf_hub_download; \
hf_hub_download(\
    repo_id='microsoft/unixcoder-base', \
    filename='onnx/model.onnx', \
    local_dir='/model', \
    local_dir_use_symlinks=False\
)"

# Stage 2: Production
FROM python:3.11-slim

# System dependencies for tree-sitter and ONNX
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Copy model from stage 1
COPY --from=model-downloader /model/ ./model/

# Create non-root user for security
RUN useradd -m -r appuser
USER appuser

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Run with gunicorn + uvicorn workers
CMD ["gunicorn", "app.main:app", \
     "-w", "2", \
     "-k", "uvicorn.workers.UvicornWorker", \
     "--bind", "0.0.0.0:8000", \
     "--timeout", "120", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
