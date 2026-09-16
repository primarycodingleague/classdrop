#!/usr/bin/env bash
# ClassDrop hosted service on Azure, UK South. Paste this whole file into Azure Cloud
# Shell (bash) at https://shell.azure.com — nothing to install. Safe to run again: every
# step is create-if-missing.
#
# What it makes, all in one resource group in uksouth:
#   - Azure Database for PostgreSQL Flexible Server (Burstable B1ms, 32 GB, 35-day backups)
#   - a storage account with one private container for photos, video and voice notes
#   - an App Service plan (Linux B1) and a Node 22 web app running server/
#
# Roughly £30–40 a month; the Founders Hub credit covers it.
set -euo pipefail

RG=${RG:-classdrop}
LOC=${LOC:-uksouth}
APP=${APP:-classdrop-api}                       # becomes https://$APP.azurewebsites.net
PG=${PG:-classdrop-pg}
PGUSER=${PGUSER:-classdrop}
SUB=$(az account show --query id -o tsv)
SA=${SA:-cdmedia$(echo "$SUB" | tr -d - | cut -c1-14)}   # storage names: 3–24 lowercase, globally unique
REPO=${REPO:-https://github.com/primarycodingleague/classdrop.git}
BRANCH=${BRANCH:-main}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "0/6  Registering the Azure services this uses (once per subscription; a minute or two)"
for ns in Microsoft.DBforPostgreSQL Microsoft.Storage Microsoft.Web Microsoft.CloudShell; do
  if [ "$(az provider show --namespace "$ns" --query registrationState -o tsv 2>/dev/null)" != "Registered" ]; then
    az provider register --namespace "$ns" --wait -o none
  fi
done

say "1/6  Resource group $RG in $LOC"
az group create -n "$RG" -l "$LOC" -o none

say "2/6  PostgreSQL Flexible Server $PG (this one takes a few minutes)"
if ! az postgres flexible-server show -g "$RG" -n "$PG" -o none 2>/dev/null; then
  PGPASS=$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-28)
  az postgres flexible-server create -g "$RG" -n "$PG" -l "$LOC" \
    --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
    --admin-user "$PGUSER" --admin-password "$PGPASS" \
    --public-access 0.0.0.0 --backup-retention 35 --yes -o none
  # --public-access 0.0.0.0 means "Azure services only", not the internet.
  az postgres flexible-server db create -g "$RG" -s "$PG" -d classdrop -o none
  echo "$PGPASS" > "$HOME/.classdrop-pg-password"; chmod 600 "$HOME/.classdrop-pg-password"
  echo "    DATABASE PASSWORD (Cloud Shell is ephemeral; copy this into your password manager now): $PGPASS"
else
  if [ -f "$HOME/.classdrop-pg-password" ]; then PGPASS=$(cat "$HOME/.classdrop-pg-password")
  else
    PGPASS=${PGPASS:-}
    if [ -z "$PGPASS" ]; then   # a fresh (ephemeral) shell: set a new password so the app settings are right
      PGPASS=$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-28)
      az postgres flexible-server update -g "$RG" -n "$PG" --admin-password "$PGPASS" -o none
      echo "    DATABASE PASSWORD RESET (copy this into your password manager now): $PGPASS"
    fi
    echo "$PGPASS" > "$HOME/.classdrop-pg-password"; chmod 600 "$HOME/.classdrop-pg-password"
  fi
  echo "    already exists"
fi
DATABASE_URL="postgresql://$PGUSER:$PGPASS@$PG.postgres.database.azure.com:5432/classdrop?sslmode=require"

say "3/6  Storage account $SA (private, TLS 1.2, UK South)"
az storage account create -g "$RG" -n "$SA" -l "$LOC" --sku Standard_LRS --kind StorageV2 \
  --allow-blob-public-access false --min-tls-version TLS1_2 -o none
STORAGE_CONN=$(az storage account show-connection-string -g "$RG" -n "$SA" -o tsv)
az storage container create -n media --connection-string "$STORAGE_CONN" -o none
# a deleted or overwritten photo can be brought back for 35 days (the runbook's promise)
az storage account blob-service-properties update -g "$RG" --account-name "$SA" \
  --enable-delete-retention true --delete-retention-days 35 --enable-versioning true -o none

say "4/6  App Service $APP (Linux B1, Node 22)"
az appservice plan create -g "$RG" -n classdrop-plan -l "$LOC" --is-linux --sku B1 -o none
if ! az webapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  az webapp create -g "$RG" -n "$APP" --plan classdrop-plan --runtime "NODE:22-lts" -o none
fi
az webapp config set -g "$RG" -n "$APP" --always-on true --min-tls-version 1.2 --ftps-state Disabled \
  --generic-configurations '{"healthCheckPath":"/health"}' -o none
az webapp update -g "$RG" -n "$APP" --https-only true -o none

if [ -z "${INVITE_CODES:-}" ]; then
  INVITE_CODES=$(az webapp config appsettings list -g "$RG" -n "$APP" --query "[?name=='INVITE_CODES'].value | [0]" -o tsv)
  INVITE_CODES=${INVITE_CODES:-PCL-$(openssl rand -hex 3 | tr a-f A-F)}
fi
az webapp config appsettings set -g "$RG" -n "$APP" -o none --settings \
  DATABASE_URL="$DATABASE_URL" \
  STORAGE=azure AZURE_STORAGE_CONNECTION_STRING="$STORAGE_CONN" AZURE_CONTAINER=media \
  ALLOWED_ORIGINS="https://classdrop.co.uk" \
  INVITE_CODES="$INVITE_CODES" \
  MAX_SCHOOL_MB=5120 \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true

say "5/6  Deploying server/ from $REPO ($BRANCH)"
WORK=$(mktemp -d)
git clone -q --depth 1 -b "$BRANCH" "$REPO" "$WORK/classdrop"
( cd "$WORK/classdrop/server" && zip -qr "$WORK/server.zip" . -x 'node_modules/*' 'data/*' '*.log' )
az webapp deploy -g "$RG" -n "$APP" --src-path "$WORK/server.zip" --type zip -o none
rm -rf "$WORK"

say "6/6  Checking"
sleep 20
curl -fsS "https://$APP.azurewebsites.net/health" && echo

cat <<EOF

Done. The API is at https://$APP.azurewebsites.net
Invite code for new schools: $INVITE_CODES   (staff sign-up asks for this; keep it private)

The app at classdrop.co.uk only talks to https://api.classdrop.co.uk (content security
policy), so the last step is the custom domain. In your DNS (Cloudflare):

  CNAME  api          $APP.azurewebsites.net        (DNS only, not proxied)
  TXT    asuid.api    $(az webapp show -g "$RG" -n "$APP" --query customDomainVerificationId -o tsv)

then run:

  az webapp config hostname add -g $RG --webapp-name $APP --hostname api.classdrop.co.uk
  az webapp config ssl create -g $RG -n $APP --hostname api.classdrop.co.uk
  az webapp config ssl bind -g $RG -n $APP --hostname api.classdrop.co.uk --ssl-type SNI \\
    --certificate-thumbprint \$(az webapp config ssl list -g $RG --query "[?subjectName=='api.classdrop.co.uk'].thumbprint | [0]" -o tsv)

To ship a new version later, run this script again (steps 1–4 are no-ops).
EOF
