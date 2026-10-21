import os
import re
import sys

from nginxconf import backup, host_block, listens

HOST = "studio.delicateaudio.com"
args = sys.argv[1:] + [None] * 6
conf = args[0] or "/etc/nginx/sites-available/" + HOST
enabled = args[1] or "/etc/nginx/sites-enabled/" + HOST
live = (args[2] or "/etc/letsencrypt/live/" + HOST).rstrip("/")
dj = args[3] or "/etc/nginx/sites-available/dj.delicateaudio.com"
webroot = (args[4] or "/var/www/certbot").rstrip("/")
backup_dir = args[5] or "/root"

PROXY = """proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;"""

SSL_EXTRA = r"^\s*((include\s+/etc/letsencrypt/[^;#]+|ssl_dhparam\s+[^;#]+|ssl_protocols\s+[^;#]+|ssl_ciphers\s+[^;#]+|ssl_prefer_server_ciphers\s+[^;#]+|ssl_session_\w+\s+[^;#]+|http2\s+on)\s*);"

l80, l443, extra = ["listen 80;"], ["listen 443 ssl;"], []
if os.path.exists(dj):
    s = open(dj).read()
    b80, b443 = host_block(s, "dj.delicateaudio.com", 80), host_block(s, "dj.delicateaudio.com", 443)
    if b80:
        l80 = listens(s[b80[0][0]:b80[0][1]], 80)
    if b443:
        body = s[b443[0][0]:b443[0][1]]
        l443 = listens(body, 443)
        extra = [m.group(1).strip() + ";" for m in re.finditer(SSL_EXTRA, body, re.M)]
else:
    print("note: %s not found, using plain listen lines" % dj)


def block(lines, indent):
    return "".join(indent + line + "\n" for line in lines)


def proxied(path, upstream, more=()):
    return "    location %s {\n        proxy_pass %s;\n%s%s    }\n" % (path, upstream, block(PROXY.splitlines(), "        "), block(more, "        "))


http = "server {\n%s    server_name %s;\n\n    location /.well-known/acme-challenge/ {\n        root %s;\n    }\n\n    location / {\n        return 301 https://$host$request_uri;\n    }\n}\n" % (block(l80, "    "), HOST, webroot)

has_cert = os.path.exists(live + "/fullchain.pem") and os.path.exists(live + "/privkey.pem")
out = http
if has_cert:
    out += "\nserver {\n%s%s    server_name %s;\n\n    ssl_certificate %s/fullchain.pem;\n    ssl_certificate_key %s/privkey.pem;\n\n" % (block(l443, "    "), block(extra, "    "), HOST, live, live)
    out += proxied("^~ /api/studio/", "http://127.0.0.1:4541") + "\n"
    out += proxied("^~ /api/locker/", "http://127.0.0.1:4540", ["client_max_body_size 70m;", "proxy_read_timeout 600s;"]) + "\n"
    out += proxied("^~ /api/", "http://127.0.0.1:4540", ["proxy_buffering off;", "proxy_read_timeout 3600s;"]) + "\n"
    out += proxied("/", "http://127.0.0.1:4541") + "}\n"

if os.path.exists(conf) and open(conf).read() == out:
    print("%s already up to date" % conf)
else:
    if os.path.exists(conf):
        print("backup:", backup(conf, backup_dir))
    os.makedirs(webroot, exist_ok=True)
    with open(conf, "w") as f:
        f.write(out)
    print("wrote", conf, "(http and https)" if has_cert else "(http only, for the certificate)")

if not os.path.lexists(enabled):
    os.symlink(conf, enabled)
    print("enabled:", enabled)
elif os.path.realpath(enabled) != os.path.realpath(conf):
    print("warning: %s exists and points elsewhere, left as it is" % enabled)

print()
print(out)
if not has_cert:
    print("next: nginx -t && systemctl reload nginx, then certbot certonly --webroot -w %s -d %s, then run this script again" % (webroot, HOST))
else:
    print("next: nginx -t && systemctl reload nginx")
