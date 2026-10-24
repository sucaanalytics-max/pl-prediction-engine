import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Suca FPL Decision OS",
    short_name: "Suca FPL",
    description:
      "FPL decision support: this week's call and plan, player projections and season stats, fixture runs by club, the evidence behind each forecast, and a log of the squad you actually submitted.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // The chrome colour, kept in step with `--chrome` and the `theme-color`
    // meta tag. An installed app whose splash screen is the previous palette
    // announces the old design before the new one has finished loading.
    background_color: "#f1f2f4",
    theme_color: "#f1f2f4",
    orientation: "portrait-primary",
    categories: ["sports", "productivity"],
    // Three of the eight live pages, the ones opened most from a home screen.
    // Existing icons only; `/capture` is the squad-record page, not a post scanner.
    shortcuts: [
      {
        name: "Players",
        short_name: "Players",
        description: "Projections and season stats by player",
        url: "/players",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Capture",
        short_name: "Capture",
        description: "Record the squad you submitted to FPL",
        url: "/capture",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Phases",
        short_name: "Phases",
        description: "Fixture runs and team strength for all twenty clubs",
        url: "/phases",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
