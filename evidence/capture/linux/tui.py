# Drive the interactive app in a pseudo-terminal: type a prompt, wait for the model request,
# then ask for a manual compaction, then quit. Saves everything the app drew to <out>.screen.txt.
# Usage: python3 tui.py <outPrefix> <requestsDir> <droid> [args...]
import os, sys, pty, time, select, signal, struct, fcntl, termios, glob

out, reqdir, argv = sys.argv[1], sys.argv[2], sys.argv[3:]
screen = open(out + '.screen.txt', 'wb')
events = open(out + '.events.txt', 'w')

def ev(msg):
    events.write('%.1f %s\n' % (time.time() - t0, msg)); events.flush()

t0 = time.time()
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            screen.write(data); screen.flush()
            # answer cursor-position queries so the app does not wait
            if b'\x1b[6n' in data:
                os.write(fd, b'\x1b[1;1R')
    return True

def nreq():
    return len(glob.glob(os.path.join(reqdir, 'req-*.json')))

CMD = os.environ.get('TUI_CMD', '/compact')
DELAY = float(os.environ.get('TUI_DELAY', '0.05'))

def typ(s):
    for ch in s:
        os.write(fd, ch.encode()); pump(DELAY)

def wait_req(n, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if not pump(0.5):
            return False
        if nreq() >= n:
            return True
    return False

alive = pump(10); ev('started alive=%s reqs=%d' % (alive, nreq()))
typ('say hi'); os.write(fd, b'\r')
ok = wait_req(1, 40); ev('after prompt got_request=%s reqs=%d' % (ok, nreq()))
pump(4)
before = nreq()
typ(CMD); pump(1.5); os.write(fd, b'\r')
if os.environ.get('TUI_CONFIRM'):
    pump(3); os.write(fd, b'\r'); ev('sent confirm Enter')
ok = wait_req(before + 1, 40); ev('after %s got_request=%s reqs=%d' % (CMD, ok, nreq()))
pump(5)
for _ in range(3):
    try:
        os.write(fd, b'\x03')
    except OSError:
        break
    pump(1)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
pump(1)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
ev('done reqs=%d' % nreq())
