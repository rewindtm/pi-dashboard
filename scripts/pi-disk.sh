#!/bin/bash
# Helper privilegiato per la sezione "Dischi" della dashboard.
# Viene installato come /usr/local/bin/pi-disk (root:root, 755) da scripts/setup-disks.sh
# e chiamato con `sudo -n`. Fa solo poche operazioni, su dispositivi USB/NVMe che non
# ospitano il sistema, e valida tutti gli argomenti: la dashboard non ha mai un root generico.
#
# Uso: pi-disk check
#      pi-disk mount|unmount|automount-on|automount-off <partizione>
#      pi-disk eject <disco o partizione>
#      pi-disk format <disco intero> <ext4|exfat|ntfs> [etichetta]
set -euo pipefail

BASE=/mnt/disks
FSTAB=/etc/fstab
MARK='# pi-dashboard'

die() { echo "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "manca $1: installa con 'sudo apt install $2'"; }

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

  format)
    # pi-disk format <disco intero> <ext4|exfat|ntfs> [etichetta]
    # Cancella TUTTO il disco: nuova tabella GPT con una sola partizione.
    newfs=${3:-}
    newlabel=${4:-}
    [ "$(lsblk -no TYPE "$dev" | head -1)" = disk ] || die "indica il disco intero, non una partizione"
    case "$newfs" in
      ext4)  need mkfs.ext4 e2fsprogs;  ptype=0FC63DAF-8483-4772-8E79-3D69D8477DE4 ;;
      exfat) need mkfs.exfat exfatprogs; ptype=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7 ;;
      ntfs)  need mkntfs ntfs-3g;        ptype=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7 ;;
      *) die "filesystem non supportato" ;;
    esac
    [[ $newlabel =~ ^[A-Za-z0-9_-]{0,15}$ ]] || die "etichetta non valida (max 15 caratteri: lettere, numeri, - _)"
    lsblk -nro MOUNTPOINT "$dev" | grep -q . && die "smonta prima tutte le partizioni del disco"
    lsblk -nro FSTYPE "$dev" | grep -qx swap && die "il disco contiene swap"

    # via le voci di montaggio automatico dei vecchi filesystem
    for u in $(lsblk -nro UUID "$dev"); do
      [[ $u =~ ^[A-Za-z0-9-]+$ ]] && sed -i "\#^UUID=$u .*$MARK\$#d" "$FSTAB"
    done
    for p in $(lsblk -nro PATH "$dev" | tail -n +2); do wipefs -a "$p" >/dev/null 2>&1 || true; done
    wipefs -a "$dev" >/dev/null
    printf 'label: gpt\ntype=%s\n' "$ptype" | sfdisk --quiet "$dev"
    udevadm settle
    partprobe "$dev" 2>/dev/null || true
    sleep 1; udevadm settle
    newpart=$(lsblk -nro PATH,TYPE "$dev" | awk '$2=="part"{print $1; exit}')
    [ -n "$newpart" ] || die "partizione non creata"

    lbl=()
    [ -n "$newlabel" ] && lbl=(-L "$newlabel")
    case "$newfs" in
      ext4)  mkfs.ext4 -F -q "${lbl[@]}" "$newpart" ;;
      exfat) mkfs.exfat "${lbl[@]}" "$newpart" >/dev/null ;;
      ntfs)  mkntfs -f -Q "${lbl[@]}" "$newpart" >/dev/null ;;
    esac
    systemctl daemon-reload
    echo "formattato $newpart come $newfs"
    ;;

  *)
    die "azione non valida"
    ;;
esac
