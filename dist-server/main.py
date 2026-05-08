"""
Distribution Server
- Browse directory structure under BASE_PATH
- Receive multipart file uploads from external servers
"""

import os
import math
import shutil
import aiofiles
from pathlib import Path
from typing import List
from fastapi import FastAPI, HTTPException, UploadFile, File, Query, Body, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from pydantic import BaseModel

BASE_PATH = Path(os.environ.get("BASE_PATH", "/media")).resolve()
DIST_SECRET_KEY = os.environ.get("DIST_SECRET_KEY", "dist_changeme_in_production")
DIST_SERVICE_PASSWORD = os.environ.get("DIST_SERVICE_PASSWORD", "dist_service_password")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 365

app = FastAPI(title="Distribution Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_bearer = HTTPBearer()


def require_auth(credentials: HTTPAuthorizationCredentials = Depends(_bearer)):
    """Validate a Bearer JWT issued by this dist-server."""
    try:
        payload = jwt.decode(credentials.credentials, DIST_SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("sub") is None:
            raise ValueError("Missing subject")
    except (JWTError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class DistTokenRequest(BaseModel):
    password: str


@app.post("/auth/token")
def dist_token(body: DistTokenRequest):
    """Issue a long-lived service JWT. Accepts the DIST_SERVICE_PASSWORD."""
    if body.password != DIST_SERVICE_PASSWORD:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid service password",
        )
    from datetime import datetime, timedelta, timezone
    expire = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    token = jwt.encode({"sub": "service", "exp": expire}, DIST_SECRET_KEY, algorithm=ALGORITHM)
    return {"access_token": token, "token_type": "bearer"}


def safe_resolve(rel_path: str) -> Path:
    """Resolve a relative path under BASE_PATH; raise 403 if it escapes."""
    target = (BASE_PATH / rel_path.lstrip("/")).resolve()
    if not str(target).startswith(str(BASE_PATH)):
        raise HTTPException(status_code=403, detail="Access denied: path escapes base directory")
    return target


# ---------------------------------------------------------------------------
# Directory browser
# ---------------------------------------------------------------------------

@app.get("/browse")
def browse(path: str = Query(default="", description="Relative path under base"),
          _=Depends(require_auth)):
    """List contents of a directory relative to BASE_PATH."""
    target = safe_resolve(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    entries = []
    for entry in sorted(target.iterdir()):
        entries.append({
            "name": entry.name,
            "type": "directory" if entry.is_dir() else "file",
            "size": entry.stat().st_size if entry.is_file() else None,
            "path": str(entry.relative_to(BASE_PATH)),
        })

    return {
        "current_path": str(target.relative_to(BASE_PATH)) if target != BASE_PATH else "",
        "entries": entries,
    }


@app.post("/mkdir")
def mkdir(path: str = Query(..., description="Relative path to create under base"),
          _=Depends(require_auth)):
    """Create a directory under BASE_PATH."""
    target = safe_resolve(path)
    target.mkdir(parents=True, exist_ok=True)
    return {"created": str(target.relative_to(BASE_PATH))}


# ---------------------------------------------------------------------------
# Multipart / chunked upload
# ---------------------------------------------------------------------------

@app.post("/upload")
async def upload(
    dest_path: str = Query(..., description="Destination relative path including filename"),
    file: UploadFile = File(...),
    _=Depends(require_auth),
):
    """Upload a file to the given path under BASE_PATH."""
    target = safe_resolve(dest_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    async with aiofiles.open(target, "wb") as out:
        while chunk := await file.read(1024 * 1024):  # 1 MB chunks
            await out.write(chunk)

    return {"uploaded": str(target.relative_to(BASE_PATH)), "size": target.stat().st_size}


# ---------------------------------------------------------------------------
# Chunked upload (resume-capable)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# .plexmatch helpers
# ---------------------------------------------------------------------------

@app.get("/plexmatch")
def get_plexmatch(path: str = Query(..., description="Relative folder path"),
                  _=Depends(require_auth)):
    """Return entries of the .plexmatch file in the given folder (or empty if absent)."""
    folder = safe_resolve(path)
    plexmatch = folder / ".plexmatch"
    if not plexmatch.exists():
        return {"exists": False, "entries": []}
    lines = [l.strip() for l in plexmatch.read_text(encoding="utf-8").splitlines() if l.strip()]
    return {"exists": True, "entries": lines}


class PlexmatchAppendRequest(BaseModel):
    entries: List[str]


@app.post("/plexmatch")
def append_plexmatch(
    path: str = Query(..., description="Relative folder path"),
    body: PlexmatchAppendRequest = Body(...),
    _=Depends(require_auth),
):
    """Append entries to (or create) the .plexmatch file in the given folder."""
    folder = safe_resolve(path)
    folder.mkdir(parents=True, exist_ok=True)
    plexmatch = folder / ".plexmatch"
    with open(plexmatch, "a", encoding="utf-8") as f:
        for entry in body.entries:
            f.write(entry.rstrip("\n") + "\n")
    return {"appended": len(body.entries)}


@app.get("/plexmatch/aggregate")
def aggregate_plexmatch(path: str = Query(..., description="Root folder to search recursively"),
                        _=Depends(require_auth)):
    """Recursively find all .plexmatch files under a folder and return all their entries combined."""
    root = safe_resolve(path)
    all_entries: List[str] = []
    sources: List[str] = []
    for pm_file in sorted(root.rglob(".plexmatch")):
        lines = [l.strip() for l in pm_file.read_text(encoding="utf-8").splitlines() if l.strip()]
        all_entries.extend(lines)
        sources.append(str(pm_file.relative_to(BASE_PATH)))
    return {"entries": all_entries, "sources": sources}


@app.post("/upload/chunk")
async def upload_chunk(
    dest_path: str = Query(...),
    chunk_index: int = Query(...),
    total_chunks: int = Query(...),
    file: UploadFile = File(...),
    _=Depends(require_auth),
):
    """Upload a single chunk of a file. Assembles automatically on last chunk."""
    target = safe_resolve(dest_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    chunk_path = target.parent / f".{target.name}.chunk{chunk_index}"
    async with aiofiles.open(chunk_path, "wb") as out:
        await out.write(await file.read())

    # Check if all chunks have arrived
    received = list(target.parent.glob(f".{target.name}.chunk*"))
    if len(received) == total_chunks:
        # Assemble
        async with aiofiles.open(target, "wb") as out:
            for i in range(total_chunks):
                part = target.parent / f".{target.name}.chunk{i}"
                async with aiofiles.open(part, "rb") as p:
                    await out.write(await p.read())
                part.unlink()
        return {"assembled": True, "path": str(target.relative_to(BASE_PATH))}

    return {"assembled": False, "chunk_index": chunk_index, "received": len(received)}
