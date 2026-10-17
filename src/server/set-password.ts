// Set (or remove) the app password. Reads the password from stdin — never
// from the command line — so bin/set-password can pass it from a hidden
// prompt. Prints only its length.
//
//   node dist/node/server/set-password.js            (password on stdin)
//   node dist/node/server/set-password.js --off      (remove it: no login)
import path from "node:path";
import { clearPassword, setPassword } from "./auth.js";
import { resolvePaths } from "./config.js";

const authDir = path.join(resolvePaths().root, ".auth");
if (process.argv.includes("--off")) {
  clearPassword(authDir);
  console.log("The app password is removed: think no longer asks for one.");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const password = input.replace(/\r?\n$/, "");
  if (password.length < 10) {
    console.error(`Too short (${password.length} characters): use at least 10.`);
    process.exit(1);
  }
  setPassword(authDir, password);
  console.log(`Password set (${password.length} characters). Everyone signed in before must sign in again.`);
});
