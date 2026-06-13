import { useEffect, useState } from "react";

/** Reactive matchMedia hook. Returns true while the viewport is phone-sized in
 *  EITHER dimension — narrow (portrait phones) OR short-and-not-wide (landscape
 *  phones, where the four-panel HUD would otherwise eat the limited height).
 *  Drives the mobile tabbed HUD; the .hud-mobile styles in styles.css are
 *  unconditional so they apply whichever condition triggers. */
export function useIsMobile(
  query = "(max-width: 600px), (max-height: 600px) and (max-width: 1000px)",
): boolean {
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
