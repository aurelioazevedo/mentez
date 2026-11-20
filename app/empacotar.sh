#!/bin/sh
# Gera sistema.zip para publicar na Hostinger (Node.js), copiando as folhas dos cadernos.
set -e
cd "$(dirname "$0")"
rm -rf private && mkdir -p private
for d in folhas folhas-ilustradas folhas-tematicas; do cp -r ../consultorio/$d private/; done
rm -f sistema.zip
zip -qr sistema.zip package.json package-lock.json server.js lib routes public private
ls -lh sistema.zip
