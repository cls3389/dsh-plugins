FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils findutils grep sed gawk git jq curl ca-certificates file procps && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/
WORKDIR /workspace
