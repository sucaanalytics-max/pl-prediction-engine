"use client";

import { ThemeProvider } from "next-themes";

/**
 * One surface, declared light — and the `color-scheme` is the point.
 *
 * This forced `dark`, which was right when the app was ink-on-black and survived
 * the move to paper because nothing the app PAINTS reads it. What reads it is the
 * browser: `color-scheme: dark` on the root makes every native control render in
 * the dark palette, so a checkbox on the stats sheet came out a filled black
 * square, and the caret, selection and scrollbars in the search field came out
 * dark on paper. None of that is styleable from the app's own tokens; it is the
 * user agent, and this declaration is the only thing that tells it.
 *
 * `forcedTheme` rather than `defaultTheme`: there is ONE surface. A default is a
 * preference a viewer can move off, and a stored "dark" from before this change
 * would otherwise keep half of them on a palette that no longer exists.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      forcedTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
