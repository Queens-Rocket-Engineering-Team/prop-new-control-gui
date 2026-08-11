#!/usr/bin/env bash
set -euo pipefail

# Ensure script runs relative to project root
cd "$(dirname "$0")/.."

# Configuration
VENV_DIR=".venv-flatpak-tools"
TOOLS_DIR=".flatpak-builder-tools"
REPO_URL="https://github.com/flatpak/flatpak-builder-tools.git"

for cmd in git python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: Required command '$cmd' is not installed." >&2
    exit 1
  fi
done

# 2. Sync flatpak-builder-tools
if [ ! -d "${TOOLS_DIR}" ]; then
  echo "Cloning flatpak-builder-tools..."
  git clone --depth 1 "${REPO_URL}" "${TOOLS_DIR}"
else
  echo "Updating flatpak-builder-tools..."
  git -C "${TOOLS_DIR}" fetch --depth 1
  git -C "${TOOLS_DIR}" reset --hard FETCH_HEAD
fi

# 3. Setup / sync virtual environment
if [ ! -d "${VENV_DIR}" ]; then
  echo "Creating virtual environment in ${VENV_DIR}..."
  python3 -m venv "${VENV_DIR}"
  "${VENV_DIR}/bin/python3" -m pip install --upgrade pip
fi

echo "Syncing generator dependencies..."
"${VENV_DIR}/bin/python3" -m pip install -e "${TOOLS_DIR}/node" \
  "aiohttp<4.0.0,>=3.9.5" \
  "PyYAML<7.0.0,>=6.0.2" \
  "tomlkit>=0.13.3,<1.0" >/dev/null

# 4. Prepare target directory
mkdir -p flatpak
rm -f flatpak/node-sources.json flatpak/cargo-sources.json

# 5. Generate manifests
echo "Generating flatpak/node-sources.json..."
"${VENV_DIR}/bin/flatpak-node-generator" npm package-lock.json -o flatpak/node-sources.json

echo "Generating flatpak/cargo-sources.json..."
"${VENV_DIR}/bin/python3" "${TOOLS_DIR}/cargo/flatpak-cargo-generator.py" src-tauri/Cargo.lock -o flatpak/cargo-sources.json

echo "Flatpak source manifests successfully generated."