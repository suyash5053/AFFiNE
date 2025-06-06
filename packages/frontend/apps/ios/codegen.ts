import { execSync } from 'node:child_process';

import { ProjectRoot } from '@affine-tools/utils/path';
import { Package } from '@affine-tools/utils/workspace';

const iosPackage = new Package('@affine/ios');

const PackageRoot = iosPackage.path;

console.log('[*] PackageRoot', PackageRoot);

console.log('[*] graphql...');
execSync(
  `${PackageRoot}/App/Packages/AffineGraphQL/apollo-ios-cli generate --path ${PackageRoot}/apollo-codegen-config.json`,
  { stdio: 'inherit' }
);

console.log('[*] rust...');
execSync(
  'cargo build -p affine_mobile_native --lib --release --target aarch64-apple-ios',
  {
    stdio: 'inherit',
  }
);

execSync(
  `cargo run -p affine_mobile_native --bin uniffi-bindgen generate \
  --library ${ProjectRoot}/target/aarch64-apple-ios/release/libaffine_mobile_native.a \
  --language swift --out-dir ${PackageRoot}/App/App/uniffi`,
  { stdio: 'inherit' }
);

console.log('[+] codegen complete');
