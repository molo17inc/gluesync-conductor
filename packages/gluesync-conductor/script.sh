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
echo " Usage: $0 -t <ticketId> -e <email>"
echo "=================================================================================="
echo ""

# Fixed settings
DUR="3"          # seconds total
INTERVAL="0.25"  # seconds per dot
start_msg="starting"
end_msg="done"

# Parse command line arguments
ticketId=""
email=""

while getopts "t:e:" opt; do
  case $opt in
    t) ticketId="$OPTARG" ;;
    e) email="$OPTARG" ;;
    *) echo "Usage: $0 -t <ticketId> -e <email>" >&2; exit 2 ;;
  esac
done

# Basic argument validation
if [ -z "$ticketId" ] || [ -z "$email" ]; then
  echo "Usage: $0 -t <ticketId> -e <email>"
  exit 2
fi

# Very light email sanity check
if ! printf '%s' "$email" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+$'; then
  echo "Invalid email format"
  exit 2
fi

# Display context
printf "ticket: %s, email: %s\n" "$ticketId" "$email"

# Start message
printf "%s " "$start_msg"

elapsed=0

# Hide cursor during animation if available, and restore on exit
if command -v tput >/dev/null 2>&1; then
  tput civis
  trap 'tput cnorm >/dev/null 2>&1' EXIT INT TERM HUP
fi

# Loop for fixed duration, printing dots every INTERVAL
while awk "BEGIN{exit !($elapsed < $DUR)}"; do
  printf "."
  sleep "$INTERVAL"
  elapsed=$(awk "BEGIN{print $elapsed + $INTERVAL}")
done

# Newline and final message
printf "\n%s\n" "$end_msg"
exit 0
