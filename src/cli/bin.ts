// Entry point of the built yad-cli.mjs: always runs, whatever the file is named.
import { main } from "./yad";

process.exitCode = main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  color: !!process.stdout.isTTY && !process.env.NO_COLOR,
});
