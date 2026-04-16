"""
Diff Extractor — Maps unified diffs to changed functions.

Takes a git unified diff and the full file content, then identifies
which functions were changed by the diff.
"""

import logging
import re

from app.core.ast_parser import extract_functions_from_file
from app.models.schemas import FunctionBlock, FunctionDiff

logger = logging.getLogger(__name__)


def parse_diff_hunks(diff: str) -> list[tuple[int, int]]:
    """
    Parse unified diff to extract changed line ranges.

    Returns list of (start_line, end_line) tuples representing
    the lines that were added or modified.
    """
    changed_ranges = []
    current_line = 0

    for line in diff.split("\n"):
        # Match hunk headers: @@ -old_start,old_count +new_start,new_count @@
        hunk_match = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
        if hunk_match:
            current_line = int(hunk_match.group(1))
            continue

        if line.startswith("+") and not line.startswith("+++"):
            # Added line
            changed_ranges.append(current_line)
            current_line += 1
        elif line.startswith("-") and not line.startswith("---"):
            # Deleted line — don't increment current_line
            # But the deletion affects the function at this location
            changed_ranges.append(current_line)
        else:
            # Context line
            if current_line > 0:
                current_line += 1

    if not changed_ranges:
        return []

    # Merge adjacent lines into ranges
    ranges = []
    start = changed_ranges[0]
    end = changed_ranges[0]

    for line_num in changed_ranges[1:]:
        if line_num <= end + 2:  # Allow small gaps
            end = line_num
        else:
            ranges.append((start, end))
            start = line_num
            end = line_num
    ranges.append((start, end))

    return ranges


def map_changes_to_functions(
    changed_ranges: list[tuple[int, int]],
    functions: list[FunctionBlock],
) -> list[FunctionBlock]:
    """
    Find which functions overlap with the changed line ranges.

    A function is considered changed if any changed line falls within
    its start_line to end_line range.
    """
    changed_functions = []
    seen = set()

    for change_start, change_end in changed_ranges:
        for func in functions:
            if func.name in seen:
                continue

            # Check if the changed range overlaps with the function
            if change_start <= func.end_line and change_end >= func.start_line:
                changed_functions.append(func)
                seen.add(func.name)

    return changed_functions


def extract_changed_functions(
    diff: str,
    file_content: str,
    file_path: str,
) -> list[FunctionDiff]:
    """
    Main entry point: Extract the functions that were changed by a diff.

    1. Parse diff to find changed line ranges
    2. Parse file content with AST to find all function boundaries
    3. Map changed lines to functions
    4. Return only the changed functions

    Args:
        diff: Unified diff string
        file_content: Full file content after the commit
        file_path: File path (used for language detection)

    Returns:
        List of FunctionDiff with the changed function bodies
    """
    # Step 1: Parse diff hunks
    changed_ranges = parse_diff_hunks(diff)
    if not changed_ranges:
        logger.debug(f"No changed line ranges found in diff for {file_path}")
        return []

    # Step 2: Extract all functions from the file
    all_functions = extract_functions_from_file(file_content, file_path)
    if not all_functions:
        logger.debug(f"No functions found in {file_path}")
        return []

    # Step 3: Map changes to functions
    changed_functions = map_changes_to_functions(changed_ranges, all_functions)

    # Step 4: Convert to FunctionDiff
    result = []
    for func in changed_functions:
        result.append(FunctionDiff(
            function_name=func.name,
            new_body=func.body,
            file_path=file_path,
            start_line=func.start_line,
            end_line=func.end_line,
            language=_detect_lang(file_path),
        ))

    logger.info(
        f"Found {len(result)} changed functions in {file_path} "
        f"(out of {len(all_functions)} total)"
    )
    return result


def _detect_lang(file_path: str) -> str:
    """Quick language detection from file path."""
    from app.core.ast_parser import detect_language
    return detect_language(file_path) or "unknown"
