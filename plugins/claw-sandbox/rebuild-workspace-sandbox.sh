#!/bin/sh
# Atomically replace one managed offline user sandbox after an image update.
# The old name is retained for a live provider's cache; never stop the DSH service.
set -eu
workspace=${1:?absolute workspace required}
old=${2:?existing managed sandbox required}
image=dsh-user-sandbox:bookworm
case "$workspace" in /data/dsh/home/agents/*/users/*|/home/lin/dsh/home/agents/*/users/*) ;; *) echo 'Refusing non-user workspace' >&2; exit 2;; esac
case "$old" in dsh-user-*) ;; *) echo 'Refusing unmanaged container name' >&2; exit 2;; esac
workspace=$(realpath "$workspace")
[ "$(docker inspect "$old" --format '{{range .Mounts}}{{if eq .Destination "/opt/dsh-tools"}}{{else}}{{.Source}}:{{.Destination}}{{end}}{{end}}')" = "$workspace:$workspace" ] || { echo 'Existing workspace mount mismatch' >&2; exit 1; }
uid=$(stat -c %u "$workspace"); gid=$(stat -c %g "$workspace")
new="${old}-next"
tools_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/tools
docker rm -f "$new" >/dev/null 2>&1 || true
cleanup() { docker rm -f "$new" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --detach --name "$new" --network none --read-only --user "$uid:$gid" \
  --tmpfs /tmp:rw,nosuid,size=64m,mode=1777 --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 128 --memory 1g --memory-swap 1g --cpus 1 \
  --env "HOME=$workspace" --env "TMPDIR=$workspace/.tmp" \
  --volume "$workspace:$workspace" --workdir "$workspace" \
  --volume "$tools_dir:/opt/dsh-tools:ro" "$image" \
  sh -c 'mkdir -p "$TMPDIR" && exec sleep infinity' >/dev/null
docker exec "$new" market-analysis --help >/dev/null
docker exec "$new" python3 -c 'import numpy,pandas,matplotlib; print("analysis dependencies ready")'
docker exec "$new" sh -c 'test "$(stat -c %u "$HOME")" = "$(id -u)" && test -w "$HOME" && test ! -w /opt/dsh-tools'
new_id=$(docker inspect "$new" --format '{{.Image}}')
image_id=$(docker image inspect "$image" --format '{{.Id}}')
[ "$new_id" = "$image_id" ] || { echo 'Image verification failed' >&2; exit 1; }
# Rename the old container aside first; then move the verified new container
# into the exact name already cached by the live provider. No missing-name gap.
docker rename "$old" "${old}-old" >/dev/null
if ! docker rename "$new" "$old"; then
  docker rename "${old}-old" "$old" >/dev/null
  exit 1
fi
trap - EXIT INT TERM
docker rm -f "${old}-old" >/dev/null
printf 'Replaced %s with verified image %s and read-only host tools.\n' "$old" "$image_id"
