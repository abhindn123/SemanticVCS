"""
AST Parser — Function Extraction using tree-sitter.

Parses source code into an AST and extracts all function/method bodies.
Supports Python, JavaScript, and TypeScript.
"""

import logging
from dataclasses import dataclass

import tree_sitter_python as tspython
import tree_sitter_javascript as tsjavascript
import tree_sitter_typescript as tstypescript
from tree_sitter import Language, Parser

from app.models.schemas import FunctionBlock

logger = logging.getLogger(__name__)

# === Language Setup ===

LANGUAGES = {
    "python": Language(tspython.language()),
    "javascript": Language(tsjavascript.language()),
    "typescript": Language(tstypescript.language_typescript()),
    "tsx": Language(tstypescript.language_tsx()),
}

# Map file extensions to language names
EXTENSION_MAP = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".mjs": "javascript",
    ".cjs": "javascript",
}

# Tree-sitter node types that represent functions/methods
FUNCTION_NODE_TYPES = {
    "python": [
        "function_definition",
    ],
    "javascript": [
        "function_declaration",
        "method_definition",
        "arrow_function",
    ],
    "typescript": [
        "function_declaration",
        "method_definition",
        "arrow_function",
    ],
    "tsx": [
        "function_declaration",
        "method_definition",
        "arrow_function",
    ],
}


def detect_language(file_path: str) -> str | None:
    """Detect programming language from file extension."""
    for ext, lang in EXTENSION_MAP.items():
        if file_path.endswith(ext):
            return lang
    return None


def _get_function_name(node, source_bytes: bytes) -> str:
    """Extract function name from a tree-sitter node."""
    # Look for a 'name' or 'identifier' child
    for child in node.children:
        if child.type in ("identifier", "property_identifier"):
            return source_bytes[child.start_byte:child.end_byte].decode("utf-8")

    # For arrow functions assigned to variables, check parent
    parent = node.parent
    if parent and parent.type in ("variable_declarator", "assignment_expression"):
        for child in parent.children:
            if child.type in ("identifier", "property_identifier"):
                return source_bytes[child.start_byte:child.end_byte].decode("utf-8")

    return "<anonymous>"


def _get_function_signature(node, source_bytes: bytes) -> str:
    """Extract the function signature (first line)."""
    text = source_bytes[node.start_byte:node.end_byte].decode("utf-8")
    first_line = text.split("\n")[0].strip()
    return first_line


def _walk_tree(node, source_bytes: bytes, language: str) -> list[FunctionBlock]:
    """Recursively walk the AST and collect all function nodes."""
    functions = []
    target_types = FUNCTION_NODE_TYPES.get(language, [])

    if node.type in target_types:
        name = _get_function_name(node, source_bytes)
        body = source_bytes[node.start_byte:node.end_byte].decode("utf-8")
        signature = _get_function_signature(node, source_bytes)

        functions.append(FunctionBlock(
            name=name,
            body=body,
            start_line=node.start_point[0] + 1,  # 1-indexed
            end_line=node.end_point[0] + 1,
            signature=signature,
        ))

    for child in node.children:
        functions.extend(_walk_tree(child, source_bytes, language))

    return functions


def extract_functions(code: str, language: str) -> list[FunctionBlock]:
    """
    Parse source code and extract all functions/methods.

    Args:
        code: Source code string
        language: Language name (python, javascript, typescript)

    Returns:
        List of FunctionBlock with name, body, line numbers, and signature
    """
    if language not in LANGUAGES:
        logger.warning(f"Unsupported language: {language}")
        return []

    parser = Parser(LANGUAGES[language])

    source_bytes = code.encode("utf-8")
    tree = parser.parse(source_bytes)

    functions = _walk_tree(tree.root_node, source_bytes, language)

    logger.debug(f"Extracted {len(functions)} functions from {language} code")
    return functions


def extract_functions_from_file(code: str, file_path: str) -> list[FunctionBlock]:
    """
    Extract functions from code, auto-detecting language from file path.

    Returns empty list if language is not supported.
    """
    language = detect_language(file_path)
    if not language:
        logger.warning(f"Cannot detect language for: {file_path}")
        return []

    functions = extract_functions(code, language)

    # Attach file path to each function
    for f in functions:
        f.file_path = file_path

    return functions
