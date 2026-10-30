import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

export default async function sign(options: SignOptions): Promise<void> {
  const localIdentity =
    process.env.T3CODE_SIGNING_DIRECTORY && process.env.T3CODE_CLI_MAC_SIGN_IDENTITY;
  const keychain = process.env.CSC_KEYCHAIN;
  if (localIdentity && !keychain)
    throw new Error("The local signing identity requires CSC_KEYCHAIN.");
  await signApplication({
    ...options,
    ...(localIdentity && keychain
      ? {
          identity: localIdentity,
          identityValidation: false,
          keychain,
        }
      : {}),
    batchCodesignCalls: true,
  });
}
