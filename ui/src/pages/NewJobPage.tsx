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

// The last episode record in the .plexmatch: highest season, then that
// season's highest episode (mirrors how the server assigns the next one).
function parsePlexmatch(entries: string[]): { found: boolean; lastSeason: number; lastEpisode: number } {
  let lastSeason = 0;
  let lastEpisode = 0;
  let found = false;
  for (const line of entries) {
    const m = line.match(/ep:\s*s(\d+)e(\d+):/i);
    if (!m) continue;
    found = true;
    const sn = parseInt(m[1], 10);
    const ep = parseInt(m[2], 10);
    if (sn > lastSeason) { lastSeason = sn; lastEpisode = ep; }
    else if (sn === lastSeason) lastEpisode = Math.max(lastEpisode, ep);
  }
  return { found, lastSeason, lastEpisode };
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
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  // undefined = not probed yet, null = probe failed
  const [probes, setProbes] = useState<Record<string, ProbeInfo | null>>({});
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
    setPlexmatch(null);
    setSeason(1);
    setEpisode(1);
    if (!destPath) return;
    let stale = false;
    setLoadingPlexmatch(true);
    distApi.get<PlexmatchData>("/plexmatch", { params: { path: destPath } })
      .then(({ data }) => { if (!stale) setPlexmatch(data); })
      .catch(() => { if (!stale) setPlexmatch({ exists: false, entries: [] }); })
      .finally(() => { if (!stale) setLoadingPlexmatch(false); });
    return () => { stale = true; };
  }, [destPath]);

  // With episode records already in .plexmatch, episodes are assigned
  // automatically (sequentially) when each file is distributed.
  const parsed = parsePlexmatch(plexmatch?.entries ?? []);
  const autoEpisodes = !!plexmatch && parsed.found;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedKeys.length === 0) return setError("Please select at least one file from S3.");
    if (!destPath) return setError("Please select a destination folder.");
    setError("");
    setSubmitting(true);
    try {
      await api.post("/jobs", {
        s3_keys: selectedKeys,
        dest_path: destPath,
        // Only chosen by the user when the destination has no episode records
        season: autoEpisodes ? null : season,
        episode: autoEpisodes ? null : episode,
        target_codec: overrideCodec ? targetCodec : null,
      });
      navigate("/");
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? "Failed to create job. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const fileName = (key: string) => key.split("/").pop()!;
  const pad2 = (n: number) => String(n).padStart(2, "0");

  // Preview of the .plexmatch lines (episodes follow selection order)
  const previewLines = selectedKeys.map((key, i) => {
    const name = fileName(key);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const sn = autoEpisodes ? parsed.lastSeason : season;
    const ep = autoEpisodes ? parsed.lastEpisode + 1 + i : episode + i;
    return `ep: s${pad2(sn)}e${pad2(ep)}: ${stem}_<resolution>${ext}`;
  });
  const firstProbe = selectedKeys.map((k) => probes[k]).find((p) => p) ?? null;

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
            <label className="block text-sm font-medium text-gray-300 mb-2">Source Files from S3</label>
            <S3Browser
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
              onProbe={(key, info) => setProbes((prev) => ({ ...prev, [key]: info }))}
            />
          </div>

          {/* Selected files */}
          {selectedKeys.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Film size={14} className="text-indigo-400" />
                <span className="text-sm font-medium text-gray-200">
                  Selected files ({selectedKeys.length})
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedKeys([])}
                  className="ml-auto text-xs text-gray-500 hover:text-gray-300 transition"
                >
                  Clear
                </button>
              </div>
              <ol className="space-y-2">
                {selectedKeys.map((key, i) => {
                  const info = probes[key];
                  return (
                    <li key={key} className="bg-gray-800 rounded-lg px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500 font-mono w-5 shrink-0">{i + 1}.</span>
                        <span className="text-gray-200 font-mono truncate flex-1" title={key}>{fileName(key)}</span>
                        <button
                          type="button"
                          onClick={() => setSelectedKeys((prev) => prev.filter((k) => k !== key))}
                          className="text-gray-500 hover:text-red-400 transition shrink-0"
                          aria-label={`Remove ${fileName(key)}`}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="pl-7 mt-0.5 text-gray-500 font-mono">
                        {info === undefined ? (
                          <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Probing…</span>
                        ) : info === null ? (
                          "No metadata"
                        ) : (
                          [
                            fmtSize(info.file_size_bytes),
                            info.video && `${info.video.width}×${info.video.height}`,
                            info.video?.codec,
                            info.video?.fps != null && `${info.video.fps} fps`,
                            info.video?.bitrate_kbps != null && `${info.video.bitrate_kbps} kbps`,
                            info.duration_sec != null && fmtDuration(info.duration_sec),
                          ].filter(Boolean).join(" · ")
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
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
                  if (checked) setTargetCodec(normalizeCodec(firstProbe?.video?.codec));
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

              {plexmatch && autoEpisodes && (
                <p className="text-xs text-gray-400">
                  Episodes are assigned automatically as each file is distributed, continuing from the last
                  record (<span className="font-mono text-indigo-300">S{pad2(parsed.lastSeason)}E{pad2(parsed.lastEpisode)}</span>).
                </p>
              )}

              {plexmatch && !autoEpisodes && (
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
                      {selectedKeys.length > 1 ? "First episode" : "Episode"}
                    </label>
                    <input
                      type="number" min={1} value={episode}
                      onChange={(e) => setEpisode(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              )}

              {plexmatch && previewLines.length > 0 && (
                <div className="bg-gray-800 rounded-lg px-3 py-2">
                  <p className="text-xs text-gray-500 mb-1 font-medium">
                    {autoEpisodes ? "Expected .plexmatch entries:" : "Will append to .plexmatch:"}
                  </p>
                  {previewLines.map((line, i) => (
                    <p key={i} className="text-xs font-mono text-indigo-300 break-all">{line}</p>
                  ))}
                  <p className="text-[11px] text-gray-500 mt-1">
                    The actual resolution produced (e.g. 1080p) is appended after transcoding —
                    or the file is kept unchanged if the source resolution is non-standard.
                    {selectedKeys.length > 1 && " Episodes follow the order of the selected files."}
                    {autoEpisodes && " Numbers are final once each file is distributed."}
                  </p>
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
            disabled={submitting || selectedKeys.length === 0 || !destPath || loadingPlexmatch || !plexmatch}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 text-sm transition"
          >
            {submitting ? <span className="flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" /> Creating jobs…</span> : selectedKeys.length > 1 ? `Start Transcoding (${selectedKeys.length} files)` : "Start Transcoding"}
          </button>
        </form>
      </div>
    </Layout>
  );
}
