import { useEffect, useState } from "react";

/** Reactive matchMedia hook. Returns true while the viewport matches `query`
 *  (default: phone-width). Drives the mobile tabbed HUD; the same 600px
 *  breakpoint is mirrored in styles.css so CSS and layout agree. */
export function useIsMobile(query = "(max-width: 600px)"): boolean {
  const get = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches;

  const [isMobile, setIsMobile] = useState(get);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return isMobile;
}
