#!/bin/sh
# Génère pour nginx (module real_ip) la liste des adresses Cloudflare, à partir des listes officielles.
#
# Usage : sudo ./update-cloudflare-ips.sh [fichier-de-sortie]   (défaut : /etc/nginx/cloudflare-realip.conf)
# Ces adresses changent rarement : relancer de temps en temps (voir le README pour une tâche cron).
set -eu

OUT="${1:-/etc/nginx/cloudflare-realip.conf}"
V4_URL="${CF_IPS_V4_URL:-https://www.cloudflare.com/ips-v4}"
V6_URL="${CF_IPS_V6_URL:-https://www.cloudflare.com/ips-v6}"

TMP="$(mktemp)"
PART="$(mktemp)"
trap 'rm -f "$TMP" "$PART"' EXIT

{
  echo "# Généré par update-cloudflare-ips.sh le $(date -u +%Y-%m-%d) - ne pas modifier à la main."
} > "$TMP"

for url in "$V4_URL" "$V6_URL"; do
  curl -fsS --max-time 20 "$url" -o "$PART"
  # Seules des plages d'adresses valides entrent dans la configuration nginx : rien d'autre.
  tr -d '\r' < "$PART" | grep -E '^[0-9a-fA-F:.]+/[0-9]{1,3}$' | sed 's/^/set_real_ip_from /; s/$/;/' >> "$TMP" || true
done
echo "real_ip_header CF-Connecting-IP;" >> "$TMP"

count="$(grep -c '^set_real_ip_from' "$TMP" || true)"
if [ "${count:-0}" -lt 5 ]; then
  echo "Liste Cloudflare suspecte (${count:-0} plages) : $OUT laissé inchangé." >&2
  exit 1
fi

chmod 644 "$TMP"
mv "$TMP" "$OUT"
echo "$count plages Cloudflare écrites dans $OUT"

if [ "${NGINX_RELOAD:-1}" = "1" ]; then
  nginx -t && nginx -s reload
fi
