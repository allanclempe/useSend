#!/bin/sh

set -x

echo "Applying drizzle migrations"

# Run from apps/web: drizzle.config.ts declares `out` relative to the working
# directory, so migrating from /app would look for the journal in the wrong
# place. Pinned to the drizzle-kit version in apps/web/package.json.
cd apps/web && pnpx drizzle-kit@0.31.10 migrate || exit 1
cd /app || exit 1

echo "Starting web server"

node apps/web/server.js
