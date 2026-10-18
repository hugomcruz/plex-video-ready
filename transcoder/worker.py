"""
Transcoder Worker
- Polls Redis queue for job IDs
- Downloads source file from S3
- Uses ffprobe to detect source resolution, codec, and bitrate
- Transcodes a single profile matching the source's own resolution (width and
  height), at a bitrate/codec chosen from an encoding matrix keyed by
  resolution, fps, and source codec (4K is always HEVC; other resolutions
  keep the source codec). Non-standard resolutions are uploaded untouched.
- Stream-copies video when the source codec matches and its bitrate is at or
  below the target ceiling (never inflates an already-small source)
- Re-encodes keep the source's bit depth (HEVC) and colour/HDR tags
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

import boto3
from botocore.exceptions import ClientError, NoCredentialsError
import httpx

logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s [transcoder] %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

BACKEND_URL   = os.environ.get("BACKEND_URL", "http://main-backend:8000")
WORKER_TOKEN  = os.environ.get("WORKER_TOKEN", "")
TRANSCODED_DIR = Path(os.environ.get("TRANSCODED_DIR", "/transcoded"))
DIST_SERVER_URL = os.environ.get("DIST_SERVER_URL", "http://dist-server:8001")
DIST_SERVICE_PASSWORD = os.environ.get("DIST_SERVICE_PASSWORD", "dist_service_password")

# S3 config
S3_ENDPOINT_URL = os.environ.get("S3_ENDPOINT_URL")
S3_ACCESS_KEY   = os.environ.get("S3_ACCESS_KEY", "")
S3_SECRET_KEY   = os.environ.get("S3_SECRET_KEY", "")
S3_BUCKET       = os.environ.get("S3_BUCKET", "")
S3_REGION       = os.environ.get("S3_REGION", "us-east-1")


# ---------------------------------------------------------------------------
# Backend REST client
# ---------------------------------------------------------------------------

def _worker_headers() -> dict:
    return {"Authorization": f"Bearer {WORKER_TOKEN}"}


def api_dequeue() -> str | None:
    """Pop the next job_id from the backend queue. Returns None if empty."""
    resp = httpx.post(f"{BACKEND_URL}/worker/dequeue", headers=_worker_headers(), timeout=10)
    resp.raise_for_status()
    return resp.json().get("job_id")


def api_get_job(job_id: str) -> dict:
    resp = httpx.get(f"{BACKEND_URL}/worker/jobs/{job_id}", headers=_worker_headers(), timeout=10)
    resp.raise_for_status()
    return resp.json()


def api_patch_job(job_id: str, **fields) -> None:
    """Send a partial update for a job. Only the supplied fields are updated."""
    resp = httpx.patch(
        f"{BACKEND_URL}/worker/jobs/{job_id}",
        json=fields,
        headers=_worker_headers(),
        timeout=10,
    )
    resp.raise_for_status()


def api_is_cancelled(job_id: str) -> bool:
    try:
        resp = httpx.get(
            f"{BACKEND_URL}/worker/jobs/{job_id}/cancelled",
            headers=_worker_headers(),
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json().get("cancelled", False)
    except Exception:
        return False  # treat transient errors as not-cancelled


def wait_for_backend(max_wait: int = 120) -> None:
    """Block until the main-backend /health endpoint responds."""
    delay = 2
    elapsed = 0
    while elapsed < max_wait:
        try:
            resp = httpx.get(f"{BACKEND_URL}/health", timeout=5)
            if resp.status_code == 200:
                log.info("Backend ready at %s", BACKEND_URL)
                return
        except Exception as exc:
            log.warning("Backend not ready (%s), retrying in %ds…", exc, delay)
        time.sleep(delay)
        elapsed += delay
        delay = min(delay * 2, 15)
    raise RuntimeError(f"Could not reach backend at {BACKEND_URL} after {max_wait}s")


def get_s3_client():
    kwargs = dict(
        region_name=S3_REGION,
        aws_access_key_id=S3_ACCESS_KEY or None,
        aws_secret_access_key=S3_SECRET_KEY or None,
    )
    if S3_ENDPOINT_URL:
        kwargs["endpoint_url"] = S3_ENDPOINT_URL
    return boto3.client("s3", **kwargs)


def download_from_s3(s3_key: str, dest_path: Path) -> None:
    """Download an S3 object to a local path."""
    if not S3_BUCKET:
        raise RuntimeError("S3_BUCKET is not configured")
    s3 = get_s3_client()
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    # A retry may find the source already downloaded by an earlier attempt.
    # boto3 downloads to a temp file and renames on completion, so an existing
    # file of the right size is complete.
    try:
        remote_size = s3.head_object(Bucket=S3_BUCKET, Key=s3_key)["ContentLength"]
        if dest_path.exists() and dest_path.stat().st_size == remote_size:
            log.info("Source %s already downloaded (%d bytes), reusing", dest_path.name, remote_size)
            return
    except (ClientError, NoCredentialsError):
        pass  # fall through to the real download, which reports any S3 error
    log.info("Downloading s3://%s/%s → %s", S3_BUCKET, s3_key, dest_path)
    try:
        s3.download_file(S3_BUCKET, s3_key, str(dest_path))
    except (ClientError, NoCredentialsError) as e:
        raise RuntimeError(f"S3 download failed: {e}") from e
    log.info("Downloaded %s (%d bytes)", s3_key, dest_path.stat().st_size)

TRANSCODE_QUEUE = "transcode_queue"


class JobCancelledError(Exception):
    """Raised when a job is cancelled by the user."""


# Profile definitions: (label, width, height)
PROFILES = [
    ("4k",    3840, 2160),
    ("1080p", 1920, 1080),
    ("720p",  1280, 720),
    ("480p",  854,  480),
]

# Target bitrate in kbps per resolution profile / fps bucket / codec, per the
# encoding matrix. The codec here is both the source AND output codec: HEVC
# sources stay HEVC, H.264 sources stay H.264 (see resolve_target_codec).
# 4K has no H.264 row — 4K sources are always forced to HEVC regardless of
# their source codec.
BITRATE_MATRIX_KBPS: dict[str, dict[int, dict[str, int]]] = {
    "4k":    {60: {"hevc": 35_000}, 30: {"hevc": 25_000}},
    "1080p": {60: {"hevc": 6_000, "h264": 9_000}, 30: {"hevc": 4_500, "h264": 6_000}},
    "720p":  {60: {"hevc": 3_500, "h264": 5_000}, 30: {"hevc": 2_500, "h264": 4_000}},
    "480p":  {60: {"hevc": 1_800, "h264": 2_500}, 30: {"hevc": 1_200, "h264": 2_000}},
}

# ffprobe codec_name → our internal key used in the bitrate matrix
CODEC_MAP: dict[str, str] = {
    "h264": "h264",
    "hevc": "hevc",
    "h265": "hevc",
}

# Fallback output codec for source codecs outside the matrix (e.g. VP9, AV1,
# MPEG-2): resolved per-profile by resolve_target_codec (4K -> HEVC, else H264).
FALLBACK_CODEC = "h264"


# Source widths may differ from a profile's nominal width by a few pixels
# (e.g. 848/853/854x480); anything further off is a non-standard resolution.
WIDTH_TOLERANCE = 8


def standard_profile_label(width: int, height: int) -> str | None:
    """Return the profile label whose resolution the source matches, else None.

    Both dimensions must match: a 2560x1080 (21:9) or 720x480 source shares a
    height with a profile but isn't that resolution, so it's treated as
    non-standard and copied through untouched.
    """
    for label, prof_width, prof_height in PROFILES:
        if height == prof_height and abs(width - prof_width) <= WIDTH_TOLERANCE:
            return label
    return None


def fps_bucket(fps: float | None) -> int:
    """Bucket a source fps into the matrix's 30/60 rows.

    This only selects which bitrate-matrix row to use — the output frame
    rate always matches the source exactly (ffmpeg performs no fps
    conversion here).
    """
    return 60 if fps and fps > 30 else 30


def resolve_target_codec(label: str, src_codec_key: str | None, override: str | None = None) -> str:
    """Pick the output codec for a profile per the encoding matrix.

    An explicit override (the job's target_codec field, set via the UI's
    "override codec" checkbox) always wins. Otherwise: 4K is always encoded
    as HEVC; other resolutions keep the source's own codec when it's H.264
    or HEVC; any other/unknown source codec falls back to FALLBACK_CODEC.
    """
    if override in ("h264", "hevc"):
        return override
    if label == "4k":
        return "hevc"
    if src_codec_key in ("h264", "hevc"):
        return src_codec_key
    return FALLBACK_CODEC


def target_bitrate_range(label: str, fps: float | None, codec: str) -> tuple[int, int]:
    """Return (lo, hi) bits/sec = matrix target ±25% for this profile/fps/codec.

    Falls back to the other fps bucket if the exact one has no entry for
    this codec (e.g. a 720p H.264 source has no matching column at 4K).
    If the codec still isn't found (e.g. an explicit H.264 override at 4K,
    which the matrix only defines for HEVC), falls back to whatever codec
    IS defined for that resolution/fps as an approximate target.
    """
    bucket = fps_bucket(fps)
    other_bucket = 60 if bucket == 30 else 30
    by_bucket = BITRATE_MATRIX_KBPS.get(label, {})
    target_kbps = by_bucket.get(bucket, {}).get(codec)
    if target_kbps is None:
        target_kbps = by_bucket.get(other_bucket, {}).get(codec)
    if target_kbps is None:
        fallback_row = by_bucket.get(bucket) or by_bucket.get(other_bucket) or {}
        target_kbps = next(iter(fallback_row.values()), None)
    if target_kbps is None:
        raise KeyError(f"No bitrate matrix entry for {label}/{codec}")
    target_bps = target_kbps * 1000
    return int(target_bps * 0.75), int(target_bps * 1.25)




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
    """Return codec, size, bitrate, fps and colour info of the first video stream.

    bitrate is in bits/sec (int) or None if ffprobe cannot determine it.
    fps is a float or None. pix_fmt / color_* are ffprobe strings or None.
    """
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries",
            "stream=width,height,codec_name,bit_rate,avg_frame_rate,"
            "pix_fmt,color_primaries,color_transfer,color_space",
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
    return {
        "width": width, "height": height, "codec": codec, "bitrate": bitrate, "fps": fps,
        "pix_fmt": stream.get("pix_fmt"),
        "color_primaries": stream.get("color_primaries"),
        "color_transfer": stream.get("color_transfer"),
        "color_space": stream.get("color_space"),
    }


def should_copy(src_info: dict, label: str, target_codec: str) -> bool:
    """Return True when the source video can be stream-copied for this profile.

    Conditions (all must hold):
    - Source codec is the same as target_codec.
    - Source bitrate is known and is at or below the profile's target ceiling
      (target +25%). Re-encoding a source that's already under the target
      would only inflate it, so anything at or below the ceiling is kept.
    The resolution always matches the profile here (non-standard resolutions
    never reach this point), so no scaling is involved.
    """
    codec_key = CODEC_MAP.get(src_info["codec"])
    if codec_key != target_codec:
        return False
    bitrate = src_info["bitrate"]
    if bitrate is None:
        return False
    _, hi = target_bitrate_range(label, src_info["fps"], target_codec)
    return bitrate <= hi


def video_color_args(src_info: dict, target_codec: str) -> list[str]:
    """ffmpeg args to preserve bit depth and colour tags on a re-encode.

    HEVC keeps 10-bit sources 10-bit (8-bit would crush HDR/banding); H.264
    stays 8-bit for playback compatibility. Colour primaries/transfer/matrix
    are passed through when the source declares them, so HDR10 stays HDR10
    (libx265 also forwards mastering-display / content-light-level metadata).
    """
    pix_fmt = (src_info.get("pix_fmt") or "")
    ten_bit = "10" in pix_fmt or "12" in pix_fmt
    args = ["-pix_fmt", "yuv420p10le" if target_codec == "hevc" and ten_bit else "yuv420p"]
    for flag, key in (
        ("-color_primaries", "color_primaries"),
        ("-color_trc", "color_transfer"),
        ("-colorspace", "color_space"),
    ):
        value = src_info.get(key)
        if value and value != "unknown":
            args += [flag, value]
    return args


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
                "-show_entries", "format=bit_rate,duration",
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
        duration_str = data.get("format", {}).get("duration")
        info["duration_sec"] = (
            round(float(duration_str), 1) if duration_str and duration_str != "N/A" else None
        )
        return info
    except Exception as exc:
        log.warning("Could not probe output info for %s: %s", path, exc)
        return {}


def transcode(
    src: Path,
    dst: Path,
    src_info: dict,
    target_codec: str = "hevc",
    use_copy: bool = False,
    bitrate_lo: int = 0,
    bitrate_hi: int = 0,
    cancel_flag=None,
):
    """Run ffmpeg to transcode src → dst at the source's own resolution.

    When use_copy=True the video stream is copied as-is (codec/bitrate already
    acceptable) and only the audio is normalised to AAC 128k.
    target_codec is "h264" or "hevc".
    bitrate_lo/bitrate_hi are the target range in bits/sec; when provided the
    encoder targets the midpoint and is capped at the maximum.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    # Encode to a temp name and rename on success, so `dst` only ever exists
    # when it is complete (lets a retry safely skip straight to the upload).
    tmp = dst.with_name(f"{dst.stem}.partial{dst.suffix}")
    tmp.unlink(missing_ok=True)
    ffmpeg_loglevel = os.environ.get("FFMPEG_LOG_LEVEL", "verbose")
    ffmpeg_threads = os.environ.get("FFMPEG_THREADS", "0")
    if use_copy:
        cmd = [
            "ffmpeg", "-y",
            "-loglevel", ffmpeg_loglevel,
            "-threads", ffmpeg_threads,
            "-i", str(src),
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            str(tmp),
        ]
        log.info("Stream-copying video for %s (codec+bitrate within target range)", dst.name)
    else:
        video_encoder = "libx265" if target_codec == "hevc" else "libx264"
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
            "-loglevel", ffmpeg_loglevel,
            "-threads", ffmpeg_threads,
            "-i", str(src),
            "-c:v", video_encoder,
            *video_color_args(src_info, target_codec),
            "-preset", "medium",
            *bitrate_args,
            *(
                ["-x265-params", "pools=+:wpp=1:pmode=1:pme=1"]
                if target_codec == "hevc"
                else []
            ),
            *(
                ["-tag:v", "hvc1"]
                if target_codec == "hevc" and dst.suffix.lower() == ".mp4"
                else []
            ),
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            str(tmp),
        ]
    log.info("Running: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stderr_lines: list[str] = []

    def _drain_stderr():
        for raw in proc.stderr:
            line = raw.decode(errors="replace").rstrip()
            stderr_lines.append(line)
            log.info("[ffmpeg] %s", line)

    import threading
    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    while True:
        ret = proc.poll()
        if ret is not None:
            break
        if cancel_flag and cancel_flag():
            proc.kill()
            proc.wait()
            tmp.unlink(missing_ok=True)
            raise JobCancelledError("Job cancelled by user")
        time.sleep(1)

    stderr_thread.join()
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise subprocess.CalledProcessError(
            proc.returncode, cmd, stderr="\n".join(stderr_lines).encode()
        )
    os.replace(tmp, dst)


def dist_post(endpoint: str, folder: str, payload: dict) -> dict:
    """POST JSON to a dist-server endpoint for a folder, refreshing the token once on 401."""
    def _send():
        return httpx.post(
            f"{DIST_SERVER_URL}{endpoint}",
            params={"path": folder},
            json=payload,
            headers=dist_headers(),
            timeout=30,
        )

    resp = _send()
    if resp.status_code == 401:
        get_dist_token()
        resp = _send()
    resp.raise_for_status()
    return resp.json()


def upload_to_dist(local_path: Path, dest_path: str, attempts: int = 3):
    """Upload a file, retrying transient failures with a short backoff."""
    for attempt in range(1, attempts + 1):
        try:
            return _upload_once(local_path, dest_path)
        except Exception as exc:
            if attempt == attempts:
                raise
            delay = 5 * attempt
            log.warning(
                "Upload of %s failed (attempt %d/%d): %s — retrying in %ds",
                local_path.name, attempt, attempts, exc, delay,
            )
            time.sleep(delay)


def _upload_once(local_path: Path, dest_path: str):
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


def process_job(job_id: str) -> None:
    job = api_get_job(job_id)
    if job["status"] == "cancelled":
        log.info("Job %s already cancelled, skipping", job_id)
        return
    log.info("Processing job %s (%s)", job_id, job["original_filename"])

    def is_cancelled() -> bool:
        return api_is_cancelled(job_id)

    # Resolve the source file: download from S3 if s3_key is set, else fall
    # back to the legacy local upload_path for backward compatibility.
    downloaded_path: Path | None = None
    if job.get("s3_key"):
        local_download = TRANSCODED_DIR / job_id / Path(job["original_filename"]).name
        download_from_s3(job["s3_key"], local_download)
        src_path = local_download
        downloaded_path = local_download
    elif job.get("upload_path"):
        src_path = Path(job["upload_path"])
        if not src_path.exists():
            raise FileNotFoundError(f"Source file not found: {src_path}")
    else:
        raise ValueError(f"Job {job_id} has neither s3_key nor upload_path")

    src_info = get_video_info(src_path)
    src_width, src_height = src_info["width"], src_info["height"]
    log.info(
        "Source: %dx%d  codec=%s  fps=%s  bitrate=%s",
        src_width, src_height,
        src_info["codec"],
        src_info["fps"],
        f"{src_info['bitrate'] // 1000} kbps" if src_info["bitrate"] else "unknown",
    )

    stem = Path(job["original_filename"]).stem
    suffix = Path(job["original_filename"]).suffix
    dest_folder = job["dest_path"].rstrip("/")

    api_patch_job(
        job_id,
        status="transcoding",
        source_resolution={"width": src_width, "height": src_height},
        source_codec=src_info["codec"],
        source_bitrate=src_info["bitrate"],
        source_fps=src_info["fps"],
        source_file_size=src_path.stat().st_size,
    )

    progress: dict = dict(job.get("transcode_progress") or {})
    profile_bitrates: dict = dict(job.get("profile_bitrates") or {})

    target_label = standard_profile_label(src_width, src_height)

    if target_label is None:
        # Non-standard source resolution (width and height must both match a
        # profile): don't resize or pad it into a standard canvas. Copy the
        # original file through untouched and flag it ("original") so the UI
        # can highlight that no transcoding happened.
        log.info(
            "Source resolution %dx%d is non-standard — copying original file as-is",
            src_width, src_height,
        )
        label = "original"
        if is_cancelled():
            api_patch_job(job_id, status="cancelled")
            raise JobCancelledError("Job cancelled by user")

        if progress.get(label) != "uploaded":
            progress[label] = "uploading"
            api_patch_job(job_id, transcode_progress=progress)
            out_info = get_output_file_info(src_path)
            if out_info:
                profile_bitrates[label] = out_info
                api_patch_job(job_id, profile_bitrates=profile_bitrates)
            try:
                remote_dest = f"{dest_folder}/{job['original_filename']}"
                upload_to_dist(src_path, remote_dest)
                progress[label] = "uploaded"
                api_patch_job(job_id, transcode_progress=progress)
                log.info("Uploaded original file to dist-server at %s", remote_dest)
            except Exception as e:
                progress[label] = "upload_failed"
                api_patch_job(
                    job_id,
                    transcode_progress=progress,
                    error=f"Upload failed for original file: {e}",
                    status="failed",
                )
                raise
    else:
        # Only keep a single rendition: the profile matching the source's
        # own resolution. The output keeps the source's dimensions as-is.
        for label, _, _ in PROFILES:
            # Check for cancellation before starting each profile
            if is_cancelled():
                log.info("Job %s cancelled before profile %s", job_id, label)
                api_patch_job(job_id, status="cancelled")
                raise JobCancelledError("Job cancelled by user")

            if label != target_label:
                log.info("Skipping %s (keeping only source-matching resolution %s)", label, target_label)
                progress[label] = "skipped"
                api_patch_job(job_id, transcode_progress=progress)
                continue

            # Skip already completed profiles (resume support)
            if progress.get(label) == "uploaded":
                log.info("Profile %s already uploaded, skipping", label)
                continue

            out_filename = f"{stem}_{label}{suffix}"
            out_path = TRANSCODED_DIR / job_id / out_filename

            # Transcode if not already done
            profile_codec = resolve_target_codec(
                label, CODEC_MAP.get(src_info["codec"]), override=job.get("target_codec")
            )
            use_copy = should_copy(src_info, label, profile_codec)
            # A previous attempt may have finished encoding and failed later
            # (e.g. during upload): the output file is only ever renamed into
            # place when complete, so reuse it instead of encoding again.
            already_encoded = (
                progress.get(label) in ("transcoded", "uploading", "upload_failed")
                and out_path.exists()
            )
            if already_encoded:
                log.info("Profile %s already transcoded (%s) — skipping to upload", label, out_path.name)
            else:
                progress[label] = "transcoding"
                api_patch_job(job_id, transcode_progress=progress)
                try:
                    bitrate_range = target_bitrate_range(label, src_info["fps"], profile_codec)
                    encode_started = time.monotonic()
                    transcode(
                        src_path, out_path, src_info,
                        target_codec=profile_codec, use_copy=use_copy,
                        bitrate_lo=bitrate_range[0], bitrate_hi=bitrate_range[1],
                        cancel_flag=is_cancelled,
                    )
                    encode_seconds = round(time.monotonic() - encode_started, 1)

                    # Probe and log output file info (codec, bitrate, fps)
                    out_info = get_output_file_info(out_path)
                    if out_info:
                        # Encode timing (ffmpeg only; excludes download/upload).
                        # speed = media seconds produced per wall-clock second.
                        out_info["mode"] = "copy" if use_copy else "encoded"
                        out_info["encode_seconds"] = encode_seconds
                        media_sec = out_info.get("duration_sec")
                        out_info["speed"] = (
                            round(media_sec / encode_seconds, 2)
                            if media_sec and encode_seconds > 0 else None
                        )
                        log.info(
                            "Profile %s %s took %.1fs (%s x realtime, %s media seconds)",
                            label, out_info["mode"], encode_seconds,
                            out_info["speed"], media_sec,
                        )
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
                        api_patch_job(job_id, profile_bitrates=profile_bitrates)
                    else:
                        log.warning("Profile %s output info: unknown", label)

                    progress[label] = "transcoded"
                    api_patch_job(job_id, transcode_progress=progress)
                    log.info("Transcoded %s → %s", label, out_path)
                except JobCancelledError:
                    progress[label] = "cancelled"
                    api_patch_job(job_id, transcode_progress=progress, status="cancelled")
                    raise
                except subprocess.CalledProcessError as e:
                    progress[label] = "failed"
                    api_patch_job(
                        job_id,
                        transcode_progress=progress,
                        error=f"FFmpeg failed on profile {label}: {e}",
                        status="failed",
                    )
                    raise

            # Upload to dist-server
            progress[label] = "uploading"
            api_patch_job(job_id, transcode_progress=progress)
            try:
                remote_dest = f"{dest_folder}/{out_filename}"
                upload_to_dist(out_path, remote_dest)
                progress[label] = "uploaded"
                api_patch_job(job_id, transcode_progress=progress)
                log.info("Uploaded %s to dist-server at %s", out_filename, remote_dest)
                # Remove the transcoded file now that it's safely on the dist-server
                try:
                    out_path.unlink(missing_ok=True)
                    log.info("Removed local transcoded file %s", out_path)
                except OSError as cleanup_err:
                    log.warning("Could not remove transcoded file %s: %s", out_path, cleanup_err)
            except Exception as e:
                progress[label] = "upload_failed"
                api_patch_job(
                    job_id,
                    transcode_progress=progress,
                    error=f"Upload failed for profile {label}: {e}",
                    status="failed",
                )
                raise

    # Register the uploaded files in the destination's .plexmatch
    uploaded_files = []
    if progress.get("original") == "uploaded":
        uploaded_files.append(job["original_filename"])
    for label, _, _ in PROFILES:
        if progress.get(label) == "uploaded":
            uploaded_files.append(f"{stem}_{label}{suffix}")

    plexmatch_error = None
    if uploaded_files:
        try:
            if job.get("season") is None or job.get("episode") is None:
                # Auto mode: the dist-server picks the next episode after the
                # last record in .plexmatch, atomically, at distribution time.
                assigned = dist_post(
                    "/plexmatch/auto", job["dest_path"], {"filenames": uploaded_files}
                )
                api_patch_job(job_id, season=assigned["season"], episode=assigned["episode"])
                log.info(
                    "Assigned S%02dE%02d to %s", assigned["season"], assigned["episode"],
                    ", ".join(uploaded_files),
                )
            else:
                season, episode = job["season"], job["episode"]
                entries = [f"ep: s{season:02d}e{episode:02d}: {name}" for name in uploaded_files]
                dist_post("/plexmatch", job["dest_path"], {"entries": entries})
                log.info("Appended %d entries to .plexmatch", len(entries))
        except Exception as e:
            log.warning("Failed to update .plexmatch: %s", e)
            plexmatch_error = f"Uploaded, but .plexmatch was not updated: {e}"

    api_patch_job(job_id, status="completed", error=plexmatch_error)
    log.info("Job %s completed successfully", job_id)

    # Clean up: remove downloaded S3 file (or legacy upload), then the job dir
    file_to_remove = downloaded_path or (Path(job["upload_path"]) if job.get("upload_path") else None)
    if file_to_remove:
        try:
            file_to_remove.unlink(missing_ok=True)
            log.info("Removed source file %s", file_to_remove)
        except OSError as e:
            log.warning("Could not remove source file %s: %s", file_to_remove, e)
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
    wait_for_backend()
    wait_for_dist_token()
    log.info("Polling backend for jobs…")
    while True:
        try:
            job_id = api_dequeue()
            if not job_id:
                time.sleep(5)
                continue
            log.info("Picked up job: %s", job_id)
            try:
                process_job(job_id)
            except JobCancelledError:
                log.info("Job %s was cancelled", job_id)
            except Exception as exc:
                log.error("Job %s failed: %s", job_id, exc, exc_info=True)
                try:
                    api_patch_job(job_id, status="failed", error=str(exc))
                except Exception:
                    pass
        except httpx.HTTPError as e:
            log.error("Backend connection error: %s. Retrying in 5s...", e)
            time.sleep(5)
        except Exception as e:
            log.error("Unexpected error: %s. Retrying in 5s...", e)
            time.sleep(5)


if __name__ == "__main__":
    main()
