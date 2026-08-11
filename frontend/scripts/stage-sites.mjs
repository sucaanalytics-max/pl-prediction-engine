import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const bundledWorker = resolve(root, ".sites-bundle", "worker.js");
const assets = resolve(root, ".open-next", "assets");
const destination = resolve(root, "dist");
const serverDirectory = resolve(destination, "server");

await rm(destination, { recursive: true, force: true });
await mkdir(serverDirectory, { recursive: true });
await cp(bundledWorker, resolve(serverDirectory, "index.js"));
await cp(assets, resolve(destination, "assets"), { recursive: true });
