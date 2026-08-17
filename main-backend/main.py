"""
Main Backend
- Local authentication (JWT)
- Job management (persisted in PostgreSQL)
- S3 source file browsing and selection
- Triggers transcoder worker via Redis queue
"""

import os
import uuid
import json
import subprocess
import tempfile
import aiofiles
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import boto3
from botocore.exceptions import ClientError, NoCredentialsError
import redis as sync_redis
import httpx
from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Form, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, String, Integer, BigInteger, Text, Float
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SECRET_KEY = os.environ.get("SECRET_KEY", "changeme_in_production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 8  # 8 hours

# Token used by external transcoder workers to authenticate against /worker/* endpoints.
# Must match WORKER_TOKEN in the transcoder's environment.
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")

TRANSCODED_DIR = Path(os.environ.get("TRANSCODED_DIR", "/transcoded"))
DIST_SERVER_URL = os.environ.get("DIST_SERVER_URL", "http://dist-server:8001")
DIST_SERVICE_PASSWORD = os.environ.get("DIST_SERVICE_PASSWORD", "dist_service_password")
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@postgres:5432/plex")

# S3 config
S3_ENDPOINT_URL = os.environ.get("S3_ENDPOINT_URL")          # e.g. https://s3.amazonaws.com or MinIO URL
S3_ACCESS_KEY   = os.environ.get("S3_ACCESS_KEY", "")
S3_SECRET_KEY   = os.environ.get("S3_SECRET_KEY", "")
S3_BUCKET       = os.environ.get("S3_BUCKET", "")
S3_REGION       = os.environ.get("S3_REGION", "us-east-1")

TRANSCODED_DIR.mkdir(parents=True, exist_ok=True)


def get_s3_client():
    kwargs = dict(
        region_name=S3_REGION,
        aws_access_key_id=S3_ACCESS_KEY or None,
        aws_secret_access_key=S3_SECRET_KEY or None,
    )
    if S3_ENDPOINT_URL:
        kwargs["endpoint_url"] = S3_ENDPOINT_URL
    return boto3.client("s3", **kwargs)

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


class Base(DeclarativeBase):
    pass


class JobModel(Base):
    __tablename__ = "jobs"

    id = Column(String, primary_key=True)
    original_filename = Column(String, nullable=False)
    s3_key = Column(Text)            # S3 object key (source file)
    upload_path = Column(Text)       # kept for backward compat (unused for new jobs)
    dest_path = Column(Text)
    season = Column(Integer)
    episode = Column(Integer)
    status = Column(String, nullable=False, default="uploaded")
    created_at = Column(String)
    created_by = Column(String)
    transcode_progress = Column(JSONB, default=dict)
    source_resolution = Column(JSONB)
    source_codec = Column(String)
    source_bitrate = Column(BigInteger)
    source_fps = Column(Float)
    source_file_size = Column(BigInteger)
    target_codec = Column(String, nullable=True)
    profile_bitrates = Column(JSONB, default=dict)
    error = Column(Text)


class UserModel(Base):
    __tablename__ = "users"

    username = Column(String, primary_key=True)
    hashed_password = Column(String, nullable=False)


engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)


def init_db():
    Base.metadata.create_all(bind=engine)
    # Seed default admin user if no users exist yet
    db = SessionLocal()
    try:
        if not db.query(UserModel).first():
            db.add(UserModel(
                username="admin",
                hashed_password=pwd_context.hash("admin123"),
            ))
            db.commit()
    finally:
        db.close()


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def job_to_dict(job: JobModel) -> dict:
    return {
        "id": job.id,
        "original_filename": job.original_filename,
        "s3_key": job.s3_key,
        "upload_path": job.upload_path,
        "dest_path": job.dest_path,
        "season": job.season,
        "episode": job.episode,
        "status": job.status,
        "created_at": job.created_at,
        "created_by": job.created_by,
        "transcode_progress": job.transcode_progress or {},
        "source_resolution": job.source_resolution,
        "source_codec": job.source_codec,
        "source_bitrate": job.source_bitrate,
        "source_fps": job.source_fps,
        "source_file_size": job.source_file_size,
        "target_codec": job.target_codec,
        "profile_bitrates": job.profile_bitrates or {},
        "error": job.error,
    }

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def authenticate_user(username: str, password: str, db: Session):
    user = db.query(UserModel).filter(UserModel.username == username).first()
    if not user or not verify_password(password, user.hashed_password):
        return None
    return user


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=15))
    to_encode["exp"] = expire
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    user = db.query(UserModel).filter(UserModel.username == username).first()
    if user is None:
        raise credentials_exception
    return user


# ---------------------------------------------------------------------------
# Redis (queue only)
# ---------------------------------------------------------------------------

rdb = sync_redis.from_url(REDIS_URL, decode_responses=True)

TRANSCODE_QUEUE = "transcode_queue"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class Token(BaseModel):
    access_token: str
    token_type: str
    dist_access_token: str
    dist_token_type: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class CreateJobRequest(BaseModel):
    s3_key: str
    dest_path: str
    season: int
    episode: int
    # None (the default) means "no override" — the worker keeps the
    # source's own codec (except 4K, which is always HEVC).
    target_codec: Optional[str] = None


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Video Ready – Main Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    init_db()


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

@app.post("/auth/token", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = authenticate_user(form_data.username, form_data.password, db)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = create_access_token(
        data={"sub": user.username},
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    # Fetch a long-lived dist-server token on behalf of the user
    try:
        dist_resp = httpx.post(
            f"{DIST_SERVER_URL}/auth/token",
            json={"password": DIST_SERVICE_PASSWORD},
            timeout=10,
        )
        dist_resp.raise_for_status()
        dist_token_data = dist_resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Could not reach distribution server")
    return {
        "access_token": token,
        "token_type": "bearer",
        "dist_access_token": dist_token_data["access_token"],
        "dist_token_type": "bearer",
    }


@app.get("/auth/me")
def me(current_user: UserModel = Depends(get_current_user)):
    return {"username": current_user.username}


@app.post("/auth/change-password")
def change_password(
    req: ChangePasswordRequest,
    current_user: UserModel = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(req.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    user = db.query(UserModel).filter(UserModel.username == current_user.username).first()
    user.hashed_password = pwd_context.hash(req.new_password)
    db.commit()
    return {"detail": "Password updated"}


# ---------------------------------------------------------------------------
# S3 routes
# ---------------------------------------------------------------------------

@app.get("/s3/browse")
def s3_browse(
    prefix: str = "",
    current_user: UserModel = Depends(get_current_user),
):
    """List objects and common prefixes (folders) in the S3 bucket."""
    if not S3_BUCKET:
        raise HTTPException(status_code=503, detail="S3 is not configured")
    try:
        s3 = get_s3_client()
        paginator = s3.get_paginator("list_objects_v2")
        page = paginator.paginate(
            Bucket=S3_BUCKET,
            Prefix=prefix,
            Delimiter="/",
            PaginationConfig={"MaxItems": 500},
        )
        folders, files = [], []
        for result in page:
            for cp in result.get("CommonPrefixes") or []:
                folders.append({"key": cp["Prefix"], "name": cp["Prefix"][len(prefix):].rstrip("/")})
            for obj in result.get("Contents") or []:
                key = obj["Key"]
                if key == prefix:
                    continue  # skip the folder marker itself
                name = key[len(prefix):]
                files.append({"key": key, "name": name, "size": obj["Size"], "last_modified": obj["LastModified"].isoformat()})
        return {"bucket": S3_BUCKET, "prefix": prefix, "folders": folders, "files": files}
    except (ClientError, NoCredentialsError) as e:
        raise HTTPException(status_code=502, detail=f"S3 error: {e}")


@app.post("/s3/probe")
def s3_probe(
    body: dict,
    current_user: UserModel = Depends(get_current_user),
):
    """Generate a presigned URL and run ffprobe directly against S3 — no download."""
    s3_key = body.get("s3_key", "")
    if not s3_key or not S3_BUCKET:
        raise HTTPException(status_code=400, detail="s3_key and S3 config required")
    try:
        s3 = get_s3_client()
        head = s3.head_object(Bucket=S3_BUCKET, Key=s3_key)
        file_size_bytes = head["ContentLength"]
        presigned_url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": s3_key},
            ExpiresIn=300,
        )
    except (ClientError, NoCredentialsError) as e:
        raise HTTPException(status_code=502, detail=f"S3 error: {e}")

    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries",
                "stream=codec_type,codec_name,bit_rate,avg_frame_rate,width,height",
                "-show_entries", "format=bit_rate,duration",
                "-of", "json",
                presigned_url,
            ],
            capture_output=True, text=True, check=True,
        )
        data = json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=422, detail=f"ffprobe failed: {e.stderr[:200]}")

    info: dict = {"file_size_bytes": file_size_bytes}
    for stream in data.get("streams", []):
        ctype = stream.get("codec_type")
        if ctype == "video" and "video" not in info:
            br_str = stream.get("bit_rate")
            fps = None
            try:
                num, den = stream.get("avg_frame_rate", "0/0").split("/")
                if int(den) > 0:
                    fps = round(int(num) / int(den), 3)
            except Exception:
                pass
            info["video"] = {
                "codec": stream.get("codec_name", "unknown"),
                "width": stream.get("width"),
                "height": stream.get("height"),
                "bitrate_kbps": int(br_str) // 1000 if br_str and br_str != "N/A" else None,
                "fps": fps,
            }
        elif ctype == "audio" and "audio" not in info:
            br_str = stream.get("bit_rate")
            info["audio"] = {
                "codec": stream.get("codec_name", "unknown"),
                "bitrate_kbps": int(br_str) // 1000 if br_str and br_str != "N/A" else None,
            }
    fmt = data.get("format", {})
    total_br = fmt.get("bit_rate")
    info["total_bitrate_kbps"] = int(total_br) // 1000 if total_br and total_br != "N/A" else None
    dur = fmt.get("duration")
    info["duration_sec"] = round(float(dur), 1) if dur else None
    return info


# ---------------------------------------------------------------------------
# Job routes
# ---------------------------------------------------------------------------

@app.get("/jobs")
def get_jobs(
    current_user: UserModel = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    jobs = db.query(JobModel).order_by(JobModel.created_at.desc()).all()
    return [job_to_dict(j) for j in jobs]


@app.get("/jobs/{job_id}")
def get_job(
    job_id: str,
    current_user: UserModel = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = db.query(JobModel).filter(JobModel.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job_to_dict(job)


@app.post("/jobs/{job_id}/retry")
def retry_job(
    job_id: str,
    current_user: UserModel = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = db.query(JobModel).filter(JobModel.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in ("failed", "completed"):
        raise HTTPException(status_code=400, detail="Only failed or completed jobs can be retried")
    job.status = "queued"
    job.error = None
    db.commit()
    rdb.rpush(TRANSCODE_QUEUE, job_id)
    return job_to_dict(job)


@app.post("/jobs/{job_id}/stop")
def stop_job(
    job_id: str,
    current_user: UserModel = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = db.query(JobModel).filter(JobModel.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in ("queued", "transcoding", "uploading"):
        raise HTTPException(status_code=400, detail="Job is not active")
    job.status = "cancelled"
    db.commit()
    # Signal the worker to abort the running ffmpeg process
    rdb.setex(f"cancel:{job_id}", 3600, "1")
    return job_to_dict(job)


@app.post("/jobs/{job_id}/restart")
def restart_job(
    job_id: str,
    current_user: UserModel = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = db.query(JobModel).filter(JobModel.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in ("failed", "cancelled", "completed"):
        raise HTTPException(status_code=400, detail="Only failed, cancelled, or completed jobs can be restarted")
    job.status = "queued"
    job.error = None
    job.transcode_progress = {}
    db.commit()
    # Clear any lingering cancel flag
    rdb.delete(f"cancel:{job_id}")
    rdb.rpush(TRANSCODE_QUEUE, job_id)
    return job_to_dict(job)


# ---------------------------------------------------------------------------
# Job creation (S3-based)
# ---------------------------------------------------------------------------

@app.post("/jobs")
def create_job(
    body: CreateJobRequest,
    current_user: UserModel = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if body.target_codec is not None and body.target_codec not in ("h264", "hevc"):
        body.target_codec = None
    if not S3_BUCKET:
        raise HTTPException(status_code=503, detail="S3 is not configured")

    # Verify the key exists in S3 before creating the job
    try:
        s3 = get_s3_client()
        s3.head_object(Bucket=S3_BUCKET, Key=body.s3_key)
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in ("404", "NoSuchKey"):
            raise HTTPException(status_code=404, detail=f"S3 key not found: {body.s3_key}")
        raise HTTPException(status_code=502, detail=f"S3 error: {e}")

    job_id = str(uuid.uuid4())
    original_filename = Path(body.s3_key).name

    job = JobModel(
        id=job_id,
        original_filename=original_filename,
        s3_key=body.s3_key,
        upload_path=None,
        dest_path=body.dest_path,
        season=body.season,
        episode=body.episode,
        status="queued",
        created_at=datetime.now(timezone.utc).isoformat(),
        created_by=current_user.username,
        target_codec=body.target_codec,
        transcode_progress={},
        error=None,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    rdb.rpush(TRANSCODE_QUEUE, job_id)
    return job_to_dict(job)


# ---------------------------------------------------------------------------
# Video probe (legacy local upload — kept for compatibility)
# ---------------------------------------------------------------------------

@app.post("/probe")
async def probe_file(
    file: UploadFile = File(...),
    current_user: UserModel = Depends(get_current_user),
):
    """Accept a video file, run ffprobe on it, return stream metadata."""
    suffix = Path(file.filename).suffix or ".tmp"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        # Write uploaded bytes to temp file
        async with aiofiles.open(tmp_path, "wb") as out:
            while chunk := await file.read(4 * 1024 * 1024):
                await out.write(chunk)

        file_size_bytes = tmp_path.stat().st_size

        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries",
                "stream=codec_type,codec_name,bit_rate,avg_frame_rate,width,height",
                "-show_entries", "format=bit_rate,duration",
                "-of", "json",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        data = json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"ffprobe failed: {e.stderr[:200]}")
    finally:
        tmp_path.unlink(missing_ok=True)

    info: dict = {"file_size_bytes": file_size_bytes}

    for stream in data.get("streams", []):
        ctype = stream.get("codec_type")
        if ctype == "video" and "video" not in info:
            br_str = stream.get("bit_rate")
            fps = None
            try:
                num, den = stream.get("avg_frame_rate", "0/0").split("/")
                if int(den) > 0:
                    fps = round(int(num) / int(den), 3)
            except Exception:
                pass
            info["video"] = {
                "codec": stream.get("codec_name", "unknown"),
                "width": stream.get("width"),
                "height": stream.get("height"),
                "bitrate_kbps": int(br_str) // 1000 if br_str and br_str != "N/A" else None,
                "fps": fps,
            }
        elif ctype == "audio" and "audio" not in info:
            br_str = stream.get("bit_rate")
            info["audio"] = {
                "codec": stream.get("codec_name", "unknown"),
                "bitrate_kbps": int(br_str) // 1000 if br_str and br_str != "N/A" else None,
            }

    fmt = data.get("format", {})
    total_br = fmt.get("bit_rate")
    info["total_bitrate_kbps"] = int(total_br) // 1000 if total_br and total_br != "N/A" else None
    dur = fmt.get("duration")
    info["duration_sec"] = round(float(dur), 1) if dur else None

    return info


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Worker API  (authenticated by WORKER_TOKEN, no user session needed)
# ---------------------------------------------------------------------------

worker_token_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token", auto_error=False)


def require_worker(token: str = Depends(worker_token_scheme)):
    """Dependency that validates the shared WORKER_TOKEN Bearer header."""
    if not WORKER_TOKEN:
        raise HTTPException(status_code=503, detail="WORKER_TOKEN is not configured on the server")
    if token != WORKER_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid worker token",
            headers={"WWW-Authenticate": "Bearer"},
        )


class WorkerJobUpdate(BaseModel):
    """Partial job update sent by the transcoder worker."""
    status: Optional[str] = None
    transcode_progress: Optional[dict] = None
    profile_bitrates: Optional[dict] = None
    source_resolution: Optional[dict] = None
    source_codec: Optional[str] = None
    source_bitrate: Optional[int] = None
    source_fps: Optional[float] = None
    source_file_size: Optional[int] = None
    error: Optional[str] = None


@app.post("/worker/dequeue")
def worker_dequeue(
    _: None = Depends(require_worker),
    db: Session = Depends(get_db),
):
    """Pop the next job_id from the Redis queue. Returns {job_id} or {job_id: null}."""
    job_id = rdb.lpop(TRANSCODE_QUEUE)
    if not job_id:
        return {"job_id": None}
    # Verify job exists and is still queued
    job = db.query(JobModel).filter(JobModel.id == job_id).first()
    if not job:
        return {"job_id": None}
    return {"job_id": job_id}


@app.get("/worker/jobs/{job_id}")
def worker_get_job(
    job_id: str,
    _: None = Depends(require_worker),
    db: Session = Depends(get_db),
):
    """Return full job details for the worker."""
    job = db.query(JobModel).filter(JobModel.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job_to_dict(job)


@app.patch("/worker/jobs/{job_id}")
def worker_patch_job(
    job_id: str,
    body: WorkerJobUpdate,
    _: None = Depends(require_worker),
    db: Session = Depends(get_db),
):
    """Partial update of a job from the transcoder worker."""
    job = db.query(JobModel).filter(JobModel.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    updates = body.model_dump(exclude_unset=True)
    for key, val in updates.items():
        setattr(job, key, val)
    db.commit()
    return job_to_dict(job)


@app.get("/worker/jobs/{job_id}/cancelled")
def worker_is_cancelled(
    job_id: str,
    _: None = Depends(require_worker),
):
    """Check whether the cancel flag is set for a job (set by POST /jobs/{id}/stop)."""
    cancelled = bool(rdb.exists(f"cancel:{job_id}"))
    return {"cancelled": cancelled}
