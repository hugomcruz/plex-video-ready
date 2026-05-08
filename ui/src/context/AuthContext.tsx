import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { api } from "../api";

interface AuthContextType {
  user: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      api.get("/auth/me").then((r) => setUser(r.data.username)).catch(() => {
        localStorage.removeItem("token");
        localStorage.removeItem("dist_token");
      });
    }
  }, []);

  async function login(username: string, password: string) {
    const params = new URLSearchParams();
    params.append("username", username);
    params.append("password", password);
    const { data } = await api.post("/auth/token", params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    localStorage.setItem("token", data.access_token);
    localStorage.setItem("dist_token", data.dist_access_token);
    setUser(username);
  }

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("dist_token");
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
