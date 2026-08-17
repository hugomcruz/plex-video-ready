import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, distApi } from "../api";
import FolderBrowser from "../components/FolderBrowser";
import S3Browser from "../components/S3Browser";
import Layout from "../components/Layout";
import { ArrowLeft, Film, FileText, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

interface PlexmatchData {
  exists: boolean;
  entries: string[];
}

interface ProbeInfo {
  file_size_bytes: number;
  total_bitrate_kbps: number | null;
  duration_sec: number | null;
  video?: { codec: string; width: number; height: number; bitrate_kbps: number | null; fps: number | null };
  audio?: { codec: string; bitrate_kbps: number | null };
}

function parsePlexmatch(entries: string[]): { season: number; nextEpisode: number } {
  let maxSeason = 1;
  let maxEpisodeForLastSeason = 0;
  for (const line of entries) {
    const m = line.match(/ep:\s*s(\d+)e(\d+):/i);
    if (m) maxSeason = Math.max(maxSeason, parseInt(m[1], 10));
  }
  for (const line of entries) {
    const m = line.match(/ep:\s*s(\d+)e(\d+):/i);
    if (m && parseInt(m[1], 10) === maxSeason) {
      maxEpisodeForLastSeason = Math.max(maxEpisodeForLastSeason, parseInt(m[2], 10));
    }
  }
  return { season: maxSeason, nextEpisode: maxEpisodeForLastSeason + 1 };
}

function fmtSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function normalizeCodec(codec?: string): "hevc" | "h264" {
  return codec?.toLowerCase() === "h264" ? "h264" : "hevc";
}

export default function NewJobPage() {
  const navigate = useNavigate();
  const [s3Key, setS3Key] = useState("");
  const [probeInfo, setProbeInfo] = useState<ProbeInfo | null>(null);
  const [destPath, setDestPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [overrideCodec, setOverrideCodec] = useState(false);
  const [targetCodec, setTargetCodec] = useState<"hevc" | "h264">("hevc");

  // .plexmatch state
  const [plexmatch, setPlexmatch] = useState<PlexmatchData | null>(null);
  const [loadingPlexmatch, setLoadingPlexmatch] = useState(false);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [showExisting, setShowExisting] = useState(false);

  useEffect(() => {
    if (!destPath) { setPlexmatch(null); return; }
    setLoadingPlexmatch(true);
    distApi.get<PlexmatchData>("/plexmatch", { params: { path: destPath } })
      .then(({ data }) => {
        setPlexmatch(data);
        const { season: s, nextEpisode: e } = parsePlexmatch(data.entries);
        setSeason(s);
        setEpisode(e);
      })
      .catch(() => {
        setPlexmatch({ exists: false, entries: [] });
        setSeason(1);
        setEpisode(1);
      })
      .finally(() => setLoadingPlexmatch(false));
  }, [destPath]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!s3Key) return setError("Please select a file from S3.");
    if (!destPath) return setError("Please select a destination folder.");
    setError("");
    setSubmitting(true);
    try {
      await api.post("/jobs", {
        s3_key: s3Key,
        dest_path: destPath,
        season,
        episode,
        target_codec: overrideCodec ? targetCodec : null,
      });
      navigate("/");
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? "Failed to create job. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const filename = s3Key ? s3Key.split("/").pop()! : "";

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-6 py-10">
        <button onClick={() => navigate("/")} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition mb-6">
          <ArrowLeft size={16} /> Back
        </button>
        <h2 className="text-xl font-bold mb-6">New Job</h2>
        <form onSubmit={handleSubmit} className="space-y-6">

          {/* S3 file browser */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Source File from S3</label>
            <S3Browser
              selectedKey={s3Key}
              onSelect={(key, info) => { setS3Key(key); setProbeInfo(info); }}
            />
            {s3Key && (
              <p className="mt-2 text-xs text-indigo-400 font-mono truncate">{s3Key}</p>
            )}
          </div>

          {/* File info card */}
          {s3Key && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Film size={14} className="text-indigo-400" />
                <span className="text-sm font-medium text-gray-200">Source File Info</span>
                {!probeInfo && <Loader2 size={13} className="animate-spin text-gray-500 ml-1" />}
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                <span className="text-gray-500">File name</span>
                <span className="text-gray-300 truncate font-mono">{filename}</span>
                {probeInfo ? (
                  <>
                    <span className="text-gray-500">File size</span>
                    <span className="text-gray-300 font-mono">{fmtSize(probeInfo.file_size_bytes)}</span>
                    {probeInfo.video && (
                      <>
                        <span className="text-gray-500">Resolution</span>
                        <span className="text-gray-300 font-mono">{probeInfo.video.width}×{probeInfo.video.height}</span>
                        <span className="text-gray-500">Video codec</span>
                        <span className="text-gray-300 font-mono">{probeInfo.video.codec}</span>
                        <span className="text-gray-500">Video bitrate</span>
                        <span className="text-gray-300 font-mono">
                          {probeInfo.video.bitrate_kbps != null ? `${probeInfo.video.bitrate_kbps} kbps` : "—"}
                        </span>
                        <span className="text-gray-500">Frame rate</span>
                        <span className="text-gray-300 font-mono">
                          {probeInfo.video.fps != null ? `${probeInfo.video.fps} fps` : "—"}
                        </span>
                      </>
                    )}
                    {probeInfo.audio && (
                      <>
                        <span className="text-gray-500">Audio codec</span>
                        <span className="text-gray-300 font-mono">{probeInfo.audio.codec}</span>
                        <span className="text-gray-500">Audio bitrate</span>
                        <span className="text-gray-300 font-mono">
                          {probeInfo.audio.bitrate_kbps != null ? `${probeInfo.audio.bitrate_kbps} kbps` : "—"}
                        </span>
                      </>
                    )}
                    {probeInfo.total_bitrate_kbps != null && (
                      <>
                        <span className="text-gray-500">Total bitrate</span>
                        <span className="text-gray-300 font-mono">{probeInfo.total_bitrate_kbps} kbps</span>
                      </>
                    )}
                    {probeInfo.duration_sec != null && (
                      <>
                        <span className="text-gray-500">Duration</span>
                        <span className="text-gray-300 font-mono">{fmtDuration(probeInfo.duration_sec)}</span>
                      </>
                    )}
                  </>
                ) : (
                  <span className="text-gray-600 col-span-2 mt-1">Probing file…</span>
                )}
              </div>
            </div>
          )}

          {/* Output codec */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={overrideCodec}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setOverrideCodec(checked);
                  if (checked) setTargetCodec(normalizeCodec(probeInfo?.video?.codec));
                }}
                className="rounded border-gray-700 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
              />
              Override output codec
            </label>
            <p className="text-xs text-gray-500 mt-1">
              By default the output keeps the source's own codec (4K is always encoded in HEVC).
            </p>
            {overrideCodec && (
              <select
                value={targetCodec}
                onChange={(e) => setTargetCodec(e.target.value as "hevc" | "h264")}
                className="mt-2 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-200"
              >
                <option value="hevc">H.265 (HEVC) — smaller files, better quality</option>
                <option value="h264">H.264 (AVC) — wider compatibility</option>
              </select>
            )}
          </div>

          {/* Destination folder */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Destination Folder on Distribution Server
            </label>
            <FolderBrowser value={destPath} onChange={setDestPath} />
          </div>

          {/* .plexmatch / episode info */}
          {destPath && (
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-4">
              <div className="flex items-center gap-2">
                <FileText size={16} className="text-indigo-400" />
                <span className="text-sm font-medium text-gray-200">.plexmatch</span>
                {loadingPlexmatch && <span className="text-xs text-gray-500">Loading…</span>}
                {!loadingPlexmatch && plexmatch && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${plexmatch.exists ? "bg-green-900 text-green-300" : "bg-gray-800 text-gray-500"}`}>
                    {plexmatch.exists ? `${plexmatch.entries.length} entries` : "No file — will be created"}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">Season</label>
                  <input
                    type="number" min={1} value={season}
                    onChange={(e) => setSeason(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">
                    Episode
                    {plexmatch?.exists && <span className="text-indigo-400 ml-1">(auto-detected)</span>}
                  </label>
                  <input
                    type="number" min={1} value={episode}
                    onChange={(e) => setEpisode(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              {filename && (
                <div className="bg-gray-800 rounded-lg px-3 py-2">
                  <p className="text-xs text-gray-500 mb-1 font-medium">Will append to .plexmatch:</p>
                  {["4k", "1080p", "720p", "480p"].map((res) => {
                    const stem = filename.replace(/\.[^.]+$/, "");
                    const ext = filename.slice(filename.lastIndexOf("."));
                    return (
                      <p key={res} className="text-xs font-mono text-indigo-300">
                        ep: s{String(season).padStart(2, "0")}e{String(episode).padStart(2, "0")}: {stem}_{res}{ext}
                      </p>
                    );
                  })}
                </div>
              )}

              {plexmatch?.exists && plexmatch.entries.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowExisting((v) => !v)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition"
                  >
                    {showExisting ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    {showExisting ? "Hide" : "Show"} existing entries ({plexmatch.entries.length})
                  </button>
                  {showExisting && (
                    <div className="mt-2 bg-gray-800 rounded-lg p-3 max-h-40 overflow-y-auto">
                      {plexmatch.entries.map((entry, i) => (
                        <p key={i} className="text-xs font-mono text-gray-400 leading-5">{entry}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={submitting || !s3Key || !destPath}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 text-sm transition"
          >
            {submitting ? <span className="flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" /> Creating job…</span> : "Start Transcoding"}
          </button>
        </form>
      </div>
    </Layout>
  );
}
