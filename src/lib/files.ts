import { invoke } from "@tauri-apps/api/core";

export type Side = "a" | "b";

export const readText = (path: string) => invoke<string>("read_text", { path });
export const writeText = (path: string, contents: string) =>
  invoke<void>("write_text", { path, contents });
export const initialPaths = () => invoke<string[]>("initial_paths");

export type Lang = "yaml" | "json" | "plain";

export function langFor(path: string | null): Lang {
  const ext = path?.split(".").pop()?.toLowerCase();
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext === "json") return "json";
  return "plain";
}

export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
