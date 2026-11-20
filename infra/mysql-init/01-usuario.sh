#!/bin/bash
# Usuário do app: só cria e usa o banco da plataforma e os bancos das clínicas (mz_*)
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE USER IF NOT EXISTS '${MENTEZ_DB_USER}'@'%' IDENTIFIED BY '${MENTEZ_DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`mentez_platform\`.* TO '${MENTEZ_DB_USER}'@'%';
GRANT ALL PRIVILEGES ON \`mz\\_%\`.* TO '${MENTEZ_DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL
