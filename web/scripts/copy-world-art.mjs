// Copies the adapted pixel art the UI uses into public/world/ (git-ignored there:
// the art derives from third-party packs, see public/world/.gitignore).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const adapted = join(web, "..", "assets", "gamification", "adapted");
const props = join(web, "..", "assets", "gamification", "Tile Pack", "Top_Down_Adventure_Pack_v.1.0", "Props_Items_(animated)");
const out = join(web, "public", "world");

const files = [
  [adapted, "keep-v4-2x.png"],
  [adapted, "core-crystal-pedestal-2x.png"],
  [adapted, "light-active-2x.png"],
  [adapted, "light-wait-2x.png"],
  [adapted, "light-core-2x.png"],
  [adapted, "light-active-4x.png"],
  [adapted, "light-wait-4x.png"],
  [adapted, "light-fail-4x.png"],
  [adapted, "room-researcher-workshop-4x-slate.png"],
  [adapted, "room-publisher-workshop-4x.png"],
  ...["council", "engine", "library", "publisher", "researcher", "vault", "war"].map((r) => [adapted, `room-v5-${r}-2x.png`]),
  [props, "key_item_anim_strip_6.png"],
  [props, "lootchest_item_anim_strip_8.png"],
  [props, "lootchest_item_static_open.png"],
];

mkdirSync(join(out, "strips"), { recursive: true });
for (const [dir, name] of files) cpSync(join(dir, name), join(out, name));
cpSync(join(adapted, "strips-outlined-2x"), join(out, "strips"), { recursive: true });
// The Keeper: one outlined Rogue frame (read from the design workstream's art; no strip exists yet).
cpSync(join(adapted, "sprites-outlined-2x", "rogue-idle-2x-outlined.png"), join(out, "strips", "rogue-idle-2x-outlined.png"));
console.log(`Copied ${files.length} files and the outlined strips into public/world/`);
