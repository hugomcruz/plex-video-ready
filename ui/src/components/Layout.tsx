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

  const navItems = [
    { label: "New Video", shortLabel: "New", icon: PlusCircle, active: isNewVideo, onClick: () => navigate("/jobs/new") },
    { label: "Jobs", shortLabel: "Jobs", icon: ListVideo, active: isJobs, onClick: () => navigate("/") },
    { label: "Video Browsing", shortLabel: "Browse", icon: MonitorPlay, active: isBrowse, onClick: () => navigate("/browse") },
  ];

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      {/* Top header */}
      <header className="bg-gray-900 border-b border-gray-800 px-3 sm:px-6 py-3 flex items-center justify-between shrink-0">
        <div
          className="flex items-center gap-2 sm:gap-3 cursor-pointer select-none min-w-0"
          onClick={() => navigate("/")}
        >
          <Film className="text-indigo-500 shrink-0" size={24} />
          <h1 className="text-base sm:text-lg font-bold truncate">Video Ready</h1>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <span className="hidden sm:inline text-sm text-gray-400">
            Signed in as <span className="text-white font-medium">{user}</span>
          </span>
          <button
            onClick={() => { logout(); navigate("/login"); }}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition"
          >
            <LogOut size={15} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      {/* Body: sidebar (desktop) + content */}
      <div className="flex flex-1 min-h-0">
        {/* Left nav — desktop and up */}
        <nav className="hidden md:flex flex-col w-56 shrink-0 bg-gray-900 border-r border-gray-800">
          {navItems.map(({ label, icon: Icon, active, onClick }) => (
            <button
              key={label}
              onClick={onClick}
              className={`flex items-center gap-3 px-4 py-3 text-sm font-semibold transition border-b border-gray-800 ${
                active ? "bg-indigo-700 text-white" : "text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              <Icon size={18} className={active ? "text-white" : "text-indigo-400"} />
              {label}
            </button>
          ))}
        </nav>

        <main className="flex-1 min-w-0 overflow-y-auto">
          {children}
        </main>
      </div>

      {/* Bottom tab bar — mobile only */}
      <nav className="flex md:hidden shrink-0 bg-gray-900 border-t border-gray-800">
        {navItems.map(({ label, shortLabel, icon: Icon, active, onClick }) => (
          <button
            key={label}
            onClick={onClick}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition ${
              active ? "text-indigo-400" : "text-gray-400"
            }`}
          >
            <Icon size={20} />
            {shortLabel}
          </button>
        ))}
      </nav>
    </div>
  );
}
