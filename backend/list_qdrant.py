from qdrant_client import QdrantClient
from app.config import get_settings

s = get_settings()
client = QdrantClient(url=s.QDRANT_URL, api_key=s.QDRANT_API_KEY)
result = client.scroll(collection_name=s.QDRANT_COLLECTION, limit=20, with_payload=True, with_vectors=False)
points = result[0]
for p in points:
    pl = p.payload
    sha = str(pl.get("commit_sha", "?"))[:12]
    func = pl.get("function_name", "?")
    fpath = pl.get("file_path", "?")
    body = str(pl.get("code_body", ""))[:80]
    print(f"  {sha}  {func}  {fpath}")
    print(f"    code: {body}...")
print(f"Total stored embeddings: {len(points)}")
