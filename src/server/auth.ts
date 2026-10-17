// Optional built-in login: one password for the whole app, for installs that
// have no Cloudflare Access (or other authenticating proxy) in front.
//
// On when ROOT/.auth/password exists (set it with bin/set-password). Sessions
// are HMAC-signed cookies with a random server secret (ROOT/.auth/secret), so
// nothing needs storing per session; changing the password rotates the secret
// and signs everyone out. ROOT/.auth is mounted into the app container only —
// never into the agents' container.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const COOKIE = "think_session";
const MAX_AGE_S = 30 * 24 * 3600;

interface PasswordFile {
  algo: "scrypt";
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

export function hashPassword(password: string): PasswordFile {
  const salt = crypto.randomBytes(16);
  const params = { N: 1 << 15, r: 8, p: 1 };
  const hash = crypto.scryptSync(password, salt, 32, { ...params, maxmem: 128 * 1024 * 1024 });
  return { algo: "scrypt", salt: salt.toString("base64"), hash: hash.toString("base64"), ...params };
}

/** Write a new password (and a new session secret: everyone signs in again). */
export function setPassword(authDir: string, password: string): void {
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(authDir, "password"), JSON.stringify(hashPassword(password)) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(authDir, "secret"), crypto.randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
}

export function clearPassword(authDir: string): void {
  fs.rmSync(path.join(authDir, "password"), { force: true });
}

export class Auth {
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly dir: string) {}

  private read(name: string): string | null {
    try {
      return fs.readFileSync(path.join(this.dir, name), "utf8").trim();
    } catch {
      return null;
    }
  }

  get enabled(): boolean {
    return this.read("password") !== null;
  }

  private secret(): Buffer {
    let s = this.read("secret");
    if (!s) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      s = crypto.randomBytes(32).toString("base64");
      fs.writeFileSync(path.join(this.dir, "secret"), s + "\n", { mode: 0o600 });
    }
    return Buffer.from(s, "base64");
  }

  private sign(payload: string): string {
    return crypto.createHmac("sha256", this.secret()).update(payload).digest("base64url");
  }

  /** Is the request's cookie a valid, unexpired session? */
  check(cookieHeader: string | undefined): boolean {
    if (!this.enabled) return true;
    const raw = (cookieHeader ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!raw) return false;
    const [expires, sig] = raw.split(".");
    if (!expires || !sig || Number(expires) < Date.now() / 1000) return false;
    const want = this.sign(expires);
    return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
  }

  /** Seconds a client must still wait after repeated failures (0 = may try). */
  retryAfter(ip: string): number {
    const f = this.failures.get(ip);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  /** Verify a password; returns the Set-Cookie value on success. */
  login(ip: string, password: string, secure: boolean): string | null {
    const stored = this.read("password");
    if (!stored) return null;
    const p = JSON.parse(stored) as PasswordFile;
    const got = crypto.scryptSync(password, Buffer.from(p.salt, "base64"), 32, { N: p.N, r: p.r, p: p.p, maxmem: 128 * 1024 * 1024 });
    const ok = crypto.timingSafeEqual(got, Buffer.from(p.hash, "base64"));
    if (!ok) {
      // 5 free attempts, then a wait that doubles with each further failure.
      const f = this.failures.get(ip) ?? { count: 0, until: 0 };
      f.count++;
      if (f.count >= 5) f.until = Date.now() + Math.min(3600, 15 * 2 ** (f.count - 5)) * 1000;
      this.failures.set(ip, f);
      return null;
    }
    this.failures.delete(ip);
    const expires = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
    return `${COOKIE}=${expires}.${this.sign(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? "; Secure" : ""}`;
  }

  logoutCookie(): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}

export function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · think</title>
<style>
  :root { --bg:#f5f5f2; --panel:#fff; --border:#e3e3de; --text:#1c1c1a; --muted:#8e8e87; --accent:#4f46e5; --danger:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#131312; --panel:#1c1c1a; --border:#31312d; --text:#ececea; --muted:#76766f; --accent:#7c7cff; --danger:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding:16px; }
  form { width:min(360px, 100%); padding:28px; border-radius:16px; background:var(--panel); border:1px solid var(--border);
         box-shadow:0 16px 40px rgba(0,0,0,.08); }
  h1 { margin:0 0 4px; font-size:20px; letter-spacing:-.01em; }
  p { margin:0 0 18px; color:var(--muted); font-size:13.5px; }
  input { width:100%; height:42px; padding:0 12px; border-radius:10px; border:1px solid var(--border); background:transparent;
          color:inherit; font:inherit; outline:none; }
  input:focus { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
  button { width:100%; height:42px; margin-top:12px; border:none; border-radius:10px; background:var(--accent); color:#fff;
           font:inherit; font-weight:600; cursor:pointer; }
  .error { margin-top:12px; color:var(--danger); font-size:13.5px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>think</h1>
  <p>Sign in to your canvases.</p>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
  ${error ? `<div class="error">${error.replace(/[<>&]/g, "")}</div>` : ""}
</form>
</body>
</html>`;
}
