#!/usr/bin/env python3
"""wb-remote@.service 的单连接处理：AIReins 没在跑就先拉起，再把这条连接原样转给 AIReins 的远程端口。

每个连接都重新检查，所以手动 aireins stop 之后手机再访问照样能拉起。
AIReins 放进独立的 systemd scope 启动：本连接结束、实例退出时不会连坐杀掉 AIReins。
"""
import os
import shlex
import socket
import subprocess
import sys
import threading
import time

PORT = 8793  # 与 ~/.workbench/remote.json 的 port 一致


def connect():
    return socket.create_connection(("127.0.0.1", PORT), timeout=1)


try:
    up = connect()
except OSError:
    # 手机首屏会并发开好几条连接：加锁只让一个去拉起，其余拿到锁时 aireins start 发现已在运行、立即返回。
    # -o：锁只由 flock 本身持有，否则被拉起的 AIReins 会继承锁 fd、永久占着锁。
    subprocess.run(["flock", "-o", f"/run/user/{os.getuid()}/wb-remote.lock",
                    "systemd-run", "--user", "--scope", "-q",
                    "/bin/bash", "-lc", f"WORKBENCH_NO_OPEN=1 {shlex.quote(os.path.expanduser('~/.local/bin/aireins'))} start"],
                   stdin=subprocess.DEVNULL, timeout=60)  # 不把手机连接交给子进程；挂死也有期限
    for _ in range(60):
        try:
            up = connect()
            break
        except OSError:
            time.sleep(0.25)
    else:
        sys.exit(f"AIReins 远程端口 {PORT} 未就绪")

up.settimeout(None)
down = socket.socket(fileno=0)  # Accept=yes：stdin 就是手机那条连接


def pipe(src, dst):
    # 每个方向一个线程：一侧写阻塞不耽误另一侧（如 WS 的 pong）。读完就半关闭对方的写。
    try:
        while data := src.recv(65536):
            dst.sendall(data)
        dst.shutdown(socket.SHUT_WR)
    except OSError:  # 任一侧重置：两边都关掉，让另一个线程也退出
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


t = threading.Thread(target=pipe, args=(up, down))
t.start()
pipe(down, up)
t.join()
