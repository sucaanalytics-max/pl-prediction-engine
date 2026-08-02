import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Suca FPL Decision OS",
    short_name: "Suca FPL",
    description:
      "Squad-aware FPL transfer recommendations, Top 10 rankings and weekly decision support.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#07130f",
    theme_color: "#07130f",
    orientation: "portrait-primary",
    categories: ["sports", "productivity"],
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
        src: "/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
