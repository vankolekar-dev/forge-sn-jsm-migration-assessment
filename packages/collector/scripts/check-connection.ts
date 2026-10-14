/**
 * Read-only ServiceNow connection check.
 *   npm run sn:check -- dev317128.service-now.com
 * Loads OAuth client credentials from env or macOS Keychain, gets a token, and runs four GET probes.
 * Never prints secrets or tokens.
 */
import { ClientCredentialsProvider, ServiceNowClient, normaliseInstanceUrl, nodeFetch } from '../src';
import { loadClientCredentials } from '../src/node';

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error('usage: npm run sn:check -- <instance>.service-now.com');
  const instanceUrl = normaliseInstanceUrl(arg);
  const creds = loadClientCredentials(instanceUrl);
  console.log(`instance: ${instanceUrl}\ncredentials: ${creds.source}`);
  const auth = new ClientCredentialsProvider(instanceUrl, creds.clientId, creds.clientSecret, nodeFetch);
  await auth.getToken();
  console.log('token: ok');
  const sn = new ServiceNowClient({ instanceUrl, auth, maxRequestsPerSecond: 2 });
  const probe = async (label: string, fn: () => Promise<unknown>) => {
    try {
      console.log(`${label}: ${JSON.stringify(await fn())}`);
    } catch (e) {
      console.log(`${label}: FAILED — ${(e as Error).message}`);
    }
  };
  await probe('release', () => sn.instanceInfo());
  await probe('business rules (count)', () => sn.count('sys_script'));
  await probe('catalog items (count)', () => sn.count('sc_cat_item', 'active=true'));
  await probe('CI classes (top 5 by count)', async () => (await sn.countBy('cmdb_ci', ['sys_class_name'])).sort((a, b) => b.count - a.count).slice(0, 5));
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
