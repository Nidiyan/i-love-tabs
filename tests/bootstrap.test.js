const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const script = path.resolve(__dirname, '../scripts/bootstrap-azure.sh');
const subscription = '11111111-1111-1111-1111-111111111111';
const tester = '22222222-2222-2222-2222-222222222222';

test('bootstrap help and invalid inputs make no cloud calls', async () => {
  assert.match((await run('bash', [script, '--help'])).stdout, /SUBSCRIPTION_ID/);
  await assert.rejects(run('bash', [script, '--yes'], {
    env: { ...process.env, SUBSCRIPTION_ID: '' },
  }), error => /Set SUBSCRIPTION_ID/.test(error.stderr));
});

// These command doubles exercise orchestration without any Azure/GitHub credentials.
const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const joined = args.join(' ');
const value = key => args[args.indexOf(key) + 1];
const output = value => process.stdout.write(typeof value === 'string' ? value + '\\n' : JSON.stringify(value) + '\\n');
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({command, args}) + '\\n');
if (command === 'az') {
  if (args.includes('--web-enable-id-token-issuance')) throw Error('Unsupported Azure CLI flag');
  if (joined.startsWith('containerapp ingress enable') && joined.includes('--type external') && process.env.FAIL_INGRESS === '1') process.exit(1);
  if (joined === 'account show --output none') process.exit(0);
  if (joined.startsWith('account show')) output('tenant');
  else if (joined.startsWith('ad signed-in-user')) output('${tester}');
  else if (joined.startsWith('group exists')) output(process.env.EXISTING_GROUP || 'false');
  else if (joined.startsWith('group show')) output({tags: {'tabs-bootstrap': process.env.OWNERSHIP || 'Nidiyan/i-love-tabs/i-love-tabs'}});
  else if (joined.startsWith('ad app list')) {
    output(process.env.REUSE === '1' ? [{displayName: value('--display-name'), appId: value('--display-name').includes('-github-') ? 'deploy-client' : 'login-client'}] : []);
  } else if (joined.startsWith('ad app create')) output(value('--display-name').includes('-github-') ? 'deploy-client' : 'login-client');
  else if (joined.startsWith('ad sp list')) output(process.env.REUSE === '1' ? [{id: 'principal'}] : []);
  else if (joined.startsWith('ad sp create')) output('principal');
  else if (joined.startsWith('ad app federated-credential list')) output(process.env.REUSE === '1' ? [{name: 'github-azure-testing', id: 'federation'}] : []);
  else if (joined.startsWith('acr show')) output('registry.azurecr.io');
  else if (joined.startsWith('ad app credential list')) output([{displayName: 'tabs-bootstrap-login', keyId: 'old-key'}, {displayName: 'someone-else', keyId: 'keep-key'}]);
  else if (joined.startsWith('ad app credential reset')) output({password: 'generated-test-value'});
  else if (joined.startsWith('deployment group create')) {
    const filename = value('--parameters').slice(1);
    const data = JSON.parse(fs.readFileSync(filename));
    if ((fs.statSync(filename).mode & 0o777) !== 0o600) throw Error('Insecure parameter file');
    if (data.parameters.entraClientSecret.value !== 'generated-test-value') throw Error('Missing secure parameter');
    fs.writeFileSync(process.env.PARAMETER_LOG, filename);
    if (process.env.FAIL_DEPLOY === '1') { console.error('sensitive-error-dump'); process.exit(1); }
  } else if (joined.startsWith('containerapp show')) output(value('--query') === 'id' ? '/subscriptions/test/apps/tabs' : 'tabs.eastus.azurecontainerapps.io');
  else if (joined.startsWith('rest --method get')) output({properties: {
    platform: {enabled: true}, httpSettings: {requireHttps: true},
    globalValidation: {unauthenticatedClientAction: 'RedirectToLoginPage', redirectToProvider: 'azureActiveDirectory', excludedPaths: []},
    identityProviders: {azureActiveDirectory: {
      enabled: true, registration: {clientId: 'login-client', openIdIssuer: 'https://login.microsoftonline.com/tenant/v2.0'},
      validation: {defaultAuthorizationPolicy: {allowedPrincipals: {identities: [process.env.BAD_AUTH === '1' ? 'other' : '${tester}']}}}
    }}
  }});
} else if (command === 'gh') {
  if (args[0] === 'repo') output('ADMIN');
  else if (joined.includes('/deployment-branch-policies') && !args.includes('--method')) {
    if (process.env.REUSE === '1') output('7\\tmain\\tbranch\\n8\\t*\\tbranch');
  } else if (joined.includes('/environments') && !args.includes('--method')) {
    if (process.env.REUSE === '1') output({can_admins_bypass: false, protection_rules: [{type: 'required_reviewers', prevent_self_review: true, reviewers: [{type: 'User', reviewer: {id: 42}}]}]});
  } else if (args.includes('--input')) {
    const data = JSON.parse(fs.readFileSync(value('--input')));
    if (!data.deployment_branch_policy.custom_branch_policies) throw Error('Missing branch restriction');
    if (process.env.REUSE === '1' && data.reviewers[0].id !== 42) throw Error('Lost reviewers');
    if (process.env.REUSE === '1' && data.can_admins_bypass !== false) throw Error('Lost admin bypass restriction');
  }
} else if (command === 'docker' && args[0] === 'inspect') output('registry.azurecr.io/i-love-tabs@sha256:abc');
else if (command === 'git') output(args.includes('hash-object') ? 'abcdef1234567890' : '1234567890abcdef');
else if (command === 'curl') {
  fs.writeFileSync(value('--dump-header'), process.env.ANONYMOUS === '1'
    ? 'HTTP/2 200\\r\\n\\r\\n'
    : 'HTTP/2 302\\r\\nLocation: /.auth/login/aad?post_login_redirect_uri=/\\r\\n\\r\\n');
}
`;

async function bootstrap(options = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tabs-bootstrap-test-'));
  const bin = path.join(directory, 'bin');
  await fs.mkdir(bin);
  for (const name of ['az', 'gh', 'docker', 'curl', 'git']) {
    await fs.writeFile(path.join(bin, name), mock, { mode: 0o755 });
  }
  const callsFile = path.join(directory, 'calls');
  const parameterLog = path.join(directory, 'parameter');
  try {
    let result;
    try {
      result = await run('bash', [script, '--yes'], {
        env: { ...process.env, ...options, SUBSCRIPTION_ID: subscription,
          TESTER_OBJECT_ID: tester, APP_NAME: 'i-love-tabs', GITHUB_REPO: 'Nidiyan/i-love-tabs',
          LOCATION: 'eastus', REGISTRY_NAME: 'testregistry', PATH: `${bin}:${process.env.PATH}`,
          CALL_LOG: callsFile, PARAMETER_LOG: parameterLog, TMPDIR: directory },
        timeout: 30000,
      });
    } catch (error) { result = error; }
    const calls = (await fs.readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse);
    let parameter;
    try { parameter = await fs.readFile(parameterLog, 'utf8'); } catch { /* Failed before deployment. */ }
    if (parameter) await assert.rejects(fs.access(path.dirname(parameter)), { code: 'ENOENT' });
    assert.ok(!result.stdout.includes('generated-test-value'));
    assert.ok(!result.stderr.includes('generated-test-value'));
    assert.ok(!JSON.stringify(calls).includes('generated-test-value'));
    return { result, calls };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const called = (calls, text) => calls.some(call => call.args.join(' ').includes(text));

test('bootstrap creates resources, configures all GitHub variables, and opens only protected ingress', async () => {
  const { result, calls } = await bootstrap();
  assert.equal(result.code, undefined, result.stderr);
  assert.match(result.stdout, /Ready: https:/);
  assert.ok(called(calls, 'deployment sub create'));
  assert.ok(called(calls, 'deployment group create'));
  assert.ok(called(calls, '--enable-id-token-issuance true'));
  assert.equal(calls.filter(c => c.command === 'gh' && c.args[0] === 'variable').length, 8);
  assert.ok(called(calls, '--type external'));
  assert.ok(!called(calls, '--type internal'));
  assert.ok(called(calls, '--key-id old-key'));
  assert.ok(!called(calls, '--key-id keep-key'));
});

test('bootstrap reuses identities and preserves reviewers while removing broad branch rules', async () => {
  const { result, calls } = await bootstrap({ REUSE: '1', EXISTING_GROUP: 'true' });
  assert.equal(result.code, undefined, result.stderr);
  assert.ok(!called(calls, 'ad app create'));
  assert.ok(!called(calls, 'ad sp create'));
  assert.ok(called(calls, 'federated-credential update'));
  assert.ok(called(calls, 'deployment-branch-policies/8'));
});

test('unsafe auth and shared resource groups fail before public ingress', async () => {
  for (const options of [{ BAD_AUTH: '1' }, { EXISTING_GROUP: 'true', OWNERSHIP: 'someone-else' }]) {
    const { result, calls } = await bootstrap(options);
    assert.equal(result.code, 1);
    assert.ok(!called(calls, '--type external'));
  }
});

test('failed secure deployment cleans files and suppresses sensitive error dumps', async () => {
  const { result, calls } = await bootstrap({ FAIL_DEPLOY: '1' });
  assert.equal(result.code, 1);
  assert.ok(!result.stderr.includes('sensitive-error-dump'));
  assert.ok(!called(calls, '--type external'));
});

test('anonymous access after enabling ingress triggers rollback to internal', async () => {
  const { result, calls } = await bootstrap({ ANONYMOUS: '1' });
  assert.equal(result.code, 1);
  assert.ok(called(calls, '--type external'));
  assert.ok(called(calls, '--type internal'));
  assert.ok(!called(calls, '--key-id old-key'));
});

test('a failed external-ingress command still attempts rollback', async () => {
  const { result, calls } = await bootstrap({ FAIL_INGRESS: '1' });
  assert.equal(result.code, 1);
  assert.ok(called(calls, '--type external'));
  assert.ok(called(calls, '--type internal'));
});
