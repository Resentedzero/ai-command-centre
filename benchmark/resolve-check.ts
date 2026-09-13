import { resolveClaudeExecutable } from "../src/router/providers/claudeSubscription.js";
const resolved = resolveClaudeExecutable();
console.log("RESOLVED:", resolved);
console.log("IS_EXE:", /\.exe$/i.test(resolved));
console.log("IS_CMD:", /\.(cmd|bat)$/i.test(resolved));
