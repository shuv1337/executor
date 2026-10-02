#!/usr/bin/env bash
# Install trusted Linux Actions runner agents for the executor-ci-desktop label.
set -euo pipefail

repository_url="${GITHUB_REPOSITORY_URL:-https://github.com/UsefulSoftwareCo/executor-next}"
runner_label="${CI_RUNNER_LABEL:-executor-ci-desktop}"
runner_count="${CI_RUNNER_COUNT:-5}"
runner_version="${ACTIONS_RUNNER_VERSION:-2.337.0}"
runner_root="${ACTIONS_RUNNER_ROOT:-$HOME/.actions-runner/executor-next}"
service_root="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
runner_token="${GITHUB_RUNNER_TOKEN:-}"

if [[ -z "$runner_token" ]]; then
  printf 'GITHUB_RUNNER_TOKEN must contain a short-lived repository registration token.\n' >&2
  exit 2
fi
if ! [[ "$runner_count" =~ ^[1-9][0-9]*$ ]] || ((runner_count > 32)); then
  printf 'CI_RUNNER_COUNT must be between 1 and 32.\n' >&2
  exit 2
fi
if ! command -v curl >/dev/null || ! command -v tar >/dev/null; then
  printf 'curl and tar are required.\n' >&2
  exit 1
fi

if command -v pacman >/dev/null && { ! command -v ffmpeg >/dev/null || ! command -v Xvfb >/dev/null; }; then
  sudo pacman --sync --noconfirm --needed ca-certificates curl ffmpeg xorg-server-xvfb
fi

mkdir -p "$runner_root" "$service_root"
archive="actions-runner-linux-x64-${runner_version}.tar.gz"
download_url="https://github.com/actions/runner/releases/download/v${runner_version}/${archive}"

for index in $(seq 1 "$runner_count"); do
  runner_dir="$runner_root/$index"
  runner_name="rhys-desktop-ci-$index"
  service_name="executor-ci-$index.service"
  mkdir -p "$runner_dir"

  if [[ ! -x "$runner_dir/run.sh" ]]; then
    curl --fail --location --silent --show-error "$download_url" | tar --extract --gzip --file=- --directory "$runner_dir"
  fi

  "$runner_dir/config.sh" \
    --unattended \
    --replace \
    --url "$repository_url" \
    --token "$runner_token" \
    --name "$runner_name" \
    --labels "$runner_label" \
    --work _work

  cat >"$service_root/$service_name" <<EOF
[Unit]
Description=GitHub Actions runner $runner_name
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$runner_dir
ExecStart=$runner_dir/run.sh
KillMode=process
TimeoutStopSec=5min
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
done

systemctl --user daemon-reload
for index in $(seq 1 "$runner_count"); do
  systemctl --user enable --now "executor-ci-$index.service"
done

printf 'Installed %s runner agents with label %s.\n' "$runner_count" "$runner_label"
