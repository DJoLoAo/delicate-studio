import re
import shutil
import time


def server_blocks(s):
    blocks, depth, i, n, start = [], 0, 0, len(s), None
    while i < n:
        c = s[i]
        if c == "#":
            j = s.find("\n", i)
            i = n if j < 0 else j
            continue
        if c in "\"'":
            j = i + 1
            while j < n and s[j] != c:
                j += 2 if s[j] == "\\" else 1
            i = j + 1
            continue
        if c == "{":
            if depth == 0 and re.search(r"(^|[\s;}])server\s*$", s[max(0, i - 40):i]):
                start = i
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0 and start is not None:
                blocks.append((start, i))
                start = None
        i += 1
    return blocks


def listens(body, port):
    out = []
    for m in re.finditer(r"^\s*listen\s+([^;#]*);", body, re.M):
        parts = m.group(1).split()
        if not parts or not re.search(r"(^|:)%d$" % port, parts[0]):
            continue
        out.append("listen " + " ".join([parts[0]] + [p for p in parts[1:] if p in ("ssl", "http2")]) + ";")
    return out


def host_block(s, host, port):
    found = []
    for a, b in server_blocks(s):
        body = s[a:b]
        if listens(body, port) and re.search(r"^\s*server_name\s+[^;#]*(?<![\w.-])%s(?![\w.-])" % re.escape(host), body, re.M):
            found.append((a, b))
    return found


def backup(path, backup_dir):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = "%s/%s.bak-%s" % (backup_dir.rstrip("/"), path.rsplit("/", 1)[-1], stamp)
    shutil.copy2(path, dest)
    return dest
