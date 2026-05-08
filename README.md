# Video Ready

A containerized video transcoding pipeline with a React UI.

## Services

| Service | Port | Description |
|---|---|---|
| `ui` | 3000 | React frontend (served by nginx) |
| `main-backend` | 8000 | FastAPI – auth, jobs, file upload |
| `dist-server` | 8001 | FastAPI – file browser + upload receiver |
| `transcoder` | — | Python worker (FFmpeg) |
| `redis` | — | Job queue + state store |

## Quick Start

```bash
cp .env.example .env
# Edit .env and set a strong SECRET_KEY

docker compose up --build
```

Open http://localhost:3000

**Default credentials:** `admin` / `admin123`  
(Change via the API at `POST /auth/change-password` or update `USERS_DB` in `main-backend/main.py`)

## Transcode Profiles

| Profile | Width | Height | Notes |
|---|---|---|---|
| 4K | 3840 | 2160 | Only produced if source ≥ 2160p |
| 1080p | 1920 | 1080 | Only if source ≥ 1080p |
| 720p | 1280 | 720 | Only if source ≥ 720p |
| 480p | 854 | 480 | Always produced (minimum) |

Output filenames: `original_1080p.mp4`, `original_720p.mp4`, etc.

### Target Bitrate Ranges

Sources already matching the target codec and within range are **stream-copied** (no re-encode).

**H.264**

| Profile | Min | Max |
|---|---|---|
| 4K | 35 Mbps | 68 Mbps |
| 1080p | 8 Mbps | 16 Mbps |
| 720p | 4 Mbps | 8 Mbps |
| 480p | 1.5 Mbps | 3 Mbps |

**H.265 / HEVC**

| Profile | Min | Max |
|---|---|---|
| 4K | 15 Mbps | 35 Mbps |
| 1080p | 4 Mbps | 10 Mbps |
| 720p | 2.5 Mbps | 5 Mbps |
| 480p | 1 Mbps | 2 Mbps |

## Resume After Failure

Per-profile progress is stored in Redis. If the transcoder crashes mid-job, click **Retry** in the UI (or `POST /jobs/{id}/retry`) and it will skip already-uploaded profiles and resume from where it left off.

## Architecture

```
Browser → nginx (ui:80)
           ├── /api/*  → main-backend:8000
           └── /dist/* → dist-server:8001

main-backend → Redis (job queue)
transcoder   → polls Redis queue → ffmpeg → dist-server upload
```
