import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Film, LogOut, PlusCircle, MonitorPlay, ListVideo } from "lucide-react";

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const isNewVideo = location.pathname === "/jobs/new";
  const isBrowse   = location.pathname === "/browse";
  const isJobs     = location.pathname === "/" || location.pathname.startsWith("/jobs/") && location.pathname !== "/jobs/new";

  return (
    <div className="flex flex-col min-h-screen bg-gray-950">
      {/* Top header */}
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between shrink-0">
        <div
          className="flex items-center gap-3 cursor-pointer select-none"
          onClick={() => navigate("/")}
        >
          <Film className="text-indigo-500" size={26} />
          <h1 className="text-lg font-bold">Video Ready</h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-400">
            Signed in as <span className="text-white font-medium">{user}</span>
          </span>
          <button
            onClick={() => { logout(); navigate("/login"); }}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition"
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left nav */}
        <nav className="flex flex-col w-56 shrink-0 bg-gray-900 border-r border-gray-800">
          <button
            onClick={() => navigate("/jobs/new")}
            className={`flex items-center gap-3 px-4 py-3 text-sm font-semibold transition border-b border-gray-800 ${
              isNewVideo ? "bg-indigo-700 text-white" : "text-gray-300 hover:bg-gray-800 hover:text-white"
            }`}
          >
            <PlusCircle size={18} className={isNewVideo ? "text-white" : "text-indigo-400"} />
            New Video
          </button>

          <button
            onClick={() => navigate("/")}
            className={`flex items-center gap-3 px-4 py-3 text-sm font-semibold transition border-b border-gray-800 ${
              isJobs ? "bg-indigo-700 text-white" : "text-gray-300 hover:bg-gray-800 hover:text-white"
            }`}
          >
            <ListVideo size={18} className={isJobs ? "text-white" : "text-indigo-400"} />
            Jobs
          </button>

          <button
            onClick={() => navigate("/browse")}
            className={`flex items-center gap-3 px-4 py-3 text-sm font-semibold transition border-b border-gray-800 ${
              isBrowse ? "bg-indigo-700 text-white" : "text-gray-300 hover:bg-gray-800 hover:text-white"
            }`}
          >
            <MonitorPlay size={18} className={isBrowse ? "text-white" : "text-indigo-400"} />
            Video Browsing
          </button>
        </nav>

        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
