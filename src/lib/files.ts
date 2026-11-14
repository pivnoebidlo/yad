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

export const pathKind = (path: string) => invoke<"file" | "dir" | "missing">("path_kind", { path });
export const listFiles = (root: string) => invoke<string[]>("list_files", { root });

/** Join a root directory and a `/`-separated relative path. */
export function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
}
