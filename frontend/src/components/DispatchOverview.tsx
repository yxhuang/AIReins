import { createContext, useEffect, useState, type ReactNode } from "react";
import { fetchDispatches } from "../api";
import { startDispatchPolling } from "../dispatch-polling";
import type { DispatchOverview } from "../types";

export const DispatchOverviewContext = createContext<{ overview: DispatchOverview | null; error: string }>({
  overview: null, error: "",
});

export function DispatchOverviewProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<DispatchOverview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => startDispatchPolling({
    visible: () => document.visibilityState !== "hidden",
    every: (callback, ms) => window.setInterval(callback, ms),
    cancel: timer => window.clearInterval(timer as number),
    onVisibility: callback => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
  }, fetchDispatches, setOverview, setError), []);
  return <DispatchOverviewContext.Provider value={{ overview, error }}>{children}</DispatchOverviewContext.Provider>;
}
