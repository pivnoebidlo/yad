/** Self-update from GitHub releases (Tauri updater; packages are signed). */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

/** The newer release, or null when this is the latest. Throws on network errors. */
export const findUpdate = (): Promise<Update | null> => check({ timeout: 15000 });

/** Download, install and restart; `progress` gets 0…1 (or null while the size is unknown). */
export async function installUpdate(update: Update, progress: (p: number | null) => void): Promise<void> {
  let total = 0, done = 0;
  await update.downloadAndInstall((ev) => {
    if (ev.event === "Started") total = ev.data.contentLength ?? 0;
    else if (ev.event === "Progress") {
      done += ev.data.chunkLength;
      progress(total ? Math.min(1, done / total) : null);
    }
  });
  await relaunch();
}
