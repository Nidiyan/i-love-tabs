# i-love-tabs
Translate a video of a guitarist to a set of tabs.

## Run locally

Use Node.js **24.22.0 or a newer 24.x patch** (the latest LTS line) and
Python **3.15.0** with pip, plus FFmpeg on your PATH. `.nvmrc` and
`.python-version` record the selected runtimes for version managers.
NumPy is pinned to a release with Python 3.15 support. Node.js 26 is still
in its Current phase, so this project targets Node.js 24 LTS instead.
On Debian/Ubuntu, install FFmpeg with `sudo apt-get install ffmpeg`.

```sh
python3.15 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm start
```

Open http://127.0.0.1:3000. No npm dependencies, API keys, database, or build step
are required. `PORT` and `HOST` configure the listener; `PYTHON` can specify a
Python executable if it is not named `python3`. Keep the default loopback binding
for local use. Public deployment needs authentication/rate limits at a reverse
proxy and a sandboxed, resource-limited FFmpeg worker.

## Use

Paste a **direct public HTTPS video/audio file URL** (for example, an MP4 link),
choose automatic tuning or a known tuning, and select **Generate tabs**.
The app downloads up to 40 MB and analyzes the first 60 seconds. Supported
containers include MP4/MOV, WebM/MKV, WAV, MP3, Ogg, FLAC, and AAC. The file must
contain audio. Streaming-site pages such as YouTube, private hosts, IPv6-only
hosts, authenticated links, and custom ports are not supported.
Only process recordings you own or have permission to use.

The audio-first pipeline extracts mono audio with FFmpeg, detects stable pitches
with normalized autocorrelation, estimates tuning and key, then maps notes onto
six strings (up to 24 frets), favoring small fret movements. Results include
plain-text tabs, estimated tuning/key, timed notes, and a download button.
Downloaded media is temporary and removed after each request. No third-party
AI service is used.

### Accuracy and limitations

- This is an **experimental monophonic** transcription tool, not a reliable
  transcription of chords or a full band. Clean, isolated melodies work best.
  Noise, harmonics, vocals, repeated notes, bends, and effects can cause errors.
- Tuning cannot generally be recovered from a melody. Auto uses standard tuning
  as a low-confidence baseline, suggests half-step down for a lowest detected D#2,
  and Drop D for D2. It does **not** distinguish alternate tunings with the same
  range or detect capo positions. Override tuning when you know it; available
  choices also include DADGAD and Open G.
- Key is a duration-weighted pitch-class/profile estimate, not a guarantee.
  Short or ambiguous passages may have low confidence or an unknown key.
- Finger positions are suggestions: the same pitch is playable in several
  places. This version does not analyze hand movements or video frames.
- Tab columns represent **note order**, not rhythm. Consult the timed note list
  for starts and durations. Unplayable pitches are listed as unmapped.
- One analysis runs at a time; downloads and subprocesses have timeouts.

## Tests

```sh
npm test
```

Tests use Node's built-in test runner and Python's `unittest` with synthetic
guitar-range tones. No network access is required for the tests.

## API

`POST /api/transcribe` with `Content-Type: application/json`:

```json
{"url": "https://example.com/guitar.mp4", "tuning": "auto"}
```

Returns `tuning`, `key`, `tabs`, `notes`, `duration`, and `warnings`, or an
`error` message when download/analysis fails or no stable notes are detected.
Tuning values: `auto`, `standard`, `drop-d`, `half-step-down`, `dadgad`, `open-g`.
In the timed notes, string **1 is the lowest-pitched string** and string 6 the
highest; the ASCII tab displays the highest string first.

## Container

The multi-stage Dockerfile packages the selected Node/Python versions, NumPy,
and FFmpeg. Base images are digest-pinned; update those digests when updating
runtime versions or applying base-image security updates. The `test` target runs
the tests, including an offline MP4 → download stream → FFmpeg → Python → API
integration test. Only the HTTPS response is substituted; extraction, analysis,
and temporary-file cleanup are real. The `production` target excludes tests.

```sh
REPO_ROOT=$(git rev-parse --show-toplevel)
docker build --target test -t i-love-tabs:test "$REPO_ROOT"
docker build --target production -t i-love-tabs:local "$REPO_ROOT"
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 2g \
  -p 127.0.0.1:3000:3000 i-love-tabs:local
```

The image runs as UID/GID 10001, binds `0.0.0.0:3000`, and uses its Python
virtual environment. Do not override its user to root. Azure applies the
template's 1 CPU / 2 GiB container limits; the Docker command additionally tests
read-only/capability restrictions that are not configurable through the selected
Container Apps API. This is a resource-bounded testing container, **not a fully
isolated hostile-media sandbox**. Use trusted recordings and restricted testers.

## Deploy to Azure Container Apps

Architecture: GitHub Actions → Azure Container Registry (ACR) → Container Apps.
This is a **one-time bootstrap followed by image-only deployments** on pushes
to `main` (not `master`). PRs targeting `main` run checks without Azure access.
No database or persistent media volume is needed.

### Automated bootstrap (recommended)

Use **Bash on Linux, macOS, or WSL**, with Azure CLI/Bicep, Docker (running),
GitHub CLI, jq, curl, and Git installed. You need Azure resource/role-assignment
permissions and Entra app-registration permissions, plus GitHub repository admin
access. GitHub environment protection must be available for your repository/plan.
Run from a trusted checkout containing the deployment files:

```sh
az login
gh auth login
REPO_ROOT=$(git rev-parse --show-toplevel)
SUBSCRIPTION_ID='<your-subscription-uuid>' \
  bash "$REPO_ROOT/scripts/bootstrap-azure.sh" --yes
```

This creates **billable resources**. `--yes` acknowledges that and changes to the
dedicated `azure-testing` GitHub environment. Optional environment inputs:

| Input | Default |
| --- | --- |
| `LOCATION` | `eastus` |
| `APP_NAME` | `i-love-tabs` |
| `REGISTRY_NAME` | Stable generated name derived from subscription/repo/app |
| `GITHUB_REPO` | `Nidiyan/i-love-tabs` (set this when using a fork) |
| `TESTER_OBJECT_ID` | Signed-in Azure user's tenant-local object ID |

The script generates/reuses the two Entra registrations, OIDC federation, Azure
resources and managed identity roles; builds/tests/pushes a Linux amd64 image;
deploys the app; checks tenant and owner-only authentication; and sets **all eight**
GitHub environment variables. It preserves existing required reviewers/wait timer
while replacing environment branch/tag policies with **only the `main` branch**.
No deployment client secret is created. The script never merges code or pushes
Git commits; merging the workflow to `main` enables subsequent deployments.

The website sign-in secret goes through mode-600 files in a mode-700 temporary
directory, is removed on exit, and is stored as a secure Azure app secret.
Do not run with shell tracing, publish CLI debug logs, or provide secrets as input.
The resource URLs/IDs and eight GitHub variables are configuration, not passwords.

Initial ingress stays internal until authentication and GitHub configuration
succeed. If a later step or the anonymous-login check fails after public ingress
was attempted, the script tries to restore internal ingress and warns if rollback
fails. **Do not ignore that warning.** A successful redirect does not prove browser
login or authorization: after setup, sign in as yourself, then verify another
tenant account is denied. The public URL is reachable, but only your selected
user is authorized; Azure administrators retain administrative access.

**Reruns:** use the same subscription, repository, app, and registry inputs.
Registrations have stable unique names and are reused; the foundation is
redeployed. The script refuses preexisting resource groups without its ownership
tag, so choose a different `APP_NAME` if you previously followed the manual
instructions below. Do not point it at shared app registrations or resources.
Each run appends a new website login credential, deploys it, and deletes only
older credentials labeled `tabs-bootstrap-login` after a successful smoke check.
Other credentials are preserved. A failed run may leave a generated credential
or partial resources in Azure; rerun after fixing permissions/quota/name conflicts.
Never automatically delete resources on an error. Review app credentials in Entra
if abandoning a failed setup, and remove the dedicated resource group/registrations
when finished. New identities/roles may need time to propagate before a rerun.
The login secret expires in one year; rerun before expiry or rotate it manually.
The script needs public Azure cloud endpoints; sovereign clouds are not supported.

For troubleshooting or manual setup, the equivalent steps follow.

### 1. Prerequisites and deployment identity

You need an Azure subscription, current Azure CLI with Bicep and the Container
Apps extension, Docker, permission to create Entra app registrations, and
subscription permissions to create resources and role assignments (for example,
Owner). The GitHub workflow subsequently uses only ACR-scoped `AcrPush` and
Container-App-scoped `Contributor`, not subscription-wide Contributor.

Run these interactively; do not enable shell tracing or paste secrets into GitHub:

```sh
az login
az extension add --name containerapp --upgrade
az bicep install
REPO_ROOT=$(git rev-parse --show-toplevel)
SUBSCRIPTION_ID='<your-subscription-id>'
LOCATION='eastus'
APP_NAME='i-love-tabs'
REGISTRY_NAME='<globally-unique-lowercase-alphanumeric-name>'
az account set --subscription "$SUBSCRIPTION_ID"
TENANT_ID=$(az account show --query tenantId -o tsv)
for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.OperationalInsights Microsoft.ManagedIdentity; do
  az provider register --namespace "$provider" --wait
done
DEPLOY_CLIENT_ID=$(az ad app create --display-name "$APP_NAME-github" --query appId -o tsv)
DEPLOY_OBJECT_ID=$(az ad sp create --id "$DEPLOY_CLIENT_ID" --query id -o tsv)
az ad app federated-credential create --id "$DEPLOY_CLIENT_ID" --parameters '{
  "name": "github-azure-testing",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:Nidiyan/i-love-tabs:environment:azure-testing",
  "audiences": ["api://AzureADTokenExchange"]
}'
az deployment sub create --name "$APP_NAME-foundation" --location "$LOCATION" \
  --template-file "$REPO_ROOT/infra/main.bicep" \
  --parameters location="$LOCATION" appName="$APP_NAME" registryName="$REGISTRY_NAME" \
    deployPrincipalId="$DEPLOY_OBJECT_ID" --output none
RG="$APP_NAME-rg"
```

The federation subject deliberately uses the **GitHub environment**, not a branch
subject: the deployment job declares `environment: azure-testing`. For a fork,
change the owner/repository in the subject. No deployment client secret is created.
Re-use these app registrations/IDs on subsequent runs; do not create duplicates.
Allow time for new role assignments to propagate.

The foundation creates the resource group, Basic ACR (admin login disabled),
a user-assigned pull identity with `AcrPull`, a Consumption environment, and a
30-day Log Analytics workspace. ACR and logs have costs even without requests;
the app keeps one replica warm. Configure a subscription budget before testing.

### 2. Bootstrap the image and restricted sign-in

Create a **different**, single-tenant Entra web application for browser sign-in.
Do not use the GitHub deployment identity as a tester:

```sh
ENTRA_CLIENT_ID=$(az ad app create --display-name "$APP_NAME-testers" \
  --sign-in-audience AzureADMyOrg --enable-id-token-issuance true --query appId -o tsv)
az ad sp create --id "$ENTRA_CLIENT_ID" --output none
ENTRA_CLIENT_SECRET=$(az ad app credential reset --id "$ENTRA_CLIENT_ID" \
  --append --display-name container-app-login --years 1 --query password -o tsv)
TESTER_OBJECT_IDS_JSON='["<your-tenant-local-user-object-id>"]'
LOGIN_SERVER=$(az acr show --name "$REGISTRY_NAME" --query loginServer -o tsv)
IMAGE="$LOGIN_SERVER/i-love-tabs:$(git rev-parse HEAD)"
az acr login --name "$REGISTRY_NAME"
docker build --target test -t i-love-tabs:test "$REPO_ROOT"
docker build --target production -t "$IMAGE" "$REPO_ROOT"
docker push "$IMAGE"
IMAGE_DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE")
az deployment group create --resource-group "$RG" --name "$APP_NAME-app" \
  --template-file "$REPO_ROOT/infra/app.bicep" \
  --parameters appName="$APP_NAME" registryName="$REGISTRY_NAME" image="$IMAGE_DIGEST" \
    entraClientId="$ENTRA_CLIENT_ID" entraClientSecret="$ENTRA_CLIENT_SECRET" \
    testerObjectIds="$TESTER_OBJECT_IDS_JSON" deployPrincipalId="$DEPLOY_OBJECT_ID" \
  --output none
unset ENTRA_CLIENT_SECRET
```

Use Entra **user object IDs**, not emails, subscription IDs, or client IDs.
For your own ID, `az ad signed-in-user show --query id -o tsv` may help; tenant
directory permissions may be needed for other users. The nonempty identities-only
allowlist permits only those users, including tenant-local guest IDs if applicable
(up to 12 users to stay below the provider's identity-list size limit).

The sign-in secret is a `@secure()` Bicep parameter stored as a Container Apps
secret and referenced by built-in authentication. It is **not** a GitHub secret
or a password for deployment. Rotate it before expiry using Entra and Container
Apps secret management; never commit it or place it in a checked-in parameter file.

Initial ingress is **internal**, so creating the parent app does not briefly expose
an unauthenticated public endpoint before the auth child resource exists. Read
back the auth configuration before enabling external ingress:

```sh
APP_ID=$(az containerapp show -g "$RG" -n "$APP_NAME" --query id -o tsv)
az rest --method get --url "$APP_ID/authConfigs/current?api-version=2024-03-01" \
  --query properties
```

Confirm platform and Entra are enabled, the issuer is your tenant's `/v2.0`
endpoint, the unauthenticated action is `RedirectToLoginPage`, there are no
excluded paths, and `allowedPrincipals.identities` is **exactly** your tester
allowlist. Then enable HTTPS ingress and register the resulting public callback:

```sh
az containerapp ingress enable -g "$RG" -n "$APP_NAME" \
  --type external --target-port 3000 --transport auto --output none
FQDN=$(az containerapp show -g "$RG" -n "$APP_NAME" \
  --query properties.configuration.ingress.fqdn -o tsv)
az ad app update --id "$ENTRA_CLIENT_ID" \
  --web-redirect-uris "https://$FQDN/.auth/login/aad/callback"
curl --silent --show-error --dump-header - --output /dev/null "https://$FQDN/"
```

Expect a **302 redirect to `/.auth/login/aad`**, not an anonymous 200. In separate
browser sessions, verify a listed tester can access the app and an unlisted tenant
user is denied (403). This manual check is essential; a redirect alone does not
verify successful login or the allowlist. If access is unexpected, immediately
switch ingress back to internal with `az containerapp ingress enable --type internal`.
Reapplying the app template intentionally resets ingress to internal; repeat these
verification steps before enabling it again. Do not share this Container Apps
environment with untrusted workloads; internal ingress is not an authorization wall.

### 3. Configure GitHub and merge to main

Create a GitHub environment named **`azure-testing`**. Under its deployment branch
rules, allow **only `main`**; optionally require reviewer approval. Protect `main`
with pull requests and the `test` job as a required status check. Configure these
**environment variables** (IDs/names are not credentials):

| Variable | Value from bootstrap |
| --- | --- |
| `AZURE_CLIENT_ID` | `DEPLOY_CLIENT_ID` |
| `AZURE_TENANT_ID` | `TENANT_ID` |
| `AZURE_SUBSCRIPTION_ID` | `SUBSCRIPTION_ID` |
| `AZURE_RESOURCE_GROUP` | `RG` |
| `AZURE_CONTAINER_APP` | `APP_NAME` |
| `AZURE_REGISTRY_NAME` | `REGISTRY_NAME` |
| `AZURE_ENTRA_CLIENT_ID` | `ENTRA_CLIENT_ID` |
| `AZURE_TESTER_OBJECT_IDS_JSON` | Exact tester JSON array |

After merging, the workflow:

1. Compiles the Bicep templates and runs all tests inside the pinned runtimes,
   including the FFmpeg/Python pipeline; smoke-tests the production container.
2. On pushes to `main` **only**, obtains an Azure token via OIDC, checks that the
   tenant/provider/tester allowlist have not drifted, and rebuilds/tests the image.
3. Pushes a commit-SHA-tagged image, then deploys its immutable **digest**.
4. Waits for that specific revision to be active, provisioned, and healthy, then
   verifies that the public endpoint redirects anonymous visitors to Entra login.

PR and manually dispatched runs are **checks only**. Deployments are serialized.
The update changes only the image: it does not weaken auth, change ingress, or
replace secrets. The pull identity retrieves the image without registry passwords.
The readiness check plus anonymous redirect check is not an authenticated-user
transcription test; run that manually after first deployment and auth changes.

### Operations and limitations

- Inspect startup/system logs with `az containerapp logs show -g "$RG" -n "$APP_NAME" --type system`
  and application output with `--type console`. Logging must not include submitted
  media URLs (which can contain signed credentials), tokens, or secret values.
- The app's existing one-active-transcription guard returns 429 while busy.
  `minReplicas: 1`, `maxReplicas: 1`, and single-revision mode avoid steady-state
  scale-out, but old/new revisions can briefly overlap during rollout. There is
  no distributed queue or per-user quota. Add rate limiting before broadening access.
- Downloads, conversion, and analysis can take about 105 seconds in total.
  Any additional proxy must permit that duration; future longer processing needs
  asynchronous jobs rather than increasingly long HTTP requests.
- CPU/memory limits apply to Node and its child processes together. This setup
  is for a small, allowlisted test deployment, not an unrestricted media service.
- To roll back, use `az containerapp update -g "$RG" -n "$APP_NAME" --image '<previous-image-digest>'`
  and repeat readiness/login checks. Keep previous image digests in ACR.
- To stop all resource charges, delete the dedicated resource group with
  `az group delete --name "$RG"` after confirming it holds only this app. Also
  delete the two dedicated Entra registrations/federated credential and remove
  GitHub environment variables when retiring the deployment.
- Azure deployment does not add streaming-site support, source separation,
  chords, or visual fingering analysis. Start with short, clean single-note recordings.
