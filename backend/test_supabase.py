import asyncio
from supabase import create_client

from app.config import get_settings
from app.services.supabase_service import SupabaseService

async def main():
    settings = get_settings()
    client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
    service = SupabaseService(client)
    
    # 1. Get user by API key (simulate auth middleware)
    api_key = "svcs_XXxnDzU8GKd1BQ_T5AHO-DB8gfKXmtGuN4A2avbDs-s"
    user = await service.get_user_by_api_key(api_key)
    print("User:", user)

    # 2. Get or create repo
    repo = await service.get_or_create_repo(user["id"], "test-shop")
    print("Repo:", repo)

    # 3. Get warning stats
    try:
        stats = await service.get_warning_stats(repo["id"])
        print("Stats:", stats)
    except Exception as e:
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
