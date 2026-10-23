import test from 'ava';
import { readFileSync } from 'node:fs';
import { PACKAGE_VERSION } from '../src/package-version.js';

test('runtime MCP version comes from the package manifest', (t) => {
  const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  t.is(PACKAGE_VERSION, metadata.version);
});
