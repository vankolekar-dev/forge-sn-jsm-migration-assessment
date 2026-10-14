const ALLOWED_HOST = /^[a-z0-9-]+\.(service-now\.com|servicenowservices\.com)$/i;

/** Normalise and validate an instance URL: https only, ServiceNow-hosted domains only, no path. */
export function normaliseInstanceUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('Enter a valid ServiceNow instance URL, e.g. https://acme.service-now.com');
  }
  if (u.protocol !== 'https:') throw new Error('ServiceNow instance URL must use https.');
  if (!ALLOWED_HOST.test(u.hostname)) throw new Error('Only *.service-now.com and *.servicenowservices.com instances are supported.');
  return `https://${u.hostname.toLowerCase()}`;
}

export const instanceHost = (instanceUrl: string): string => new URL(instanceUrl).hostname;
