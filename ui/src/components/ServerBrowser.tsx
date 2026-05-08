import { useEffect, useState, useCallback } from "react";
import { distApi } from "../api";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Film,
  RefreshCw,
  FileText,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
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
}

interface PlexSeason {
  season: number;
  episodes: PlexEpisode[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESOLUTION_ORDER = ["4k", "1080p", "720p", "480p"];
const RESOLUTION_COLORS: Record<string, string> = {
  "4k":    "bg-purple-900 text-purple-300",
  "1080p": "bg-indigo-900 text-indigo-300",
  "720p":  "bg-blue-900 text-blue-300",
  "480p":  "bg-gray-800 text-gray-400",
};

function parsePlexmatchEntries(lines: string[]): PlexSeason[] {
  const map = new Map<number, Map<number, { filename: string; resolution: string }[]>>();

  for (const line of lines) {
    const m = line.match(/ep:\s*s(\d+)e(\d+):\s*(.+)/i);
    if (!m) continue;
    const s = parseInt(m[1], 10);
    const e = parseInt(m[2], 10);
    const filename = m[3].trim();

    // Detect resolution from filename suffix before extension
    let resolution = "unknown";
    for (const res of RESOLUTION_ORDER) {
      if (filename.toLowerCase().includes(`_${res}.`)) { resolution = res; break; }
    }

    if (!map.has(s)) map.set(s, new Map());
    const epMap = map.get(s)!;
    if (!epMap.has(e)) epMap.set(e, []);
    epMap.get(e)!.push({ filename, resolution });
  }

  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([season, epMap]) => ({
      season,
      episodes: [...epMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([episode, files]) => ({
          episode,
          files: [...files].sort(
            (a, b) => RESOLUTION_ORDER.indexOf(a.resolution) - RESOLUTION_ORDER.indexOf(b.resolution)
          ),
        })),
    }));
}

// ---------------------------------------------------------------------------
// PlexTree — renders seasons/episodes for a folder with .plexmatch
// ---------------------------------------------------------------------------

function PlexTree({ folderPath }: { folderPath: string }) {
  const [seasons, setSeasons] = useState<PlexSeason[]>([]);
  const [loading, setLoading] = useState(true);
  const [openSeasons, setOpenSeasons] = useState<Set<number>>(new Set());
  const [openEpisodes, setOpenEpisodes] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    distApi
      .get("/plexmatch", { params: { path: folderPath } })
      .then(({ data }) => {
        const parsed = parsePlexmatchEntries(data.entries ?? []);
        setSeasons(parsed);
        // Auto-open all seasons
        setOpenSeasons(new Set(parsed.map((s) => s.season)));
      })
      .catch(() => setSeasons([]))
      .finally(() => setLoading(false));
  }, [folderPath]);

  function toggleSeason(s: number) {
    setOpenSeasons((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });
  }

  function toggleEpisode(key: string) {
    setOpenEpisodes((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  if (loading) return <p className="text-xs text-gray-600 pl-4 py-1">Loading…</p>;
  if (seasons.length === 0) return <p className="text-xs text-gray-600 pl-4 py-1">No entries in .plexmatch</p>;

  return (
    <div className="mt-1">
      {seasons.map((s) => {
        const seasonOpen = openSeasons.has(s.season);
        return (
          <div key={s.season}>
            <button
              onClick={() => toggleSeason(s.season)}
              className="w-full flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold text-indigo-300 hover:bg-gray-800 transition"
            >
              {seasonOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Season {String(s.season).padStart(2, "0")}
              <span className="ml-auto text-gray-600 font-normal">{s.episodes.length} ep</span>
            </button>

            {seasonOpen && (
              <div className="ml-3">
                {s.episodes.map((ep) => {
                  const key = `s${s.season}e${ep.episode}`;
                  const epOpen = openEpisodes.has(key);
                  // Derive a display name: strip resolution suffix from first file
                  const baseName = ep.files[0]?.filename.replace(/_(?:4k|1080p|720p|480p)\.[^.]+$/i, "") ?? key;
                  return (
                    <div key={key}>
                      <button
                        onClick={() => toggleEpisode(key)}
                        className="w-full flex items-center gap-1.5 px-3 py-1 rounded text-xs text-gray-300 hover:bg-gray-800 transition"
                      >
                        {epOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="font-mono text-gray-500 shrink-0">
                          e{String(ep.episode).padStart(2, "0")}
                        </span>
                        <span className="truncate text-left">{baseName}</span>
                      </button>

                      {epOpen && (
                        <div className="ml-6 mb-1 space-y-0.5">
                          {ep.files.map((f) => (
                            <div
                              key={f.filename}
                              className="flex items-center gap-2 px-2 py-0.5"
                            >
                              <Film size={11} className="text-gray-600 shrink-0" />
                              <span className="text-xs text-gray-500 truncate flex-1">{f.filename}</span>
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
// FolderNode — a single folder row in the tree
// ---------------------------------------------------------------------------

interface FolderNodeProps {
  path: string;
  name: string;
  depth: number;
}

function FolderNode({ path, name, depth }: FolderNodeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[]>([]);
  const [hasPlexmatch, setHasPlexmatch] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data } = await distApi.get("/browse", { params: { path } });
    const entries: DirEntry[] = data.entries ?? [];
    setChildren(entries.filter((e) => e.type === "directory"));
    setHasPlexmatch(entries.some((e) => e.type === "file" && e.name === ".plexmatch"));
    setLoaded(true);
  }, [path]);

  async function toggle() {
    if (!loaded) await load();
    setOpen((v) => !v);
  }

  const indent = depth * 12;

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1.5 py-1.5 pr-2 rounded text-sm hover:bg-gray-800 transition text-gray-300"
        style={{ paddingLeft: `${indent + 8}px` }}
      >
        {open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
        {open ? (
          <FolderOpen size={14} className="shrink-0 text-yellow-400" />
        ) : (
          <Folder size={14} className="shrink-0 text-yellow-400" />
        )}
        <span className="truncate flex-1 text-left">{name}</span>
        {hasPlexmatch && (
          <span title=".plexmatch">
            <FileText size={12} className="text-indigo-400 shrink-0" />
          </span>
        )}
      </button>

      {open && (
        <div>
          {hasPlexmatch && (
            <div style={{ paddingLeft: `${indent + 20}px` }}>
              <PlexTree folderPath={path} />
            </div>
          )}
          {children.map((child) => (
            <FolderNode key={child.path} path={child.path} name={child.name} depth={depth + 1} />
          ))}
          {loaded && children.length === 0 && !hasPlexmatch && (
            <p className="text-xs text-gray-600 py-1" style={{ paddingLeft: `${indent + 24}px` }}>
              Empty
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServerBrowser — top-level sidebar panel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ServerBrowser — pure folder/file tree (no outer wrapper)
// ---------------------------------------------------------------------------

export default function ServerBrowser() {
  const [rootEntries, setRootEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadRoot() {
    setLoading(true);
    setError("");
    try {
      const { data } = await distApi.get("/browse", { params: { path: "" } });
      const entries: DirEntry[] = data.entries ?? [];
      setRootEntries(entries.filter((e) => e.type === "directory"));
    } catch {
      setError("Could not connect to distribution server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadRoot(); }, []);

  return (
    <div>
      <div className="flex items-center justify-between px-3 pb-2">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Media Root</span>
        <button onClick={loadRoot} className="text-gray-600 hover:text-white transition" title="Refresh">
          <RefreshCw size={12} />
        </button>
      </div>
      {loading && <p className="text-xs text-gray-600 px-4 py-1">Loading…</p>}
      {error && <p className="text-xs text-red-400 px-4 py-1">{error}</p>}
      {!loading && rootEntries.length === 0 && !error && (
        <p className="text-xs text-gray-600 px-4 py-1">No folders at root</p>
      )}
      {rootEntries.map((entry) => (
        <FolderNode key={entry.path} path={entry.path} name={entry.name} depth={0} />
      ))}
    </div>
  );
}
