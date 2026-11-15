import { readFileSync, writeFileSync } from "node:fs";
import { linuxReleaseTarball } from "../main/linux-release.ts";
const [source, target] = process.argv.slice(2);
if (!source || !target || !source.endsWith(".AppImage") || !target.endsWith(".tar.gz")) throw new Error("usage: linux-release.ts <app.AppImage> <release.tar.gz>");
writeFileSync(target, linuxReleaseTarball(readFileSync(source)), { flag: "wx" });
console.log(target);
