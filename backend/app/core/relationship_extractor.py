"""
Relationship Extractor — Extracts code dependencies for the Knowledge Graph.

Parses source code to find:
  - Import statements (file → imports → file)
  - Database table usage (function → uses → table)
  - API/HTTP calls (function → calls → API)
  - Function names (file → contains → function)
"""

import logging
import re

logger = logging.getLogger(__name__)


def extract_relationships(file_content: str, file_path: str, language: str) -> dict:
    """
    Extract all relationships from a source file.

    Returns:
        {
            "imports": ["./supabase", "../utils"],
            "function_names": ["handleLike", "fetchReviews"],
            "table_usages": ["likes", "visitor_likes"],
            "api_calls": ["https://api.ipify.org"],
        }
    """
    result = {
        "imports": [],
        "function_names": [],
        "table_usages": [],
        "api_calls": [],
    }

    try:
        result["imports"] = _extract_imports(file_content, language)
        result["function_names"] = _extract_function_names(file_content, language)
        result["table_usages"] = _extract_table_usages(file_content)
        result["api_calls"] = _extract_api_calls(file_content)
    except Exception as e:
        logger.warning(f"Relationship extraction failed for {file_path}: {e}")

    logger.info(
        f"KG relationships for {file_path}: "
        f"{len(result['imports'])} imports, "
        f"{len(result['function_names'])} functions, "
        f"{len(result['table_usages'])} tables, "
        f"{len(result['api_calls'])} APIs"
    )

    return result


def _extract_imports(content: str, language: str) -> list[str]:
    """Extract import/require paths from source code."""
    imports = []

    if language in ("typescript", "javascript", "tsx", "jsx"):
        # ES6: import X from 'path'
        for m in re.finditer(r'''import\s+.*?\s+from\s+['"]([^'"]+)['"]''', content):
            imports.append(m.group(1))
        # require('path')
        for m in re.finditer(r'''require\s*\(\s*['"]([^'"]+)['"]\s*\)''', content):
            imports.append(m.group(1))

    elif language == "python":
        # from X import Y
        for m in re.finditer(r'^from\s+([\w.]+)\s+import', content, re.MULTILINE):
            imports.append(m.group(1))
        # import X
        for m in re.finditer(r'^import\s+([\w.]+)', content, re.MULTILINE):
            imports.append(m.group(1))

    return list(set(imports))


def _extract_function_names(content: str, language: str) -> list[str]:
    """Extract function/method names from source code."""
    names = []

    if language in ("typescript", "javascript", "tsx", "jsx"):
        # function name() / async function name()
        for m in re.finditer(r'(?:async\s+)?function\s+(\w+)', content):
            names.append(m.group(1))
        # const name = () => / const name = async () =>
        for m in re.finditer(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(', content):
            names.append(m.group(1))
        # const name = async (
        for m in re.finditer(r'(?:const|let|var)\s+(\w+)\s*=\s*async\s*\(', content):
            names.append(m.group(1))
        # Export function components: export const Name = () =>
        for m in re.finditer(r'export\s+(?:const|function)\s+(\w+)', content):
            names.append(m.group(1))

    elif language == "python":
        # def name( / async def name(
        for m in re.finditer(r'(?:async\s+)?def\s+(\w+)\s*\(', content):
            names.append(m.group(1))

    return list(set(names))


def _extract_table_usages(content: str) -> list[str]:
    """Extract database table names from Supabase/SQL calls."""
    tables = []

    # supabase.from("table_name") or supabase.from('table_name')
    for m in re.finditer(r'''\.from\s*\(\s*['"](\w+)['"]\s*\)''', content):
        tables.append(m.group(1))

    # Prisma: prisma.tableName.findMany()
    for m in re.finditer(r'prisma\.(\w+)\.(?:find|create|update|delete|upsert)', content):
        tables.append(m.group(1))

    # Raw SQL: FROM table_name, INSERT INTO table_name
    for m in re.finditer(r'(?:FROM|INTO|UPDATE|JOIN)\s+["\']?(\w+)["\']?', content, re.IGNORECASE):
        table = m.group(1).lower()
        if table not in ("select", "where", "set", "values", "and", "or", "not"):
            tables.append(table)

    return list(set(tables))


def _extract_api_calls(content: str) -> list[str]:
    """Extract external HTTP API URLs."""
    apis = []

    # fetch("https://...") or axios.get("https://...")
    for m in re.finditer(r'''(?:fetch|axios\.\w+|http\.\w+)\s*\(\s*['"`](https?://[^'"`\s]+)''', content):
        url = m.group(1)
        # Normalize: strip query params
        url = url.split("?")[0]
        apis.append(url)

    return list(set(apis))
