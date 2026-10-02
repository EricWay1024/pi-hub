// The SDK's published shrinkwrap overrides npm's root override/lock entry.
// Copy the independently locked, patched dev dependency over its vulnerable copy.
// No network requests or third-party install scripts are required.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../node_modules/brace-expansion/', import.meta.url));
const target = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/', import.meta.url));
if (!existsSync(target)) process.exit(0);
const version = directory => JSON.parse(readFileSync(directory + '/package.json', 'utf8')).version;
if (version(source) !== '5.0.12') throw new Error('Install the locked brace-expansion 5.0.12 development dependency first.');
if (version(target) !== '5.0.12') {
  rmSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
  console.log('Hardened Pi SDK dependency: brace-expansion 5.0.12');
}
