"""
Authentication endpoints.

Handles user registration, login, and API key management.
"""

import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from jose import jwt

from app.api.deps import SupabaseDep
from app.config import get_settings
from app.models.schemas import AuthResponse, LoginRequest, RegisterRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/auth", tags=["Authentication"])


def create_jwt_token(user_id: str) -> str:
    """Create a JWT token for the user."""
    settings = get_settings()
    expire = datetime.utcnow() + timedelta(hours=settings.JWT_EXPIRY_HOURS)
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest, supabase: SupabaseDep) -> AuthResponse:
    """
    Register a new user and get an API key.

    The API key is used in the VS Code extension for authentication.
    """
    try:
        result = await supabase.create_user(email=body.email, password=body.password)
    except Exception as e:
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email already registered",
            )
        logger.error(f"Registration failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Registration failed",
        )

    token = create_jwt_token(result["user_id"])

    return AuthResponse(
        user_id=result["user_id"],
        api_key=result["api_key"],
        token=token,
    )


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest, supabase: SupabaseDep) -> AuthResponse:
    """
    Login with email and password. Returns JWT token and API key.
    """
    user = await supabase.authenticate_user(email=body.email, password=body.password)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    token = create_jwt_token(user["user_id"])

    return AuthResponse(
        user_id=user["user_id"],
        api_key=user["api_key"],
        token=token,
    )
