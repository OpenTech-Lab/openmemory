#!/bin/bash

# Usage: ./scripts/bump-version.sh [<version>] [--force]
# Example: ./scripts/bump-version.sh          # auto-increments patch
#          ./scripts/bump-version.sh 1.1.9
#          ./scripts/bump-version.sh 0.1.0 --force

set -e

SERVER_CARGO="apps/server/Cargo.toml"
WEB_PKG="apps/web/package.json"
VERSION_DIR="version"

version_gt() {
  [ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ] && [ "$1" != "$2" ]
}

bump_patch() {
  local ver=$1
  local major minor patch
  major=$(echo "$ver" | cut -d. -f1)
  minor=$(echo "$ver" | cut -d. -f2)
  patch=$(echo "$ver" | cut -d. -f3)
  echo "$major.$minor.$((patch + 1))"
}

CURRENT_VERSION=$(grep '^version = ' "$SERVER_CARGO" | head -n1 | sed -E 's/version = "([^"]+)"/\1/')

VERSION=$1
FORCE=false
if [ -z "$VERSION" ] || [ "$VERSION" = "--force" ]; then
  [ "$VERSION" = "--force" ] && FORCE=true
  VERSION=$(bump_patch "$CURRENT_VERSION")
  echo "No version specified, auto-incrementing patch: $CURRENT_VERSION → $VERSION"
elif [ "$2" = "--force" ]; then
  FORCE=true
fi

VERSION_FILE="$VERSION_DIR/$VERSION.md"

# Validate version format (x.y.z)
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be in format x.y.z (e.g. 1.1.9)"
  exit 1
fi

echo "Updating version to $VERSION..."

# Ensure the requested version is greater than the current version
if ! version_gt "$VERSION" "$CURRENT_VERSION"; then
  if [ "$FORCE" = true ]; then
    echo "Warning: version $VERSION is not greater than current ($CURRENT_VERSION). Proceeding due to --force."
  else
    echo "Error: version must be greater than current version ($CURRENT_VERSION)."
    echo "Use --force to override."
    exit 1
  fi
fi

# Update apps/server/Cargo.toml
sed -i "0,/^version = \"[^\"]*\"/{s/^version = \"[^\"]*\"/version = \"$VERSION\"/}" "$SERVER_CARGO"
echo "✓ Updated $SERVER_CARGO"

# Update Cargo.lock if it exists (keep it in sync)
if [ -f "Cargo.lock" ]; then
  cargo generate-lockfile --quiet 2>/dev/null || true
  echo "✓ Refreshed Cargo.lock"
fi

# Update apps/web/package.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$WEB_PKG"
echo "✓ Updated $WEB_PKG"

# Create/update version markdown file and keep only the latest one
mkdir -p "$VERSION_DIR"
cat > "$VERSION_FILE" <<EOF
# Version $VERSION

- Server version: $VERSION
- Web version: $VERSION
EOF

find "$VERSION_DIR" -maxdepth 1 -type f -name "*.md" ! -name "$VERSION.md" -delete
echo "✓ Updated $VERSION_FILE"
echo "✓ Kept only the latest file in $VERSION_DIR/"

git add "$SERVER_CARGO" "$WEB_PKG" "$VERSION_DIR"
[ -f "Cargo.lock" ] && git add Cargo.lock

# Create commit only when there are staged changes
if git diff --cached --quiet; then
  echo "No changes to commit."
else
  git commit -m "chore: bump version to $VERSION"
  echo "✓ Created commit for version bump"
fi

# Create git tag
TAG="v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Warning: tag $TAG already exists. Skipping tag creation."
else
  git tag "$TAG"
  echo "✓ Created git tag: $TAG"
fi

# Push current branch and tags to GitHub
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if git remote get-url origin >/dev/null 2>&1; then
  echo "Pushing commits to origin/$CURRENT_BRANCH..."
  git push origin "$CURRENT_BRANCH"
  echo "Pushing tag $TAG to origin..."
  git push origin "$TAG"
  echo "✓ Pushed commit and tag to GitHub"
else
  echo "Warning: git remote 'origin' not found. Skipping push."
fi

echo ""
echo "Done! Version is now $VERSION"
