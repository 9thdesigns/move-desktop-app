'use strict';

// electron-builder afterPack hook (runs after the app directory is assembled,
// before code signing).
//
// 1. Writes build-info.json into the app's resources so the running app knows
//    whether it was signed. electron-updater can only install updates into a
//    signed macOS app, so unsigned builds turn the updater off instead of
//    offering a "Restart Now" that would fail.
// 2. Ad-hoc signs unsigned macOS builds. Apple Silicon refuses to launch a
//    wholly unsigned app, so a build without a Developer ID certificate still
//    gets `codesign --sign -`. When a certificate is configured electron-builder
//    signs properly right after this hook and this step is skipped.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const productFilename = packager.appInfo.productFilename;
  const isMac = electronPlatformName === 'darwin';
  const isWindows = electronPlatformName === 'win32';

  const signed = isMac
    ? Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
    : isWindows
      ? Boolean(process.env.WIN_CSC_LINK)
      : false;

  const appPath = isMac ? path.join(appOutDir, `${productFilename}.app`) : appOutDir;
  const resourcesDir = isMac ? path.join(appPath, 'Contents', 'Resources') : path.join(appOutDir, 'resources');

  const info = {
    version: packager.appInfo.version,
    platform: electronPlatformName,
    arch: ARCH_NAMES[context.arch] || String(context.arch),
    signed,
    // Windows NSIS updates work unsigned; macOS updates need a signed app.
    updatesEnabled: isWindows || signed,
    channel: (packager.config.publish && packager.config.publish.channel) || 'latest',
    builtAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA || null,
  };

  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`  • build-info.json written (${info.platform}/${info.arch}, signed=${info.signed})`);

  if (isMac && !signed) {
    console.log('  • no macOS signing identity configured: ad-hoc signing the app so it launches on Apple Silicon');
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  }
};
