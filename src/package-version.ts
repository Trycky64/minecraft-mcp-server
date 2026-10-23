import { readFileSync } from 'node:fs';

interface PackageMetadata {
  version?: unknown;
}

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata;

if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
  throw new Error('package-version-metadata-invalid');
}

export const PACKAGE_VERSION = metadata.version;
