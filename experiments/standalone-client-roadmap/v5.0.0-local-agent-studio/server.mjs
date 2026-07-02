#!/usr/bin/env node
// v5.0 Local Agent Studio entry point.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { startStudio } from "./standalone-app.mjs";

const manifest = JSON.parse(await readFile(new URL("./version-manifest.json", import.meta.url), "utf8"));
const studio = startStudio(manifest);
await studio.ready;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await studio.close().catch(() => {});
    process.exit(0);
  });
}
