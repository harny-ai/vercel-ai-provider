import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const canonical = resolve(root, '../../sdk/harny/_canonical_example.py');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('package', () => {
  it('has the version in src/version.ts equal to package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });
  it('declares Apache-2.0, Node 20, an ai v7 peer and no runtime dependencies', () => {
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.engines.node).toBe('>=20');
    expect(pkg.peerDependencies.ai).toBe('^7.0.0');
    expect(pkg.dependencies).toBeUndefined();
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('Apache License');
  });
  it('pins the framework versions it is tested against', () => {
    expect(pkg.devDependencies.ai).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies['@ai-sdk/provider']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readme).toContain(`ai@${pkg.devDependencies.ai}`);
    expect(readme).toContain(`@ai-sdk/provider@${pkg.devDependencies['@ai-sdk/provider']}`);
  });
  it('names no storage vendor and no internal id in any shipped file', () => {
    const banned = new RegExp(['mem' + '0', 'graph' + 'iti', 'open' + 'viking'].join('|'), 'i');
    const internal = /\bD-\d{3}\b|\bO-\d{3}\b/;
    for (const file of walk(root)) {
      if (/package-lock\.json$|\.test\.ts$/.test(file) || /\/(\.git)\//.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      expect(banned.test(text), file).toBe(false);
      expect(internal.test(text), file).toBe(false);
    }
  });
});

describe.skipIf(!existsSync(canonical))('README matches the SDK’s canonical example (repo only)', () => {
  it('contains SYNC_EXAMPLE byte for byte', () => {
    const source = readFileSync(canonical, 'utf8');
    const match = source.match(/SYNC_EXAMPLE = '''\\\n([\s\S]*?)'''/);
    expect(match).not.toBeNull();
    expect(readme).toContain(match![1]!);
  });
  it('tells the same story in TypeScript: same ids, same facts, same question', () => {
    for (const fact of [
      'call-8820',
      'call-8821',
      'Nadia confirmed the Acme pilot ships March 14. Budget is 32k.',
      'Nadia raised the Acme pilot budget from 32k to 40k.',
      'What is the Acme pilot budget?',
    ]) {
      expect(readme).toContain(fact);
    }
  });
});
