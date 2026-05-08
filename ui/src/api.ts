import axios from "axios";

const api = axios.create({ baseURL: "/api" });
const distApi = axios.create({ baseURL: "/dist" });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

distApi.interceptors.request.use((config) => {
  const token = localStorage.getItem("dist_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export { api, distApi };
