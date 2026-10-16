import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import { Folder, FileVideo, ChevronRight, Loader2, ArrowLeft, HardDrive } from "lucide-react";

interface S3Object {
  key: string;
  name: string;
  size: number;
  last_modified: string;
}

interface S3Folder {
  key: string;
  name: string;
}

interface S3BrowseResult {
  bucket: string;
  prefix: string;
  folders: S3Folder[];
  files: S3Object[];
}

interface ProbeInfo {
  file_size_bytes: number;
  total_bitrate_kbps: number | null;
  duration_sec: number | null;
  video?: { codec: string; width: number; height: number; bitrate_kbps: number | null; fps: number | null };
  audio?: { codec: string; bitrate_kbps: number | null };
}

interface S3BrowserProps {
  selectedKeys: string[];
  // Updates the ordered selection (functional form, so rapid clicks never overwrite each other).
  onSelectionChange: (updater: (prev: string[]) => string[]) => void;
  // Called when a file's metadata has been probed (null if the probe failed).
  onProbe: (key: string, probeInfo: ProbeInfo | null) => void;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".mov", ".avi", ".wmv", ".ts", ".m4v", ".webm", ".flv", ".mpg", ".mpeg"]);

function isVideoFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return VIDEO_EXTS.has(ext);
}

export default function S3Browser({ selectedKeys, onSelectionChange, onProbe }: S3BrowserProps) {
  const [prefix, setPrefix] = useState("");
  const [result, setResult] = useState<S3BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [probing, setProbing] = useState(0);

  const load = useCallback((p: string) => {
    setLoading(true);
    setError("");
    api.get<S3BrowseResult>("/s3/browse", { params: { prefix: p } })
      .then(({ data }) => { setResult(data); setPrefix(p); })
      .catch((e) => setError(e?.response?.data?.detail ?? "Failed to list S3 bucket"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(""); }, [load]);

  function navigateTo(p: string) {
    load(p);
  }

  function navigateUp() {
    if (!prefix) return;
    const parts = prefix.replace(/\/$/, "").split("/");
    parts.pop();
    load(parts.length ? parts.join("/") + "/" : "");
  }

  // Build breadcrumb segments
  const crumbs: { label: string; prefix: string }[] = [{ label: "root", prefix: "" }];
  if (prefix) {
    const parts = prefix.replace(/\/$/, "").split("/");
    parts.forEach((p, i) => {
      crumbs.push({ label: p, prefix: parts.slice(0, i + 1).join("/") + "/" });
    });
  }

  // Probe files one at a time so a bulk selection doesn't fire a burst of ffprobe runs.
  async function probeKeys(keys: string[]) {
    setProbing((n) => n + keys.length);
    for (const key of keys) {
      try {
        const { data } = await api.post<ProbeInfo>("/s3/probe", { s3_key: key });
        onProbe(key, data);
      } catch {
        onProbe(key, null); // probe failed — keep the selection, just no metadata
      } finally {
        setProbing((n) => n - 1);
      }
    }
  }

  function toggleFile(file: S3Object) {
    const wasSelected = selectedKeys.includes(file.key);
    onSelectionChange((prev) =>
      prev.includes(file.key) ? prev.filter((k) => k !== file.key) : [...prev, file.key]
    );
    if (!wasSelected) probeKeys([file.key]);
  }

  const folderVideos = result ? result.files.filter((f) => isVideoFile(f.name)) : [];
  const allFolderSelected =
    folderVideos.length > 0 && folderVideos.every((f) => selectedKeys.includes(f.key));

  function toggleAllInFolder() {
    const folderKeys = folderVideos.map((f) => f.key);
    if (allFolderSelected) {
      const inFolder = new Set(folderKeys);
      onSelectionChange((prev) => prev.filter((k) => !inFolder.has(k)));
    } else {
      const added = folderKeys.filter((k) => !selectedKeys.includes(k));
      onSelectionChange((prev) => [...prev, ...folderKeys.filter((k) => !prev.includes(k))]);
      probeKeys(added);
    }
  }

  return (
    <div className="border border-gray-700 rounded-xl overflow-hidden bg-gray-900">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-800 border-b border-gray-700">
        <HardDrive size={14} className="text-indigo-400 shrink-0" />
        <div className="flex items-center gap-1 text-sm flex-wrap">
          {crumbs.map((c, i) => (
            <span key={c.prefix} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="text-gray-600" />}
              <button type="button"
                onClick={() => navigateTo(c.prefix)}
                className={`hover:text-white transition ${c.prefix === prefix ? "text-white font-medium" : "text-gray-400"}`}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
        {loading && <Loader2 size={13} className="animate-spin text-gray-500 ml-auto" />}
        {probing > 0 && <span className="text-xs text-indigo-400 ml-auto animate-pulse">Probing…</span>}
      </div>

      {/* Bulk select */}
      {folderVideos.length > 1 && (
        <button
          type="button"
          onClick={toggleAllInFolder}
          className="flex items-center gap-2 px-4 py-2 text-xs text-indigo-300 hover:text-white hover:bg-gray-800 transition w-full border-b border-gray-800"
        >
          {allFolderSelected ? "Clear selection in this folder" : `Select all ${folderVideos.length} videos in this folder`}
        </button>
      )}

      {/* Back button */}
      {prefix && (
        <button type="button"
          onClick={navigateUp}
          className="flex items-center gap-2 px-4 py-2 text-xs text-gray-400 hover:text-white hover:bg-gray-800 transition w-full border-b border-gray-800"
        >
          <ArrowLeft size={13} /> ..
        </button>
      )}

      {/* Error */}
      {error && <p className="px-4 py-3 text-sm text-red-400">{error}</p>}

      {/* Listing */}
      {result && (
        <div className="max-h-72 overflow-y-auto divide-y divide-gray-800">
          {result.folders.map((f) => (
            <button type="button"
              key={f.key}
              onClick={() => navigateTo(f.key)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left hover:bg-gray-800 transition"
            >
              <Folder size={15} className="text-yellow-500 shrink-0" />
              <span className="text-gray-300 truncate">{f.name}</span>
              <ChevronRight size={13} className="text-gray-600 ml-auto shrink-0" />
            </button>
          ))}
          {result.files.map((f) => {
            const isVideo = isVideoFile(f.name);
            const isSelected = selectedKeys.includes(f.key);
            return (
              <button type="button"
                key={f.key}
                onClick={() => isVideo && toggleFile(f)}
                disabled={!isVideo}
                className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left transition ${
                  isSelected
                    ? "bg-indigo-900/60 border-l-2 border-indigo-500"
                    : isVideo
                    ? "hover:bg-gray-800 cursor-pointer"
                    : "opacity-40 cursor-not-allowed"
                }`}
              >
                {isVideo && (
                  <input
                    type="checkbox"
                    readOnly
                    checked={isSelected}
                    tabIndex={-1}
                    className="pointer-events-none rounded border-gray-700 bg-gray-800 text-indigo-600"
                  />
                )}
                <FileVideo size={15} className={isSelected ? "text-indigo-400" : "text-gray-500"} />
                <span className={`truncate ${isSelected ? "text-indigo-200 font-medium" : "text-gray-300"}`}>{f.name}</span>
                <span className="ml-auto text-xs text-gray-600 shrink-0">{fmtSize(f.size)}</span>
              </button>
            );
          })}
          {result.folders.length === 0 && result.files.length === 0 && (
            <p className="px-4 py-6 text-sm text-gray-600 text-center">Empty folder</p>
          )}
        </div>
      )}
    </div>
  );
}
