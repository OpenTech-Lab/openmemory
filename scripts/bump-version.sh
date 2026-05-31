#!/bin/bash

# Usage: ./scripts/bump-version.sh [<version>] [--force] [--no-tag] [--no-push] [--tag-only]
# Example: ./scripts/bump-version.sh          # auto-increments patch
#          ./scripts/bump-version.sh 1.1.9
#          ./scripts/bump-version.sh 0.1.0 --force
#          ./scripts/bump-version.sh --tag-only  # tag current version without file changes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVER_CARGO="${PROJECT_ROOT}/apps/server/Cargo.toml"
WEB_PKG="${PROJECT_ROOT}/apps/web/package.json"
VERSION_DIR="${PROJECT_ROOT}/version"

INPUT_VERSION=""
FORCE=false
CREATE_TAG=true
PUSH_CHANGES=true
TAG_ONLY=false

usage() {
  cat <<'EOF'
Usage: ./scripts/bump-version.sh [<version>] [--force] [--no-tag] [--no-push] [--tag-only]

Arguments:
  <version>   Semantic version to release (e.g. 1.2.3)

Options:
  --force     Allow releasing a version not greater than the current one
  --no-tag    Skip creating the git tag
  --no-push   Skip pushing branch and tag
  --tag-only  Tag the current version and push without modifying any files
  -h, --help  Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)   FORCE=true ;;
    --no-tag)  CREATE_TAG=false ;;
    --no-push) PUSH_CHANGES=false ;;
    --tag-only) TAG_ONLY=true ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "Error: unknown option '$1'"
      usage; exit 1
      ;;
    *)
      if [ -n "${INPUT_VERSION}" ]; then
        echo "Error: multiple versions provided"; usage; exit 1
      fi
      INPUT_VERSION="$1"
      ;;
  esac
  shift
done

CURRENT_VERSION="$(grep '^version = ' "${SERVER_CARGO}" | head -n1 | sed -E 's/version = "([^"]+)"/\1/')"

if [ "${TAG_ONLY}" = "true" ]; then
  TAG_NAME="v${CURRENT_VERSION}"
  if git -C "${PROJECT_ROOT}" rev-parse "${TAG_NAME}" >/dev/null 2>&1; then
    echo "Error: tag ${TAG_NAME} already exists."
    exit 1
  fi
  git -C "${PROJECT_ROOT}" tag -a "${TAG_NAME}" -m "Release ${TAG_NAME}"
  echo "✓ Created tag: ${TAG_NAME}"
  if [ "${PUSH_CHANGES}" = "true" ]; then
    git -C "${PROJECT_ROOT}" push origin "${TAG_NAME}"
    echo "✓ Pushed ${TAG_NAME}"
  fi
  echo ""; echo "Done! Tagged current version as ${TAG_NAME}"
  exit 0
fi

semver_gt() {
  local IFS=.
  local a=($1) b=($2)
  for i in 0 1 2; do
    local av="${a[$i]:-0}" bv="${b[$i]:-0}"
    if (( av > bv )); then return 0; fi
    if (( av < bv )); then return 1; fi
  done
  return 1
}

LATEST_VERSION="${CURRENT_VERSION}"
LATEST_TAG="$(git -C "${PROJECT_ROOT}" tag --list 'v[0-9]*.[0-9]*.[0-9]*' | sed 's/^v//' | sort -V | tail -n1)"
if [ -n "${LATEST_TAG}" ] && semver_gt "${LATEST_TAG}" "${LATEST_VERSION}"; then
  LATEST_VERSION="${LATEST_TAG}"
fi

if [ -z "${INPUT_VERSION}" ]; then
  IFS='.' read -r maj min pat <<< "${LATEST_VERSION}"
  VERSION="${maj}.${min}.$((pat + 1))"
  echo "No version supplied. Auto bumping patch: ${LATEST_VERSION} → ${VERSION}"
else
  VERSION="${INPUT_VERSION#v}"
fi

if ! echo "${VERSION}" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be in format x.y.z (e.g. 1.2.3)"; exit 1
fi

if ! semver_gt "${VERSION}" "${LATEST_VERSION}" && [ "${FORCE}" != "true" ]; then
  echo "Error: ${VERSION} must be greater than current version (${LATEST_VERSION})."
  echo "Use --force to override."
  exit 1
fi

TAG_NAME="v${VERSION}"

if git -C "${PROJECT_ROOT}" rev-parse "${TAG_NAME}" >/dev/null 2>&1; then
  echo "Error: tag ${TAG_NAME} already exists."; exit 1
fi

echo "Updating version to ${VERSION}..."

# Update apps/server/Cargo.toml (first version = line only)
sed -i "0,/^version = \"[^\"]*\"/{s/^version = \"[^\"]*\"/version = \"${VERSION}\"/}" "${SERVER_CARGO}"
echo "✓ Updated ${SERVER_CARGO}"

# Update apps/web/package.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "${WEB_PKG}"
echo "✓ Updated ${WEB_PKG}"

# Create version notes file
mkdir -p "${VERSION_DIR}"
VERSION_FILE="${VERSION_DIR}/${VERSION}.md"

LAST_TAG="$(git -C "${PROJECT_ROOT}" describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)"
if [ -n "${LAST_TAG}" ]; then
  CHANGELOG="$(git -C "${PROJECT_ROOT}" log "${LAST_TAG}..HEAD" --pretty=format:'- %h %s' || true)"
else
  CHANGELOG="$(git -C "${PROJECT_ROOT}" log --max-count=20 --pretty=format:'- %h %s' || true)"
fi
[ -z "${CHANGELOG}" ] && CHANGELOG="- No changes since the previous release."

cat > "${VERSION_FILE}" <<EOF
# Release ${TAG_NAME}

- Date: $(date +%F)
- Server version: ${VERSION}
- Web version: ${VERSION}

## Changes

${CHANGELOG}
EOF

find "${VERSION_DIR}" -maxdepth 1 -type f -name '*.md' ! -name "${VERSION}.md" -delete
echo "✓ Wrote ${VERSION_FILE}"

# Commit
git -C "${PROJECT_ROOT}" add "${SERVER_CARGO}" "${WEB_PKG}"
git -C "${PROJECT_ROOT}" add -A "${VERSION_DIR}"

if git -C "${PROJECT_ROOT}" diff --cached --quiet; then
  echo "No staged changes to commit."
else
  git -C "${PROJECT_ROOT}" commit -m "chore(release): bump version to ${VERSION}"
  echo "✓ Committed version bump"
fi

# Tag
if [ "${CREATE_TAG}" = "true" ]; then
  git -C "${PROJECT_ROOT}" tag -a "${TAG_NAME}" -m "Release ${TAG_NAME}"
  echo "✓ Created tag: ${TAG_NAME}"
fi

# Push
if [ "${PUSH_CHANGES}" = "true" ]; then
  CURRENT_BRANCH="$(git -C "${PROJECT_ROOT}" branch --show-current)"
  if [ -z "${CURRENT_BRANCH}" ]; then
    echo "Error: could not determine current branch"; exit 1
  fi
  git -C "${PROJECT_ROOT}" push origin "${CURRENT_BRANCH}"
  echo "✓ Pushed origin/${CURRENT_BRANCH}"
  if [ "${CREATE_TAG}" = "true" ]; then
    git -C "${PROJECT_ROOT}" push origin "${TAG_NAME}"
    echo "✓ Pushed ${TAG_NAME}"
    if command -v gh >/dev/null 2>&1; then
      gh release create "${TAG_NAME}" --title "Release ${TAG_NAME}" --notes-file "${VERSION_FILE}"
      echo "✓ Created GitHub release: ${TAG_NAME}"
    else
      echo "⚠ gh CLI not found; skipping GitHub release creation"
    fi
  fi
fi

echo ""
echo "Done! Version is now ${VERSION}"
