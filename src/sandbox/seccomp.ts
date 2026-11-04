// A seccomp filter for the bubblewrap sandbox (spec 5.5.8 "bubblewrap + socat + seccomp filter").
//
// bubblewrap loads a compiled classic-BPF program from a file descriptor (`--seccomp FD`). There is no libseccomp here, so
// the program is assembled by hand: an array of struct sock_filter (8 bytes each: u16 code, u8 jt, u8 jf, u32 k), little endian.
//
// What the filter does (default allow, with a deny list; denied calls fail with EPERM, `clone3` with ENOSYS so libc falls back to `clone`):
//  - a syscall made through a foreign ABI (32-bit on x86_64, the x32 range) is refused, since the deny list is written for the native one;
//  - kernel and boot: kexec_load, kexec_file_load, init_module, finit_module, delete_module, reboot, swapon, swapoff, acct,
//    quotactl, syslog, settimeofday, clock_settime, adjtimex, sethostname, setdomainname, vhangup, iopl, ioperm, modify_ldt;
//  - mounts and namespaces: mount, umount2, pivot_root, chroot, move_mount, open_tree, fsopen, fsconfig, fsmount, fspick,
//    mount_setattr, setns, unshare, and `clone` with any CLONE_NEW* flag (a command cannot make its own namespaces or user ns);
//  - other kernel attack surface: bpf, perf_event_open, userfaultfd, keyctl, add_key, request_key, open_by_handle_at,
//    kcmp, pidfd_getfd, process_vm_readv, process_vm_writev, and the NUMA policy calls.
// ptrace is NOT blocked (debuggers work; the PID namespace already limits the targets to the sandbox's own processes).
// This is defense in depth next to the mount and network rules; it is not a substitute for them.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SeccompArch = "x86_64" | "aarch64";

/** [name, x86_64 number, aarch64 number]; null: the syscall does not exist on that architecture. */
const DENY: [string, number | null, number | null][] = [
  ["kexec_load", 246, 104], ["kexec_file_load", 320, 294], ["init_module", 175, 105], ["finit_module", 313, 273], ["delete_module", 176, 106],
  ["reboot", 169, 142], ["swapon", 167, 224], ["swapoff", 168, 225], ["acct", 163, 89], ["quotactl", 179, 60], ["syslog", 103, 116],
  ["settimeofday", 164, 170], ["clock_settime", 227, 112], ["adjtimex", 159, 171], ["sethostname", 170, 161], ["setdomainname", 171, 162],
  ["vhangup", 153, 58], ["iopl", 172, null], ["ioperm", 173, null], ["modify_ldt", 154, null],
  ["mount", 165, 40], ["umount2", 166, 39], ["pivot_root", 155, 41], ["chroot", 161, 51], ["move_mount", 429, 429], ["open_tree", 428, 428],
  ["fsopen", 430, 430], ["fsconfig", 431, 431], ["fsmount", 432, 432], ["fspick", 433, 433], ["mount_setattr", 442, 442],
  ["setns", 308, 268], ["unshare", 272, 97],
  ["bpf", 321, 280], ["perf_event_open", 298, 241], ["userfaultfd", 323, 282], ["keyctl", 250, 219], ["add_key", 248, 217], ["request_key", 249, 218],
  ["open_by_handle_at", 304, 265], ["kcmp", 312, 272], ["pidfd_getfd", 438, 438], ["process_vm_readv", 310, 270], ["process_vm_writev", 311, 271],
  ["mbind", 237, 235], ["get_mempolicy", 239, 236], ["set_mempolicy", 238, 237], ["migrate_pages", 256, 238], ["move_pages", 279, 239],
];
const CLONE: Record<SeccompArch, number> = { x86_64: 56, aarch64: 220 };
const CLONE3 = 435;
const AUDIT_ARCH: Record<SeccompArch, number> = { x86_64: 0xc000003e, aarch64: 0xc00000b7 };
/** CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET */
const CLONE_NEW_MASK = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;

const RET_ALLOW = 0x7fff0000;
const retErrno = (e: number) => 0x00050000 | e;
const EPERM = 1;
const ENOSYS = 38;

// classic BPF opcodes
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const JSET_K = 0x45;
const RET_K = 0x06;

export function deniedSyscalls(arch: SeccompArch): string[] {
  const i = arch === "x86_64" ? 1 : 2;
  return DENY.filter((d) => d[i] !== null).map((d) => d[0]).concat(["clone(CLONE_NEW*)", "clone3"]);
}

/** The architecture this process runs on, or null when no filter is written for it. */
export function seccompArch(arch: string = process.arch): SeccompArch | null {
  return arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
}

type Ins = { code: number; jt?: string | number; jf?: string | number; k: number; label?: string };

/** The compiled filter for `arch` (struct sock_filter[]). */
export function buildSeccompProgram(arch: SeccompArch): Buffer {
  const i = arch === "x86_64" ? 1 : 2;
  const nrs = DENY.map((d) => d[i]).filter((n): n is number => n !== null);
  const prog: Ins[] = [];
  const add = (x: Ins) => prog.push(x);
  add({ code: LD_W_ABS, k: 4 }); // seccomp_data.arch
  add({ code: JEQ_K, k: AUDIT_ARCH[arch], jt: 1, jf: 0 });
  add({ code: RET_K, k: retErrno(EPERM) }); // another ABI
  add({ code: LD_W_ABS, k: 0 }); // seccomp_data.nr
  if (arch === "x86_64") add({ code: JGE_K, k: 0x40000000, jt: "deny", jf: 0 }); // x32 ABI
  add({ code: JEQ_K, k: CLONE[arch], jt: "clone", jf: 0 });
  add({ code: JEQ_K, k: CLONE3, jt: "nosys", jf: 0 });
  for (const n of nrs) add({ code: JEQ_K, k: n, jt: "deny", jf: 0 });
  add({ code: RET_K, k: RET_ALLOW });
  add({ code: LD_W_ABS, k: 16, label: "clone" }); // args[0] (the flags), low word
  add({ code: JSET_K, k: CLONE_NEW_MASK, jt: "deny", jf: 0 }); // classic BPF jumps only go forward
  add({ code: RET_K, k: RET_ALLOW });
  add({ code: RET_K, k: retErrno(EPERM), label: "deny" });
  add({ code: RET_K, k: retErrno(ENOSYS), label: "nosys" });
  const at = new Map<string, number>();
  prog.forEach((x, n) => { if (x.label) at.set(x.label, n); });
  const buf = Buffer.alloc(prog.length * 8);
  prog.forEach((x, n) => {
    const rel = (t: string | number | undefined) => {
      if (t === undefined) return 0;
      if (typeof t === "number") return t;
      const to = at.get(t);
      if (to === undefined) throw new Error(`seccomp: unknown label ${t}`);
      const d = to - (n + 1);
      if (d < 0 || d > 255) throw new Error("seccomp: jump out of range");
      return d;
    };
    buf.writeUInt16LE(x.code, n * 8);
    buf.writeUInt8(rel(x.jt), n * 8 + 2);
    buf.writeUInt8(rel(x.jf), n * 8 + 3);
    buf.writeUInt32LE(x.k >>> 0, n * 8 + 4);
  });
  return buf;
}

let written: string | null | undefined;

/** Writes the filter for this machine to a file (once per process) and returns its path; null when this architecture has none. */
export function seccompFile(): string | null {
  if (written !== undefined) return written;
  const arch = seccompArch();
  if (!arch) return (written = null);
  const prog = buildSeccompProgram(arch);
  try {
    // A private directory made for this process (0700, unique name): another user cannot swap the file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rigwell-seccomp-"));
    const file = path.join(dir, `${arch}.bpf`);
    fs.writeFileSync(file, prog, { mode: 0o600 });
    process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
    return (written = file);
  } catch {
    return (written = null);
  }
}
