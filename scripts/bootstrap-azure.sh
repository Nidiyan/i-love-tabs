#!/usr/bin/env bash
# Run locally after az login and gh auth login. Never trace generated credentials.
set +x
set -euo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: SUBSCRIPTION_ID=<uuid> bash scripts/bootstrap-azure.sh --yes

Creates billable Azure resources and configures GitHub's azure-testing environment.
Requires Azure CLI/Bicep, Docker, GitHub CLI, jq, curl, and Bash.
Sign in first: az login; gh auth login

Environment inputs:
  SUBSCRIPTION_ID   Required Azure subscription UUID
  LOCATION          Azure region (default: eastus)
  APP_NAME          Dedicated Container App name (default: i-love-tabs)
  REGISTRY_NAME     Optional globally unique ACR name; otherwise generated
  GITHUB_REPO       GitHub owner/repository (default: Nidiyan/i-love-tabs)
  TESTER_OBJECT_ID  Defaults to the signed-in Azure user's tenant-local object ID

Only that user can sign in. Azure administrators retain administrative access.
Run from a trusted checkout. --yes acknowledges resource costs and environment changes.
No credentials are written to the repository or printed. Website sign-in uses an
Azure-stored secret; deployment uses OIDC. Public ingress opens only after auth checks.
HELP
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
[[ $# == 1 && $1 == --yes ]] || { usage >&2; exit 1; }
[[ ${SUBSCRIPTION_ID:-} =~ ^[[:xdigit:]]{8}(-[[:xdigit:]]{4}){3}-[[:xdigit:]]{12}$ ]] \
  || fail 'Set SUBSCRIPTION_ID to the Azure subscription UUID.'
LOCATION=${LOCATION:-eastus}
APP_NAME=${APP_NAME:-i-love-tabs}
GITHUB_REPO=${GITHUB_REPO:-Nidiyan/i-love-tabs}
[[ $APP_NAME =~ ^[a-z][a-z0-9-]{0,21}[a-z0-9]$ && $APP_NAME != *--* ]] \
  || fail 'APP_NAME must be 2–24 lowercase letters/numbers/hyphens, start with a letter, and have no consecutive hyphens.'
[[ $LOCATION =~ ^[a-z0-9]+$ ]] || fail 'LOCATION must be an Azure region name.'
[[ $GITHUB_REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'GITHUB_REPO must be owner/repository.'
for command in az docker gh jq curl git; do
  command -v "$command" >/dev/null || fail "Install $command first."
done
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
az account show --output none || fail 'Run az login first.'
az account set --subscription "$SUBSCRIPTION_ID"
TENANT_ID=$(az account show --query tenantId -o tsv)
TESTER_OBJECT_ID=${TESTER_OBJECT_ID:-$(az ad signed-in-user show --query id -o tsv)}
[[ $TESTER_OBJECT_ID =~ ^[[:xdigit:]]{8}(-[[:xdigit:]]{4}){3}-[[:xdigit:]]{12}$ ]] \
  || fail 'TESTER_OBJECT_ID must be a tenant-local USER object UUID.'
gh auth status >/dev/null 2>&1 || fail 'Run gh auth login with repository administration access first.'
gh repo view "$GITHUB_REPO" --json viewerPermission --jq .viewerPermission | grep -qx ADMIN \
  || fail 'GitHub repository admin permission is required for environment settings.'
docker info >/dev/null
az bicep version >/dev/null
az extension add --name containerapp --upgrade --only-show-errors

# Stable names avoid duplicate registrations when a failed bootstrap is resumed.
SUFFIX=$(printf '%s' "$SUBSCRIPTION_ID/$GITHUB_REPO/$APP_NAME" | git hash-object --stdin)
SUFFIX=${SUFFIX:0:12}
REGISTRY_NAME=${REGISTRY_NAME:-tabs$SUFFIX}
[[ $REGISTRY_NAME =~ ^[a-z0-9]{5,50}$ ]] || fail 'REGISTRY_NAME must be 5–50 lowercase letters/numbers.'
RG="$APP_NAME-rg"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/tabs-bootstrap.XXXXXXXX")
PUBLIC_OPENED=false
SUCCESS=false
cleanup() {
  local status=$?
  trap - EXIT
  if [[ $PUBLIC_OPENED == true && $SUCCESS != true ]]; then
    printf 'Bootstrap failed; restoring internal ingress.\n' >&2
    az containerapp ingress enable -g "$RG" -n "$APP_NAME" \
      --type internal --target-port 3000 --output none >/dev/null 2>&1 \
      || printf 'WARNING: ingress rollback failed. Disable external ingress in Azure immediately.\n' >&2
  fi
  rm -rf -- "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ensure_registration() {
  local name=$1
  az ad app list --display-name "$name" --output json > "$WORK/apps.json"
  local count
  count=$(jq --arg name "$name" '[.[] | select(.displayName == $name)] | length' "$WORK/apps.json")
  [[ $count -le 1 ]] || fail "Multiple registrations named $name; resolve them before rerunning."
  if [[ $count == 1 ]]; then
    jq -r --arg name "$name" '.[] | select(.displayName == $name) | .appId' "$WORK/apps.json"
  else
    az ad app create --display-name "$name" --sign-in-audience AzureADMyOrg --query appId -o tsv
  fi
}
ensure_principal() {
  local client=$1
  az ad sp list --filter "appId eq '$client'" --output json > "$WORK/principals.json"
  if [[ $(jq length "$WORK/principals.json") == 0 ]]; then
    az ad sp create --id "$client" --query id -o tsv
  else
    jq -er 'if length == 1 then .[0].id else error("Ambiguous service principal") end' "$WORK/principals.json"
  fi
}

printf 'Configuring %s in %s; only the selected tester may sign in.\n' "$APP_NAME" "$LOCATION"
# Refuse an existing shared resource group. New groups are tagged before resources are deployed.
if [[ $(az group exists --name "$RG" -o tsv) == true ]]; then
  az group show --name "$RG" --output json > "$WORK/group.json"
  jq -e --arg owner "$GITHUB_REPO/$APP_NAME" '.tags["tabs-bootstrap"] == $owner' \
    "$WORK/group.json" >/dev/null || fail "Resource group $RG exists without this bootstrap's ownership tag; choose another APP_NAME."
else
  az group create --name "$RG" --location "$LOCATION" --tags "tabs-bootstrap=$GITHUB_REPO/$APP_NAME" --output none
fi
DEPLOY_CLIENT_ID=$(ensure_registration "$APP_NAME-github-$SUFFIX")
DEPLOY_OBJECT_ID=$(ensure_principal "$DEPLOY_CLIENT_ID")
ENTRA_CLIENT_ID=$(ensure_registration "$APP_NAME-testers-$SUFFIX")
ensure_principal "$ENTRA_CLIENT_ID" >/dev/null
az ad app update --id "$ENTRA_CLIENT_ID" --sign-in-audience AzureADMyOrg --enable-id-token-issuance true
jq -n --arg subject "repo:$GITHUB_REPO:environment:azure-testing" '{
  name: "github-azure-testing", issuer: "https://token.actions.githubusercontent.com",
  subject: $subject, audiences: ["api://AzureADTokenExchange"]
}' > "$WORK/federation.json"
az ad app federated-credential list --id "$DEPLOY_CLIENT_ID" --output json > "$WORK/federations.json"
FEDERATION_ID=$(jq -r '.[] | select(.name == "github-azure-testing") | .id' "$WORK/federations.json")
if [[ -n $FEDERATION_ID ]]; then
  az ad app federated-credential update --id "$DEPLOY_CLIENT_ID" --federated-credential-id "$FEDERATION_ID" \
    --parameters "@$WORK/federation.json" --output none
else
  az ad app federated-credential create --id "$DEPLOY_CLIENT_ID" --parameters "@$WORK/federation.json" --output none
fi
for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.OperationalInsights Microsoft.ManagedIdentity; do
  az provider register --namespace "$provider" --wait
done
az deployment sub create --name "$APP_NAME-foundation" --location "$LOCATION" \
  --template-file "$ROOT/infra/main.bicep" --parameters location="$LOCATION" appName="$APP_NAME" \
    registryName="$REGISTRY_NAME" deployPrincipalId="$DEPLOY_OBJECT_ID" \
    resourceTags="$(jq -nc --arg owner "$GITHUB_REPO/$APP_NAME" '{"tabs-bootstrap": $owner}')" --output none

LOGIN_SERVER=$(az acr show --name "$REGISTRY_NAME" --query loginServer -o tsv)
az acr login --name "$REGISTRY_NAME"
IMAGE="$LOGIN_SERVER/i-love-tabs:$(git -C "$ROOT" rev-parse HEAD)"
docker build --platform linux/amd64 --target test -t i-love-tabs:test "$ROOT"
docker build --platform linux/amd64 --target production -t "$IMAGE" "$ROOT"
docker push "$IMAGE"
IMAGE_DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE")

# Secure files, never shell arguments, carry the generated website login secret.
az ad app credential list --id "$ENTRA_CLIENT_ID" --output json > "$WORK/old-credentials.json"
if ! az ad app credential reset --id "$ENTRA_CLIENT_ID" --append \
  --display-name tabs-bootstrap-login --years 1 --output json > "$WORK/credential.json" 2>"$WORK/credential-error"; then
  fail 'Could not generate the website sign-in credential; check Entra permissions.'
fi
jq -n --slurpfile credential "$WORK/credential.json" \
  --arg name "$APP_NAME" --arg registry "$REGISTRY_NAME" --arg image "$IMAGE_DIGEST" \
  --arg client "$ENTRA_CLIENT_ID" --arg tester "$TESTER_OBJECT_ID" --arg deploy "$DEPLOY_OBJECT_ID" '{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    appName: {value: $name}, registryName: {value: $registry}, image: {value: $image},
    entraClientId: {value: $client}, entraClientSecret: {value: $credential[0].password},
    testerObjectIds: {value: [$tester]}, deployPrincipalId: {value: $deploy}
  }
}' > "$WORK/app.parameters.json"
# Suppress CLI error dumps that could include resolved secure parameter values.
if ! az deployment group create -g "$RG" --name "$APP_NAME-app" --template-file "$ROOT/infra/app.bicep" \
  --parameters "@$WORK/app.parameters.json" --output none 2>"$WORK/deployment-error"; then
  fail "App deployment failed. Inspect deployment $APP_NAME-app in Azure; ingress has not been opened. Rerun after fixing the cause."
fi
rm -f "$WORK/credential.json" "$WORK/app.parameters.json" "$WORK/deployment-error"
APP_ID=$(az containerapp show -g "$RG" -n "$APP_NAME" --query id -o tsv)
az rest --method get --url "$APP_ID/authConfigs/current?api-version=2024-03-01" > "$WORK/auth.json"
jq -e --arg client "$ENTRA_CLIENT_ID" --arg tenant "$TENANT_ID" --arg tester "$TESTER_OBJECT_ID" '
  .properties as $p | $p.identityProviders.azureActiveDirectory as $aad |
  $p.platform.enabled == true and $p.httpSettings.requireHttps == true and
  $p.globalValidation.unauthenticatedClientAction == "RedirectToLoginPage" and
  $p.globalValidation.redirectToProvider == "azureActiveDirectory" and
  (($p.globalValidation.excludedPaths // []) | length) == 0 and
  $aad.enabled == true and $aad.registration.clientId == $client and
  $aad.registration.openIdIssuer == ("https://login.microsoftonline.com/" + $tenant + "/v2.0") and
  $aad.validation.defaultAuthorizationPolicy.allowedPrincipals.identities == [$tester] and
  (($aad.validation.defaultAuthorizationPolicy.allowedPrincipals.groups // []) | length) == 0
' "$WORK/auth.json" >/dev/null || fail 'Authentication policy did not match; leaving ingress internal.'

printf 'Configuring GitHub environment (no deployment secrets).\n'
gh api "repos/$GITHUB_REPO/environments" --paginate \
  --jq '.environments[] | select(.name == "azure-testing")' > "$WORK/environment.json"
jq -s '{
  deployment_branch_policy: {protected_branches: false, custom_branch_policies: true},
  can_admins_bypass: (if .[0].can_admins_bypass == false then false else true end),
  reviewers: ([.[0].protection_rules[]? | select(.type == "required_reviewers") |
    .reviewers[]? | {type: .type, id: .reviewer.id}]),
  prevent_self_review: ([.[0].protection_rules[]? | select(.type == "required_reviewers") | .prevent_self_review][0] // false),
  wait_timer: ([.[0].protection_rules[]? | select(.type == "wait_timer") | .wait_timer][0] // 0)
}' "$WORK/environment.json" > "$WORK/environment-update.json"
gh api --method PUT "repos/$GITHUB_REPO/environments/azure-testing" \
  --input "$WORK/environment-update.json" >/dev/null
gh api "repos/$GITHUB_REPO/environments/azure-testing/deployment-branch-policies" --paginate \
  --jq '.branch_policies[] | [.id, .name, .type] | @tsv' > "$WORK/branches"
MAIN_POLICY=false
while IFS=$'\t' read -r policy_id policy_name policy_type; do
  [[ -n $policy_id ]] || continue
  if [[ $policy_name == main && $policy_type == branch ]]; then
    MAIN_POLICY=true
  else
    gh api --method DELETE "repos/$GITHUB_REPO/environments/azure-testing/deployment-branch-policies/$policy_id" >/dev/null
  fi
done < "$WORK/branches"
if [[ $MAIN_POLICY == false ]]; then
  gh api --method POST "repos/$GITHUB_REPO/environments/azure-testing/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null
fi
for pair in \
  "AZURE_SUBSCRIPTION_ID=$SUBSCRIPTION_ID" "AZURE_TENANT_ID=$TENANT_ID" \
  "AZURE_CLIENT_ID=$DEPLOY_CLIENT_ID" "AZURE_RESOURCE_GROUP=$RG" \
  "AZURE_CONTAINER_APP=$APP_NAME" "AZURE_REGISTRY_NAME=$REGISTRY_NAME" \
  "AZURE_ENTRA_CLIENT_ID=$ENTRA_CLIENT_ID" "AZURE_TESTER_OBJECT_IDS_JSON=[\"$TESTER_OBJECT_ID\"]"; do
  gh variable set "${pair%%=*}" --repo "$GITHUB_REPO" --env azure-testing --body "${pair#*=}"
done

# Mark before enabling ingress: even a partially successful CLI call must roll back on failure.
PUBLIC_OPENED=true
az containerapp ingress enable -g "$RG" -n "$APP_NAME" --type external --target-port 3000 --transport auto --output none
FQDN=$(az containerapp show -g "$RG" -n "$APP_NAME" --query properties.configuration.ingress.fqdn -o tsv)
[[ $FQDN =~ ^[a-z0-9.-]+\.azurecontainerapps\.io$ ]] || fail 'Unexpected Container Apps hostname.'
az ad app update --id "$ENTRA_CLIENT_ID" --web-redirect-uris "https://$FQDN/.auth/login/aad/callback"
PROTECTED=false
for ((attempt = 0; attempt < 12; attempt++)); do
  if curl --silent --show-error --max-time 15 --dump-header "$WORK/headers" --output /dev/null \
    -H 'Accept: text/html' "https://$FQDN/"; then
    LOGIN_LOCATION=$(tr -d '\r' < "$WORK/headers" | awk 'tolower($1) == "location:" { print $2 }')
    if grep -Eq '^HTTP/[0-9.]+ 302([[:space:]]|$)' "$WORK/headers"; then
      case "$LOGIN_LOCATION" in
        "/.auth/login/aad"|"/.auth/login/aad?"*|"https://$FQDN/.auth/login/aad"|"https://$FQDN/.auth/login/aad?"*)
          PROTECTED=true
          break
          ;;
      esac
    fi
    grep -Eq '^HTTP/[0-9.]+ 200([[:space:]]|$)' "$WORK/headers" && fail 'Anonymous access detected.'
  fi
  sleep 5
done
[[ $PROTECTED == true ]] || fail 'No expected Entra login redirect received.'
# Retire only older credentials created by this script, after the replacement is deployed.
while IFS= read -r key; do
  [[ -n $key ]] || continue
  az ad app credential delete --id "$ENTRA_CLIENT_ID" --key-id "$key" --output none
done < <(jq -r '.[] | select(.displayName == "tabs-bootstrap-login") | .keyId' "$WORK/old-credentials.json")
SUCCESS=true
printf '\nReady: https://%s/\nGitHub environment: %s / azure-testing (main only)\n' "$FQDN" "$GITHUB_REPO"
printf 'Verify your sign-in succeeds and another tenant account is denied before relying on the app.\n'
printf 'Login secret expires in one year; rerunning rotates script-managed login credentials.\n'
printf 'To remove billable resources: az group delete --name %s\n' "$RG"
printf 'Also remove the dedicated Entra registrations %s and %s when retiring this deployment.\n' "$DEPLOY_CLIENT_ID" "$ENTRA_CLIENT_ID"
