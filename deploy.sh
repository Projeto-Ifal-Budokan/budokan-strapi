#!/bin/bash
#
# Deploy do Strapi (CMS) do Budokan nesta máquina.
#
# Tudo passa pelo gateway /usr/local/bin/budokan-docker: o usuário de deploy não
# tem acesso ao socket, e o gateway recusa qualquer alvo que não seja do Budokan.
#
# Removido de propósito em relação à versão anterior deste script:
#   * `docker system prune -f`  — apagava imagens penduradas de TODOS os projetos
#   * `docker-compose down -v`  — destruía o volume do banco do CMS
#   * `docker-compose exec ... mysqldump` — `exec` não é permitido pelo gateway;
#     backup do banco precisa de um subcomando próprio no gateway (ver TODO)
#   * geração de segredos no deploy — os segredos vivem em .env, não são gerados
#     aqui (gerar a cada deploy invalidaria sessões e tokens existentes)
#
set -euo pipefail

GW="sudo -n /usr/local/bin/budokan-docker"
APP_CONTAINER=budokan-strapi-app
DB_CONTAINER=budokan-strapi-mysql

echo "=== DEPLOY STRAPI STARTED at $(date) ==="

if [[ ! -f .env ]]; then
	echo "❌ Falta .env neste diretório. Copie a partir de .env.example."
	exit 1
fi

falta=()
for k in DATABASE_NAME DATABASE_USERNAME DATABASE_PASSWORD MYSQL_ROOT_PASSWORD \
	APP_KEYS API_TOKEN_SALT ADMIN_JWT_SECRET TRANSFER_TOKEN_SALT JWT_SECRET ENCRYPTION_KEY; do
	grep -qE "^${k}=..*" .env || falta+=("$k")
done
if ((${#falta[@]})); then
	echo "❌ .env sem valor para: ${falta[*]}"
	exit 1
fi

echo "🔄 Atualizando código..."
git reset --hard
git pull origin main

echo "🐳 Subindo (build se necessário)..."
$GW compose strapi up -d --build

echo "🩺 Aguardando o banco..."
for _ in $(seq 1 30); do
	if $GW inspect "$DB_CONTAINER" 2>/dev/null |
		grep -q '"Status": "healthy"'; then
		echo "✅ MySQL healthy"
		break
	fi
	sleep 3
done

echo "🩺 Saúde do app..."
$GW inspect "$APP_CONTAINER" 2>/dev/null |
	python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data:
    st = c.get('State', {})
    print('  ', c.get('Config', {}).get('Hostname') or c.get('Name'),
          '| status:', st.get('Status'),
          '| health:', (st.get('Health') or {}).get('Status', 'sem healthcheck'),
          '| restarts:', st.get('RestartCount'))
" || echo "  (container ainda não visível)"

echo "📋 Log recente:"
$GW logs "$APP_CONTAINER" || true

$GW compose strapi ps
echo "=== DEPLOY STRAPI FINISHED at $(date) ==="
