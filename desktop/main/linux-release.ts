import { gunzipSync, gzipSync } from "node:zlib";

// A deliberately narrow release format: one regular AppImage, no directories,
// links, extended headers or extraction paths. Never extract an arbitrary tar.
const NAME = "Rigwell.AppImage", LIMIT = 1024 * 1024 * 1024;
export function linuxReleaseTarball(appImage: Uint8Array): Buffer {
  if (!appImage.length || appImage.length > LIMIT) throw new Error("Invalid AppImage size");
  const header = Buffer.alloc(512);
  header.write(NAME); header.write("0000755\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(appImage.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136); header.fill(32, 148, 156); header[156] = 48;
  header.write("ustar\0", 257); header.write("00", 263);
  header.write([...header].reduce((sum, n) => sum + n, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return gzipSync(Buffer.concat([header, appImage, Buffer.alloc((512 - appImage.length % 512) % 512 + 1024)]));
}

export function readLinuxReleaseTarball(archive: Uint8Array): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: LIMIT + 2048 });
  if (tar.length < 2048 || tar.length % 512) throw new Error("Invalid release tarball length");
  const header = tar.subarray(0, 512), number = (start: number, length: number) => {
    const text = header.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
    if (!/^[0-7]+$/.test(text)) throw new Error("Invalid release tarball number");
    return Number.parseInt(text, 8);
  };
  const size = number(124, 12), checksum = number(148, 8);
  const check = Buffer.from(header); check.fill(32, 148, 156);
  if ([...check].reduce((sum, n) => sum + n, 0) !== checksum) throw new Error("Invalid release tarball checksum");
  if (header.subarray(0, 100).toString().replace(/\0.*$/, "") !== NAME || ![0, 48].includes(header[156]!) || header.subarray(345, 500).some(n => n !== 0)) throw new Error("Release tarball must contain only the regular AppImage");
  const end = 512 + size, paddedEnd = 512 + Math.ceil(size / 512) * 512;
  if (!size || size > LIMIT || tar.length < paddedEnd + 1024 || tar.subarray(end).some(n => n !== 0)) throw new Error("Invalid release tarball payload or trailing entries");
  return tar.subarray(512, end);
}
