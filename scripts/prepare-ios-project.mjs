import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceIcon = fileURLToPath(new URL('../assets/app-icon-1024.png', import.meta.url));
const sourcePrivacy = fileURLToPath(new URL('../assets/ios/PrivacyInfo.xcprivacy', import.meta.url));
const nativeIcon = fileURLToPath(new URL('../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', import.meta.url));
const nativePrivacy = fileURLToPath(new URL('../ios/App/App/PrivacyInfo.xcprivacy', import.meta.url));
const projectFile = fileURLToPath(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url));

const fail = message => {
  throw new Error(`${message}\nRun this only after \`npx cap add ios\`. No partial Xcode project edit was written.`);
};

const replaceOnce = (source, marker, replacement, purpose) => {
  const first = source.indexOf(marker);
  if (first < 0) fail(`Could not find the expected ${purpose} marker in ${projectFile}. The Capacitor template may have changed; add PrivacyInfo.xcprivacy to the App target in Xcode instead of guessing.`);
  if (source.indexOf(marker, first + marker.length) >= 0) fail(`The ${purpose} marker is ambiguous in ${projectFile}. Add PrivacyInfo.xcprivacy to the App target in Xcode instead of guessing.`);
  return source.replace(marker, replacement);
};

const pbxId = label => createHash('sha256').update(`spotjobs-ios:${label}`).digest('hex').slice(0, 24).toUpperCase();
const privacyFileRef = pbxId('PrivacyInfo.xcprivacy:file-reference');
const privacyBuildFile = pbxId('PrivacyInfo.xcprivacy:resources-build-file');

let project;
try {
  project = await readFile(projectFile, 'utf8');
  await readFile(sourceIcon);
  await readFile(sourcePrivacy);
  await readFile(nativeIcon);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const hasAnyPrivacyReference = project.includes('PrivacyInfo.xcprivacy');
const hasCompletePrivacyReference = [
  /PrivacyInfo\.xcprivacy in Resources \*\//,
  /PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;/,
  /\/\* PrivacyInfo\.xcprivacy \*\/,/,
  /\/\* PrivacyInfo\.xcprivacy in Resources \*\/,/,
].every(pattern => pattern.test(project));

if (hasAnyPrivacyReference && !hasCompletePrivacyReference) {
  fail('PrivacyInfo.xcprivacy is only partly referenced by the Xcode project');
}

if (!hasAnyPrivacyReference) {
  const eol = project.includes('\r\n') ? '\r\n' : '\n';
  project = replaceOnce(
    project,
    `/* Begin PBXBuildFile section */${eol}`,
    `/* Begin PBXBuildFile section */${eol}\t\t${privacyBuildFile} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${privacyFileRef} /* PrivacyInfo.xcprivacy */; };${eol}`,
    'PBXBuildFile section',
  );
  project = replaceOnce(
    project,
    `/* Begin PBXFileReference section */${eol}`,
    `/* Begin PBXFileReference section */${eol}\t\t${privacyFileRef} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };${eol}`,
    'PBXFileReference section',
  );
  project = replaceOnce(
    project,
    `\t\t\t\t504EC3131FED79650016851F /* Info.plist */,${eol}`,
    `\t\t\t\t504EC3131FED79650016851F /* Info.plist */,${eol}\t\t\t\t${privacyFileRef} /* PrivacyInfo.xcprivacy */,${eol}`,
    'App group Info.plist',
  );
  project = replaceOnce(
    project,
    `\t\t\t\t504EC30F1FED79650016851F /* Assets.xcassets in Resources */,${eol}`,
    `\t\t\t\t504EC30F1FED79650016851F /* Assets.xcassets in Resources */,${eol}\t\t\t\t${privacyBuildFile} /* PrivacyInfo.xcprivacy in Resources */,${eol}`,
    'App resources Assets.xcassets',
  );
}

// Copy only after every Xcode project precondition has been validated. This
// keeps a changed Capacitor template from leaving a half-configured project.
await copyFile(sourceIcon, nativeIcon);
await copyFile(sourcePrivacy, nativePrivacy);
if (!hasAnyPrivacyReference) await writeFile(projectFile, project, 'utf8');

console.log(`Prepared iOS release assets under ${dirname(nativePrivacy).slice(root.length)}:`);
console.log('- AppIcon uses assets/app-icon-1024.png');
console.log('- PrivacyInfo.xcprivacy is included in the App target resources');
