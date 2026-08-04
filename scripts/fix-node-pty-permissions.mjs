// node-pty ships `spawn-helper` in its prebuilds with mode 644 on darwin-arm64, and node-pty
// execs that helper for every single spawn. Without the executable bit EVERY spawn fails with
// `posix_spawnp failed.` - a message that names neither the helper nor the permission, and that
// looks identical whether you asked for tmux, /bin/sh or /bin/echo.
//
// That generic error is the reason this file exists rather than a note in the README. The failure
// reads as "node-pty is broken on this machine" or "tmux is not on PATH", and both are wrong.
//
// pnpm reinstalls wipe node_modules, so this runs from `postinstall` rather than being applied by
// hand. It is idempotent and silent when there is nothing to do.
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "node_modules/.pnpm";
if (!existsSync(root)) process.exit(0);

let fixed = 0;

for (const entry of readdirSync(root)) {
  if (!entry.startsWith("node-pty@")) continue;
  const prebuilds = join(root, entry, "node_modules/node-pty/prebuilds");
  if (!existsSync(prebuilds)) continue;

  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    // Already executable by the owner: nothing to do.
    if ((mode & 0o100) !== 0) continue;
    chmodSync(helper, mode | 0o755);
    console.log(`fixed permissions on ${helper}`);
    fixed++;
  }
}

if (fixed === 0) process.exit(0);
