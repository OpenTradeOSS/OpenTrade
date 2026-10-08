import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { query } from "./api";

/**
 * Query the host through the gateway and re-query every `intervalMs` while the app is
 * in the foreground. Errors keep the last good data.
 */
export function usePoll<T>(procedure: string, intervalMs: number, input?: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inputKey = JSON.stringify(input ?? null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const v = await query<T>(procedure, input);
      if (alive.current) {
        setData(v);
        setError(null);
      }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : "Couldn't load.");
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: input is tracked by inputKey
  }, [procedure, inputKey]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    alive.current = true;
    load();
    let timer: ReturnType<typeof setInterval> | null = setInterval(load, intervalMs);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        load();
        if (!timer) timer = setInterval(load, intervalMs);
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [load, intervalMs]);

  return { data, error, refreshing, refresh };
}
