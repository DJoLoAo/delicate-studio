import re
import sys

from nginxconf import backup, host_block

args = sys.argv[1:] + [None] * 3
path = args[0] or "/etc/nginx/sites-available/dj.delicateaudio.com"
backup_dir = args[1] or "/root"
legacy = args[2] or "/opt/delicate-studio/deploy/legacy-sw.js"

BLOCK = """location = /studio {
    return 301 https://studio.delicateaudio.com/;
}

location = /studio/sw.js {
    alias %s;
    add_header Cache-Control "no-cache";
}

location ^~ /studio/ {
    rewrite ^/studio/(.*)$ https://studio.delicateaudio.com/$1 permanent;
}
""" % legacy

s = open(path).read()
targets = host_block(s, "dj.delicateaudio.com", 443)
assert len(targets) == 1, "expected exactly one 443 server block for dj.delicateaudio.com, found %d" % len(targets)
a, b = targets[0]
body = s[a:b]
if "https://studio.delicateaudio.com/" in body:
    print("redirect already present, nothing changed")
    sys.exit(0)

old = list(re.finditer(r"^[ \t]*location\s*(=\s*/studio|\^~\s*/studio/)\s*\{[^{}]*\}[ \t]*\n(?:[ \t]*\n)?", body, re.M))
if old:
    at = old[0].start()
    indent = re.match(r"[ \t]*", body[at:]).group(0)
    for m in reversed(old):
        body = body[:m.start()] + body[m.end():]
else:
    m = re.search(r"^([ \t]*)location\s", body, re.M)
    at, indent = (m.start(), m.group(1)) if m else (len(body.rstrip(" \t")), "    ")

insert = "".join((indent + line if line else "") + "\n" for line in BLOCK.splitlines()) + "\n"
body = body[:at] + insert + body[at:]
out = s[:a] + body + s[b:]
assert out.count("https://studio.delicateaudio.com/$1") == 1
assert "proxy_pass http://127.0.0.1:4541" not in out[a:a + len(body)]

print("backup:", backup(path, backup_dir))
with open(path, "w") as f:
    f.write(out)
print("removed %d old /studio location block(s), inserted:" % len(old))
print(insert)
print("next: nginx -t && systemctl reload nginx")
