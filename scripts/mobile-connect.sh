#!/usr/bin/env bash
set -euo pipefail

# Local-only helper. It never creates a public tunnel or changes the Fabric network.
mode="${1:-emulator}"
port="${MOBILE_HOST_PORT:-3001}"
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo 'MOBILE_HOST_PORT must be from 1 to 65535' >&2
  exit 1
fi
case "$mode" in
  emulator)
    echo "In DIAS Mobile, use host address: http://10.0.2.2:$port"
    ;;
  usb)
    if ! command -v adb >/dev/null; then
      echo 'Install Android SDK Platform Tools or add platform-tools to PATH.' >&2
      exit 1
    fi
    device_args=()
    if [[ -n "${ANDROID_SERIAL:-}" ]]; then device_args=(-s "$ANDROID_SERIAL"); fi
    adb "${device_args[@]}" reverse "tcp:$port" "tcp:$port"
    echo "In DIAS Mobile, use host address: http://127.0.0.1:$port"
    ;;
  check)
    curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
      "http://127.0.0.1:$port/api/health"
    echo
    ;;
  *) echo 'Usage: scripts/mobile-connect.sh emulator|usb|check' >&2; exit 1 ;;
esac
