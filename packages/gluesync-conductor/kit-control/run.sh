#!/usr/bin/env bash

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

# run.sh is kept for the installers (the docker installer and the offline installer start Gluesync by running this
# file). Gluesync Control does the work: this script picks the binary for this CPU and runs `gluesync run` from this kit
# folder, so its exit code is the one returned. It also links `gluesync` to that binary when the link is missing.
set -euo pipefail

case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Error: unsupported CPU '$(uname -m)' (Gluesync Control for Linux supports x86_64 and aarch64)." >&2; exit 1 ;;
esac

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="$dir/gluesync-linux-$arch"
if [[ ! -f "$bin" ]]; then
  echo "Error: Gluesync Control (gluesync-linux-$arch) was not found in '$dir'. Use the Gluesync setup script to install it, then run 'gluesync run'." >&2
  exit 1
fi

[[ -x "$bin" ]] || chmod +x "$bin" 2>/dev/null || true
[[ -e "$dir/gluesync" ]] || ln -s "gluesync-linux-$arch" "$dir/gluesync" 2>/dev/null || true

if [[ -x "$dir/gluesync" ]]; then
  exec "$dir/gluesync" run --folder "$dir" "$@"
fi
exec "$bin" run --folder "$dir" "$@"
