/**
 * Re-sign the packaged app ad-hoc.
 *
 * electron-builder's own signing step is off (`identity: null`), because
 * the only certificates on a typical dev machine are "Apple Development"
 * ones, which are for running on registered devices and are useless for
 * distribution — signing with one would produce a build that launches
 * nowhere except here.
 *
 * But *not* signing is worse than it sounds. The bundle still carries the
 * ad-hoc linker signature Electron shipped with, over contents we have
 * since replaced: the binary is renamed, the icon is ours, the asar is
 * ours. codesign then reports
 *
 *     code has no resources but signature indicates they must be present
 *
 * and macOS refuses to launch it at all. On Apple Silicon that surfaces as
 * "Karakeep is damaged and can't be opened. You should move it to the
 * Trash." — which, unlike the ordinary unidentified-developer warning, has
 * no right-click > Open way past it. A release built that way is dead on
 * arrival for everyone who downloads it.
 *
 * Re-signing ad-hoc makes the signature describe what is actually in the
 * bundle. The build is still not notarized and still carries no team
 * identity, so a downloaded copy is quarantined and needs one
 * right-click > Open — but that is a prompt the user can get past.
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // --deep is deprecated for real distribution signing, where each nested
  // binary should be signed inside-out with its own identity. For an
  // ad-hoc signature with no entitlements there is nothing to get wrong,
  // and it is the one invocation that reliably covers Electron's nested
  // frameworks and helper apps.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })

  // Fail the build rather than shipping a bundle that cannot launch.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed  ${app}`)
}
