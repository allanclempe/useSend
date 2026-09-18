import { useTheme } from "@usesend/ui";

/**
 * The analytics charts' palette, picked from the resolved theme.
 *
 * `useTheme` is next-themes, re-exported by `@usesend/ui` and mounted in
 * `__root.tsx` — it is not a Next.js API despite the package name, so this
 * survived the move unchanged. During SSR and the first client render
 * `resolvedTheme` is undefined, which lands on the light palette; the theme
 * class on `<html>` settles it before anything is visible, exactly as it did
 * under Next.js.
 */
export function useColors() {
  const { resolvedTheme } = useTheme();

  const lightColors = {
    delivered: "#40a02b",
    bounced: "#d20f39",
    complained: "#df8e1d",
    opened: "#8839ef",
    clicked: "#04a5e5",
    xaxis: "#6D6F84",
  };

  const darkColors = {
    delivered: "#a6e3a1",
    bounced: "#f38ba8",
    complained: "#F9E2AF",
    opened: "#cba6f7",
    clicked: "#93c5fd",
    xaxis: "#AAB1CD",
  };

  return resolvedTheme === "dark" ? darkColors : lightColors;
}
