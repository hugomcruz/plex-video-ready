"""
Transcoder Worker
- Polls Redis queue for job IDs
- Uses ffprobe to detect source resolution, codec, and bitrate
- Transcodes to required profiles (only downscaling)
- Stream-copies when source already meets target codec + bitrate range
- Uploads each transcoded file to dist-server via multipart upload
- Tracks per-profile progress in PostgreSQL so failures can be resumed
- Probes and stores per-stream codec/bitrate/fps after each transcode
"""

import os
import json
import time
import subprocess
import logging
from pathlib import Path

import redis
import httpx
from sqlalchemy import create_engine, Column, String, Integer, BigInteger, Text, Float, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session
from sqlalchemy.orm.attributes import flag_modified

logging.basicConfig(level=logging.INFO, format="%(asctime)s [transcoder] %(message)s")
log = logging.getLogger(__name__)

REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@postgres:5432/plex")
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "/uploads"))
TRANSCODED_DIR = Path(os.environ.get("TRANSCODED_DIR", "/transcoded"))
DIST_SERVER_URL = os.environ.get("DIST_SERVER_URL", "http://dist-server:8001")
DIST_SERVICE_PASSWORD = os.environ.get("DIST_SERVICE_PASSWORD", "dist_service_password")

TRANSCODE_QUEUE = "transcode_queue"
CANCEL_KEY_PREFIX = "cancel:"


class JobCancelledError(Exception):
    """Raised when a job is cancelled by the user."""


# Profile definitions: (label, width, height)
PROFILES = [
    ("4k",    3840, 2160),
    ("1080p", 1920, 1080),
    ("720p",  1280, 720),
    ("480p",  854,  480),
]

# Target bitrate ranges in bits/sec (min, max) per codec per profile label.
# A source that already matches the target codec AND falls within this range
# will be stream-copied rather than re-encoded.
BITRATE_RANGES: dict[str, dict[str, tuple[int, int]]] = {
    "h264": {
        "480p":  (1_500_000,   3_000_000),
        "720p":  (4_000_000,   8_000_000),
        "1080p": (8_000_000,  16_000_000),
        "4k":   (35_000_000,  68_000_000),
    },
    "hevc": {
        "480p":  (1_000_000,   2_000_000),
        "720p":  (2_500_000,   5_000_000),
        "1080p": (4_000_000,  10_000_000),
        "4k":   (15_000_000,  35_000_000),
    },
}

# ffprobe codec_name → our internal key used in BITRATE_RANGES
CODEC_MAP: dict[str, str] = {
    "h264": "h264",
    "hevc": "hevc",
    "h265": "hevc",
}

# The codec we transcode TO (must be a key in BITRATE_RANGES)
TARGET_CODEC = "h264"

# ---------------------------------------------------------------------------
# Database (same schema as main-backend)
# ---------------------------------------------------------------------------


class Base(DeclarativeBase):
    pass


class JobModel(Base):
    __tablename__ = "jobs"

    id = Column(String, primary_key=True)
    original_filename = Column(String, nullable=False)
    upload_path = Column(Text)
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
    target_codec = Column(String, default="hevc")
    profile_bitrates = Column(JSONB, default=dict)
    error = Column(Text)


engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)


def wait_for_db(max_wait: int = 60) -> None:
    """Wait until PostgreSQL is reachable and ensure the jobs table exists."""
    delay = 2
    elapsed = 0
    while elapsed < max_wait:
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            Base.metadata.create_all(bind=engine)
            log.info("Database ready")
            return
        except Exception as exc:
            log.warning("Database not ready (%s), retrying in %ds…", exc, delay)
            time.sleep(delay)
            elapsed += delay
            delay = min(delay * 2, 10)
    raise RuntimeError(f"Could not connect to database after {max_wait}s")


# ---------------------------------------------------------------------------
# Redis (queue only)
# ---------------------------------------------------------------------------

rdb = redis.from_url(REDIS_URL, decode_responses=True)

_dist_token: str = ""


def get_dist_token() -> str:
    """Obtain a long-lived JWT directly from the dist-server."""
    global _dist_token
    resp = httpx.post(
        f"{DIST_SERVER_URL}/auth/token",
        json={"password": DIST_SERVICE_PASSWORD},
        timeout=10,
    )
    resp.raise_for_status()
    _dist_token = resp.json()["access_token"]
    log.info("Obtained dist-server token")
    return _dist_token


def wait_for_dist_token(max_wait: int = 120) -> None:
    """Retry get_dist_token until the dist-server is reachable (up to max_wait seconds)."""
    delay = 2
    elapsed = 0
    while elapsed < max_wait:
        try:
            get_dist_token()
            return
        except Exception as exc:
            log.warning("Dist-server not ready (%s), retrying in %ds…", exc, delay)
            time.sleep(delay)
            elapsed += delay
            delay = min(delay * 2, 15)
    raise RuntimeError(f"Could not reach dist-server after {max_wait}s")


def dist_headers() -> dict:
    """Return Authorization header, fetching the token if absent."""
    if not _dist_token:
        get_dist_token()
    return {"Authorization": f"Bearer {_dist_token}"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def get_video_info(path: Path) -> dict:
    """Return codec, width, height, bitrate, and fps of the first video stream.

    bitrate is in bits/sec (int) or None if ffprobe cannot determine it.
    fps is a float or None.
    """
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,codec_name,bit_rate,avg_frame_rate",
            "-show_entries", "format=bit_rate",
            "-of", "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    info = json.loads(result.stdout)
    stream = info["streams"][0]
    width = stream["width"]
    height = stream["height"]
    codec = stream.get("codec_name", "unknown")
    bitrate_str = stream.get("bit_rate") or info.get("format", {}).get("bit_rate")
    bitrate = int(bitrate_str) if bitrate_str and bitrate_str != "N/A" else None
    fps = None
    try:
        num, den = stream.get("avg_frame_rate", "0/0").split("/")
        if int(den) > 0:
            fps = round(int(num) / int(den), 3)
    except Exception:
        pass
    return {"width": width, "height": height, "codec": codec, "bitrate": bitrate, "fps": fps}


def should_copy(src_info: dict, label: str, prof_height: int, target_codec: str) -> bool:
    """Return True when the source can be stream-copied for this profile.

    Conditions (all must hold):
    - Source height exactly matches the profile height (no scaling needed).
    - Source codec is the same as target_codec.
    - Source bitrate is known and falls within the target range for this profile.
    """
    if src_info["height"] != prof_height:
        return False
    codec_key = CODEC_MAP.get(src_info["codec"])
    if codec_key != target_codec:
        return False
    bitrate = src_info["bitrate"]
    if bitrate is None:
        return False
    lo, hi = BITRATE_RANGES[target_codec][label]
    return lo <= bitrate <= hi


def get_output_file_info(path: Path) -> dict:
    """Probe a transcoded file and return per-stream codec/bitrate/fps info.

    Returns a dict shaped::

        {
            "video": {"codec": str, "bitrate_kbps": int|None, "fps": float|None},
            "audio": {"codec": str, "bitrate_kbps": int|None},
            "total_bitrate_kbps": int|None,
        }
    """
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries",
                "stream=codec_type,codec_name,bit_rate,avg_frame_rate",
                "-show_entries", "format=bit_rate",
                "-of", "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        data = json.loads(result.stdout)
        info: dict = {}

        for stream in data.get("streams", []):
            ctype = stream.get("codec_type")
            codec = stream.get("codec_name", "unknown")
            br_str = stream.get("bit_rate")
            bitrate_kbps = int(br_str) // 1000 if br_str and br_str != "N/A" else None

            if ctype == "video" and "video" not in info:
                fps = None
                try:
                    num, den = stream.get("avg_frame_rate", "0/0").split("/")
                    if int(den) > 0:
                        fps = round(int(num) / int(den), 3)
                except Exception:
                    pass
                info["video"] = {"codec": codec, "bitrate_kbps": bitrate_kbps, "fps": fps}

            elif ctype == "audio" and "audio" not in info:
                info["audio"] = {"codec": codec, "bitrate_kbps": bitrate_kbps}

        total_str = data.get("format", {}).get("bit_rate")
        info["total_bitrate_kbps"] = (
            int(total_str) // 1000 if total_str and total_str != "N/A" else None
        )
        info["file_size_bytes"] = path.stat().st_size
        return info
    except Exception as exc:
        log.warning("Could not probe output info for %s: %s", path, exc)
        return {}


def transcode(
    src: Path,
    dst: Path,
    target_width: int,
    target_height: int,
    target_codec: str = "hevc",
    use_copy: bool = False,
    bitrate_lo: int = 0,
    bitrate_hi: int = 0,
    cancel_flag=None,
):
    """Run ffmpeg to transcode src → dst at the given resolution.

    When use_copy=True the video stream is copied as-is (codec/bitrate already
    acceptable) and only the audio is normalised to AAC 128k.
    target_codec is "h264" or "hevc".
    bitrate_lo/bitrate_hi are the target range in bits/sec; when provided the
    encoder targets the midpoint and is capped at the maximum.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    if use_copy:
        cmd = [
            "ffmpeg", "-y",
            "-threads", "0",
            "-i", str(src),
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            str(dst),
        ]
        log.info("Stream-copying video for %s (codec+bitrate within target range)", dst.name)
    else:
        video_encoder = "libx265" if target_codec == "hevc" else "libx264"
        # Use scale filter keeping aspect ratio; pad to exact size if needed
        scale_filter = (
            f"scale={target_width}:{target_height}:"
            f"force_original_aspect_ratio=decrease,"
            f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2"
        )
        if bitrate_hi:
            target_bps = (bitrate_lo + bitrate_hi) // 2
            bitrate_args = [
                "-b:v", str(target_bps),
                "-maxrate", str(bitrate_hi),
                "-bufsize", str(bitrate_hi * 2),
            ]
            log.info(
                "Encoding %s with target %d kbps, maxrate %d kbps",
                dst.name, target_bps // 1000, bitrate_hi // 1000,
            )
        else:
            bitrate_args = ["-crf", "23"]
        cmd = [
            "ffmpeg", "-y",
            "-threads", "0",
            "-i", str(src),
            #"-vf", scale_filter,
            "-c:v", video_encoder,
            "-preset", "slow",
            *bitrate_args,
            *(
                ["-x265-params", "pools=none:wpp=1:pmode=1:pme=1"]
                if target_codec == "hevc"
                else []
            ),
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            str(dst),
        ]
    log.info("Running: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    while True:
        ret = proc.poll()
        if ret is not None:
            break
        if cancel_flag and cancel_flag():
            proc.kill()
            proc.wait()
            raise JobCancelledError("Job cancelled by user")
        time.sleep(1)
    if proc.returncode != 0:
        stderr_out = proc.stderr.read().decode(errors="replace")
        raise subprocess.CalledProcessError(proc.returncode, cmd, stderr=stderr_out.encode())


def upload_to_dist(local_path: Path, dest_path: str):
    """Upload a file to the distribution server."""
    with open(local_path, "rb") as f:
        response = httpx.post(
            f"{DIST_SERVER_URL}/upload",
            params={"dest_path": dest_path},
            files={"file": (local_path.name, f, "application/octet-stream")},
            headers=dist_headers(),
            timeout=None,  # large files
        )
    if response.status_code == 401:
        log.info("Token expired, refreshing and retrying upload")
        get_dist_token()
        with open(local_path, "rb") as f:
            response = httpx.post(
                f"{DIST_SERVER_URL}/upload",
                params={"dest_path": dest_path},
                files={"file": (local_path.name, f, "application/octet-stream")},
                headers=dist_headers(),
                timeout=None,
            )
    response.raise_for_status()
    return response.json()


# ---------------------------------------------------------------------------
# Main processing
# ---------------------------------------------------------------------------


def process_job(job_id: str, db: Session):
    job = db.query(JobModel).filter(JobModel.id == job_id).first()
    if not job:
        raise ValueError(f"Job {job_id} not found in database")
    if job.status == "cancelled":
        log.info("Job %s already cancelled, skipping", job_id)
        return
    log.info("Processing job %s (%s)", job_id, job.original_filename)

    def is_cancelled() -> bool:
        return bool(rdb.exists(f"{CANCEL_KEY_PREFIX}{job_id}"))

    src_path = Path(job.upload_path)
    if not src_path.exists():
        raise FileNotFoundError(f"Source file not found: {src_path}")

    src_info = get_video_info(src_path)
    src_width, src_height = src_info["width"], src_info["height"]
    log.info(
        "Source: %dx%d  codec=%s  fps=%s  bitrate=%s",
        src_width, src_height,
        src_info["codec"],
        src_info["fps"],
        f"{src_info['bitrate'] // 1000} kbps" if src_info["bitrate"] else "unknown",
    )

    stem = Path(job.original_filename).stem
    suffix = Path(job.original_filename).suffix
    dest_folder = job.dest_path.rstrip("/")

    job.status = "transcoding"
    job.source_resolution = {"width": src_width, "height": src_height}
    job.source_codec = src_info["codec"]
    job.source_bitrate = src_info["bitrate"]
    job.source_fps = src_info["fps"]
    job.source_file_size = src_path.stat().st_size
    db.commit()

    target_codec = job.target_codec or TARGET_CODEC
    progress = dict(job.transcode_progress or {})
    profile_bitrates = dict(job.profile_bitrates or {})

    for label, prof_width, prof_height in PROFILES:
        # Check for cancellation before starting each profile
        if is_cancelled():
            log.info("Job %s cancelled before profile %s", job_id, label)
            job.status = "cancelled"
            db.commit()
            raise JobCancelledError("Job cancelled by user")

        # Never upscale
        if prof_height > src_height:
            log.info("Skipping %s (source %dp < target %dp)", label, src_height, prof_height)
            progress[label] = "skipped"
            job.transcode_progress = progress
            flag_modified(job, "transcode_progress")
            db.commit()
            continue

        # Skip already completed profiles (resume support)
        if progress.get(label) == "uploaded":
            log.info("Profile %s already uploaded, skipping", label)
            continue

        out_filename = f"{stem}_{label}{suffix}"
        out_path = TRANSCODED_DIR / job_id / out_filename

        # Transcode if not already done
        use_copy = should_copy(src_info, label, prof_height, target_codec)
        if progress.get(label) != "transcoded" or not out_path.exists():
            progress[label] = "transcoding"
            job.transcode_progress = progress
            flag_modified(job, "transcode_progress")
            db.commit()
            try:
                bitrate_range = BITRATE_RANGES.get(target_codec, {}).get(label, (0, 0))
                transcode(
                    src_path, out_path, prof_width, prof_height,
                    target_codec=target_codec, use_copy=use_copy,
                    bitrate_lo=bitrate_range[0], bitrate_hi=bitrate_range[1],
                    cancel_flag=is_cancelled,
                )

                # Probe and log output file info (codec, bitrate, fps)
                out_info = get_output_file_info(out_path)
                if out_info:
                    v = out_info.get("video", {})
                    a = out_info.get("audio", {})
                    log.info(
                        "Profile %s output (%s): "
                        "video=%s %s kbps @ %s fps | "
                        "audio=%s %s kbps | total=%s kbps",
                        label,
                        "stream copy" if use_copy else "encoded",
                        v.get("codec", "?"),
                        v.get("bitrate_kbps", "?"),
                        v.get("fps", "?"),
                        a.get("codec", "?"),
                        a.get("bitrate_kbps", "?"),
                        out_info.get("total_bitrate_kbps", "?"),
                    )
                    profile_bitrates[label] = out_info
                    job.profile_bitrates = profile_bitrates
                    flag_modified(job, "profile_bitrates")
                else:
                    log.warning("Profile %s output info: unknown", label)

                progress[label] = "transcoded"
                job.transcode_progress = progress
                flag_modified(job, "transcode_progress")
                db.commit()
                log.info("Transcoded %s → %s", label, out_path)
            except JobCancelledError:
                progress[label] = "cancelled"
                job.transcode_progress = progress
                flag_modified(job, "transcode_progress")
                job.status = "cancelled"
                db.commit()
                raise
            except subprocess.CalledProcessError as e:
                progress[label] = "failed"
                job.transcode_progress = progress
                flag_modified(job, "transcode_progress")
                job.error = f"FFmpeg failed on profile {label}: {e}"
                job.status = "failed"
                db.commit()
                raise

        # Upload to dist-server
        progress[label] = "uploading"
        job.transcode_progress = progress
        flag_modified(job, "transcode_progress")
        db.commit()
        try:
            remote_dest = f"{dest_folder}/{out_filename}"
            upload_to_dist(out_path, remote_dest)
            progress[label] = "uploaded"
            job.transcode_progress = progress
            flag_modified(job, "transcode_progress")
            db.commit()
            log.info("Uploaded %s to dist-server at %s", out_filename, remote_dest)
            # Remove the transcoded file now that it's safely on the dist-server
            try:
                out_path.unlink(missing_ok=True)
                log.info("Removed local transcoded file %s", out_path)
            except OSError as cleanup_err:
                log.warning("Could not remove transcoded file %s: %s", out_path, cleanup_err)
        except Exception as e:
            progress[label] = "upload_failed"
            job.transcode_progress = progress
            flag_modified(job, "transcode_progress")
            job.error = f"Upload failed for profile {label}: {e}"
            job.status = "failed"
            db.commit()
            raise

    # Append .plexmatch entries for all uploaded profiles
    season = job.season
    episode = job.episode
    plexmatch_entries = []
    for label, _, _ in PROFILES:
        if progress.get(label) == "uploaded":
            out_filename = f"{stem}_{label}{suffix}"
            plexmatch_entries.append(
                f"ep: s{season:02d}e{episode:02d}: {out_filename}"
            )
    if plexmatch_entries:
        try:
            resp = httpx.post(
                f"{DIST_SERVER_URL}/plexmatch",
                params={"path": job.dest_path},
                json={"entries": plexmatch_entries},
                headers=dist_headers(),
            )
            if resp.status_code == 401:
                get_dist_token()
                resp = httpx.post(
                    f"{DIST_SERVER_URL}/plexmatch",
                    params={"path": job.dest_path},
                    json={"entries": plexmatch_entries},
                    headers=dist_headers(),
                )
            resp.raise_for_status()
            log.info("Appended %d entries to .plexmatch", len(plexmatch_entries))
        except Exception as e:
            log.warning("Failed to update .plexmatch (non-fatal): %s", e)

    job.status = "completed"
    job.error = None
    db.commit()
    log.info("Job %s completed successfully", job_id)

    # Clean up source upload file and the (now empty) transcoded job directory
    try:
        src_path.unlink(missing_ok=True)
        log.info("Removed source upload file %s", src_path)
    except OSError as e:
        log.warning("Could not remove source file %s: %s", src_path, e)
    try:
        job_transcode_dir = TRANSCODED_DIR / job_id
        if job_transcode_dir.exists():
            import shutil
            shutil.rmtree(job_transcode_dir)
            log.info("Removed transcoded directory %s", job_transcode_dir)
    except OSError as e:
        log.warning("Could not remove transcoded dir: %s", e)


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------

def main():
    log.info("Transcoder worker starting…")
    wait_for_db()
    wait_for_dist_token()
    log.info("Listening on queue '%s'", TRANSCODE_QUEUE)
    while True:
        try:
            # Blocking pop with 5s timeout
            result = rdb.blpop(TRANSCODE_QUEUE, timeout=5)
            if result is None:
                continue
            _, job_id = result
            log.info("Picked up job: %s", job_id)
            db = SessionLocal()
            try:
                process_job(job_id, db)
            except JobCancelledError:
                log.info("Job %s was cancelled", job_id)
            except Exception as exc:
                log.error("Job %s failed: %s", job_id, exc, exc_info=True)
                try:
                    job = db.query(JobModel).filter(JobModel.id == job_id).first()
                    if job and job.status not in ("failed", "cancelled"):
                        job.status = "failed"
                        job.error = str(exc)
                        db.commit()
                except Exception:
                    pass
            finally:
                db.close()
        except redis.exceptions.ConnectionError as e:
            log.error("Redis connection error: %s. Retrying in 5s...", e)
            time.sleep(5)
        except Exception as e:
            log.error("Unexpected error: %s. Retrying in 5s...", e)
            time.sleep(5)


if __name__ == "__main__":
    main()
