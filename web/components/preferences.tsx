"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_PREFERENCES, readPreferences, writePreferences, type Preferences } from "../lib/preferences";

type Ctx = { preferences: Preferences; update: (change: Partial<Preferences>) => void };
// Without a provider (tests, isolated renders) the defaults apply and nothing is stored.
const PreferencesContext = createContext<Ctx>({ preferences: DEFAULT_PREFERENCES, update: () => {} });

/** Reads the stored preferences after mount (SSR renders the defaults) and applies the motion choice to <html>. */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  useEffect(() => {
    setPreferences(readPreferences());
    const onStorage = () => setPreferences(readPreferences());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.motion = preferences.motion;
  }, [preferences.motion]);
  const update = useCallback((change: Partial<Preferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...change };
      writePreferences(next);
      return next;
    });
  }, []);
  return <PreferencesContext.Provider value={{ preferences, update }}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Ctx {
  return useContext(PreferencesContext);
}
