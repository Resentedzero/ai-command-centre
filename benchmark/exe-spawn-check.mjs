/** BENCHMARK ARTIFACT — confirms which spawn form can start the CLI on Windows. Zero model calls. */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";

const EXE = "C:/Users/cress/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe";

function attempt(label, cmd, opts = {}) {
  return new Promise((resolve) => {
    let out = "";
    try {
      const c = spawn(cmd, ["--version"], { stdio: ["ignore", "pipe", "pipe"], ...opts });
      c.stdout?.on("data", (d) => (out += String(d)));
      c.stderr?.on("data", (d) => (out += String(d)));
      c.on("error", (e) => resolve(`${label}\n    -> ERROR ${e.code}: ${e.message.split("\n")[0]}`));
      c.on("close", (code) => resolve(`${label}\n    -> exit=${code} stdout="${out.trim()}"`));
    } catch (e) {
      resolve(`${label}\n    -> THREW ${e.code ?? ""}: ${e.message.split("\n")[0]}`);
    }
  });
}

const results = [];
results.push(await attempt('A. spawn("claude", shell:false)   [WHAT PRODUCTION DOES]', "claude", { shell: false }));
results.push(await attempt("B. spawn(<resolved .exe>, shell:false)  [candidate fix]", EXE, { shell: false }));
console.log(results.join("\n"));

// Does `where` resolution find the .exe? (relevant to a portable fix)
try {
  const resolved = execFileSync("where", ["claude"], { encoding: "utf8" }).trim().split(/\r?\n/);
  console.log("\nC. `where claude` resolves to:\n    " + resolved.join("\n    "));
  console.log("    NOTE: none of these is the .exe; the .exe is reached only via the .cmd shim's body.");
} catch (e) {
  console.log("where failed", e.message);
}
