"""
Neo4j Knowledge Graph Service.

Stores code dependency relationships:
  - Files → import → Files
  - Functions → call → Functions
  - Functions → use → Database Tables / APIs
  - Commits → modify → Functions

Used alongside Qdrant (vector similarity) for combined risk detection.
"""

import logging
from typing import Optional

from neo4j import AsyncGraphDatabase

logger = logging.getLogger(__name__)


class Neo4jService:
    """Async Neo4j driver wrapper for the code knowledge graph."""

    def __init__(self, uri: str, user: str, password: str):
        self.driver = AsyncGraphDatabase.driver(uri, auth=(user, password))
        logger.info(f"Neo4j driver created for {uri}")

    async def verify_connectivity(self):
        """Test the connection to Neo4j."""
        await self.driver.verify_connectivity()
        logger.info("✅ Neo4j connected")

    async def close(self):
        """Close the Neo4j driver."""
        await self.driver.close()
        logger.info("Neo4j connection closed")

    # ── Schema Setup ──────────────────────────────────────────

    async def ensure_indexes(self):
        """Create indexes for fast lookups."""
        queries = [
            "CREATE INDEX IF NOT EXISTS FOR (f:File) ON (f.path)",
            "CREATE INDEX IF NOT EXISTS FOR (fn:Function) ON (fn.name, fn.file_path)",
            "CREATE INDEX IF NOT EXISTS FOR (c:Commit) ON (c.sha)",
            "CREATE INDEX IF NOT EXISTS FOR (t:Table) ON (t.name)",
            "CREATE INDEX IF NOT EXISTS FOR (a:API) ON (a.url)",
        ]
        async with self.driver.session() as session:
            for q in queries:
                await session.run(q)
        logger.info("Neo4j indexes ensured")

    # ── Node & Edge Creation ──────────────────────────────────

    async def store_file_relationships(
        self,
        file_path: str,
        repo_id: str,
        imports: list[str],
        function_names: list[str],
        table_usages: list[str],
        api_calls: list[str],
        commit_sha: str,
        is_reverted: bool = False,
    ):
        """
        Store a file's dependency graph in Neo4j.

        Creates nodes for files, functions, tables, APIs
        and edges for imports, contains, uses_table, calls_api, modified_by.
        """
        async with self.driver.session() as session:
            await session.run(
                """
                MERGE (f:File {path: $file_path, repo_id: $repo_id})
                MERGE (c:Commit {sha: $commit_sha, repo_id: $repo_id})
                SET c.is_reverted = $is_reverted
                MERGE (c)-[:MODIFIES]->(f)
                """,
                file_path=file_path,
                repo_id=repo_id,
                commit_sha=commit_sha,
                is_reverted=is_reverted,
            )

            # Import edges
            for imp in imports:
                await session.run(
                    """
                    MERGE (f:File {path: $file_path, repo_id: $repo_id})
                    MERGE (imported:File {path: $imported_path, repo_id: $repo_id})
                    MERGE (f)-[:IMPORTS]->(imported)
                    """,
                    file_path=file_path,
                    repo_id=repo_id,
                    imported_path=imp,
                )

            # Function nodes
            for fn_name in function_names:
                await session.run(
                    """
                    MERGE (f:File {path: $file_path, repo_id: $repo_id})
                    MERGE (fn:Function {name: $fn_name, file_path: $file_path, repo_id: $repo_id})
                    MERGE (f)-[:CONTAINS]->(fn)
                    MERGE (c:Commit {sha: $commit_sha, repo_id: $repo_id})
                    MERGE (c)-[:MODIFIES]->(fn)
                    """,
                    file_path=file_path,
                    repo_id=repo_id,
                    fn_name=fn_name,
                    commit_sha=commit_sha,
                )

            # Table usage edges
            for table in table_usages:
                await session.run(
                    """
                    MERGE (f:File {path: $file_path, repo_id: $repo_id})
                    MERGE (t:Table {name: $table_name, repo_id: $repo_id})
                    MERGE (f)-[:USES_TABLE]->(t)
                    """,
                    file_path=file_path,
                    repo_id=repo_id,
                    table_name=table,
                )

            # API call edges
            for api_url in api_calls:
                await session.run(
                    """
                    MERGE (f:File {path: $file_path, repo_id: $repo_id})
                    MERGE (a:API {url: $api_url, repo_id: $repo_id})
                    MERGE (f)-[:CALLS_API]->(a)
                    """,
                    file_path=file_path,
                    repo_id=repo_id,
                    api_url=api_url,
                )

    # ── Risk Queries ──────────────────────────────────────────

    async def get_dependency_risk(
        self,
        file_path: str,
        repo_id: str,
    ) -> dict:
        """
        Query the knowledge graph for dependency-based risk.

        Checks:
        1. Does this file share tables/APIs with reverted commits?
        2. Do files that import this file have revert history?
        3. What's the "blast radius" — how many files depend on this?

        Returns:
            {
                "graph_risk_score": float (0-1),
                "shared_reverted_tables": [...],
                "shared_reverted_apis": [...],
                "dependent_files": [...],
                "reverted_neighbors": [...],
                "blast_radius": int,
            }
        """
        result = {
            "graph_risk_score": 0.0,
            "shared_reverted_tables": [],
            "shared_reverted_apis": [],
            "dependent_files": [],
            "reverted_neighbors": [],
            "blast_radius": 0,
        }

        async with self.driver.session() as session:
            # 1. Find tables used by this file that were also used by reverted commits
            res = await session.run(
                """
                MATCH (f:File {path: $file_path, repo_id: $repo_id})-[:USES_TABLE]->(t:Table)
                MATCH (other:File)-[:USES_TABLE]->(t)
                MATCH (c:Commit {is_reverted: true})-[:MODIFIES]->(other)
                WHERE other.path <> $file_path
                RETURN DISTINCT t.name AS table_name, other.path AS reverted_file, c.sha AS reverted_sha
                """,
                file_path=file_path,
                repo_id=repo_id,
            )
            records = await res.data()
            for r in records:
                result["shared_reverted_tables"].append(r["table_name"])
                result["reverted_neighbors"].append(
                    f"{r['reverted_file']} (commit {r['reverted_sha'][:7]})"
                )

            # 2. Find APIs used by this file that were also used by reverted commits
            res = await session.run(
                """
                MATCH (f:File {path: $file_path, repo_id: $repo_id})-[:CALLS_API]->(a:API)
                MATCH (other:File)-[:CALLS_API]->(a)
                MATCH (c:Commit {is_reverted: true})-[:MODIFIES]->(other)
                WHERE other.path <> $file_path
                RETURN DISTINCT a.url AS api_url, other.path AS reverted_file
                """,
                file_path=file_path,
                repo_id=repo_id,
            )
            records = await res.data()
            for r in records:
                result["shared_reverted_apis"].append(r["api_url"])

            # 3. Blast radius — how many files depend on this file?
            res = await session.run(
                """
                MATCH (other:File)-[:IMPORTS*1..3]->(f:File {path: $file_path, repo_id: $repo_id})
                RETURN DISTINCT other.path AS dependent_file
                """,
                file_path=file_path,
                repo_id=repo_id,
            )
            records = await res.data()
            result["dependent_files"] = [r["dependent_file"] for r in records]
            result["blast_radius"] = len(result["dependent_files"])

        # Calculate graph risk score
        risk = 0.0
        if result["shared_reverted_tables"]:
            risk += 0.5  # High risk: shares DB tables with reverted code
        if result["shared_reverted_apis"]:
            risk += 0.3  # Medium risk: shares APIs with reverted code
        if result["blast_radius"] > 3:
            risk += 0.2  # Risk: many files depend on this

        result["graph_risk_score"] = min(risk, 1.0)

        return result

    # ── Stats ─────────────────────────────────────────────────

    async def get_graph_stats(self, repo_id: str) -> dict:
        """Get knowledge graph statistics for a repo."""
        async with self.driver.session() as session:
            res = await session.run(
                """
                MATCH (f:File {repo_id: $repo_id}) WITH count(f) AS files
                MATCH (fn:Function {repo_id: $repo_id}) WITH files, count(fn) AS functions
                MATCH (t:Table {repo_id: $repo_id}) WITH files, functions, count(t) AS tables
                MATCH (c:Commit {repo_id: $repo_id}) WITH files, functions, tables, count(c) AS commits
                RETURN files, functions, tables, commits
                """,
                repo_id=repo_id,
            )
            record = await res.single()
            if record:
                return dict(record)
            return {"files": 0, "functions": 0, "tables": 0, "commits": 0}

    async def get_blast_radius(self, file_path: str, repo_id: str) -> dict:
        """
        Get detailed blast radius for a file — which files depend on it
        and which specific functions they use.

        Returns:
            {
                "changed_file": str,
                "dependent_files": [
                    {"file": "orders.py", "uses": ["sanitize_input", "hash_password"]},
                    ...
                ],
                "total_affected": int,
                "affected_functions": [...],
            }
        """
        result = {
            "changed_file": file_path,
            "dependent_files": [],
            "total_affected": 0,
            "affected_functions": [],
        }

        async with self.driver.session() as session:
            # Find files that import the changed file + which functions they use
            res = await session.run(
                """
                MATCH (dep:File {repo_id: $repo_id})-[:IMPORTS]->(changed:File {path: $file_path, repo_id: $repo_id})
                OPTIONAL MATCH (changed)-[:CONTAINS]->(fn:Function)
                RETURN dep.path AS dependent_file,
                       collect(DISTINCT fn.name) AS functions_used
                """,
                file_path=file_path,
                repo_id=repo_id,
            )
            records = await res.data()

            for r in records:
                result["dependent_files"].append({
                    "file": r["dependent_file"],
                    "uses": [f for f in r["functions_used"] if f],
                })

            # Also check transitive dependencies (depth 2-3)
            res = await session.run(
                """
                MATCH (dep:File {repo_id: $repo_id})-[:IMPORTS*2..3]->(changed:File {path: $file_path, repo_id: $repo_id})
                WHERE NOT (dep)-[:IMPORTS]->(changed)
                RETURN DISTINCT dep.path AS dependent_file
                """,
                file_path=file_path,
                repo_id=repo_id,
            )
            records = await res.data()
            for r in records:
                result["dependent_files"].append({
                    "file": r["dependent_file"],
                    "uses": ["(indirect dependency)"],
                })

            result["total_affected"] = len(result["dependent_files"])

            # Get all functions in the changed file
            res = await session.run(
                """
                MATCH (f:File {path: $file_path, repo_id: $repo_id})-[:CONTAINS]->(fn:Function)
                RETURN fn.name AS function_name
                """,
                file_path=file_path,
                repo_id=repo_id,
            )
            records = await res.data()
            result["affected_functions"] = [r["function_name"] for r in records]

        return result
