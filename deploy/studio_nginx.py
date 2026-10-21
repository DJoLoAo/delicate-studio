import re
import shutil
import sys
import time

path = sys.argv[1] if len(sys.argv) > 1 else "/etc/nginx/sites-available/dj.delicateaudio.com"
backup_dir = sys.argv[2] if len(sys.argv) > 2 else "/root"

BLOCK = """location = /studio {
    return 301 /studio/;
}

location ^~ /studio/ {
    proxy_pass http://127.0.0.1:4541;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
"""


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


s = open(path).read()
if "location ^~ /studio/" in s:
    print("studio location already present, nothing changed")
    sys.exit(0)

targets = []
for a, b in server_blocks(s):
    body = s[a:b]
    if re.search(r"^\s*listen\s+[^;#]*443", body, re.M) and re.search(r"^\s*server_name\s+[^;#]*\bdj\.delicateaudio\.com\b", body, re.M):
        targets.append((a, b))
assert len(targets) == 1, "expected exactly one 443 server block for dj.delicateaudio.com, found %d" % len(targets)
a, b = targets[0]
body = s[a:b]

m = re.search(r"^([ \t]*)location\s", body, re.M)
if m:
    at = a + m.start()
    indent = m.group(1)
else:
    at = b
    indent = "    "
    while at > a and s[at - 1] in " \t":
        at -= 1

insert = "".join((indent + line if line else "") + "\n" for line in BLOCK.splitlines()) + "\n"
out = s[:at] + insert + s[at:]
assert out.count("location ^~ /studio/") == 1

stamp = time.strftime("%Y%m%d-%H%M%S")
backup = "%s/%s.bak-%s" % (backup_dir.rstrip("/"), path.rsplit("/", 1)[-1], stamp)
shutil.copy2(path, backup)
with open(path, "w") as f:
    f.write(out)
print("backup:", backup)
print("inserted into the 443 server block:")
print(insert)
