#!/bin/sh
# Build-time dependency egress only; the resulting user sandbox remains offline.
set -eu
cd "$(dirname "$0")"
: "${SANDBOX_PROXY_HOST:=192.168.5.254}"
: "${SANDBOX_PROXY_PORT:=1081}"
case "$SANDBOX_PROXY_PORT" in 1081|1082|1083|1084|1085|1086) ;; *) echo 'Allowed build proxy ports: 1081-1086' >&2; exit 2;; esac
# Host networking is restricted to the Docker build phase so RUN steps can
# reach the LAN SOCKS5 endpoint. No proxy is persisted in the final image.
export ALL_PROXY="socks5h://$SANDBOX_PROXY_HOST:$SANDBOX_PROXY_PORT"
export all_proxy=$ALL_PROXY
export HTTPS_PROXY=$ALL_PROXY HTTP_PROXY=$ALL_PROXY
export https_proxy=$ALL_PROXY http_proxy=$ALL_PROXY
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy=$NO_PROXY
export DOCKER_BUILDKIT=1
# apt and Python both honor ALL_PROXY; curl-based tooling honors HTTPS_PROXY.
docker build --network host --build-arg ALL_PROXY="$ALL_PROXY" --build-arg HTTP_PROXY="$HTTP_PROXY" --build-arg HTTPS_PROXY="$HTTPS_PROXY" --build-arg NO_PROXY="$NO_PROXY" --build-arg PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}" -t "${SANDBOX_IMAGE:-dsh-user-sandbox:bookworm}" .
printf 'Built %s via build-only SOCKS5 port %s; no runtime proxy configured.\n' "${SANDBOX_IMAGE:-dsh-user-sandbox:bookworm}" "$SANDBOX_PROXY_PORT"
