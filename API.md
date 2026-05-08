# API Reference

All services run inside Docker. The React UI (nginx) proxies:
- `/api/*` → `main-backend:8000`
- `/dist/*` → `dist-server:8001`

Default credentials: `admin` / `admin123`

---

## Main Backend — `/api`

> Port `8000` internally, accessed via nginx at `/api`.  
> All routes except `/auth/token` require a `Bearer` JWT token.

### Authentication

#### `POST /auth/token`
Obtain a JWT access token (valid 8 hours).

**Request** — `application/x-www-form-urlencoded`
| Field | Type | Description |
|---|---|---|
| `username` | string | Account username |
| `password` | string | Account password |

**Response**
```json
{ "access_token": "<jwt>", "token_type": "bearer" }
```

---

#### `GET /auth/me`
Return the currently authenticated user.

**Response**
```json
{ "username": "admin" }
```

---

#### `POST /auth/change-password`
Change the password for the authenticated user.

**Request body** — `application/json`
```json
{ "current_password": "admin123", "new_password": "newpass" }
```

**Response**
```json
{ "detail": "Password updated" }
```

---

### Jobs

#### `GET /jobs`
List all jobs, sorted newest first.

**Response** — array of Job objects (see schema below).

---

#### `GET /jobs/{job_id}`
Get a single job by ID.

**Response** — Job object.

---

#### `POST /jobs`
Create a new transcoding job by uploading a video file.

**Request** — `multipart/form-data`
| Field | Type | Description |
|---|---|---|
| `file` | file | Video file to transcode |
| `dest_path` | string | Destination folder on dist-server (relative to `BASE_PATH`) |
| `season` | integer | Season number for `.plexmatch` entry |
| `episode` | integer | Episode number for `.plexmatch` entry |

**Response** — Job object with `status: "queued"`.

---

#### `POST /jobs/{job_id}/retry`
Re-queue a `failed` or `completed` job for re-processing.

**Response** — Updated Job object with `status: "pending"`.

---

### Job Object Schema

```json
{
  "id": "uuid",
  "original_filename": "video.mp4",
  "upload_path": "/uploads/<id>/video.mp4",
  "dest_path": "ema/2025",
  "season": 1,
  "episode": 11,
  "status": "queued | uploaded | transcoding | uploading | completed | failed",
  "created_at": "2026-05-07T10:00:00+00:00",
  "created_by": "admin",
  "transcode_progress": {
    "4k":    "skipped | transcoding | transcoded | uploading | uploaded | failed | upload_failed",
    "1080p": "...",
    "720p":  "...",
    "480p":  "..."
  },
  "error": null
}
```

---

## Distribution Server — `/dist`

> Port `8001` internally, accessed via nginx at `/dist`.  
> No authentication required (runs on internal network only).  
> All paths are relative to `BASE_PATH` (`/media` inside the container, mounted from `~/Downloads/plex/media`).  
> Path traversal outside `BASE_PATH` returns `403`.

### File System

#### `GET /browse`
List contents of a directory.

**Query parameters**
| Param | Type | Default | Description |
|---|---|---|---|
| `path` | string | `""` | Relative path to list (empty = root) |

**Response**
```json
{
  "current_path": "ema/2025",
  "entries": [
    { "name": "video_1080p.mp4", "type": "file", "size": 1234567890, "path": "ema/2025/video_1080p.mp4" },
    { "name": "clips",           "type": "directory", "size": null,        "path": "ema/2025/clips" }
  ]
}
```

---

#### `POST /mkdir`
Create a directory (including any missing parents).

**Query parameters**
| Param | Type | Description |
|---|---|---|
| `path` | string | Relative path to create |

**Response**
```json
{ "created": "ema/2026" }
```

---

### File Upload

#### `POST /upload`
Upload a single file (full file in one request).

**Query parameters**
| Param | Type | Description |
|---|---|---|
| `dest_path` | string | Destination relative path including filename |

**Request** — `multipart/form-data`
| Field | Type | Description |
|---|---|---|
| `file` | file | File to upload |

**Response**
```json
{ "uploaded": "ema/2025/video_1080p.mp4", "size": 1234567890 }
```

---

#### `POST /upload/chunk`
Upload one chunk of a large file. Chunks are assembled automatically when the last one arrives. Chunk temp files are named `.{filename}.chunk{N}` in the same directory.

**Query parameters**
| Param | Type | Description |
|---|---|---|
| `dest_path` | string | Final destination relative path including filename |
| `chunk_index` | integer | Zero-based index of this chunk |
| `total_chunks` | integer | Total number of chunks expected |

**Request** — `multipart/form-data`
| Field | Type | Description |
|---|---|---|
| `file` | file | Chunk data |

**Response (not yet assembled)**
```json
{ "assembled": false, "chunk_index": 2, "received": 3 }
```

**Response (last chunk — assembled)**
```json
{ "assembled": true, "path": "ema/2025/video_1080p.mp4" }
```

---

### .plexmatch

The `.plexmatch` file lives inside each destination folder and records which video files map to which season/episode. Each line has the format:

```
ep: s01e05: filename_1080p.mp4
```

#### `GET /plexmatch`
Read the `.plexmatch` file from a single folder.

**Query parameters**
| Param | Type | Description |
|---|---|---|
| `path` | string | Relative folder path |

**Response**
```json
{ "exists": true, "entries": ["ep: s01e05: video_1080p.mp4", "..."] }
```
Returns `{ "exists": false, "entries": [] }` if the file doesn't exist.

---

#### `POST /plexmatch`
Append entries to (or create) the `.plexmatch` file in a folder.

**Query parameters**
| Param | Type | Description |
|---|---|---|
| `path` | string | Relative folder path |

**Request body** — `application/json`
```json
{ "entries": ["ep: s01e05: video_4k.mp4", "ep: s01e05: video_1080p.mp4"] }
```

**Response**
```json
{ "appended": 2 }
```

---

#### `GET /plexmatch/aggregate`
Recursively scan a folder tree for all `.plexmatch` files and return all their entries combined. Used by the Browse page to display the full library for a series that spans multiple subfolders.

**Query parameters**
| Param | Type | Description |
|---|---|---|
| `path` | string | Root folder to scan recursively |

**Response**
```json
{
  "entries": ["ep: s01e01: welcome_1080p.mp4", "ep: s01e05: birthday_4k.mp4", "..."],
  "sources": ["ema/2021/.plexmatch", "ema/2025/.plexmatch"]
}
```

---

## Transcoder Worker

Not an HTTP server — runs as an internal Redis queue consumer. Documented here for reference.

**Queue key:** `transcode_queue` (Redis list, RPUSH to enqueue, BLPOP to consume)  
**Job state key:** `jobs` (Redis hash, keyed by job ID, values are JSON)

### Processing flow

1. Pop a `job_id` from `transcode_queue`
2. Load job from Redis; locate the uploaded file at `upload_path`
3. Run `ffprobe` to detect source resolution
4. For each profile (`4k`, `1080p`, `720p`, `480p`):
   - **Skip** if `prof_height > src_height` (never upscale) → state `skipped`
   - **Skip** if already `uploaded` (resume support)
   - Transcode with FFmpeg → state `transcoded`
   - Upload to dist-server via `POST /upload` → state `uploaded`
   - **Delete** the local transcoded file immediately after upload
5. Append `.plexmatch` entries via `POST /plexmatch` for all uploaded profiles
6. Set job `status = completed`
7. **Delete** the original uploaded source file and the job's temp directory

### Transcode profiles

| Label | Resolution | Notes |
|---|---|---|
| `4k` | 3840×2160 | Skipped if source height < 2160 |
| `1080p` | 1920×1080 | Skipped if source height < 1080 |
| `720p` | 1280×720 | Skipped if source height < 720 |
| `480p` | 854×480 | Almost always produced |

Output filename format: `{original_stem}_{label}{original_ext}` — e.g. `holiday_1080p.mp4`

### FFmpeg settings
- Codec: `libx264`, CRF 23, preset `fast`
- Audio: `aac` 128 kbps
- Scale: maintain aspect ratio, pad to exact resolution
- Flags: `+faststart` for web streaming
