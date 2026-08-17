import { Job } from "../pages/DashboardPage";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { CheckCircle, Clock, AlertCircle, Loader2, RotateCcw, ChevronRight, Square, XCircle } from "lucide-react";

const STATUS_STYLES: Record<string, { color: string; icon: React.ReactNode }> = {
  queued: { color: "text-yellow-400", icon: <Clock size={16} /> },
  uploaded: { color: "text-blue-400", icon: <Clock size={16} /> },
  transcoding: { color: "text-indigo-400", icon: <Loader2 size={16} className="animate-spin" /> },
  uploading: { color: "text-cyan-400", icon: <Loader2 size={16} className="animate-spin" /> },
  completed: { color: "text-green-400", icon: <CheckCircle size={16} /> },
  failed: { color: "text-red-400", icon: <AlertCircle size={16} /> },
  cancelled: { color: "text-orange-400", icon: <XCircle size={16} /> },
};

export default function JobCard({ job, onRefresh }: { job: Job; onRefresh: () => void }) {
  const navigate = useNavigate();
  const s = STATUS_STYLES[job.status] ?? { color: "text-gray-400", icon: null };

  async function retry(e: React.MouseEvent) {
    e.stopPropagation();
    await api.post(`/jobs/${job.id}/retry`);
    onRefresh();
  }

  async function stop(e: React.MouseEvent) {
    e.stopPropagation();
    await api.post(`/jobs/${job.id}/stop`);
    onRefresh();
  }

  async function restart(e: React.MouseEvent) {
    e.stopPropagation();
    await api.post(`/jobs/${job.id}/restart`);
    onRefresh();
  }

  // The worker only ever transcodes one profile (matching the source's own
  // resolution) and marks the rest "skipped" — find that one active profile.
  const activeProfile = Object.entries(job.transcode_progress ?? {}).find(
    ([, status]) => status !== "skipped"
  );
  const [activeLabel, activeStatus] = activeProfile ?? [undefined, undefined];

  return (
    <div
      className="bg-gray-900 border border-gray-800 rounded-xl p-5 cursor-pointer hover:border-indigo-600 transition"
      onClick={() => navigate(`/jobs/${job.id}`)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-base truncate">{job.original_filename}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {new Date(job.created_at).toLocaleString()} · dest: <span className="text-gray-400">{job.dest_path}</span>
            {job.source_file_size != null && (
              <span className="ml-2 text-gray-500">· {(job.source_file_size / (1024 ** 3)).toFixed(2)} GB</span>
            )}
          </p>
        </div>
        <div className={`flex items-center gap-1.5 text-sm font-medium shrink-0 ${s.color}`}>
          {s.icon}
          <span className="capitalize">{job.status}</span>
        </div>
      </div>

      {/* Resolution: generic status while in progress, final resolution once done */}
      <div className="mt-3">
        {activeStatus === "uploaded" ? (
          <span className="text-xs px-2 py-0.5 rounded-full font-mono bg-green-900 text-green-300">
            {activeLabel}
          </span>
        ) : activeStatus === "failed" || activeStatus === "upload_failed" ? (
          <span className="text-xs px-2 py-0.5 rounded-full font-mono bg-red-900 text-red-300">
            {activeLabel} failed
          </span>
        ) : activeLabel ? (
          <span className="flex items-center gap-1.5 text-xs text-gray-400">
            <Loader2 size={12} className="animate-spin" />
            {activeStatus === "uploading" ? "Uploading…" : "Transcoding…"}
          </span>
        ) : (
          <span className="text-xs text-gray-500">Queued</span>
        )}
      </div>

      {job.error && (
        <p className="text-red-400 text-xs mt-2 truncate">{job.error}</p>
      )}

      <div className="flex justify-end mt-3 gap-2">
        {["queued", "transcoding", "uploading"].includes(job.status) && (
          <button
            onClick={stop}
            className="flex items-center gap-1 text-xs bg-red-900/40 hover:bg-red-900/70 text-red-300 px-3 py-1.5 rounded-lg transition"
          >
            <Square size={12} /> Stop
          </button>
        )}
        {job.status === "failed" && (
          <button
            onClick={retry}
            className="flex items-center gap-1 text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition"
          >
            <RotateCcw size={12} /> Retry
          </button>
        )}
        {["cancelled", "failed", "completed"].includes(job.status) && (
          <button
            onClick={restart}
            className="flex items-center gap-1 text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition"
          >
            <RotateCcw size={12} /> Restart
          </button>
        )}
        <span className="flex items-center gap-1 text-xs text-gray-600">
          View details <ChevronRight size={12} />
        </span>
      </div>
    </div>
  );
}
