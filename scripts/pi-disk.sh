#!/bin/bash
# Helper privilegiato per la sezione "Dischi" della dashboard.
# Viene installato come /usr/local/bin/pi-disk (root:root, 755) da scripts/setup-disks.sh
# e chiamato con `sudo -n`. Fa solo poche operazioni, su dispositivi USB/NVMe che non
# ospitano il sistema, e valida tutti gli argomenti: la dashboard non ha mai un root generico.
#
# Uso: pi-disk check
#      pi-disk mount|unmount|automount-on|automount-off <partizione>
#      pi-disk eject <disco o partizione>
set -euo pipefail

BASE=/mnt/disks
FSTAB=/etc/fstab
MARK='# pi-dashboard'

die() { echo "$*" >&2; exit 1; }

action=${1:-}
dev=${2:-}

if [ "$action" = check ]; then echo ok; exit 0; fi

[[ $dev =~ ^/dev/(sd[a-z]+[0-9]*|nvme[0-9]+n[0-9]+(p[0-9]+)?)$ ]] || die "dispositivo non valido"
[ -b "$dev" ] || die "dispositivo non trovato"

disk=$(lsblk -no pkname "$dev" | head -1)
[ -n "$disk" ] || disk=$(basename "$dev")

# Mai toccare un disco che contiene il sistema operativo.
if lsblk -nro MOUNTPOINT "/dev/$disk" | grep -qE '^(/|/boot.*)$'; then
  die "disco di sistema: operazione non consentita"
fi

owner=${SUDO_UID:-1000}
group=${SUDO_GID:-1000}

fstype=$(lsblk -no FSTYPE "$dev" | head -1)
uuid=$(lsblk -no UUID "$dev" | head -1)
label=$(lsblk -no LABEL "$dev" | head -1)

mount_name() {
  local n
  n=$(printf '%s' "${label:-$uuid}" | tr -c 'A-Za-z0-9._-' '_')
  echo "${n:-disk}"
}

# Tipo di filesystem e opzioni di mount (le stesse per mount manuale e fstab).
fs_setup() {
  case "$fstype" in
    ntfs)  FS_TYPE=ntfs-3g; FS_OPTS="uid=$owner,gid=$group,umask=022,windows_names" ;;
    exfat) FS_TYPE=exfat;   FS_OPTS="uid=$owner,gid=$group,umask=022" ;;
    vfat)  FS_TYPE=vfat;    FS_OPTS="uid=$owner,gid=$group,umask=022" ;;
    ext2|ext3|ext4|btrfs|xfs) FS_TYPE=$fstype; FS_OPTS=defaults ;;
    '')    die "nessun filesystem riconosciuto su $dev" ;;
    *)     die "filesystem non supportato: $fstype" ;;
  esac
}

case "$action" in
  mount)
    fs_setup
    findmnt -rn -S "$dev" >/dev/null && die "già montato"
    target="$BASE/$(mount_name)"
    mountpoint -q "$target" && target="$target-$(basename "$dev")"
    mkdir -p "$target"
    if ! mount -t "$FS_TYPE" -o "$FS_OPTS" "$dev" "$target"; then
      rmdir "$target" 2>/dev/null || true
      die "mount fallito"
    fi
    echo "$target"
    ;;

  unmount)
    mp=$(findmnt -rn -S "$dev" -o TARGET | head -1)
    [ -n "$mp" ] || die "non è montato"
    umount "$dev" || die "impossibile smontare: qualcosa lo sta usando"
    case "$mp" in "$BASE"/*) rmdir "$mp" 2>/dev/null || true ;; esac
    echo "smontato"
    ;;

  eject)
    [[ $disk == sd* ]] || die "rimozione sicura supportata solo per dischi USB/SATA"
    if lsblk -nro MOUNTPOINT "/dev/$disk" | grep -q .; then
      die "smonta prima tutte le partizioni del disco"
    fi
    sync
    echo 1 > "/sys/block/$disk/device/delete"
    echo "disco scollegato, puoi staccarlo"
    ;;

  automount-on)
    fs_setup
    [[ $uuid =~ ^[A-Za-z0-9-]+$ ]] || die "il disco non ha un UUID"
    target="$BASE/$(mount_name)"
    cp -n "$FSTAB" "$FSTAB.pidashboard.bak"
    sed -i "\#^UUID=$uuid .*$MARK\$#d" "$FSTAB"
    # nofail + timeout: se il disco non c'è il Pi parte lo stesso.
    echo "UUID=$uuid $target $FS_TYPE $FS_OPTS,nofail,x-systemd.device-timeout=10 0 0 $MARK" >> "$FSTAB"
    mkdir -p "$target"
    systemctl daemon-reload
    echo "montaggio automatico attivo"
    ;;

  automount-off)
    [[ $uuid =~ ^[A-Za-z0-9-]+$ ]] || die "il disco non ha un UUID"
    sed -i "\#^UUID=$uuid .*$MARK\$#d" "$FSTAB"
    systemctl daemon-reload
    echo "montaggio automatico disattivato"
    ;;

  *)
    die "azione non valida"
    ;;
esac
