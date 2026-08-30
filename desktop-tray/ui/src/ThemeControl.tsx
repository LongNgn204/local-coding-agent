import { useEffect, useState } from "react";
import { effectiveTheme, normalizeTheme } from "./view-model.mjs";
import type { ThemePreference } from "./view-model.mjs";

const STORAGE_KEY = "lca-theme";
const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

export function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>(() => normalizeTheme(localStorage.getItem(STORAGE_KEY)));

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = effectiveTheme(preference, media.matches);
      document.documentElement.dataset.themePreference = preference;
    };
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem(STORAGE_KEY, preference);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  return (
    <div className="theme-control" role="group" aria-label="Color theme">
      {OPTIONS.map((option) => (
        <button key={option.value} type="button" className="theme-option" aria-pressed={preference === option.value} onClick={() => setPreference(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
