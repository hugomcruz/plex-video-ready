import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, distApi } from "../api";
import { Job, ProfileMediaInfo } from "./DashboardPage";
import { ArrowLeft, Film, RotateCcw, CheckCircle, AlertCircle, Clock, Loader2, FileText, ChevronDown, ChevronRight } from "lucide-react";
import Layout from "../components/Layout";

const PROFILE_LABEL: Record<string, string> = {
  "4k": "4K",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
};

const STATUS_COLOR = {
  uploaded_profile: "text-green-400 bg-green-900/30",
};

const RESOLUTION_COLORS: Record<string, string> = {
  "4k":    "bg-purple-900 text-purple-300",
  "1080p": "bg-indigo-900 text-indigo-300",
  "720p":  "bg-blue-900 text-blue-300",
  "480p":  "bg-gray-800 text-gray-400",
};

function StatusIcon({ status }: { status: string }) {
  if (status === "uploaded" || status === "completed") return <CheckCircle size={13} className="text-green-400" />;
  if (status === "failed") return <AlertCircle size={13} className="text-red-400" />;
  if (status === "transcoding" || status === "uploading") return <Loader2 size={13} className="animate-spin text-indigo-400" />;
  return <Clock size={13} className="text-gray-400" />;
}

interface PlexEntry { season: number; episode: number; filename: string; resolution: string; }

function parsePlexmatch(lines: string[]): PlexEntry[] {
  return lines.flatMap((line) => {
    const m = line.match(/ep:\s*s(\d+)e(\d+):\s*(.+)/i);
    if (!m) return [];
    const filename = m[3].trim();
    let resolution = "unknown";
    for (const res of ["4k","1080p","720p","480p"]) {
      if (filename.toLowerCase().includes(`_${res}.`)) { resolution = res; break; }
    }
    return [{ season: parseInt(m[1],10), episode: parseInt(m[2],10), filename, resolution }];
  });
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [plexEntries, setPlexEntries] = useState<PlexEntry[]>([]);
  const [plexLoaded, setPlexLoaded] = useState(false);
  const [openEpisodes, setOpenEpisodes] = useState<Set<string>>(new Set());

  async function fetchJob() {
    const { data } = await api.get<Job>(`/jobs/${id}`);
    setJob(data);
  }

  useEffect(() => {
    fetchJob();
    const interval = setInterval(fetchJob, 3000);
    return () => clearInterval(interval);
  }, [id]);

  // Load plexmatch when job is completed and dest_path known
  useEffect(() => {
    if (!job?.dest_path) return;
    distApi.get("/plexmatch", { params: { path: job.dest_path } })
      .then(({ data }) => {
        setPlexEntries(parsePlexmatch(data.entries ?? []));
        setPlexLoaded(true);
      })
      .catch(() => setPlexLoaded(true));
  }, [job?.dest_path, job?.status]);

  function toggleEp(key: string) {
    setOpenEpisodes((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  const [openProfiles, setOpenProfiles] = useState<Set<string>>(new Set());

  function toggleProfile(p: string) {
    setOpenProfiles((prev) => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n; });
  }

  async function retry() {
    await api.post(`/jobs/${id}/retry`);
    fetchJob();
  }

  if (!job) return <Layout><div className="p-8 text-gray-500">Loading…</div></Layout>;

  // The worker only ever transcodes one profile (matching the source's own
  // resolution) and marks the rest "skipped" — find that one active profile.
  const activeProfile = Object.entries(job.transcode_progress ?? {}).find(
    ([, status]) => status !== "skipped"
  );
  const [activeLabel, activeStatus] = activeProfile ?? [undefined, undefined];
  const activeInfo: ProfileMediaInfo | undefined = activeLabel ? job.profile_bitrates?.[activeLabel] : undefined;
  const activeOpen = activeLabel ? openProfiles.has(activeLabel) : false;

  // Group plexmatch entries this job contributed (match by dest_path + season/episode)
  const jobSeason  = (job as any).season  as number | undefined;
  const jobEpisode = (job as any).episode as number | undefined;
  const jobPlexEntries = (jobSeason != null && jobEpisode != null)
    ? plexEntries.filter((e) => e.season === jobSeason && e.episode === jobEpisode)
    : [];

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-4">
        <button onClick={() => navigate("/")} className="flex items-center gap-2 text-xs text-gray-500 hover:text-white transition">
          <ArrowLeft size={14} /> Jobs
        </button>

        {/* Compact header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Film className="text-indigo-500 shrink-0" size={18} />
            <h2 className="text-base font-bold truncate">{job.original_filename}</h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusIcon status={job.status} />
            <span className="capitalize text-xs font-semibold text-gray-300">{job.status}</span>
            {job.status === "failed" && (
              <button
                onClick={retry}
                className="flex items-center gap-1 bg-indigo-700 hover:bg-indigo-600 text-white text-xs px-3 py-1.5 rounded-lg transition ml-2"
              >
                <RotateCcw size={12} /> Retry
              </button>
            )}
          </div>
        </div>

        {/* Compact overview */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          <span className="text-gray-500">Job ID</span>
          <span className="font-mono text-gray-400 truncate">{job.id}</span>
          <span className="text-gray-500">Created</span>
          <span className="text-gray-300">{new Date(job.created_at).toLocaleString()}</span>
          <span className="text-gray-500">Destination</span>
          <span className="font-mono text-gray-400 truncate">{job.dest_path}</span>
          {job.target_codec && (
            <>
              <span className="text-gray-500">Output codec</span>
              <span className="text-gray-300">{job.target_codec === "hevc" ? "H.265 (HEVC)" : "H.264 (AVC)"}</span>
            </>
          )}
          {jobSeason != null && (
            <>
              <span className="text-gray-500">Season / Episode</span>
              <span className="text-gray-300">S{String(jobSeason).padStart(2,"0")} E{String(jobEpisode).padStart(2,"0")}</span>
            </>
          )}
        </div>

        {job.error && (
          <div className="bg-red-950/40 border border-red-800 rounded-lg p-3 text-xs text-red-300">{job.error}</div>
        )}

        {/* Source file info */}
        {(job.source_codec || job.source_resolution || job.source_bitrate || job.source_file_size) && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Source File</h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              {job.source_resolution && (
                <>
                  <span className="text-gray-500">Resolution</span>
                  <span className="text-gray-300 font-mono">{job.source_resolution.width}×{job.source_resolution.height}</span>
                </>
              )}
              {job.source_codec && (
                <>
                  <span className="text-gray-500">Video codec</span>
                  <span className="text-gray-300 font-mono">{job.source_codec}</span>
                </>
              )}
              {job.source_bitrate != null && (
                <>
                  <span className="text-gray-500">Bitrate</span>
                  <span className="text-gray-300 font-mono">{Math.round(job.source_bitrate / 1000)} kbps</span>
                </>
              )}
              {job.source_fps != null && (
                <>
                  <span className="text-gray-500">Frame rate</span>
                  <span className="text-gray-300 font-mono">{job.source_fps} fps</span>
                </>
              )}
              {job.source_file_size != null && (
                <>
                  <span className="text-gray-500">File size</span>
                  <span className="text-gray-300 font-mono">
                    {job.source_file_size >= 1_073_741_824
                      ? `${(job.source_file_size / 1_073_741_824).toFixed(2)} GB`
                      : `${(job.source_file_size / 1_048_576).toFixed(1)} MB`}
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Transcode result: generic status while in progress, final resolution once done */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Transcode</h3>
          {!activeLabel ? (
            <p className="text-xs text-gray-500">Queued</p>
          ) : activeStatus === "failed" || activeStatus === "upload_failed" ? (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <AlertCircle size={13} /> {PROFILE_LABEL[activeLabel] ?? activeLabel} failed
            </div>
          ) : activeStatus !== "uploaded" ? (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Loader2 size={13} className="animate-spin" />
              {activeStatus === "uploading" ? "Uploading…" : "Transcoding…"}
            </div>
          ) : (
            <div className="bg-gray-800 rounded-lg px-3 py-2 space-y-1.5">
              <button
                type="button"
                onClick={() => activeInfo && toggleProfile(activeLabel)}
                className={`w-full flex items-center justify-between ${activeInfo ? "cursor-pointer" : "cursor-default"}`}
              >
                <div className="flex items-center gap-2">
                  {activeInfo && (activeOpen ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />)}
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${RESOLUTION_COLORS[activeLabel] ?? "bg-gray-800 text-gray-400"}`}>
                    {PROFILE_LABEL[activeLabel] ?? activeLabel}
                  </span>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${STATUS_COLOR.uploaded_profile}`}>
                  done
                </span>
              </button>
              {activeInfo && activeOpen && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] border-t border-gray-700 pt-1.5">
                  {activeInfo.video && (
                    <>
                      <span className="text-gray-500">Video codec</span>
                      <span className="text-gray-300 font-mono">{activeInfo.video.codec}</span>
                      <span className="text-gray-500">Video bitrate</span>
                      <span className="text-gray-300 font-mono">
                        {activeInfo.video.bitrate_kbps != null ? `${activeInfo.video.bitrate_kbps} kbps` : "—"}
                      </span>
                      <span className="text-gray-500">Frame rate</span>
                      <span className="text-gray-300 font-mono">
                        {activeInfo.video.fps != null ? `${activeInfo.video.fps} fps` : "—"}
                      </span>
                    </>
                  )}
                  {activeInfo.audio && (
                    <>
                      <span className="text-gray-500">Audio codec</span>
                      <span className="text-gray-300 font-mono">{activeInfo.audio.codec}</span>
                      <span className="text-gray-500">Audio bitrate</span>
                      <span className="text-gray-300 font-mono">
                        {activeInfo.audio.bitrate_kbps != null ? `${activeInfo.audio.bitrate_kbps} kbps` : "—"}
                      </span>
                    </>
                  )}
                  {activeInfo.total_bitrate_kbps != null && (
                    <>
                      <span className="text-gray-500">Total bitrate</span>
                      <span className="text-gray-300 font-mono">{activeInfo.total_bitrate_kbps} kbps</span>
                    </>
                  )}
                  {activeInfo.file_size_bytes != null && (
                    <>
                      <span className="text-gray-500">File size</span>
                      <span className="text-gray-300 font-mono">
                        {activeInfo.file_size_bytes >= 1_073_741_824
                          ? `${(activeInfo.file_size_bytes / 1_073_741_824).toFixed(2)} GB`
                          : `${(activeInfo.file_size_bytes / 1_048_576).toFixed(1)} MB`}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* .plexmatch entries for this job */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <FileText size={14} className="text-indigo-400" />
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">.plexmatch Entries</h3>
          </div>

          {!plexLoaded && <p className="text-xs text-gray-600">Loading…</p>}

          {plexLoaded && jobPlexEntries.length === 0 && (
            <p className="text-xs text-gray-600">
              {job.status !== "completed" ? "Available after job completes" : "No entries found for this episode"}
            </p>
          )}

          {plexLoaded && jobPlexEntries.length > 0 && (
            <div className="space-y-1">
              {jobPlexEntries.map((e) => {
                const key = `${e.season}-${e.episode}-${e.filename}`;
                return (
                  <div key={key} className="flex items-center gap-2 bg-gray-800 rounded px-3 py-1.5">
                    <Film size={12} className="text-gray-600 shrink-0" />
                    <span className="text-xs font-mono text-gray-300 truncate flex-1">{e.filename}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${RESOLUTION_COLORS[e.resolution] ?? "bg-gray-800 text-gray-500"}`}>
                      {e.resolution}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Raw plexmatch preview (all entries in folder) */}
          {plexLoaded && plexEntries.length > 0 && (
            <div className="mt-3 border-t border-gray-800 pt-3">
              <button
                onClick={() => toggleEp("raw")}
                className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-gray-400 transition"
              >
                {openEpisodes.has("raw") ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
                All entries in folder ({plexEntries.length})
              </button>
              {openEpisodes.has("raw") && (
                <div className="mt-2 space-y-0.5 max-h-40 overflow-y-auto">
                  {plexEntries.map((e, i) => (
                    <p key={i} className="font-mono text-[10px] text-gray-500">
                      ep: s{String(e.season).padStart(2,"0")}e{String(e.episode).padStart(2,"0")}: {e.filename}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
