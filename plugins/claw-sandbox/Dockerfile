FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils findutils grep sed gawk git jq curl ca-certificates file procps && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/
# Limit native math worker pools to the sandbox CPU/PID budget.
ENV OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1
# Build-time package index and SOCKS5 proxy only; neither persists as runtime ENV.
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG ALL_PROXY
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
RUN env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy python -m pip install --no-cache-dir PySocks==1.7.1
RUN python -m pip install --no-cache-dir numpy==2.5.4 pandas==3.1.0 matplotlib==3.10.8
# Host-maintained programs are mounted read-only at /opt/dsh-tools at runtime.
# The user workspace is writable; the tool directory and container root are not.
ENV PATH=/opt/dsh-tools:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
# The base image includes DejaVu but no CJK font. Font discovery uses fontconfig.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
