#!/bin/zsh
# fold-relay.sh — publish the open link (`opencode link`) at a domain you already run, with no DNS change.
#
# The Mac holds one ssh connection to a VM that forwards a loopback port there back to the local server; the VM's nginx
# publishes an existing hostname (default bcc.hyphae.social, a retired site that already has DNS and a certificate)
# and forwards it to that port. See packages/cli/src/services/relay-tunnel.ts.
#
#   fold-relay.sh plan        print everything below without changing anything
#   fold-relay.sh key         Mac: make a locked-down ssh key, add the ssh alias, set the relay in the service config
#   fold-relay.sh install     VM: add the restricted login and publish the hostname (backs up what it replaces)
#   fold-relay.sh status      read-only: the VM's side of it
#   fold-relay.sh uninstall   VM: put the hostname back as it was and remove the login
#
# Overrides: RELAY_ADMIN (ssh alias with sudo, default hyphae), RELAY_ALIAS (alias made for the tunnel, default
# hyphae-link), RELAY_HOST (hostname, default bcc.hyphae.social), RELAY_PORT (VM loopback port, default 49700),
# RELAY_USER (restricted login on the VM, default oclink), RELAY_KEY (default ~/.ssh/openfold-link).
set -eu

ADMIN=${RELAY_ADMIN:-hyphae}
ALIAS=${RELAY_ALIAS:-hyphae-link}
HOST=${RELAY_HOST:-bcc.hyphae.social}
PORT=${RELAY_PORT:-49700}
RUSER=${RELAY_USER:-oclink}
KEY=${RELAY_KEY:-$HOME/.ssh/openfold-link}
VHOST=/etc/nginx/sites-available/${HOST%%.*}
BACKUP=$VHOST.pre-openfold

# The nginx file for the hostname. Only the link and a browser that already signed in through it reach the server; every
# other visitor, and everyone while the link is off, gets a 410.
vhost() {
  cat <<NGINX
# Published by fold-relay.sh. A reverse ssh forward from a Mac lands on 127.0.0.1:$PORT while its open link is on.
# The previous file is at $BACKUP.
map \$http_upgrade \$oc_connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $HOST;
    ssl_certificate /etc/letsencrypt/live/$HOST/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$HOST/privkey.pem;

    default_type text/plain;
    client_max_body_size 64m;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$oc_connection_upgrade;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    # The link itself: the code in the path is the secret, and the server checks it.
    # The code is a credential, so the request line is kept out of the access log.
    location ^~ /auth/connect/ { access_log off; proxy_pass http://127.0.0.1:$PORT; }

    # Everything else needs the session cookie the link sets, so a visitor without one sees nothing of the app.
    location / {
        if (\$cookie_opencode_session = "") { return 410 "This link is off.\n"; }
        proxy_pass http://127.0.0.1:$PORT;
    }

    # No forward behind it: the link is off, or the Mac is asleep. A request that lands here is logged by this location,
    # not the one it came from, so this one stays out of the log too or the code in /auth/connect/ would be in it.
    error_page 502 503 504 = @off;
    location @off { access_log off; return 410 "This link is off.\n"; }
}
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    location / { default_type text/plain; return 410 "This link is off.\n"; }
}
NGINX
}

# What runs on the VM, as root. The public key arrives as \$1.
remote_install() {
  cat <<'SH'
set -eu
PUBKEY="$1"; RUSER="$2"; PORT="$3"; VHOST="$4"; BACKUP="$5"; NEWFILE="$6"
if ! id "$RUSER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$RUSER" --shell /usr/sbin/nologin "$RUSER"
  # A password field of * (not the locked !) lets sshd accept the key and nothing else.
  usermod -p '*' "$RUSER"
fi
install -d -m 700 -o "$RUSER" -g "$RUSER" "/home/$RUSER/.ssh"
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s" %s\n' "$PORT" "$PUBKEY" > "/home/$RUSER/.ssh/authorized_keys"
chown "$RUSER:$RUSER" "/home/$RUSER/.ssh/authorized_keys"; chmod 600 "/home/$RUSER/.ssh/authorized_keys"
[ -e "$BACKUP" ] || cp -p "$VHOST" "$BACKUP"
cp -p "$VHOST" "$VHOST.rollback"
install -m 644 "$NEWFILE" "$VHOST"
if nginx -t 2>/tmp/relay-nginx-test; then
  systemctl reload nginx
  rm -f "$VHOST.rollback" "$NEWFILE"
  echo "published: nginx reloaded"
else
  cat /tmp/relay-nginx-test >&2
  cp -p "$VHOST.rollback" "$VHOST"; rm -f "$VHOST.rollback"
  echo "nginx rejected the file; the previous one is back and nothing was reloaded" >&2
  exit 1
fi
SH
}

remote_uninstall() {
  cat <<'SH'
set -eu
RUSER="$1"; VHOST="$2"; BACKUP="$3"
if [ -e "$BACKUP" ]; then cp -p "$BACKUP" "$VHOST" && nginx -t && systemctl reload nginx && echo "restored $VHOST"; fi
if id "$RUSER" >/dev/null 2>&1; then userdel -r "$RUSER" 2>/dev/null || userdel "$RUSER"; echo "removed $RUSER"; fi
SH
}

case "${1:-plan}" in
  plan)
    echo "== Mac (key): ssh-keygen -t ed25519 -N '' -f $KEY   +   Host $ALIAS in ~/.ssh/config   +   opencode service set relay $ALIAS,https://$HOST,$PORT"
    echo "== VM ($ADMIN, sudo): user $RUSER (nologin, key restricted to 127.0.0.1:$PORT), nginx file $VHOST (backup $BACKUP), nginx -t, reload"
    echo; echo "--- $VHOST would become:"; vhost
    ;;
  key)
    [ -e "$KEY" ] || ssh-keygen -t ed25519 -N '' -C openfold-link -f "$KEY" >/dev/null
    if ! grep -q "^Host $ALIAS\$" ~/.ssh/config 2>/dev/null; then
      ADDR=$(ssh -G "$ADMIN" | awk '$1=="hostname"{print $2}')
      printf '\nHost %s\n    HostName %s\n    User %s\n    IdentityFile %s\n    IdentitiesOnly yes\n' "$ALIAS" "$ADDR" "$RUSER" "$KEY" >> ~/.ssh/config
    fi
    echo "key: $KEY.pub"; echo "alias: $ALIAS"
    echo "next: fold-relay.sh install, then: opencode service set relay $ALIAS,https://$HOST,$PORT"
    ;;
  install)
    [ -e "$KEY.pub" ] || { echo "run fold-relay.sh key first" >&2; exit 1; }
    TMP=$(ssh "$ADMIN" mktemp)
    vhost | ssh "$ADMIN" "cat > $TMP"
    remote_install | ssh "$ADMIN" "sudo -n bash -s -- '$(cat "$KEY.pub")' '$RUSER' '$PORT' '$VHOST' '$BACKUP' '$TMP'"
    ;;
  status)
    ssh "$ADMIN" "sudo -n nginx -t 2>&1 | tail -1; id $RUSER 2>&1 | head -1; sudo -n head -c 80 $VHOST; echo; ss -ltnH 'sport = :$PORT' | wc -l | sed 's/^/forward listening (0=no): /'"
    ;;
  uninstall)
    remote_uninstall | ssh "$ADMIN" "sudo -n bash -s -- '$RUSER' '$VHOST' '$BACKUP'"
    ;;
  *) sed -n 2,18p "$0"; exit 2 ;;
esac
