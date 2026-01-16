import { readFileSync, writeFileSync } from 'fs';

interface Manifest {
	minAppVersion: string;
	version: string;
	[key: string]: unknown;
}

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
	console.error('No version found in npm_package_version environment variable');
	process.exit(1);
}

// Read minAppVersion from manifest.json and bump version to target version
const manifest: Manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t'));

// Update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions: Record<string, string> = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!Object.values(versions).includes(minAppVersion)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}

console.log(`Version bumped to ${targetVersion}`);
