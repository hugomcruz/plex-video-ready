import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Plus, RefreshCw, Film } from "lucide-react";
import JobCard from "../components/JobCard";
import Layout from "../components/Layout";

export interface ProfileMediaInfo {
  video?: { codec: string; bitrate_kbps: number | null; fps: number | null };
  audio?: { codec: string; bitrate_kbps: number | null };
  total_bitrate_kbps?: number | null;
  file_size_bytes?: number | null;
}

export interface Job {
  id: string;
  original_filename: string;
  status: string;
  created_at: string;
  dest_path: string;
  transcode_progress: Record<string, string>;
  profile_bitrates: Record<string, ProfileMediaInfo>;
  source_resolution?: { width: number; height: number };
  source_codec?: string;
  source_bitrate?: number;
  source_fps?: number;
  source_file_size?: number;
  target_codec?: string;
  error?: string;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchJobs() {
    try {
      const { data } = await api.get<Job[]>("/jobs");
      setJobs(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Layout>
      <div className="px-6 py-8 max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold">Jobs</h2>
          <div className="flex gap-3">
            <button
              onClick={fetchJobs}
              className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-sm px-4 py-2 rounded-lg transition"
            >
              <RefreshCw size={15} />
              Refresh
            </button>
            <button
              onClick={() => navigate("/jobs/new")}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-sm px-4 py-2 rounded-lg font-semibold transition"
            >
              <Plus size={16} />
              New Job
            </button>
          </div>
        </div>

        {loading && <p className="text-gray-500">Loading…</p>}
        {!loading && jobs.length === 0 && (
          <div className="text-center py-20 text-gray-500">
            <Film size={48} className="mx-auto mb-4 opacity-30" />
            <p className="text-lg">No jobs yet. Create your first one!</p>
          </div>
        )}
        <div className="space-y-4">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} onRefresh={fetchJobs} />
          ))}
        </div>
      </div>
    </Layout>
  );
}
