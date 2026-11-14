# Releasing rustflix

`.github/workflows/release.yml` builds every target on GitHub and
publishes the results as a GitHub Release. The helper scripts it runs are
in `.github/scripts/`.

| Trigger | Result |
| --- | --- |
| Push to `main` | Rolling pre-release **`latest`**, deleted and recreated on every run (its tag moves to the new commit; only this run's files are attached). Changes that touch only `docs/`, `*.md` or `store/` do not trigger a build. A newer push cancels a run still in progress. |
| Push of a tag `v*` | Release **`vX.Y.Z`**. The tag must equal `MARKETING_VERSION`, or the run fails before it builds anything. |
| Actions → Release → Run workflow | You choose the targets. By default nothing is published: the files are kept on the run page for 14 days. `publish` (from `main` only) updates `latest`. |

Each target builds in its own job, so one failing does not stop the
others. The release job attaches whatever was built, plus `SHA256SUMS.txt`
and notes listing the commits since the previous `v*` tag. **Android and
macOS are required**: if either fails, the release is still published
with the rest, but the run is marked failed. **iOS is optional.**

## Version

`ios/project.yml` is the single source:

- `MARKETING_VERSION`: the version (`0.1.0`). It becomes Android
  `versionName`, iOS `CFBundleShortVersionString` and macOS
  `CFBundleShortVersionString`.
- `CURRENT_PROJECT_VERSION`: the build number, an integer (`15`). It
  becomes Android `versionCode`, iOS `CFBundleVersion` and macOS
  `CFBundleVersion`.

File names carry both: `rustflix-0.1.0-15-arm64-v8a.apk`.

## Cut a release

1. Bump `MARKETING_VERSION` (and `CURRENT_PROJECT_VERSION`) in
   `ios/project.yml` and commit to `main`.
2. Tag that commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. Watch it: `gh run watch -R hexuria/rustflix`. The release appears at
   `https://github.com/hexuria/rustflix/releases/tag/v0.2.0`.

If the tag and `MARKETING_VERSION` differ (for example tag `v0.2.0`, file
`0.1.0`), the Version job fails with a message naming both. Delete the
tag (`git push origin :v0.2.0`), fix the file, and tag again.

Re-running a tag's workflow uploads the files again over the existing
release (`--clobber`) and replaces its notes.

Android installs an update only when its `versionCode` is the same or
higher. Two `latest` builds with the same build number install over each
other, so bump `CURRENT_PROJECT_VERSION` when you want devices to see a
newer version.

## What each job builds

| Job | Runner | Files | Typical time (cold / cached) |
| --- | --- | --- | --- |
| Android | `macos-26` | `rustflix-V-B-arm64-v8a.apk`, `rustflix-V-B-armeabi-v7a.apk`, `rustflix-V-B.aab` | 35–50 min / 15–20 min |
| macOS | `macos-26` | `rustflix-V-B-macos-arm64.zip` (Apple silicon) | 15–25 min / 8–12 min, plus notarization (usually 2–10 min) |
| iOS | `macos-26` | `rustflix-V-B.ipa` | 35–50 min / 15–20 min |
| Release | `ubuntu-latest` | `SHA256SUMS.txt`, notes | under 1 min |

- **Android** runs `android/build.sh release-splits` with
  `ABIS=arm64-v8a,armeabi-v7a`. It runs on macOS because `build.sh` uses
  the NDK's `darwin-x86_64` toolchain and builds the desktop crate on the
  host to produce the bundle. It installs NDK `29.0.13113456`, platforms
  36 and 35 (NSH's runtime compiles against 35) and build-tools 36.0.0,
  uses JDK 21, and adds the Rust targets `aarch64-linux-android` and
  `armv7-linux-androideabi`. The NSH runtime (`android/nsh-runtime/`) is
  cached by NSH commit, ABIs and NDK version. On a cache hit the build
  passes `SKIP_RUNTIME=1` and NSH is not checked out.
- **macOS** runs `./package-macos.sh` into a temporary directory, with an
  icon made from `store/app-icon-1024.png`. It stamps the version into
  `Info.plist`, then signs. With the Developer ID secrets it signs with
  hardened runtime, a secure timestamp and
  `.github/macos/rustflix.entitlements` (`allow-jit`), then notarizes and
  staples when notarization secrets exist.
- **iOS** builds `NativeShell.xcframework` from NSH
  (`cargo xtask ios-embed --no-dev --no-catalyst`; cached by NSH commit
  and Xcode version) at `../_research/nsh`, where `ios/project.yml` looks
  for it. It then runs `ios/sync-bundle.sh --release` and `xcodegen`,
  archives with **manual** signing (CI has no Xcode account for automatic
  signing), and exports. The export method follows the provisioning
  profile: an App Store profile gives `app-store-connect`, an ad hoc
  profile (one with a device list) gives `release-testing`.

The NSH commit is pinned by `NSH_REF` at the top of the workflow
(`https://github.com/longbridge/nsh`, public). Bump it on purpose; the
caches follow it.

## Secrets

Set them under Settings → Secrets and variables → Actions, or with `gh`
as shown below. A missing optional secret is read as empty.

### Subtitle keys (all jobs)

| Secret | What | Required |
| --- | --- | --- |
| `WYZIE_API_KEY` | Wyzie Subs key, baked into the bundle by `build.rs` | No: without it the build ships no Wyzie key |
| `SUBDL_API_KEY` | SubDL key, baked into the bundle by `build.rs` | No: without it the build ships no SubDL key |

### Android

| Secret | What | Required |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The release keystore file (JKS or PKCS12), base64 on a single line | **Yes** |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore's password | **Yes** |
| `ANDROID_KEY_ALIAS` | The alias of the key inside it | **Yes** |
| `ANDROID_KEY_PASSWORD` | The key's password (for PKCS12, usually the same as the keystore's) | **Yes** |

Without all four, the Android job **fails** on purpose. If the release key
changed between builds, phones would refuse every update. For a test
build without them, run the workflow manually with `allow_debug_signing`:
the APKs are then signed with a key made on the runner, named
`…-testkey.apk`, and cannot be published.

The job checks the keystore, password and alias before it builds, and
logs the certificate's SHA-256 fingerprint. The fingerprint is public;
compare it with `keytool -list -v` on your copy.

### macOS

| Secret | What | Required |
| --- | --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | "Developer ID Application" certificate and private key, exported as `.p12`, base64 | No: without it the app is ad-hoc signed |
| `MACOS_CERTIFICATE_PASSWORD` | The `.p12`'s export password | With the certificate |
| `MACOS_SIGNING_IDENTITY` | Identity name to sign with | No: the default is the `.p12`'s Developer ID Application identity for `APPLE_TEAM_ID` |
| `APPLE_ID` | Apple ID email for notarization | No (see below) |
| `APPLE_APP_PASSWORD` | App-specific password for that Apple ID (appleid.apple.com → Sign-In and Security) | With `APPLE_ID` |
| `APPLE_TEAM_ID` | Team ID (`5KZ8MD34QW`) | With `APPLE_ID`; also picks the identity |
| `APP_STORE_CONNECT_API_KEY_P8_BASE64` | App Store Connect API key (`AuthKey_XXXX.p8`), base64 | No: if all three API-key secrets are set, notarization uses them instead of the Apple ID |
| `APP_STORE_CONNECT_API_KEY_ID` | The key's ID | With the key |
| `APP_STORE_CONNECT_ISSUER_ID` | The issuer ID (Users and Access → Integrations) | With the key |

What you get:

- No certificate: an **ad-hoc** signed app. macOS blocks the first
  launch; the release notes tell users how to open it anyway.
- Certificate only: **Developer ID signed, not notarized**. Gatekeeper
  still warns; the notes say so.
- Certificate plus the API-key trio or the Apple ID trio: **notarized and
  stapled**. A rejected notarization fails the job and prints Apple's log.

### iOS (optional; skipped without these)

| Secret | What | Required |
| --- | --- | --- |
| `IOS_DIST_CERT_P12_BASE64` | "Apple Distribution" certificate and private key, `.p12`, base64 | For iOS |
| `IOS_DIST_CERT_PASSWORD` | Its export password | For iOS |
| `IOS_PROVISIONING_PROFILE_BASE64` | App Store (or ad hoc) provisioning profile for `com.hexuria.rustflix`, base64 | For iOS |
| `IOS_SIGNING_IDENTITY` | Identity name | No: default `Apple Distribution` |
| `APP_STORE_CONNECT_API_KEY_P8_BASE64`, `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID` | As above; needed only for the TestFlight upload | Only for upload |

Without the first three secrets, the iOS job reports "iOS skipped" and
succeeds.

**TestFlight upload is off by default.** It runs only when you start the
workflow manually with `testflight`, or when the repository variable
`IOS_TESTFLIGHT_UPLOAD` is `true` (that covers tag and `main` builds).
It also needs an App Store profile and the API-key secrets. Uploads fail
until the Account Holder accepts the pending agreement in App Store
Connect → Business (the 403 "required contracts" error in
[IOS.md](IOS.md#upload-errors)). The IPA is saved and attached to the
release before the upload step, so a failed upload loses nothing.

### Set them with `gh`

Run these from the repository root. Values are read from files or
prompts, so they never land in your shell history.

```sh
R=hexuria/rustflix

# Subtitle keys (from the Keychain, as the local scripts do)
secret get WYZIE_API_KEY | gh secret set WYZIE_API_KEY -R $R
secret get SUBDL_API_KEY | gh secret set SUBDL_API_KEY -R $R

# Android release key
base64 -i ~/keys/rustflix-upload.jks | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 -R $R
gh secret set ANDROID_KEYSTORE_PASSWORD -R $R     # prompts
gh secret set ANDROID_KEY_ALIAS -R $R --body upload
gh secret set ANDROID_KEY_PASSWORD -R $R          # prompts

# macOS Developer ID + notarization (Apple ID route)
base64 -i <DeveloperIDApplication.p12> | tr -d '\n' | gh secret set MACOS_CERTIFICATE_P12_BASE64 -R $R
gh secret set MACOS_CERTIFICATE_PASSWORD -R $R    # prompts
gh secret set APPLE_ID -R $R --body <apple-id-email>
gh secret set APPLE_APP_PASSWORD -R $R            # prompts
gh secret set APPLE_TEAM_ID -R $R --body <TEAMID>

# Optional: App Store Connect API key (notarization and TestFlight)
base64 -i <AuthKey_KEYID.p8> | tr -d '\n' | gh secret set APP_STORE_CONNECT_API_KEY_P8_BASE64 -R $R
gh secret set APP_STORE_CONNECT_API_KEY_ID -R $R --body <KEYID>
gh secret set APP_STORE_CONNECT_ISSUER_ID -R $R --body <ISSUER-UUID>

# Optional: iOS
base64 -i <AppleDistribution.p12> | tr -d '\n' | gh secret set IOS_DIST_CERT_P12_BASE64 -R $R
gh secret set IOS_DIST_CERT_PASSWORD -R $R        # prompts
base64 -i <rustflix_AppStore.mobileprovision> | tr -d '\n' | gh secret set IOS_PROVISIONING_PROFILE_BASE64 -R $R
gh variable set IOS_TESTFLIGHT_UPLOAD -R $R --body true   # only to upload tag/main builds

gh secret list -R $R
```

To export a certificate as `.p12`, open Keychain Access → My Certificates,
right-click "Developer ID Application: …" (or "Apple Distribution: …"),
choose Export, pick the `.p12` format, and set an export password.

## The Android release key

Create it **once**:

```sh
mkdir -p ~/keys
keytool -genkeypair -v -keystore ~/keys/rustflix-upload.jks -storetype PKCS12 \
  -alias upload -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=rustflix, O=Hexuria"
keytool -list -v -keystore ~/keys/rustflix-upload.jks -alias upload   # fingerprint
```

**This key must never change.** Android installs an update only if it is
signed with the same key as the installed app. A new key means every user
has to uninstall (and lose downloads and settings) before they can
install again. On Google Play it is the upload key: losing it means a key
reset through Play support. Back up the keystore file and its password
outside this Mac (a password manager or an offline copy). The repository
never contains it: `android/keystore.properties`, `*.jks` and
`*.keystore` are gitignored.

The CI job writes the keystore to the runner's temp directory and writes
`android/keystore.properties` with only `storeFile` and `keyAlias`. Gradle
reads the passwords from `RUSTFLIX_UPLOAD_STORE_PASSWORD` /
`RUSTFLIX_UPLOAD_KEY_PASSWORD` (set from the secrets). Both files are
deleted at the end of the job. To sign the same way locally, see
[ANDROID.md](ANDROID.md#release-signing).

## Changing the workflow

- Third-party actions are pinned to full commit SHAs, with the version in
  a comment. To update one, resolve the new tag's commit
  (`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`) and replace
  both.
- Lint before pushing:
  `actionlint .github/workflows/release.yml && shellcheck .github/scripts/*.sh`.
- Only the Release job has `contents: write`; the build jobs read only.
