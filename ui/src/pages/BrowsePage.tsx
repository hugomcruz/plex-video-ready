import { useState, useCallback, useEffect } from "react";
import { distApi } from "../api";
import Layout from "../components/Layout";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Film,
  File,
  FileText,
  RefreshCw,
  Home,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Shared types & helpers
// ---------------------------------------------------------------------------

interface DirEntry {
  name: string;
  type: "directory" | "file";
  path: string;
  size: number | null;
}

interface PlexEpisode {
  episode: number;
  files: { filename: string; resolution: string }[];
  source?: string; // which subfolder this came from
}

interface PlexSeason {
  season: number;
  episodes: PlexEpisode[];
}

const RESOLUTION_ORDER = ["4k", "1080p", "720p", "480p"];
const RESOLUTION_COLORS: Record<string, string> = {
  "4k":    "bg-purple-900 text-purple-300",
  "1080p": "bg-indigo-900 text-indigo-300",
  "720p":  "bg-blue-900 text-blue-300",
  "480p":  "bg-gray-800 text-gray-400",
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function parsePlexmatch(lines: string[], source?: string): PlexSeason[] {
  const map = new Map<number, Map<number, { filename: string; resolution: string; source?: string }[]>>();
  for (const line of lines) {
    const m = line.match(/ep:\s*s(\d+)e(\d+):\s*(.+)/i);
    if (!m) continue;
    const s = parseInt(m[1], 10);
    const e = parseInt(m[2], 10);
    const filename = m[3].trim();
    let resolution = "unknown";
    for (const res of RESOLUTION_ORDER) {
      if (filename.toLowerCase().includes(`_${res}.`)) { resolution = res; break; }
    }
    if (!map.has(s)) map.set(s, new Map());
    const epMap = map.get(s)!;
    if (!epMap.has(e)) epMap.set(e, []);
    epMap.get(e)!.push({ filename, resolution, source });
  }
  return [...map.entries()].sort(([a], [b]) => a - b).map(([season, epMap]) => ({
    season,
    episodes: [...epMap.entries()].sort(([a], [b]) => a - b).map(([episode, files]) => ({
      episode,
      files: [...files].sort((a, b) => RESOLUTION_ORDER.indexOf(a.resolution) - RESOLUTION_ORDER.indexOf(b.resolution)),
      source: files[0]?.source,
    })),
  }));
}

// ---------------------------------------------------------------------------
// PlexMatchPanel — left panel: .plexmatch Season/Episode tree
// ---------------------------------------------------------------------------

function PlexMatchPanel({ folderPath }: { folderPath: string }) {
  const [seasons, setSeasons] = useState<PlexSeason[]>([]);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [openSeasons, setOpenSeasons] = useState<Set<number>>(new Set());
  const [openEpisodes, setOpenEpisodes] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!folderPath) return;
    setLoading(true);
    distApi.get("/plexmatch/aggregate", { params: { path: folderPath } })
      .then(({ data }) => {
        setSources(data.sources ?? []);
        const parsed = parsePlexmatch(data.entries ?? []);
        setSeasons(parsed);
        setOpenSeasons(new Set(parsed.map((s) => s.season)));
        setOpenEpisodes(new Set());
      })
      .catch(() => { setSources([]); setSeasons([]); })
      .finally(() => setLoading(false));
  }, [folderPath]);

  function toggleSeason(s: number) {
    setOpenSeasons((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });
  }
  function toggleEpisode(key: string) {
    setOpenEpisodes((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  if (!folderPath) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-3 p-8">
        <FileText size={40} className="opacity-30" />
        <p className="text-sm">Select a folder to see its .plexmatch</p>
      </div>
    );
  }

  if (loading) return <p className="text-sm text-gray-500 p-4">Loading…</p>;

  if (seasons.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-3 p-8">
        <FileText size={40} className="opacity-20" />
        <p className="text-sm">No .plexmatch files found in this folder</p>
      </div>
    );
  }

  const totalEpisodes = seasons.reduce((sum, s) => sum + s.episodes.length, 0);

  return (
    <div className="overflow-y-auto h-full p-2">
      {/* Summary bar */}
      <div className="px-3 py-2 mb-1 flex items-center gap-2 text-xs text-gray-500">
        <span>{seasons.length} season{seasons.length !== 1 ? "s" : ""}</span>
        <span className="text-gray-700">·</span>
        <span>{totalEpisodes} episode{totalEpisodes !== 1 ? "s" : ""}</span>
        <span className="text-gray-700">·</span>
        <span>{sources.length} subfolder{sources.length !== 1 ? "s" : ""}</span>
      </div>
      {seasons.map((s) => {
        const sOpen = openSeasons.has(s.season);
        return (
          <div key={s.season} className="mb-1">
            <button
              onClick={() => toggleSeason(s.season)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-indigo-300 hover:bg-gray-800 transition"
            >
              {sOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Season {String(s.season).padStart(2, "0")}</span>
              <span className="ml-auto text-xs text-gray-600 font-normal">{s.episodes.length} episodes</span>
            </button>

            {sOpen && (
              <div className="ml-4">
                {s.episodes.map((ep) => {
                  const key = `s${s.season}e${ep.episode}`;
                  const eOpen = openEpisodes.has(key);
                  const baseName = ep.files[0]?.filename
                    .replace(/_(?:4k|1080p|720p|480p)\.[^.]+$/i, "")
                    ?? key;
                  return (
                    <div key={key}>
                      <button
                        onClick={() => toggleEpisode(key)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:bg-gray-800 transition"
                      >
                        {eOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        <span className="font-mono text-xs text-gray-500 shrink-0">
                          e{String(ep.episode).padStart(2, "0")}
                        </span>
                        <span className="truncate text-left">{baseName}</span>
                        <span className="ml-auto flex gap-1 shrink-0">
                          {ep.files.map((f) => (
                            <span
                              key={f.filename}
                              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${RESOLUTION_COLORS[f.resolution] ?? "bg-gray-800 text-gray-500"}`}
                            >
                              {f.resolution}
                            </span>
                          ))}
                        </span>
                      </button>

                      {eOpen && (
                        <div className="ml-6 mb-2 space-y-0.5">
                          {ep.files.map((f) => (
                            <div key={f.filename} className="flex items-center gap-2 px-2 py-0.5">
                              <Film size={12} className="text-gray-600 shrink-0" />
                              <span className="text-xs text-gray-400 truncate flex-1">{f.filename}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${RESOLUTION_COLORS[f.resolution] ?? "bg-gray-800 text-gray-500"}`}>
                                {f.resolution}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileSystemPanel — right panel: raw file system browser
// ---------------------------------------------------------------------------

function FileSystemPanel({ folderPath, onNavigate }: { folderPath: string; onNavigate: (p: string) => void }) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(folderPath);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError("");
    try {
      const { data } = await distApi.get("/browse", { params: { path } });
      setCurrentPath(data.current_path ?? "");
      const sorted = [...(data.entries as DirEntry[])].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(sorted);
    } catch {
      setError("Failed to load directory");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(folderPath); }, [folderPath, load]);

  function navigateTo(path: string) {
    onNavigate(path);
    load(path);
  }

  function navigateUp() {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    navigateTo(parts.join("/"));
  }

  const breadcrumbs = currentPath.split("/").filter(Boolean);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 flex-wrap px-4 py-2 border-b border-gray-800 text-sm text-gray-400 shrink-0">
        <button onClick={() => navigateTo("")} className="flex items-center gap-1 hover:text-white transition">
          <Home size={13} /> root
        </button>
        {breadcrumbs.map((crumb, i) => {
          const path = breadcrumbs.slice(0, i + 1).join("/");
          return (
            <span key={path} className="flex items-center gap-1">
              <ChevronRight size={12} />
              <button onClick={() => navigateTo(path)} className="hover:text-white transition">{crumb}</button>
            </span>
          );
        })}
      </div>

      {/* Listing */}
      <div className="flex-1 overflow-y-auto">
        {loading && <p className="text-sm text-gray-500 p-4">Loading…</p>}
        {error && <p className="text-sm text-red-400 p-4">{error}</p>}

        {!loading && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-right px-4 py-2 font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {currentPath && (
                <tr
                  className="hover:bg-gray-800/50 cursor-pointer transition"
                  onClick={navigateUp}
                >
                  <td className="px-4 py-2 flex items-center gap-2 text-gray-500">
                    <Folder size={15} className="shrink-0 text-yellow-600" />
                    ..
                  </td>
                  <td />
                </tr>
              )}
              {entries.map((entry) => (
                <tr
                  key={entry.path}
                  className={`border-t border-gray-800/50 transition ${
                    entry.type === "directory"
                      ? "hover:bg-gray-800/50 cursor-pointer"
                      : "hover:bg-gray-800/20"
                  }`}
                  onClick={() => entry.type === "directory" && navigateTo(entry.path)}
                >
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      {entry.type === "directory" ? (
                        <Folder size={15} className="shrink-0 text-yellow-400" />
                      ) : entry.name === ".plexmatch" ? (
                        <FileText size={15} className="shrink-0 text-indigo-400" />
                      ) : (
                        <File size={15} className="shrink-0 text-gray-500" />
                      )}
                      <span className={`truncate ${entry.type === "directory" ? "text-gray-200" : "text-gray-400"}`}>
                        {entry.name}
                      </span>
                      {entry.type === "directory" && (
                        <ChevronRight size={12} className="text-gray-600 ml-auto shrink-0" />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-gray-600 whitespace-nowrap">
                    {entry.type === "file" && entry.size !== null ? formatSize(entry.size) : ""}
                  </td>
                </tr>
              ))}
              {!loading && entries.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-4 py-6 text-center text-gray-600 text-sm">Empty directory</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BrowsePage
// ---------------------------------------------------------------------------

export default function BrowsePage() {
  const [selectedPath, setSelectedPath] = useState("");

  return (
    <Layout>
      <div className="flex h-full overflow-hidden" style={{ height: "calc(100vh - 53px)" }}>
        {/* .plexmatch panel */}
        <div className="flex flex-col w-1/2 border-r border-gray-800 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800 shrink-0">
            <FileText size={16} className="text-indigo-400" />
            <h2 className="text-sm font-semibold text-gray-200">Plex Library</h2>
            {selectedPath && (
              <span className="ml-2 font-mono text-xs text-gray-500 truncate">/{selectedPath}</span>
            )}
          </div>
          <PlexMatchPanel folderPath={selectedPath} />
        </div>

        {/* File system panel */}
        <div className="flex flex-col w-1/2 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800 shrink-0">
            <FolderOpen size={16} className="text-yellow-400" />
            <h2 className="text-sm font-semibold text-gray-200">File System</h2>
          </div>
          <FileSystemPanel folderPath={selectedPath} onNavigate={setSelectedPath} />
        </div>
      </div>
    </Layout>
  );
}
