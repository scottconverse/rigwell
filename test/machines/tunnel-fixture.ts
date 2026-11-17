import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function fakeTunnelSsh(root: string) {
  const script = join(root, "fake-ssh-tunnel.ts");
  writeFileSync(script, `
    import { connect } from 'node:net';
    const args = process.argv.slice(2);
    for (const setting of ['BatchMode=yes','StrictHostKeyChecking=yes','ClearAllForwardings=yes','ForwardAgent=no']) if(!args.includes(setting)) process.exit(8);
    if(args.includes('-L') || args.includes('-R') || args.at(-1)!=='owner@fake') process.exit(9);
    const address = args[args.indexOf('-W')+1];
    if(!/^127\\.0\\.0\\.1:\\d+$/.test(address)) process.exit(10);
    const socket = connect(Number(address.split(':')[1]),'127.0.0.1');
    socket.on('error',()=>process.exit(11));
    socket.pipe(process.stdout); process.stdin.pipe(socket);
    socket.on('close',()=>process.exit(0));
  `);
  return [process.execPath, script];
}
