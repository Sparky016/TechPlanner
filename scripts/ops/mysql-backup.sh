#!/bin/sh
# Nightly logical backup of the TechPlanner database (docs/runbook.md §8).
#
#   mysqldump --single-transaction --routines --triggers | gzip  ->  $BACKUP_DIR/techplanner-<UTC timestamp>.sql.gz
#
# Exits non-zero (and removes the partial file) on any failure, so cron can mail or log it. Keeps BACKUP_KEEP_DAYS
# days of dumps. Copying the dumps off the host is a separate step (runbook §8).
#
# Credentials come from a MySQL option file, never the command line: BACKUP_DEFAULTS_FILE (default
# /etc/techplanner/backup.cnf, mode 600, owned by the user that runs this script):
#   [client]
#   user = techplanner_backup
#   password = <generated>
#   host = localhost   (Unix socket: matches 'techplanner_backup'@'localhost' even with skip_name_resolve)
#
# Backup user grants (create once as root; see runbook §8.1):
#   CREATE USER 'techplanner_backup'@'localhost' IDENTIFIED BY '<generated>';
#   GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES ON techplanner.* TO 'techplanner_backup'@'localhost';
#   GRANT PROCESS ON *.* TO 'techplanner_backup'@'localhost';
#
# Environment: BACKUP_DIR (default /var/backups/techplanner), BACKUP_KEEP_DAYS (14), BACKUP_DB (techplanner),
# BACKUP_DEFAULTS_FILE.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/var/backups/techplanner}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
BACKUP_DB=${BACKUP_DB:-techplanner}
BACKUP_DEFAULTS_FILE=${BACKUP_DEFAULTS_FILE:-/etc/techplanner/backup.cnf}

case "$BACKUP_KEEP_DAYS" in
  '' | *[!0-9]*) echo "mysql-backup: BACKUP_KEEP_DAYS must be a whole number" >&2; exit 64 ;;
esac
if [ ! -r "$BACKUP_DEFAULTS_FILE" ]; then
  echo "mysql-backup: cannot read $BACKUP_DEFAULTS_FILE" >&2
  exit 66
fi

umask 077
mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$BACKUP_DIR/techplanner-$stamp.sql.gz"
partial="$final.partial"
status="$BACKUP_DIR/.mysqldump-status.$$"
trap 'rm -f "$partial" "$status"' EXIT

# POSIX sh has no pipefail: record mysqldump's own exit status separately from gzip's.
{
  mysqldump --defaults-extra-file="$BACKUP_DEFAULTS_FILE" --single-transaction --routines --triggers \
    --set-gtid-purged=OFF --no-tablespaces "$BACKUP_DB" || echo "$?" > "$status"
} | gzip -c > "$partial"

if [ -s "$status" ]; then
  echo "mysql-backup: mysqldump failed (exit $(cat "$status"))" >&2
  exit 1
fi
gzip -t "$partial"
mv "$partial" "$final"

find "$BACKUP_DIR" -maxdepth 1 -name 'techplanner-*.sql.gz' -type f -mtime "+$BACKUP_KEEP_DAYS" -delete
echo "mysql-backup: wrote $final"
