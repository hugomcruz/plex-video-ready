import { useEffect, useState } from "react";
import { distApi } from "../api";
import { Folder, FolderOpen, ChevronRight, Home, Plus, File } from "lucide-react";

interface Entry {
  name: string;
  type: "directory" | "file";
  path: string;
  size: number | null;
}

interface Props {
  value: string;
  onChange: (path: string) => void;
}

export default function FolderBrowser({ value, onChange }: Props) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);

  async function browse(path: string) {
    setLoading(true);
    setError("");
    try {
      const { data } = await distApi.get("/browse", { params: { path } });
      setCurrentPath(data.current_path);
      // Sort: directories first, then files, both alphabetically
      const sorted = [...data.entries].sort((a: Entry, b: Entry) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(sorted);
    } catch {
      setError("Failed to load directory");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { browse(""); }, []);

  function selectFolder(path: string) {
    onChange(path);
    browse(path);
  }

  function navigateUp() {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    browse(parts.join("/"));
  }

  async function createFolder() {
    if (!newFolderName.trim()) return;
    const newPath = currentPath ? `${currentPath}/${newFolderName.trim()}` : newFolderName.trim();
    try {
      await distApi.post("/mkdir", null, { params: { path: newPath } });
      setNewFolderName("");
      setShowNewFolder(false);
      browse(currentPath);
    } catch {
      setError("Failed to create folder");
    }
  }

  const breadcrumbs = ["root", ...currentPath.split("/").filter(Boolean)];

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-gray-400 mb-3 flex-wrap">
        <button type="button" onClick={() => browse("")} className="hover:text-white flex items-center gap-1">
          <Home size={14} /> root
        </button>
        {breadcrumbs.slice(1).map((crumb, i) => {
          const path = breadcrumbs.slice(1, i + 2).join("/");
          return (
            <span key={path} className="flex items-center gap-1">
              <ChevronRight size={12} />
              <button type="button" onClick={() => browse(path)} className="hover:text-white">{crumb}</button>
            </span>
          );
        })}
      </div>

      {/* Selected destination */}
      <div className="mb-3 flex items-center gap-2 bg-indigo-900/40 border border-indigo-700 rounded-lg px-3 py-2">
        <FolderOpen size={16} className="text-indigo-400 shrink-0" />
        <span className="text-sm text-indigo-200 truncate font-mono">
          {value || "(none selected)"}
        </span>
      </div>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Directory listing */}
      <div className="space-y-1 max-h-52 overflow-y-auto">
        {currentPath && (
          <button
            type="button"
            onClick={navigateUp}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-gray-700 transition"
          >
            <Folder size={15} /> ..
          </button>
        )}
        {entries.map((entry) => {
          const isDir = entry.type === "directory";
          return (
            <button
              type="button"
              key={entry.path}
              onClick={() => isDir ? selectFolder(entry.path) : undefined}
              disabled={!isDir}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition ${
                isDir
                  ? value === entry.path
                    ? "bg-indigo-700 text-white"
                    : "hover:bg-gray-700 text-gray-300 cursor-pointer"
                  : "text-gray-500 cursor-default"
              }`}
            >
              {isDir
                ? <Folder size={15} className="shrink-0 text-yellow-400" />
                : <File size={15} className="shrink-0 text-gray-500" />}
              <span className="truncate flex-1 text-left">{entry.name}</span>
              {!isDir && entry.size !== null && (
                <span className="text-xs text-gray-600 shrink-0">
                  {entry.size >= 1024 * 1024 * 1024
                    ? `${(entry.size / 1024 / 1024 / 1024).toFixed(1)} GB`
                    : entry.size >= 1024 * 1024
                    ? `${(entry.size / 1024 / 1024).toFixed(1)} MB`
                    : `${(entry.size / 1024).toFixed(1)} KB`}
                </span>
              )}
              {isDir && <ChevronRight size={13} className="shrink-0 text-gray-600" />}
            </button>
          );
        })}
        {!loading && entries.length === 0 && (
          <p className="text-xs text-gray-600 px-3 py-2">Empty directory.</p>
        )}
      </div>

      {/* New folder */}
      <div className="mt-3 border-t border-gray-700 pt-3">
        {showNewFolder ? (
          <div className="flex gap-2">
            <input
              className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="New folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createFolder()}
              autoFocus
            />
            <button
              type="button"
              onClick={createFolder}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg transition"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setShowNewFolder(false)}
              className="text-gray-400 hover:text-white text-sm px-2 transition"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowNewFolder(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-400 transition"
          >
            <Plus size={13} /> New folder
          </button>
        )}
      </div>
    </div>
  );
}
