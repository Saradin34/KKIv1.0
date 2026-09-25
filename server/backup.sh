#!/bin/sh
# =====================================================================
#  Ежедневный бэкап «Эхо-Цитадель» (docker-compose → service `backup`)
#  Что бэкапим:
#    1) PostgreSQL: БД echo_citadel (профили, коллекции, матчи, лор)
#    2) meta-snapshot.json — снапшот in-memory состояния meta-server
#    3) accounts.json — аккаунты (scrypt-хэши)
#  Ротация: держим7 дней (*.gz старше7 дней удаляются).
#  Восстановление БД:
#    gunzip -c backups/db_2026-09-24-0300.sql.gz | psql -h db -U echo echo_citadel
#  Восстановление снапшота: положить snapshot.json обратно в volume `metadata`.
# =====================================================================
set -e
STAMP=$(date +%F-%H%M)
mkdir -p /backups

#1) PostgreSQL
if pg_dump -h db -U echo -d echo_citadel -f - 2>/dev/null | gzip > "/backups/db_${STAMP}.sql.gz"; then
  echo "[backup] db_${STAMP}.sql.gz ok"
else
  echo "[backup] db dump failed (db ещё не готова?)" >&2
  rm -f "/backups/db_${STAMP}.sql.gz"
fi

#2) снапшот meta-server + аккаунты (volume metadata, монтируется :ro)
[ -f /metadata/snapshot.json ] && gzip -c /metadata/snapshot.json > "/backups/meta_snapshot_${STAMP}.json.gz" \
  && echo "[backup] meta_snapshot_${STAMP}.json.gz ok"
[ -f /metadata/accounts.json ] && gzip -c /metadata/accounts.json > "/backups/accounts_${STAMP}.json.gz" \
  && echo "[backup] accounts_${STAMP}.json.gz ok"

#3) ротация7 дней
find /backups -maxdepth 1 -type f -name '*.gz' -mtime +7 -delete
echo "[backup] готово: $(ls -1 /backups | wc -l) файлов в /backups"
