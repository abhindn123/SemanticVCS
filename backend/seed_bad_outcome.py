"""
Seed script: Mark the most recent commit as "reverted" in Supabase
so that similar future code triggers risk warnings.
"""
import os
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_KEY")
client = create_client(url, key)

# Get the repo
repos = client.table("repositories").select("*").eq("name", "test-shop").execute()
if not repos.data:
    print("No test-shop repo found!")
    exit(1)

repo_id = repos.data[0]["id"]
print(f"Repo: {repo_id}")

# Get the most recent commits
commits = client.table("commits").select("*").eq("repo_id", repo_id).order("created_at", desc=True).limit(3).execute()

if not commits.data:
    print("No commits found!")
    exit(1)

# Mark the first (most recent) commit as reverted
commit = commits.data[0]
print(f"Marking commit {commit['sha']} as REVERTED...")

client.table("commits").update({
    "revert_status": True,
}).eq("id", commit["id"]).execute()

print(f"✅ Done! Commit '{commit['sha']}' is now marked as reverted.")
print()
print("Now go to test-shop and commit a function that is SIMILAR to the code")
print("stored in that commit. The system will detect the similarity and warn you!")
