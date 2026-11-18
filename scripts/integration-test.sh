#!/usr/bin/env bash
# AWS Emulator を Docker で起動し、結合テスト(*.integration.test.ts)を実行する
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=9297
IMAGE=aws-emulator
CONTAINER=reptile-cage-monitor-emulator
STATE_DIR="$HOME/.aws/emulator"

case "$(uname -m)" in
  arm64|aarch64) RPM_ARCH=aarch64 ;;
  *) RPM_ARCH=x86_64 ;;
esac

docker build --build-arg "RPM_ARCH=$RPM_ARCH" -t "$IMAGE" test/integration
mkdir -p "$STATE_DIR"

# Linux ではコンテナ内のファイルをホストのユーザー権限で作らせる
user_args=()
if [ "$(uname -s)" = "Linux" ]; then
  user_args=(--user "$(id -u):$(id -g)")
fi

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" --memory=2g --memory-swap=2g \
  "${user_args[@]}" \
  -p "127.0.0.1:$PORT:$PORT" \
  -e HOME="$HOME" -v "$STATE_DIR:$STATE_DIR" \
  "$IMAGE" -p "$PORT" --telemetry off >/dev/null

CA="$STATE_DIR/$PORT/ca.pem"
for _ in $(seq 1 60); do
  if [ -f "$CA" ] && curl -fsS --cacert "$CA" "https://127.0.0.1:$PORT/__admin/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "${ready:-0}" != 1 ]; then
  echo "AWS Emulator did not become healthy" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi

export AWS_ENDPOINT_URL="https://127.0.0.1:$PORT"
export AWS_SHARED_CREDENTIALS_FILE="$STATE_DIR/$PORT/emulator_credentials"
export AWS_CONFIG_FILE="$STATE_DIR/$PORT/config"
export NODE_EXTRA_CA_CERTS="$CA"
export AWS_EC2_METADATA_DISABLED=true
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE

pnpm exec vitest run --config vitest.integration.config.ts "$@"
