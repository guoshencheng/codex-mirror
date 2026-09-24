# Exercise a piped Node installer with a real controlling terminal.
import os, pty, select, shlex, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', '-c', 'printf "" | ' + shlex.join(sys.argv[1:])])
output = b''
sent_token = False
deadline = time.time() + 12
while time.time() < deadline:
    if select.select([fd], [], [], 0.2)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        if 'Dashboard 用户 Token（隐藏输入）:'.encode() in output and not sent_token:
            os.write(fd, (os.environ['TEST_ADMIN_TOKEN'] + '\n').encode())
            sent_token = True
else:
    os.killpg(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    print('TTY_TIMEOUT')
    sys.exit(99)
_, status = os.waitpid(pid, 0)
if os.environ['TEST_ADMIN_TOKEN'].encode() in output:
    print('TOKEN_ECHOED')
    sys.exit(98)
print(output.decode(errors='replace'))
sys.exit(os.waitstatus_to_exitcode(status))
