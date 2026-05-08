"""
Risk Analyzer — Gemini API Integration.

Takes a current code change and a matched historical change,
then uses Gemini to generate a structured risk explanation.
"""

import json
import logging

import google.generativeai as genai

from app.models.schemas import RiskExplanation, RiskLevel

logger = logging.getLogger(__name__)


class RiskAnalyzer:
    """Generates human-readable risk explanations using Gemini API."""

    def __init__(self, api_key: str, model_name: str = "gemini-2.0-flash"):
        """
        Initialize the Gemini client.

        Args:
            api_key: Google AI Studio API key
            model_name: Gemini model to use
        """
        genai.configure(api_key=api_key)
        self.model = genai.GenerativeModel(
            model_name,
            generation_config=genai.GenerationConfig(
                temperature=0.3,  # Low temperature for consistent, factual output
                max_output_tokens=1024,
                response_mime_type="application/json",
            ),
        )
        logger.info(f"Gemini RiskAnalyzer initialized with model: {model_name}")

    async def analyze_risk(
        self,
        current_code: str,
        historical_code: str,
        outcome: str,
        similarity_score: float,
        function_name: str = "",
        file_path: str = "",
    ) -> RiskExplanation:
        """
        Generate a structured risk explanation by comparing current
        and historical code changes.

        Args:
            current_code: The code just committed
            historical_code: The similar historical code
            outcome: What happened to the historical code (reverted, bug_linked)
            similarity_score: Cosine similarity between the two
            function_name: Name of the function being analyzed
            file_path: File path of the current code

        Returns:
            RiskExplanation with risk_level, explanation, context, and suggestion
        """
        prompt = f"""You are a senior code reviewer analyzing a potential risk in a codebase.

A developer just committed code that is {similarity_score:.0%} semantically similar to historical code that had a bad outcome.

## Current Code (just committed):
Function: {function_name}
File: {file_path}
```
{current_code[:2000]}
```

## Historical Code (outcome: {outcome}):
```
{historical_code[:2000]}
```

Analyze the risk and respond with this exact JSON structure:
{{
  "risk_level": "HIGH" or "MEDIUM" or "LOW",
  "explanation": "2-3 sentence explanation of what is semantically similar and why it could be risky. Be specific about the code patterns.",
  "historical_context": "What happened with the historical code — why it was {outcome}. Be specific.",
  "suggested_action": "A concrete, actionable suggestion for the developer to mitigate the risk."
}}

Guidelines for risk_level:
- HIGH: similarity > 90% AND outcome is "reverted" or security-related
- MEDIUM: similarity > 85% OR outcome is "bug_linked"
- LOW: similarity > 80% but outcome is minor or uncertain"""

        try:
            response = await self.model.generate_content_async(prompt)
            return self._parse_response(response.text)
        except Exception as e:
            logger.error(f"Gemini API call failed: {e}")
            return self._fallback_explanation(similarity_score, outcome)

    def _parse_response(self, response_text: str) -> RiskExplanation:
        """Parse Gemini's JSON response into a RiskExplanation."""
        try:
            # Clean up response — sometimes Gemini wraps in ```json
            text = response_text.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1]
            if text.endswith("```"):
                text = text.rsplit("```", 1)[0]

            data = json.loads(text.strip())

            risk_level = RiskLevel.LOW
            level_str = data.get("risk_level", "LOW").upper()
            if level_str == "HIGH":
                risk_level = RiskLevel.HIGH
            elif level_str == "MEDIUM":
                risk_level = RiskLevel.MEDIUM

            return RiskExplanation(
                risk_level=risk_level,
                explanation=data.get("explanation", ""),
                historical_context=data.get("historical_context", ""),
                suggested_action=data.get("suggested_action", ""),
            )

        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"Failed to parse Gemini response: {e}")
            logger.debug(f"Raw response: {response_text}")
            return RiskExplanation(
                risk_level=RiskLevel.MEDIUM,
                explanation=response_text[:500] if response_text else "Analysis unavailable",
                historical_context="Could not parse structured explanation",
                suggested_action="Review the matched historical commit manually",
            )

    def _fallback_explanation(
        self, similarity_score: float, outcome: str
    ) -> RiskExplanation:
        """Generate a basic explanation when Gemini API fails."""
        risk_level = RiskLevel.HIGH if similarity_score > 0.90 else RiskLevel.MEDIUM

        return RiskExplanation(
            risk_level=risk_level,
            explanation=(
                f"This code is {similarity_score:.0%} semantically similar to historical code "
                f"that was {outcome}. Gemini analysis was unavailable — please review manually."
            ),
            historical_context=f"The historical code was {outcome}.",
            suggested_action="Review the matched historical commit and verify your changes.",
        )

    async def generate_fix(
        self,
        bad_code: str,
        safe_code: str,
        explanation: str,
        function_name: str = "",
        file_path: str = "",
        language: str = "python",
    ) -> dict:
        """
        Generate a NEW, smarter fix using Gemini — not a dumb restore.

        Args:
            bad_code: The risky code the developer just wrote
            safe_code: The historical safe version (for context)
            explanation: Why the code was flagged
            function_name: Name of the function
            file_path: File path
            language: Programming language

        Returns:
            dict with 'fixed_code', 'explanation', and 'changes_made'
        """
        prompt = f"""You are a senior developer fixing a security/quality issue in code.

A developer wrote code that was flagged as risky. Your job is to write a NEW, BETTER version
that fixes the security issue while RESPECTING the developer's intent.

DO NOT just copy the old safe version. Write modern, clean, optimized code.

## Risky Code (what the developer wrote):
Function: {function_name}
File: {file_path}
Language: {language}
```{language}
{bad_code[:3000]}
```

## Why it was flagged:
{explanation}

## Historical safe version (for reference only — do NOT copy this verbatim):
```{language}
{safe_code[:3000]}
```

Respond with this exact JSON:
{{
  "fixed_code": "The complete fixed function code. Must be valid {language}. Include imports if needed.",
  "explanation": "1-2 sentences explaining what you changed and why.",
  "changes_made": ["List of specific changes made, e.g. 'Added input validation', 'Used compiled regex for performance'"]
}}

Rules:
- The fix must be COMPLETE and ready to paste — include the full function
- Improve on the old safe version if possible (better patterns, modern syntax)
- Respect the developer's goal (e.g. if they wanted performance, make it fast AND safe)
- Use best practices for {language}"""

        try:
            # Use a slightly higher temperature for creative fixes
            fix_model = genai.GenerativeModel(
                self.model.model_name,
                generation_config=genai.GenerationConfig(
                    temperature=0.4,
                    max_output_tokens=2048,
                    response_mime_type="application/json",
                ),
            )
            response = await fix_model.generate_content_async(prompt)
            text = response.text.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1]
            if text.endswith("```"):
                text = text.rsplit("```", 1)[0]

            data = json.loads(text.strip())
            return {
                "success": True,
                "fixed_code": data.get("fixed_code", ""),
                "explanation": data.get("explanation", ""),
                "changes_made": data.get("changes_made", []),
            }
        except Exception as e:
            logger.error(f"Gemini fix generation failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "fixed_code": safe_code,
                "explanation": "Could not generate AI fix — falling back to historical safe version.",
                "changes_made": [],
            }
