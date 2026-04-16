"""
Code Embedder — UniXCoder Embedding via Transformers.

Converts function-level code into 768-dimensional embedding vectors
using the UniXCoder model from Microsoft.
Downloads the model automatically on first use.
"""

import hashlib
import logging
import os

import numpy as np
from transformers import AutoTokenizer, AutoModel
import torch

logger = logging.getLogger(__name__)


class CodeEmbedder:
    """
    Embeds code into 768-dimensional vectors using UniXCoder.

    UniXCoder is a unified cross-modal pre-trained model for code
    that understands both code structure and natural language.
    """

    def __init__(self, model_name: str = "microsoft/unixcoder-base", **kwargs):
        """
        Initialize the embedder. Downloads model from HuggingFace on first use.

        Args:
            model_name: HuggingFace model name
        """
        logger.info(f"Loading UniXCoder model: {model_name}")

        cache_dir = os.environ.get("HF_HOME", "/tmp/hf_cache")

        self.tokenizer = AutoTokenizer.from_pretrained(
            model_name, cache_dir=cache_dir
        )
        self.model = AutoModel.from_pretrained(
            model_name, cache_dir=cache_dir
        )
        self.model.eval()

        # Move to CPU explicitly (no GPU on free tier)
        self.device = torch.device("cpu")
        self.model.to(self.device)

        self.max_length = 512
        self.embedding_dim = 768

        logger.info(
            f"UniXCoder loaded — device: {self.device}, "
            f"max_length: {self.max_length}"
        )

    def embed(self, code: str) -> np.ndarray:
        """
        Embed a single code snippet into a 768-dim vector.

        Args:
            code: Source code string (function body)

        Returns:
            numpy array of shape (768,)
        """
        # Tokenize
        inputs = self.tokenizer(
            code,
            return_tensors="pt",
            max_length=self.max_length,
            truncation=True,
            padding="max_length",
        ).to(self.device)

        # Run inference (no gradient computation)
        with torch.no_grad():
            outputs = self.model(**inputs)

        # Mean pooling over token dimension
        token_embeddings = outputs.last_hidden_state  # (1, seq_len, 768)
        attention_mask = inputs["attention_mask"].unsqueeze(-1).float()  # (1, seq_len, 1)

        masked_embeddings = token_embeddings * attention_mask
        sum_embeddings = masked_embeddings.sum(dim=1)  # (1, 768)
        sum_mask = attention_mask.sum(dim=1)  # (1, 1)
        sum_mask = torch.clamp(sum_mask, min=1e-9)

        embedding = (sum_embeddings / sum_mask).squeeze(0)  # (768,)

        # L2 normalize
        embedding = torch.nn.functional.normalize(embedding, p=2, dim=0)

        return embedding.cpu().numpy()

    def embed_batch(self, codes: list[str]) -> list[np.ndarray]:
        """
        Embed multiple code snippets.

        Args:
            codes: List of source code strings

        Returns:
            List of numpy arrays, each of shape (768,)
        """
        return [self.embed(code) for code in codes]

    @staticmethod
    def code_hash(code: str) -> str:
        """
        Generate a hash of the code for caching.

        Used as a cache key to avoid re-embedding identical code.
        """
        return hashlib.sha256(code.strip().encode("utf-8")).hexdigest()[:16]
