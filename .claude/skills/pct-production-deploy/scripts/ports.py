#!/usr/bin/env python3
"""Which host ports are taken on a shared server, and is a candidate free?

Feed it the raw text of `docker ps` and/or `ss -ltnH` (pasted, or saved from a
screenshot transcription) on stdin:

    python ports.py 3050 4100 < fe_server.txt

It collects every PUBLISHED host port (`0.0.0.0:3160->80/tcp`,
`127.0.0.1:3002->3002/tcp`, `[::]:8080->80/tcp`, `172.28.80.51:4160->3100/tcp`)
and every listening port from `ss` (`0.0.0.0:80`, `[::]:443`, `*:22`).
Container-only ports (`3000/tcp` with no arrow) are NOT host ports and are
ignored - they cannot clash. Prints the taken set, then a verdict per
candidate, and the first free port at or above each taken one.
"""
import re
import sys

text = sys.stdin.read()
taken = set()
# docker ps: HOST:PORT->CONTAINER/proto (host may be 0.0.0.0, an IP, or [::])
for m in re.finditer(r"(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]*\]):(\d+)->\d+/(?:tcp|udp)", text):
    taken.add(int(m.group(1)))
# ss -ltn: LISTEN 0 511 0.0.0.0:80 0.0.0.0:*   /  [::]:443  /  *:22
for line in text.splitlines():
    if "LISTEN" in line or re.match(r"\s*(tcp|LISTEN)", line):
        for m in re.finditer(r"(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]*\]|\*):(\d+)\s", line + " "):
            taken.add(int(m.group(1)))

print("taken host ports:", " ".join(str(p) for p in sorted(taken)) or "(none found)")
for arg in sys.argv[1:]:
    want = int(arg)
    if want in taken:
        free = next(p for p in range(want, want + 200) if p not in taken)
        print(f"{want}: TAKEN - first free at or above it: {free}")
    else:
        print(f"{want}: free (in this listing - confirm with the preflight's `ss` check on the server)")
