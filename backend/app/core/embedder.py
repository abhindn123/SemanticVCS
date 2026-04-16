"""
Code Embedder — UniXCoder ONNX Runtime Inference.

Converts function-level code into 768-dimensional embedding vectors
using the UniXCoder model from Microsoft, optimized via ONNX Runtime.
"""

import hashlib
import logging

import numpy as np
import onnxruntime as ort
from transformers import RobertaTokenizer

logger = logging.getLogger(__name__)


class CodeEmbedder:
    """
    Embeds code into 768-dimensional vectors using UniXCoder (ONNX).

    UniXCoder is a unified cross-modal pre-trained model for code
    that understands both code structure and natural language.
    """

    def __init__(self, model_path: str, tokenizer_name: str = "microsoft/unixcoder-base"):
        """
        Initialize the embedder.

        Args:
            model_path: Path to the ONNX model file
            tokenizer_name: HuggingFace tokenizer name
        """
        logger.info(f"Loading UniXCoder ONNX model from: {model_path}")

        # Session options for optimized inference
        sess_options = ort.SessionOptions()
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess_options.intra_op_num_threads = 4
        sess_options.inter_op_num_threads = 1
        sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

        # Load ONNX model
        self.session = ort.InferenceSession(
            model_path,
            sess_options,
            providers=["CPUExecutionProvider"],
        )

        # Load tokenizer
        logger.info(f"Loading tokenizer: {tokenizer_name}")
        self.tokenizer = RobertaTokenizer.from_pretrained(tokenizer_name)

        # Get model input/output names
        self.input_names = [inp.name for inp in self.session.get_inputs()]
        self.output_names = [out.name for out in self.session.get_outputs()]

        self.max_length = 512
        self.embedding_dim = 768

        logger.info(
            f"UniXCoder loaded — inputs: {self.input_names}, "
            f"outputs: {self.output_names}, "
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
            return_tensors="np",
            max_length=self.max_length,
            truncation=True,
            padding="max_length",
        )

        # Prepare ONNX inputs
        onnx_inputs = {}
        if "input_ids" in self.input_names:
            onnx_inputs["input_ids"] = inputs["input_ids"].astype(np.int64)
        if "attention_mask" in self.input_names:
            onnx_inputs["attention_mask"] = inputs["attention_mask"].astype(np.int64)

        # Run inference
        outputs = self.session.run(self.output_names, onnx_inputs)

        # Mean pooling over token dimension
        # outputs[0] shape: (1, seq_len, 768)
        token_embeddings = outputs[0]
        attention_mask = inputs["attention_mask"]

        # Expand attention mask for broadcasting: (1, seq_len) → (1, seq_len, 1)
        mask_expanded = np.expand_dims(attention_mask, axis=-1).astype(np.float32)

        # Mask padding tokens and compute mean
        masked_embeddings = token_embeddings * mask_expanded
        sum_embeddings = masked_embeddings.sum(axis=1)  # (1, 768)
        sum_mask = mask_expanded.sum(axis=1)  # (1, 1)
        sum_mask = np.maximum(sum_mask, 1e-9)  # Avoid division by zero

        embedding = (sum_embeddings / sum_mask)[0]  # (768,)

        # L2 normalize
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm

        return embedding

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
