import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { linuxReleaseTarball, readLinuxReleaseTarball } from "../../desktop/main/linux-release.ts";
import { installLinuxUpdate, rollbackAppImage } from "../../desktop/main/update-verify.ts";

test("Linux release tarballs install and roll back without extracting paths", () => {
  const root = mkdtempSync(join(tmpdir(), "rigwell-linux-release-"));
  try {
    const bytes = Buffer.from("fixture AppImage payload"), archive = join(root, "release.tar.gz"), installed = join(root, "installed.AppImage");
    writeFileSync(archive, linuxReleaseTarball(bytes)); writeFileSync(installed, "previous installation");
    const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", windowsHide: true });
    expect(listed.status).toBe(0); expect(listed.stdout.trim()).toBe("Rigwell.AppImage");
    const extracted = spawnSync("tar", ["-xOzf", archive, "Rigwell.AppImage"], { encoding: "utf8", windowsHide: true });
    expect(extracted.status).toBe(0); expect(extracted.stdout).toBe(bytes.toString());
    installLinuxUpdate(archive, installed); expect(readFileSync(installed)).toEqual(bytes);
    expect(readdirSync(root).some(name => name.includes(".image-"))).toBe(false);
    rollbackAppImage(installed); expect(readFileSync(installed, "utf8")).toBe("previous installation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed, linked, traversal, extra-entry and truncated tarballs refuse before replacing the installation", () => {
  const archive = linuxReleaseTarball(Buffer.from("new bytes"));
  const change = (mutate: (tar: Buffer) => void) => { const tar = gunzipSync(archive); mutate(tar); tar.fill(32, 148, 156); tar.write([...tar.subarray(0, 512)].reduce((s, n) => s + n, 0).toString(8).padStart(6, "0") + "\0 ", 148); return gzipSync(tar); };
  const bad = [Buffer.from("not gzip"), gzipSync(gunzipSync(archive).subarray(0, 1024)),
    change(tar => { tar.fill(0, 0, 100); tar.write("../escape"); }),
    change(tar => { tar[156] = 50; }), change(tar => { tar[1024] = 65; }),
    change(tar => { tar.write("77777777777\0", 124); }), change(tar => { tar[345] = 65; })];
  const root = mkdtempSync(join(tmpdir(), "rigwell-linux-refuse-"));
  try {
    const installed = join(root, "installed.AppImage"), file = join(root, "bad.tar.gz"); writeFileSync(installed, "unchanged");
    for (const bytes of bad) {
      expect(() => readLinuxReleaseTarball(bytes)).toThrow(); writeFileSync(file, bytes);
      expect(() => installLinuxUpdate(file, installed)).toThrow(); expect(readFileSync(installed, "utf8")).toBe("unchanged");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
