#!/bin/bash

# This file is part of Gluesync.
#
# Gluesync is dual-licensed under the following licenses:
#
# 1. GNU General Public License (GPL) Version 3
#    You may use, modify, and distribute this software under the terms of the GPL v3.
#    See the LICENSE-GPL file or <http://www.gnu.org/licenses/gpl-3.0.html> for details.
#    This option is available at no cost, but any derivative works must also be licensed under GPL v3.
#
# 2. MOLO17 Commercial License
#    Alternatively, you may use this software under the MOLO17 Commercial License,
#    which includes a warranty and permits proprietary use. Contact MOLO17 at info@molo17.com
#    for licensing terms and conditions.
#
# You must choose one of these licenses to use this software. Using this software implies
# acceptance of one of these licenses. See the accompanying LICENSE files or contact
# MOLO17 for more information.
#
# Copyright (C) 2025 MOLO17. All rights reserved.

echo "=================================================================================="
echo " Welcome to the Gluesync Logs Collector & Uploader!"
echo ""
echo " This script safely collects all .log and .err files recursively from Gluesync"
echo " directories and creates a compressed archive (.zip or .tar.gz)."
echo ""
echo " If you have a support ticket, you can upload the logs directly to your secure"
echo " MOLO17 support area for faster troubleshooting assistance."
echo ""
echo " Usage: $0 [-e email] [-t ticket]"
echo "=================================================================================="
echo ""

# This script recursively finds all .log and .err files in the current directory and its subdirectories,
# then creates a compressed archive of them.

# It first checks for the 'zip' command. If available, it creates a 'support-logs.zip' file.
# If 'zip' is not found, it falls back to using 'tar' with gzip compression to create 'support-logs.tar.gz'.
# If neither command is found, it prints an error message.

# Script version
SCRIPT_VERSION="1.1"

# Function to URL-encode a string
urlencode() {
    echo "$1" | sed 's/@/%40/g'
}

# FTP upload parameters
EMAIL=""
TICKET=""

# Parse command line arguments
while getopts "e:t:" opt; do
  case $opt in
    e) EMAIL="$OPTARG" ;;
    t) TICKET="$OPTARG" ;;
    *) echo "Usage: $0 [-e email] [-t ticket]" >&2; exit 1 ;;
  esac
done

# If email or ticket not provided, prompt interactively
if [ -z "$EMAIL" ]; then
  read -p "Enter your email address: " EMAIL
fi
if [ -z "$TICKET" ]; then
  read -p "Enter ticket number: " TICKET
fi

# The directory where the script is located
BASE_DIR=$(dirname "$0")

# The directory to search for logs (the parent directory of the script's location)
SEARCH_DIR=$(realpath "$BASE_DIR/..")

# Determine a writable output directory for the archive
INVOKE_DIR=$(pwd)
OUTPUT_DIR="$INVOKE_DIR"
TMP_TEST=".collect_logs_write_test_$$"
if ! ( : > "$OUTPUT_DIR/$TMP_TEST" 2>/dev/null && rm -f "$OUTPUT_DIR/$TMP_TEST" 2>/dev/null ); then
  OUTPUT_DIR="/tmp"
fi

# The name of the output archive
ARCHIVE_NAME="support-logs-v${SCRIPT_VERSION}-$(date +%Y%m%d-%H%M%S)"

# Change to the search directory to ensure paths in the archive are relative
cd "$SEARCH_DIR" || exit

echo "Log Collection Script v${SCRIPT_VERSION} - Searching for .log and .err files in $SEARCH_DIR..."

# Find all .log and .err files
LOG_FILES=$(find . -type f \( -name "*.log" -o -name "*.err" \))

if [ -z "$LOG_FILES" ]; then
    echo "No .log or .err files found."
    exit 0
fi

# Resolve absolute paths to avoid PATH inconsistencies under sh
ZIP_CMD=$(command -v zip 2>/dev/null || true)
TAR_CMD=$(command -v tar 2>/dev/null || true)

# Prefer zip if truly runnable; otherwise fall back to tar
if command -v zip >/dev/null 2>&1; then
  echo "'zip' command found. Creating ${ARCHIVE_NAME}.zip..."
  # Feed file list directly into zip via stdin (-@ reads from stdin)
  # Use find to regenerate to avoid issues with word splitting
  find . -type f \( -name "*.log" -o -name "*.err" \) -print | zip -@ "${OUTPUT_DIR}/${ARCHIVE_NAME}.zip"
  if [ "$?" -eq 0 ]; then
    ARCHIVE_PATH="${OUTPUT_DIR}/${ARCHIVE_NAME}.zip"
    echo "Successfully created ${ARCHIVE_PATH}"
  else
    echo "Failed to create ${ARCHIVE_NAME}.zip"
    exit 1
  fi
elif command -v tar >/dev/null 2>&1; then
  echo "'zip' command not found. Falling back to 'tar'."
  echo "Creating ${ARCHIVE_NAME}.tar.gz..."
  # Detect GNU tar capabilities
  TAR_IS_GNU=0
  if "$TAR_CMD" --version 2>/dev/null | grep -qi "gnu tar"; then
    TAR_IS_GNU=1
  fi

  # Prepare a temporary file list and ensure cleanup
  FILE_LIST=$(mktemp 2>/dev/null || echo "/tmp/collect-logs.$$.list")
  trap 'rm -f "$FILE_LIST" >/dev/null 2>&1' EXIT INT TERM

  if [ "$TAR_IS_GNU" -eq 1 ]; then
    # GNU tar: use NUL-separated list and add helpful flags if supported
    find . -type f \( -name "*.log" -o -name "*.err" \) -print0 > "$FILE_LIST"
    TAR_WARN_FLAG=""
    if "$TAR_CMD" --help 2>&1 | grep -q -- "--warning"; then
      TAR_WARN_FLAG="--warning=no-file-changed"
    fi
    IGNORE_FAILED_READ_FLAG=""
    if "$TAR_CMD" --help 2>&1 | grep -q -- "--ignore-failed-read"; then
      IGNORE_FAILED_READ_FLAG="--ignore-failed-read"
    fi
    TAR_ERR=$(mktemp 2>/dev/null || echo "/tmp/collect-logs-tar.$$.err")
    "$TAR_CMD" --null $TAR_WARN_FLAG $IGNORE_FAILED_READ_FLAG -czvf "${OUTPUT_DIR}/${ARCHIVE_NAME}.tar.gz" -T "$FILE_LIST" 2>"$TAR_ERR"
    TAR_STATUS=$?
  else
    # Non-GNU tar: fall back to newline-separated -T list
    find . -type f \( -name "*.log" -o -name "*.err" \) -print > "$FILE_LIST"
    TAR_ERR=$(mktemp 2>/dev/null || echo "/tmp/collect-logs-tar.$$.err")
    "$TAR_CMD" -czvf "${OUTPUT_DIR}/${ARCHIVE_NAME}.tar.gz" -T "$FILE_LIST" 2>"$TAR_ERR"
    TAR_STATUS=$?
  fi

  # Cleanup the temp list now (trap also covers it)
  rm -f "$FILE_LIST" >/dev/null 2>&1 || true

  ARCHIVE_PATH="${OUTPUT_DIR}/${ARCHIVE_NAME}.tar.gz"

  # If tar returned non-zero but produced a non-empty archive, treat as success with warnings
  if [ ${TAR_STATUS:-1} -ne 0 ] && [ -s "$ARCHIVE_PATH" ]; then
    echo "Archive created with warnings: $ARCHIVE_PATH"
    TAR_STATUS=0
  fi

  if [ ${TAR_STATUS:-0} -eq 0 ]; then
    echo "Successfully created $ARCHIVE_PATH"
    rm -f "$TAR_ERR" >/dev/null 2>&1 || true
  else
    # Only now print tar error output if we truly failed to produce an archive
    echo "tar error output:" >&2
    cat "$TAR_ERR" >&2 || true
    rm -f "$TAR_ERR" >/dev/null 2>&1 || true
    echo "Failed to create $ARCHIVE_PATH"
    exit 1
  fi
else
  echo "Error: Neither 'zip' nor 'tar' command found or runnable. Please install one of them to create the archive."
  exit 1
fi

# Attempt FTP upload if email and ticket provided
if [ -n "$EMAIL" ] && [ -n "$TICKET" ]; then
  ENCODED_EMAIL=$(urlencode "$EMAIL")
  echo "Uploading $ARCHIVE_PATH to FTP..."
  echo "ftp://$TICKET:$ENCODED_EMAIL@vpn.molo17.com/"
  if curl -T "$ARCHIVE_PATH" "ftp://$TICKET:$ENCODED_EMAIL@vpn.molo17.com/"; then
    echo "Successfully uploaded to FTP."
  else
    echo "Failed to upload to FTP."
    exit 1
  fi
elif [ -z "$EMAIL" ] || [ -z "$TICKET" ]; then
  echo "Email or ticket not provided. Skipping upload."
  exit 1
fi
