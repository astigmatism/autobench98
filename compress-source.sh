#!/usr/bin/env bash
set -euo pipefail

# Creates a zip of selected project source trees and root files for AI review.
# Usage:
#   ./package-source-for-ai.sh /path/to/output-directory
#
# Output:
#   /path/to/output-directory/autobench98-YYYYMMDD-HHMMSS.zip
#
# Included source directories:
#   apps/
#   docs/
#   arduino/
#   packages/
#   services/
#   vendor/
#
# Included root files:
#   .env
#   .env.production
#   .gitignore
#   .prettierrc
#   package.json
#   tsconfig.json
#   start-linux.sh
#   start-macos.sh
#
# Excluded:
#   editor folders, dependencies, build outputs, logs, OS junk files

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOURCE_DIRS=(
  "apps"
  "docs"
  "arduino"
  "packages"
  "services"
  "vendor"
)

ROOT_FILES=(
  ".env"
  ".env.production"
  ".gitignore"
  ".prettierrc"
  "package.json"
  "tsconfig.json"
  "start-linux.sh"
  "start-macos.sh"
)

EXCLUDE_PATTERNS=(
  "*/.vscode/*"
  "*/node_modules/*"
  "*/dist/*"
  "*/build/*"
  "*/public/*"
  "*/coverage/*"
  "*/.cache/*"
  "*/.turbo/*"
  "*/.next/*"
  "*/.nuxt/*"
  "*/.svelte-kit/*"
  "*/.vite/*"
  "*.log"
  "*/.DS_Store"
  ".DS_Store"
)

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/output-directory"
  exit 1
fi

OUTPUT_DIR="$1"

TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
OUTPUT_FILE="$OUTPUT_DIR/autobench98-$TIMESTAMP.zip"

cd "$SCRIPT_DIR"

INCLUDE_PATHS=()

for dir in "${SOURCE_DIRS[@]}"; do
  if [[ -d "$dir" ]]; then
    INCLUDE_PATHS+=("$dir")
  else
    echo "Warning: $dir/ directory not found at: $SCRIPT_DIR"
  fi
done

for file in "${ROOT_FILES[@]}"; do
  if [[ -f "$file" ]]; then
    INCLUDE_PATHS+=("$file")
  else
    echo "Warning: $file not found at: $SCRIPT_DIR"
  fi
done

if [[ ${#INCLUDE_PATHS[@]} -eq 0 ]]; then
  echo "Error: no source directories or root files found to package."
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

rm -f "$OUTPUT_FILE"

ZIP_ARGS=()

for pattern in "${EXCLUDE_PATTERNS[@]}"; do
  ZIP_ARGS+=("-x" "$pattern")
done

zip -r "$OUTPUT_FILE" "${INCLUDE_PATHS[@]}" "${ZIP_ARGS[@]}"

echo "Created: $OUTPUT_FILE"