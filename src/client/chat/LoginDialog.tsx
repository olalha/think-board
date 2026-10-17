// The provider login terminal. The terminal itself (xterm.js) is loaded only
// when a login starts, keeping it out of the main bundle.
import { lazy, Suspense } from "react";
import { useBoard } from "../lib/store";

const LoginTerminal = lazy(() => import("./LoginTerminal"));

export function LoginDialog() {
  const open = useBoard((s) => s.loginOpen);
  if (!open) return null;
  return (
    <Suspense fallback={<div className="overlay"><span className="spinner" /></div>}>
      <LoginTerminal />
    </Suspense>
  );
}
